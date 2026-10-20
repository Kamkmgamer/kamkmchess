package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// GuestCredentialHeader carries the opaque guest seat credential.
//
// It is a separate header so a guest credential can never be mistaken for an
// account session token, and so the private single-owner sync API can keep its
// narrower header set. A guest credential is bound to one match and one seat.
const GuestCredentialHeader = "X-Guest-Seat-Token"

// OnlineRequestHeaders lists the request headers the online API accepts.
// Last-Event-ID is accepted for the finite stream renewal that KHA-69 adds.
var OnlineRequestHeaders = []string{GuestCredentialHeader, "Last-Event-ID"}

// OnlineService is the shared online reader and writer the participant API
// uses. It is satisfied by *online.Service, which stays the only transaction
// writer.
type OnlineService interface {
	Execute(ctx context.Context, actor online.ParticipantRef, cmd online.Command) (online.CommandResult, error)
	GetMatchForParticipant(ctx context.Context, matchID string, participant online.ParticipantRef) (online.Match, error)
	GetReceiptForParticipant(ctx context.Context, matchID, operationID string, participant online.ParticipantRef) (online.CommandResult, error)
	GetPublicProjection(ctx context.Context, matchID string) (online.PublicProjection, error)
}

// OnlineAuthenticator verifies a participant credential from a request.
type OnlineAuthenticator interface {
	AuthenticateAccount(ctx context.Context, token, origin string) (onlineauth.Principal, error)
	AuthenticateGuest(ctx context.Context, secret, origin string) (onlineauth.Principal, error)
}

// OnlineOptions configures the online API.
type OnlineOptions struct {
	// AllowedOrigins are the browser origins allowed to use the online API.
	// A same-origin read that omits the Origin header resolves against this
	// list by request host.
	AllowedOrigins []string
}

type onlineAPI struct {
	service       OnlineService
	authenticator OnlineAuthenticator
	options       OnlineOptions
}

// NewOnline returns the participant-authorized online API.
//
// The routes are:
//
//	GET  /v1/online/matches/{matchID}/replay                  public completed replay
//	GET  /v1/online/matches/{matchID}                         participant live state
//	GET  /v1/online/matches/{matchID}/operations/{operationID} participant receipt
//	POST /v1/online/matches/{matchID}/commands                participant command
//
// There is no route that creates a match. Creating a match is a trusted
// allocator operation, and an invitation link never becomes a control token.
func NewOnline(service OnlineService, authenticator OnlineAuthenticator, options OnlineOptions) http.Handler {
	api := &onlineAPI{service: service, authenticator: authenticator, options: options}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/online/matches/{matchID}/replay", api.replay)
	mux.HandleFunc("GET /v1/online/matches/{matchID}", api.live)
	mux.HandleFunc("GET /v1/online/matches/{matchID}/operations/{operationID}", api.operation)
	mux.HandleFunc("POST /v1/online/matches/{matchID}/commands", api.command)
	return mux
}

// replay returns the allowlisted completed replay. It is readable without
// signing in. Live state is not reachable here.
func (a *onlineAPI) replay(w http.ResponseWriter, r *http.Request) {
	projection, err := a.service.GetPublicProjection(r.Context(), r.PathValue("matchID"))
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, projection)
}

// live returns the live match to one of its participants only.
func (a *onlineAPI) live(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.participant(w, r, false)
	if !ok {
		return
	}
	ctx := onlineauth.WithPrincipal(r.Context(), principal)
	match, err := a.service.GetMatchForParticipant(ctx, r.PathValue("matchID"), principal.Participant)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toOnlineMatch(match, principal))
}

// operation returns one accepted receipt to a participant of its match.
func (a *onlineAPI) operation(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.participant(w, r, false)
	if !ok {
		return
	}
	ctx := onlineauth.WithPrincipal(r.Context(), principal)
	result, err := a.service.GetReceiptForParticipant(ctx, r.PathValue("matchID"), r.PathValue("operationID"), principal.Participant)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Raw))
}

// command accepts one participant command.
//
// The seat in the command is checked against the caller's own seat, so a
// participant can never command the other seat. The authenticated participant
// is never read from the request body.
func (a *onlineAPI) command(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.participant(w, r, true)
	if !ok {
		return
	}
	matchID := r.PathValue("matchID")
	raw, ok := readRawBody(w, r)
	if !ok {
		return
	}
	cmd, err := online.ParseCommand(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if cmd.MatchID != matchID {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	// Creating a match is a trusted allocator operation. It is never a
	// public command, and a request can never set another participant's seat.
	if cmd.Action.Kind == online.ActionCreateMatch {
		writeError(w, http.StatusForbidden, "command_not_allowed")
		return
	}
	if principal.IsGuest() && principal.Seat != cmd.Seat {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	ctx := onlineauth.WithPrincipal(r.Context(), principal)
	result, err := a.service.Execute(ctx, principal.Participant, cmd)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Raw))
}

// participant authenticates the request and returns the caller.
//
// An account participant presents a Clerk session token. A guest participant
// presents the opaque seat credential. Presenting both is rejected so the
// server never has to choose which identity wins.
//
// A mutation requires an explicit Origin header. A browser always sends it,
// and a mutation without one is never silently accepted.
//
// A read may omit the Origin header. A browser omits it on a same-origin
// request, so the request origin is resolved from the configured origins by
// request host. A cross-site request is rejected.
func (a *onlineAPI) participant(w http.ResponseWriter, r *http.Request, mutation bool) (onlineauth.Principal, bool) {
	origin, ok := a.requestOrigin(r, mutation)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return onlineauth.Principal{}, false
	}
	authorization := r.Header.Values("Authorization")
	guest := r.Header.Values(GuestCredentialHeader)
	if len(authorization) > 1 || len(guest) > 1 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return onlineauth.Principal{}, false
	}
	if len(authorization) == 1 && len(guest) == 1 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return onlineauth.Principal{}, false
	}
	if len(authorization) == 1 {
		fields := strings.Fields(authorization[0])
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return onlineauth.Principal{}, false
		}
		principal, err := a.authenticator.AuthenticateAccount(r.Context(), fields[1], origin)
		if err != nil {
			writeOnlineError(w, err)
			return onlineauth.Principal{}, false
		}
		return principal, true
	}
	if len(guest) == 1 {
		principal, err := a.authenticator.AuthenticateGuest(r.Context(), guest[0], origin)
		if err != nil {
			writeOnlineError(w, err)
			return onlineauth.Principal{}, false
		}
		return principal, true
	}
	writeError(w, http.StatusUnauthorized, "unauthorized")
	return onlineauth.Principal{}, false
}

// requestOrigin resolves the origin of a request.
//
// An explicit Origin header always wins. A mutation must carry one. A read
// may omit it, and then the origin is resolved from the configured origins by
// request host, which only succeeds for a same-origin deployment.
func (a *onlineAPI) requestOrigin(r *http.Request, mutation bool) (string, bool) {
	origins := r.Header.Values("Origin")
	if len(origins) > 1 {
		return "", false
	}
	if len(origins) == 1 {
		origin := strings.TrimSpace(origins[0])
		if origin == "" {
			return "", false
		}
		return origin, true
	}
	if mutation {
		return "", false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return "", false
	}
	return a.sameOrigin(r)
}

// sameOrigin resolves the request origin from the configured origins by
// request host. It never trusts a forwarded scheme header.
func (a *onlineAPI) sameOrigin(r *http.Request) (string, bool) {
	if r.Host == "" {
		return "", false
	}
	for _, candidate := range a.options.AllowedOrigins {
		parsed, err := url.Parse(candidate)
		if err != nil || parsed.Host == "" {
			continue
		}
		if parsed.Host == r.Host {
			return candidate, true
		}
	}
	return "", false
}

// onlineSeatResponse is the allowlisted seat view. The participant reference
// is an authorization identity and never leaves the server.
type onlineSeatResponse struct {
	Seat                   online.Seat        `json:"seat"`
	PublicLabel            string             `json:"publicLabel"`
	Control                online.SeatControl `json:"control"`
	ControlEpoch           int64              `json:"controlEpoch"`
	IllegalAttemptsSpent   int                `json:"illegalAttemptsSpent"`
	FormatCorrectionsSpent int                `json:"formatCorrectionsSpent"`
}

// onlineOfferResponse is the allowlisted pending offer view. An offer carries
// no participant reference and no private data.
type onlineOfferResponse struct {
	Kind          online.OfferKind `json:"kind"`
	Seat          online.Seat      `json:"seat"`
	TargetVersion *int64           `json:"targetVersion"`
	BaseVersion   int64            `json:"baseVersion"`
	CreatedAt     time.Time        `json:"createdAt"`
}

// onlineMatchResponse is the participant live state.
//
// It has no participant reference, owner identifier, session identifier,
// credential, token, or hash. The opponent's seat is described by its public
// label and declared control only.
type onlineMatchResponse struct {
	SchemaVersion      int                   `json:"schemaVersion"`
	MatchID            string                `json:"matchId"`
	Variant            string                `json:"variant"`
	StartingFEN        string                `json:"startingFen"`
	PositionFEN        string                `json:"positionFen"`
	TimeControl        online.TimeControl    `json:"timeControl"`
	Version            int64                 `json:"version"`
	ControlEpoch       int64                 `json:"controlEpoch"`
	RulesPolicyVersion string                `json:"rulesPolicyVersion"`
	Status             online.MatchStatus    `json:"status"`
	Result             *online.Result        `json:"result"`
	Seats              []onlineSeatResponse  `json:"seats"`
	Clock              online.ClockState     `json:"clock"`
	Moves              []online.Move         `json:"moves"`
	PendingOffers      []onlineOfferResponse `json:"pendingOffers"`
	CreatedAt          time.Time             `json:"createdAt"`
	UpdatedAt          time.Time             `json:"updatedAt"`
	CompletedAt        *time.Time            `json:"completedAt"`
	YourSeat           *online.Seat          `json:"yourSeat"`
}

func toOnlineMatch(match online.Match, principal onlineauth.Principal) onlineMatchResponse {
	seats := make([]onlineSeatResponse, 0, len(match.Seats))
	var yourSeat *online.Seat
	for _, seat := range match.Seats {
		seats = append(seats, onlineSeatResponse{
			Seat:                   seat.Seat,
			PublicLabel:            seat.PublicLabel,
			Control:                seat.Control,
			ControlEpoch:           seat.ControlEpoch,
			IllegalAttemptsSpent:   seat.IllegalAttemptsSpent,
			FormatCorrectionsSpent: seat.FormatCorrectionsSpent,
		})
		if seat.Participant == principal.Participant {
			own := seat.Seat
			yourSeat = &own
		}
	}
	offers := make([]onlineOfferResponse, 0, len(match.Offers))
	for _, offer := range match.Offers {
		offers = append(offers, onlineOfferResponse{
			Kind:          offer.Kind,
			Seat:          offer.Seat,
			TargetVersion: offer.TargetVersion,
			BaseVersion:   offer.BaseVersion,
			CreatedAt:     offer.CreatedAt.UTC(),
		})
	}
	return onlineMatchResponse{
		SchemaVersion:      match.SchemaVersion,
		MatchID:            match.MatchID,
		Variant:            match.Variant,
		StartingFEN:        match.StartingFEN,
		PositionFEN:        match.PositionFEN,
		TimeControl:        match.TimeControl,
		Version:            match.Version,
		ControlEpoch:       match.ControlEpoch,
		RulesPolicyVersion: match.RulesPolicyVersion,
		Status:             match.Status,
		Result:             match.Result,
		Seats:              seats,
		Clock:              match.Clock,
		Moves:              match.Moves,
		PendingOffers:      offers,
		CreatedAt:          match.CreatedAt.UTC(),
		UpdatedAt:          match.UpdatedAt.UTC(),
		CompletedAt:        match.CompletedAt,
		YourSeat:           yourSeat,
	}
}

// readRawBody reads a bounded request body and rejects duplicate JSON keys.
func readRawBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.ContentLength > maxBody {
		writeError(w, http.StatusRequestEntityTooLarge, "request_too_large")
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid_request")
		}
		return nil, false
	}
	if len(raw) == 0 || !uniqueJSON(raw) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return nil, false
	}
	return raw, true
}

// writeOnlineError maps an online or authorization failure onto a status.
//
// A membership failure and a missing match share 404 so a caller cannot learn
// whether a match exists.
func writeOnlineError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, onlineauth.ErrOriginRequired):
		writeError(w, http.StatusForbidden, "origin_required")
	case errors.Is(err, onlineauth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, online.ErrNotAuthorized), errors.Is(err, online.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, online.ErrInvalidContract), errors.Is(err, online.ErrInvalidArgument):
		writeError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, online.ErrConflict),
		errors.Is(err, online.ErrOperationReuse),
		errors.Is(err, online.ErrMatchEnded),
		errors.Is(err, online.ErrActionNotAllowed),
		errors.Is(err, online.ErrAlreadyExists),
		errors.Is(err, online.ErrStaleCandidate):
		writeError(w, http.StatusConflict, "conflict")
	default:
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	}
}
