package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
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
	Fallback(ctx context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation, origin string) (queue.Assignment, error)
}

type queueAPI struct {
	service QueueService
	auth    participantAuthenticator
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
func NewQueue(service QueueService, authenticator OnlineAuthenticator, options OnlineOptions) http.Handler {
	api := &queueAPI{service: service, auth: newParticipantAuthenticator(authenticator, options)}
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

// create creates one explicit queue entry.
//
// The creation is the authoritative ready acceptance: the service records
// the ready time and starts the search window there.
func (a *queueAPI) create(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, true)
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
	entry, created, err := a.service.CreateEntry(r.Context(), principal.Participant, queue.CreateEntryRequest{
		Control:         body.Control,
		TimeControl:     body.TimeControl,
		ClientRequestID: body.ClientRequestID,
	})
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
	principal, ok := a.auth.account(w, r, false)
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
	principal, ok := a.auth.account(w, r, true)
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
	principal, ok := a.auth.account(w, r, true)
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
func (a *queueAPI) fallback(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, true)
	if !ok {
		return
	}
	operation, ok := a.operation(w, r)
	if !ok {
		return
	}
	origin := r.Header.Get("Origin")
	assignment, err := a.service.Fallback(r.Context(), principal.Participant, r.PathValue("entryID"), operation, origin)
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
