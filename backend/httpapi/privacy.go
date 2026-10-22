package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// PrivacyRequestHeaders lists the request headers the privacy API accepts.
//
// The guest seat credential header is accepted by the guest removal route
// only, because a guest proves the ownership of its seat with that
// credential.
var PrivacyRequestHeaders = []string{GuestCredentialHeader}

// The confirmations of the two removal flows.
//
// The confirmations are separate on purpose: an ordinary account deletion and
// an explicit removal erase different things, and neither of them can be
// triggered by accident.
const (
	// ConfirmAccountDeletion confirms an ordinary account deletion.
	ConfirmAccountDeletion = "delete-account"
	// ConfirmExplicitRemoval confirms an explicit removal of the shared
	// replays.
	ConfirmExplicitRemoval = "erase-shared-replays"
)

// PrivacyService is the removal service the API uses.
type PrivacyService interface {
	DeleteAccount(ctx context.Context, account onlineauth.Principal, origin string) (privacy.Report, error)
	RemoveAccount(ctx context.Context, account onlineauth.Principal, origin string) (privacy.Report, error)
	RemoveGuest(ctx context.Context, guest onlineauth.Principal, origin string) (privacy.Report, error)
}

// PublicLabelService registers the public labels an owner chose.
type PublicLabelService interface {
	RegisterPublicLabel(ctx context.Context, accountID, label string) (history.PublicLabel, error)
}

type privacyAPI struct {
	removals PrivacyService
	labels   PublicLabelService
	auth     participantAuthenticator
}

// NewPrivacy returns the privacy API.
//
// The routes are:
//
//	POST /v1/privacy/account/deletion       ordinary account deletion
//	POST /v1/privacy/account/removal        explicit removal of the shared replays
//	POST /v1/privacy/guest/removal          explicit removal for a guest seat owner
//	POST /v1/privacy/account/model-labels   the public label an owner chose
//
// The account routes take the verified account principal, and the request
// body never names an account, a profile or an owner. The guest route takes
// the guest seat credential, and the server derives the guest identity from
// it.
func NewPrivacy(removals PrivacyService, labels PublicLabelService, authenticator OnlineAuthenticator, options OnlineOptions) http.Handler {
	api := &privacyAPI{removals: removals, labels: labels, auth: newParticipantAuthenticator(authenticator, options)}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/privacy/account/deletion", api.deleteAccount)
	mux.HandleFunc("POST /v1/privacy/account/removal", api.removeAccount)
	mux.HandleFunc("POST /v1/privacy/guest/removal", api.removeGuest)
	mux.HandleFunc("POST /v1/privacy/account/model-labels", api.registerPublicLabel)
	return mux
}

// privacyResponse is the allowlisted answer of a removal flow.
type privacyResponse struct {
	SchemaVersion         int       `json:"schemaVersion"`
	RemovalID             string    `json:"removalId"`
	Scope                 string    `json:"scope"`
	Status                string    `json:"status"`
	AnonymizedMatches     int       `json:"anonymizedMatches"`
	RemovedMatches        int       `json:"removedMatches"`
	VerifiedAt            time.Time `json:"verifiedAt"`
	LiveDeletedAt         time.Time `json:"liveDeletedAt"`
	LiveDeleteDueAt       time.Time `json:"liveDeleteDueAt"`
	RecoverySanitizeDueAt time.Time `json:"recoverySanitizeDueAt"`
}

// publicLabelResponse is the answer of a public label registration.
type publicLabelResponse struct {
	SchemaVersion int    `json:"schemaVersion"`
	LabelID       string `json:"labelId"`
	PublicLabel   string `json:"publicLabel"`
}

// deleteAccount removes the account's own identity and anonymizes the shared
// games.
func (a *privacyAPI) deleteAccount(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, true)
	if !ok {
		return
	}
	origin, ok := a.auth.origin(r, true)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return
	}
	if !confirmPrivacyBody(w, r, ConfirmAccountDeletion) {
		return
	}
	report, err := a.removals.DeleteAccount(r.Context(), principal, origin)
	if err != nil {
		writePrivacyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toPrivacyResponse(report))
}

// removeAccount erases the shared replays of the account.
func (a *privacyAPI) removeAccount(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, true)
	if !ok {
		return
	}
	origin, ok := a.auth.origin(r, true)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return
	}
	if !confirmPrivacyBody(w, r, ConfirmExplicitRemoval) {
		return
	}
	report, err := a.removals.RemoveAccount(r.Context(), principal, origin)
	if err != nil {
		writePrivacyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toPrivacyResponse(report))
}

// removeGuest erases the shared replays of a guest.
func (a *privacyAPI) removeGuest(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.participant(w, r, true)
	if !ok {
		return
	}
	if !principal.IsGuest() {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	origin, ok := a.auth.origin(r, true)
	if !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return
	}
	if !confirmPrivacyBody(w, r, ConfirmExplicitRemoval) {
		return
	}
	report, err := a.removals.RemoveGuest(r.Context(), principal, origin)
	if err != nil {
		writePrivacyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toPrivacyResponse(report))
}

// registerPublicLabel registers the public label an owner chose for their own
// model opponents.
//
// The request carries the label only. The mapping from a private routing
// identity to that label stays in the owner's browser, and the service never
// receives a routing identifier, an endpoint, a connection nickname or a
// credential.
func (a *privacyAPI) registerPublicLabel(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth.account(w, r, true)
	if !ok {
		return
	}
	if _, ok = a.auth.origin(r, true); !ok {
		writeError(w, http.StatusForbidden, "origin_required")
		return
	}
	if a.labels == nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	var body struct {
		PublicLabel string `json:"publicLabel"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	label, err := a.labels.RegisterPublicLabel(r.Context(), principal.Subject, body.PublicLabel)
	if err != nil {
		writePrivacyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, publicLabelResponse{
		SchemaVersion: 1,
		LabelID:       label.LabelID,
		PublicLabel:   label.PublicLabel,
	})
}

// confirmPrivacyBody reads the confirmation of a removal request.
//
// A request without the exact confirmation is refused, so a removal is never
// triggered by an accidental or a partial request.
func confirmPrivacyBody(w http.ResponseWriter, r *http.Request, expected string) bool {
	var body struct {
		Confirm string `json:"confirm"`
	}
	if !decodeBody(w, r, &body) {
		return false
	}
	if body.Confirm != expected {
		writeError(w, http.StatusBadRequest, "confirmation_required")
		return false
	}
	return true
}

// toPrivacyResponse renders the allowlisted answer of a removal flow.
func toPrivacyResponse(report privacy.Report) privacyResponse {
	return privacyResponse{
		SchemaVersion:         privacy.SchemaVersion,
		RemovalID:             report.RemovalID,
		Scope:                 report.Scope,
		Status:                report.Status,
		AnonymizedMatches:     report.AnonymizedMatches,
		RemovedMatches:        report.RemovedMatches,
		VerifiedAt:            report.VerifiedAt.UTC(),
		LiveDeletedAt:         report.LiveDeletedAt.UTC(),
		LiveDeleteDueAt:       report.LiveDeleteDueAt.UTC(),
		RecoverySanitizeDueAt: report.RecoverySanitizeDueAt.UTC(),
	}
}

// writePrivacyError maps a removal failure onto a status.
func writePrivacyError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, onlineauth.ErrOriginRequired):
		writeError(w, http.StatusForbidden, "origin_required")
	case errors.Is(err, onlineauth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, privacy.ErrNotAuthorized):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, privacy.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, privacy.ErrInvalidArgument):
		writeError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, history.ErrInvalidLabel):
		writeError(w, http.StatusBadRequest, "invalid_label")
	default:
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	}
}
