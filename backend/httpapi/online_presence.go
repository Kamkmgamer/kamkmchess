package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// The online presence, abandonment claim and runner lease routes.
//
// The routes are:
//
//	GET  /v1/online/matches/{matchID}/presence                  participant presence view
//	POST /v1/online/matches/{matchID}/presence                  participant heartbeat
//	POST /v1/online/matches/{matchID}/presence/keep-waiting     participant keeps waiting
//	POST /v1/online/matches/{matchID}/claim                     participant abandonment claim
//	GET  /v1/online/matches/{matchID}/runner/lease              participant lease read
//	POST /v1/online/matches/{matchID}/runner/lease              participant lease write
//	POST /v1/online/matches/{matchID}/runner/request            participant provider request
//
// Every route requires a current participant credential. A guest seat
// credential may only act for its own seat.
//
// The routes are mounted only when the service implements the presence and
// lease seam, so a service that does not support them never exposes a route
// that cannot work.

// OnlinePresenceService is the presence, claim and runner lease seam of the
// online service.
//
// It is satisfied by *online.Service, which stays the only transaction
// writer.
type OnlinePresenceService interface {
	Heartbeat(ctx context.Context, actor online.ParticipantRef, matchID string, seat online.Seat) (online.SeatPresence, error)
	KeepWaiting(ctx context.Context, actor online.ParticipantRef, matchID string, seat online.Seat) (online.SeatPresence, error)
	GetPresence(ctx context.Context, actor online.ParticipantRef, matchID string) (online.PresenceView, error)
	ClaimAbandonment(ctx context.Context, actor online.ParticipantRef, cmd online.ClaimCommand) (online.CommandResult, error)
	AcquireRunnerLease(ctx context.Context, actor online.ParticipantRef, req online.RunnerLeaseRequest) (online.RunnerLease, error)
	RenewRunnerLease(ctx context.Context, actor online.ParticipantRef, req online.RunnerLeaseRequest) (online.RunnerLease, error)
	ReleaseRunnerLease(ctx context.Context, actor online.ParticipantRef, req online.RunnerLeaseRequest) (online.RunnerLease, error)
	GetSeatRunnerLease(ctx context.Context, actor online.ParticipantRef, matchID string, seat online.Seat) (online.RunnerLease, error)
	BeginRunnerRequest(ctx context.Context, actor online.ParticipantRef, req online.RunnerRequestRequest) (online.RunnerLease, error)
	ClearRunnerRequest(ctx context.Context, actor online.ParticipantRef, req online.RunnerRequestRequest) (online.RunnerLease, error)
}

// seatRequest is the body of a seat scoped request.
type seatRequest struct {
	Seat online.Seat `json:"seat"`
}

// runnerLeaseRequestBody is the body of a runner lease request.
//
// The action names the operation, so the route never depends on a method
// that a browser preflight would have to allow.
type runnerLeaseRequestBody struct {
	SchemaVersion int         `json:"schemaVersion"`
	Action        string      `json:"action"`
	Seat          online.Seat `json:"seat"`
	RunnerID      string      `json:"runnerId"`
	LeaseID       string      `json:"leaseId,omitempty"`
	TurnVersion   int64       `json:"turnVersion,omitempty"`
	ControlEpoch  int64       `json:"controlEpoch"`
}

// runnerRequestBody is the body of an uncertain provider request.
type runnerRequestBody struct {
	SchemaVersion int         `json:"schemaVersion"`
	Action        string      `json:"action"`
	Seat          online.Seat `json:"seat"`
	RunnerID      string      `json:"runnerId"`
	LeaseID       string      `json:"leaseId"`
	RequestID     string      `json:"requestId"`
	TurnVersion   int64       `json:"turnVersion,omitempty"`
	ControlEpoch  int64       `json:"controlEpoch"`
}

// presenceView returns the presence of both seats and the claim option of
// the calling participant.
func (a *onlineAPI) presenceView(w http.ResponseWriter, r *http.Request) {
	if a.presence == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal, ok := a.participant(w, r, false)
	if !ok {
		return
	}
	view, err := a.presence.GetPresence(r.Context(), principal.Participant, r.PathValue("matchID"))
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// heartbeat records one application heartbeat of a participant.
func (a *onlineAPI) heartbeat(w http.ResponseWriter, r *http.Request) {
	if a.presence == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal, ok := a.participant(w, r, true)
	if !ok {
		return
	}
	raw, ok := readRawBody(w, r)
	if !ok {
		return
	}
	var body seatRequest
	if err := decodeOnlineBody(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !a.seatAllowed(principal, body.Seat) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	presence, err := a.presence.Heartbeat(r.Context(), principal.Participant, r.PathValue("matchID"), body.Seat)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, presence)
}

// keepWaiting records that the participant chose to wait instead of claiming
// the win.
func (a *onlineAPI) keepWaiting(w http.ResponseWriter, r *http.Request) {
	if a.presence == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal, ok := a.participant(w, r, true)
	if !ok {
		return
	}
	raw, ok := readRawBody(w, r)
	if !ok {
		return
	}
	var body seatRequest
	if err := decodeOnlineBody(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !a.seatAllowed(principal, body.Seat) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	presence, err := a.presence.KeepWaiting(r.Context(), principal.Participant, r.PathValue("matchID"), body.Seat)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, presence)
}

// claim accepts the optional abandonment claim of a participant.
func (a *onlineAPI) claim(w http.ResponseWriter, r *http.Request) {
	if a.presence == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal, ok := a.participant(w, r, true)
	if !ok {
		return
	}
	raw, ok := readRawBody(w, r)
	if !ok {
		return
	}
	cmd, err := online.ParseClaimCommand(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if cmd.MatchID != r.PathValue("matchID") {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !a.seatAllowed(principal, cmd.Seat) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	result, err := a.presence.ClaimAbandonment(r.Context(), principal.Participant, cmd)
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result.Raw))
}

// readLease returns the runner lease of one seat.
func (a *onlineAPI) readLease(w http.ResponseWriter, r *http.Request) {
	if a.presence == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal, ok := a.participant(w, r, false)
	if !ok {
		return
	}
	seat := r.URL.Query().Get("seat")
	if seat != string(online.SeatWhite) && seat != string(online.SeatBlack) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !a.seatAllowed(principal, online.Seat(seat)) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	lease, err := a.presence.GetSeatRunnerLease(r.Context(), principal.Participant, r.PathValue("matchID"), online.Seat(seat))
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lease)
}

// writeLease acquires, renews or releases the runner lease of one seat.
func (a *onlineAPI) writeLease(w http.ResponseWriter, r *http.Request) {
	if a.presence == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal, ok := a.participant(w, r, true)
	if !ok {
		return
	}
	raw, ok := readRawBody(w, r)
	if !ok {
		return
	}
	var body runnerLeaseRequestBody
	if err := decodeOnlineBody(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !a.seatAllowed(principal, body.Seat) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	req := online.RunnerLeaseRequest{
		SchemaVersion: body.SchemaVersion,
		MatchID:       r.PathValue("matchID"),
		Seat:          body.Seat,
		RunnerID:      body.RunnerID,
		LeaseID:       body.LeaseID,
		TurnVersion:   body.TurnVersion,
		ControlEpoch:  body.ControlEpoch,
	}
	var (
		lease online.RunnerLease
		err   error
	)
	switch body.Action {
	case "acquire":
		lease, err = a.presence.AcquireRunnerLease(r.Context(), principal.Participant, req)
	case "renew":
		lease, err = a.presence.RenewRunnerLease(r.Context(), principal.Participant, req)
	case "release":
		lease, err = a.presence.ReleaseRunnerLease(r.Context(), principal.Participant, req)
	default:
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lease)
}

// runnerRequest records that a billable provider request started or settled.
func (a *onlineAPI) runnerRequest(w http.ResponseWriter, r *http.Request) {
	if a.presence == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	principal, ok := a.participant(w, r, true)
	if !ok {
		return
	}
	raw, ok := readRawBody(w, r)
	if !ok {
		return
	}
	var body runnerRequestBody
	if err := decodeOnlineBody(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !a.seatAllowed(principal, body.Seat) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	req := online.RunnerRequestRequest{
		SchemaVersion: body.SchemaVersion,
		MatchID:       r.PathValue("matchID"),
		Seat:          body.Seat,
		RunnerID:      body.RunnerID,
		LeaseID:       body.LeaseID,
		RequestID:     body.RequestID,
		TurnVersion:   body.TurnVersion,
		ControlEpoch:  body.ControlEpoch,
	}
	var (
		lease online.RunnerLease
		err   error
	)
	switch body.Action {
	case "begin":
		lease, err = a.presence.BeginRunnerRequest(r.Context(), principal.Participant, req)
	case "clear":
		lease, err = a.presence.ClearRunnerRequest(r.Context(), principal.Participant, req)
	default:
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if err != nil {
		writeOnlineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lease)
}

// seatAllowed reports whether the caller may act for a seat.
//
// A guest seat credential is bound to one seat and may never act for
// another one. An account participant may act for either seat of a match it
// belongs to; the service checks the membership again.
func (a *onlineAPI) seatAllowed(principal onlineauth.Principal, seat online.Seat) bool {
	if principal.IsGuest() && principal.Seat != seat {
		return false
	}
	return seat == online.SeatWhite || seat == online.SeatBlack
}

// decodeOnlineBody decodes a strict request body.
//
// Unknown fields and trailing data are rejected, so a body cannot smuggle a
// second seat or a second action past the reader.
func decodeOnlineBody(raw []byte, dst any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("trailing data")
		}
		return err
	}
	return nil
}
