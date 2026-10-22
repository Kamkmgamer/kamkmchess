package httpapi

import (
	"context"
	"net/http"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// AccountAuthorizer decides whether a participant may use a surface.
//
// It is the generic account authorization of the HTTP layer. A surface that
// is scoped to accounts asks it before it reads or writes anything, so an
// account that is not allowed never learns whether an invitation or a queue
// entry exists.
//
// A guest is never refused by the seam. The guest rule of the friend surface
// requires a guest to be able to create and to accept a friend link, so a
// narrowing of the account access must never reach a guest.
type AccountAuthorizer interface {
	// AccountAllowed reports whether the participant may use the surface.
	//
	// The answer carries no detail about the state of the surface, so the
	// refusal of a caller never reveals private state.
	AccountAllowed(ctx context.Context, participant online.ParticipantRef) (bool, error)
}

// allowParticipant reports whether the caller of a request may use the
// surface.
//
// The check runs after the authentication and before the service is called,
// so a refused account never reaches the state of an invitation or of a queue
// entry. The refusal is the same answer for every caller of the surface, so
// it cannot be used to learn whether an invitation or an entry exists.
//
// A surface without an authorizer admits every account, and a guest is
// admitted by every authorizer.
func allowParticipant(w http.ResponseWriter, r *http.Request, authorizer AccountAuthorizer, principal onlineauth.Principal) bool {
	allowed, err := participantAllowed(r.Context(), authorizer, principal)
	if err != nil || !allowed {
		writeError(w, http.StatusForbidden, "not_authorized")
		return false
	}
	return true
}

// participantAllowed reports whether the cohort admits the caller of a
// request.
//
// It answers without writing to the response, so a surface that has to
// decide what to do with a refused caller can ask first. An authorizer that
// cannot answer fails closed: the caller is not allowed.
func participantAllowed(ctx context.Context, authorizer AccountAuthorizer, principal onlineauth.Principal) (bool, error) {
	if authorizer == nil {
		return true, nil
	}
	if principal.Kind != online.ParticipantAccount {
		return true, nil
	}
	return authorizer.AccountAllowed(ctx, principal.Participant)
}
