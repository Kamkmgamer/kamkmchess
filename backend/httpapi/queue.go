package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
)

// QueueService is the public matchmaking queue the queue API uses.
//
// The service owns the compatibility rule, the reservation, the allocation
// and the browser engine fallback. The HTTP layer only authenticates the
// caller, validates the request shape and maps the answer.
type QueueService interface {
	// CreateEntry creates one explicit queue entry. The second result
	// reports whether a new entry was created.
	CreateEntry(ctx context.Context, actor online.ParticipantRef, request queue.CreateEntryRequest) (online.QueueEntry, bool, error)
	// Entry returns the entry of the caller.
	Entry(ctx context.Context, actor online.ParticipantRef, entryID string) (online.QueueEntry, error)
	// Ready re-arms an entry that is not ready.
	Ready(ctx context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error)
	// Cancel removes a waiting entry.
	Cancel(ctx context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error)
	// KeepSearching removes the automatic cutoff of a waiting entry.
	KeepSearching(ctx context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error)
	// Heartbeat renews the readiness lease of a waiting entry.
	Heartbeat(ctx context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error)
	// Match pairs the entry with a compatible ready entry.
	Match(ctx context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (queue.Assignment, error)
	// Fallback commits the browser engine fallback.
	Fallback(ctx context.Context, actor online.ParticipantRef, entryID string, request queue.FallbackRequest) (queue.Assignment, error)
}

type queueAPI struct {
	service QueueService
	auth    participantAuthenticator
	options QueueOptions
}

// QueueOptions configures the public queue API.
type QueueOptions struct {
	// AllowedOrigins are the browser origins allowed to use the public queue.
	AllowedOrigins []string
	// Cohort narrows the accounts that may use the public queue. A nil
	// authorizer admits every account.
	//
	// The queue is account-only, so the cohort narrows exactly the accounts
	// that may enter it.
	Cohort AccountAuthorizer
}

// NewQueue returns the public queue API.
//
// The routes are:
//
//	POST /v1/online/queue/entries                              create an entry
//	GET  /v1/online/queue/entries/{entryID}                    read an entry
//	POST /v1/online/queue/entries/{entryID}/ready               re-arm an entry
//	POST /v1/online/queue/entries/{entryID}/cancel              cancel an entry
//	POST /v1/online/queue/entries/{entryID}/keep-searching      keep searching
//	POST /v1/online/queue/entries/{entryID}/heartbeat           renew readiness
//	POST /v1/online/queue/entries/{entryID}/match               pair the entry
//	POST /v1/online/queue/entries/{entryID}/fallback            commit the engine
//
// Every route needs an account session. A guest is refused: the public
// queue is account-only.
//
// The routes never answer with an owner identifier of another participant,
// a session identifier, a credential of somebody else, or a private route.
//
// The constructor takes the options of the surface, so the cohort of the
// surface cannot be dropped on the way in. There is exactly one constructor
// of the public queue, and it carries the cohort of the request path: a
// wrapper that took the options of another surface would silently admit
// every account, so the wrapper does not exist.
func NewQueue(service QueueService, authenticator OnlineAuthenticator, options QueueOptions) http.Handler {
	api := &queueAPI{service: service, auth: newParticipantAuthenticator(authenticator, OnlineOptions{AllowedOrigins: options.AllowedOrigins}), options: options}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/online/queue/entries", api.create)
	mux.HandleFunc("GET /v1/online/queue/entries/{entryID}", api.entry)
	mux.HandleFunc("POST /v1/online/queue/entries/{entryID}/ready", api.ready)
	mux.HandleFunc("POST /v1/online/queue/entries/{entryID}/cancel", api.cancel)
	mux.HandleFunc("POST /v1/online/queue/entries/{entryID}/keep-searching", api.keepSearching)
	mux.HandleFunc("POST /v1/online/queue/entries/{entryID}/heartbeat", api.heartbeat)
	mux.HandleFunc("POST /v1/online/queue/entries/{entryID}/match", api.match)
	mux.HandleFunc("POST /v1/online/queue/entries/{entryID}/fallback", api.fallback)
	return mux
}

// queueCreateRequest is the body of one explicit entry creation.
type queueCreateRequest struct {
	SchemaVersion   int                `json:"schemaVersion"`
	Control         online.SeatControl `json:"control"`
	TimeControl     online.TimeControl `json:"timeControl"`
	ClientRequestID string             `json:"clientRequestId"`
}

// queueOperationRequest is the body of one mutating queue operation.
//
// The operation identifier is optional. When it is present the answer is
// stored with the operation, so a repeated call returns the same answer.
type queueOperationRequest struct {
	SchemaVersion int    `json:"schemaVersion"`
	OperationID   string `json:"operationId"`
}

// queueFallbackRequest is the body of the browser engine fallback.
//
// The credential recovery is the explicit rotation of an owner that lost the
// answer of the fallback and holds no usable credential. A routine retry
// never sets it: it would rotate the secret the browser still has.
type queueFallbackRequest struct {
	SchemaVersion      int    `json:"schemaVersion"`
	OperationID        string `json:"operationId"`
	CredentialRecovery bool   `json:"credentialRecovery"`
}

// caller authenticates the request as an account and checks the account
// cohort.
//
// The cohort is checked before the request reaches the service, so an account
// that is not allowed never learns whether a queue entry exists.
func (a *queueAPI) caller(w http.ResponseWriter, r *http.Request, mutation bool) (onlineauth.Principal, bool) {
	principal, ok := a.auth.account(w, r, mutation)
	if !ok {
		return onlineauth.Principal{}, false
	}
	if !allowParticipant(w, r, a.options.Cohort, principal) {
		return onlineauth.Principal{}, false
	}
	return principal, true
}

// create creates one explicit queue entry.
//
// The creation is the authoritative ready acceptance: the service records
// the ready time and starts the search window there.
func (a *queueAPI) create(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	var body queueCreateRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	request := queue.CreateEntryRequest{
		Control:         body.Control,
		TimeControl:     body.TimeControl,
		ClientRequestID: body.ClientRequestID,
	}
	// The queue never accepts an engine seat and never accepts a clock
	// outside the shared bounds. The service checks the request again.
	if err := queue.ValidateEntryRequest(request); err != nil {
		writeQueueError(w, err)
		return
	}
	entry, created, err := a.service.CreateEntry(r.Context(), principal.Participant, request)
	if err != nil {
		writeQueueError(w, err)
		return
	}
	if created {
		writeJSON(w, http.StatusCreated, entry)
		return
	}
	// The entry intent already existed. The same entry is returned and no
	// second game is created.
	writeJSON(w, http.StatusOK, entry)
}

// entry returns the entry of the caller.
func (a *queueAPI) entry(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.caller(w, r, false)
	if !ok {
		return
	}
	entry, err := a.service.Entry(r.Context(), principal.Participant, r.PathValue("entryID"))
	if err != nil {
		writeQueueError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

// ready re-arms an entry that is not ready. It is the explicit rejoin of an
// expired entry.
func (a *queueAPI) ready(w http.ResponseWriter, r *http.Request) {
	a.entryOperation(w, r, func(ctx context.Context, principal online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error) {
		return a.service.Ready(ctx, principal, entryID, operation)
	})
}

// cancel removes a waiting entry without creating a game.
func (a *queueAPI) cancel(w http.ResponseWriter, r *http.Request) {
	a.entryOperation(w, r, func(ctx context.Context, principal online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error) {
		return a.service.Cancel(ctx, principal, entryID, operation)
	})
}

// keepSearching removes the automatic cutoff of a waiting entry.
func (a *queueAPI) keepSearching(w http.ResponseWriter, r *http.Request) {
	a.entryOperation(w, r, func(ctx context.Context, principal online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error) {
		return a.service.KeepSearching(ctx, principal, entryID, operation)
	})
}

// heartbeat renews the readiness lease of a waiting entry.
func (a *queueAPI) heartbeat(w http.ResponseWriter, r *http.Request) {
	a.entryOperation(w, r, func(ctx context.Context, principal online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error) {
		return a.service.Heartbeat(ctx, principal, entryID, operation)
	})
}

// entryOperation runs one authenticated entry mutation.
func (a *queueAPI) entryOperation(w http.ResponseWriter, r *http.Request, run func(context.Context, online.ParticipantRef, string, queue.Operation) (online.QueueEntry, error)) {
	principal, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	operation, ok := a.operation(w, r)
	if !ok {
		return
	}
	entry, err := run(r.Context(), principal.Participant, r.PathValue("entryID"), operation)
	if err != nil {
		writeQueueError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

// match pairs the entry with a compatible ready entry.
func (a *queueAPI) match(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	operation, ok := a.operation(w, r)
	if !ok {
		return
	}
	assignment, err := a.service.Match(r.Context(), principal.Participant, r.PathValue("entryID"), operation)
	if err != nil {
		writeQueueError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, assignment)
}

// fallback commits the browser engine fallback.
//
// The call itself is the report that the browser engine is ready. The answer
// carries the seat-scoped credential that lets the owner's browser move the
// engine, and it is only produced once that credential exists.
//
// A routine retry of the same fallback never rotates a live credential: the
// answer then names the assignment without a secret, because the browser
// already holds the credential. An owner that lost the answer asks for the
// explicit recovery, and that rotation is the only one.
func (a *queueAPI) fallback(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	var body queueFallbackRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	origin := r.Header.Get("Origin")
	assignment, err := a.service.Fallback(r.Context(), principal.Participant, r.PathValue("entryID"), queue.FallbackRequest{
		Operation:          queue.Operation{ID: body.OperationID},
		CredentialRecovery: body.CredentialRecovery,
		Origin:             origin,
	})
	if err != nil {
		writeQueueError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, assignment)
}

// operation reads the optional operation identifier of a mutation.
func (a *queueAPI) operation(w http.ResponseWriter, r *http.Request) (queue.Operation, bool) {
	var body queueOperationRequest
	if !decodeBody(w, r, &body) {
		return queue.Operation{}, false
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return queue.Operation{}, false
	}
	return queue.Operation{ID: body.OperationID}, true
}

// writeQueueError maps a queue failure onto a status.
//
// A missing entry and an entry of another owner share 404, so a caller
// cannot learn whether an entry of somebody else exists. A missing
// candidate is a 404 too: it means "no candidate right now", not an error.
func writeQueueError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, queue.ErrAccountRemoved):
		// The account of the caller was removed. It is not a participant
		// any more, so the request is refused like an unauthenticated one.
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, queue.ErrNotFound), errors.Is(err, queue.ErrNoCandidate):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, queue.ErrInvalidRequest):
		writeError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, queue.ErrConflict), errors.Is(err, queue.ErrOperationReuse):
		writeError(w, http.StatusConflict, "conflict")
	default:
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	}
}
