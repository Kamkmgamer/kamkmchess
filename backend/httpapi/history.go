package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/Kamkmgamer/kamkmchess/backend/history"
)

// PublicHistoryService is the public history and public replay service.
//
// The service is an allowlist. It answers with the published replay of a
// completed match and with the published game history of a profile, and it
// never answers with a credential, an owner identifier, a private routing
// identity, or a model conversation.
type PublicHistoryService interface {
	PublicReplay(ctx context.Context, matchID string) (history.Replay, error)
	ProfileHistory(ctx context.Context, profileID string) (history.History, error)
}

// PublicReplayProvider serves the public replay of a completed match.
//
// The online participant API uses it for the canonical replay URL, so the
// public replay of a match is always the allowlisted replay with the declared
// control of every accepted move. The provider never serves a live match.
type PublicReplayProvider interface {
	PublicReplay(ctx context.Context, matchID string) (history.Replay, error)
}

type publicHistoryAPI struct {
	service PublicHistoryService
}

// NewPublicHistory returns the public history API.
//
// The routes are:
//
//	GET /v1/public/matches/{matchID}/replay     public replay of a completed match
//	GET /v1/public/profiles/{profileID}/history  public game history of a profile
//
// Both reads work without signing in. A match that has not completed, a
// replay that was removed, and a profile that does not exist share one answer,
// so a caller cannot learn what exists.
func NewPublicHistory(service PublicHistoryService) http.Handler {
	api := &publicHistoryAPI{service: service}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/public/matches/{matchID}/replay", api.replay)
	mux.HandleFunc("GET /v1/public/profiles/{profileID}/history", api.profileHistory)
	return mux
}

// replay answers with the public replay of a completed match.
func (a *publicHistoryAPI) replay(w http.ResponseWriter, r *http.Request) {
	replay, err := a.service.PublicReplay(r.Context(), r.PathValue("matchID"))
	if err != nil {
		writeHistoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, replay)
}

// profileHistory answers with the public game history of a profile.
func (a *publicHistoryAPI) profileHistory(w http.ResponseWriter, r *http.Request) {
	record, err := a.service.ProfileHistory(r.Context(), r.PathValue("profileID"))
	if err != nil {
		writeHistoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

// writeHistoryError maps a history failure onto a status.
//
// A missing replay, a missing profile and a removed replay share the not
// found answer.
func writeHistoryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, history.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, history.ErrInvalidArgument):
		writeError(w, http.StatusBadRequest, "invalid_request")
	default:
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	}
}
