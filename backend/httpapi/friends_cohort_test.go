package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/cohort"
	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The cohort tests of the owner recovery.
//
// A cohort narrows the account access of the friend surface, and it must
// never strand an invitation that was issued while the surface was open. The
// owner token of the invitation is the proof of the ownership, so the owner
// keeps the preview and the cancellation of the invitation it owns.
//
// The exception is narrow: without the proof the account is refused, a proof
// that fails is answered exactly like an unknown invitation, and the proof
// never widens the access to another invitation.

// cohortOwnerRequest sends one request that carries an owner token.
func cohortOwnerRequest(handler http.Handler, method, path, token, ownerToken, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", testOrigin)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if ownerToken != "" {
		request.Header.Set(OwnerTokenHeader, ownerToken)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// excludedOwnerService is the invitation service of the owner recovery.
//
// The invitation belongs to the account user_stranger, and the cohort of the
// surface names user_inviter, so the owner of the invitation is an account
// that the cohort does not name.
func excludedOwnerService() *stubFriendsService {
	return &stubFriendsService{
		invitation: invite.Invitation{
			InvitationID: "inv_0123456789",
			Kind:         invite.KindLink,
			Status:       invite.StatusOpen,
			InviterLabel: "Alice",
			InviterSeat:  online.SeatWhite,
		},
		ownerToken:        "kmoi1_owner_token",
		ownerInvitationID: "inv_0123456789",
		ownerAccountID:    "user_stranger",
	}
}

// excludedOwnerHandler composes the friend routes with a cohort that
// excludes the owner of the invitation.
func excludedOwnerHandler(service FriendsService) http.Handler {
	return NewFriends(service, &stubOnlineService{}, cohortAuthenticator(), FriendsOptions{
		AllowedOrigins: []string{testOrigin},
		Cohort:         cohort.Parse("user_inviter"),
	})
}

// TestTheCohortKeepsTheOwnerRecoveryOfItsInvitation covers the owner of an
// invitation that a narrowed cohort excluded.
//
// The owner token is the proof of the ownership, so the owner still cancels
// and still previews the invitation it owns. The invitation is not stranded
// by the narrowing.
func TestTheCohortKeepsTheOwnerRecoveryOfItsInvitation(t *testing.T) {
	service := excludedOwnerService()
	handler := excludedOwnerHandler(service)

	// The excluded owner cancels its own invitation with its owner token.
	cancelled := cohortOwnerRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/cancel",
		"token-stranger", "kmoi1_owner_token", `{"schemaVersion":2}`)
	if cancelled.Code != http.StatusOK {
		t.Fatalf("the cancellation of the excluded owner status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	if service.cancel.OwnerToken != "kmoi1_owner_token" {
		t.Fatalf("the service saw the owner token %q of the cancellation", service.cancel.OwnerToken)
	}
	if service.cancel.Canceller == nil || service.cancel.Canceller.Participant.ID != "user_stranger" {
		t.Fatalf("the service saw another canceller: %+v", service.cancel.Canceller)
	}

	// The excluded owner previews its own invitation with its owner token.
	service.calls = nil
	preview := cohortOwnerRequest(handler, http.MethodGet, "/v1/online/invitations/inv_0123456789",
		"token-stranger", "kmoi1_owner_token", "")
	if preview.Code != http.StatusOK {
		t.Fatalf("the preview of the excluded owner status=%d body=%s", preview.Code, preview.Body.String())
	}
	if service.view.OwnerToken != "kmoi1_owner_token" {
		t.Fatalf("the service saw the owner token %q of the preview", service.view.OwnerToken)
	}
}

// TestTheCohortKeepsTheOwnerRecoveryOfItsOwnInvitationIdentity covers the
// identity of the owner.
//
// The service authorizes the inviter of an invitation by its account
// identity as well, so the excluded inviter withdraws its own invitation
// without the owner token. The proof still covers the invitation of the
// request and nothing else.
func TestTheCohortKeepsTheOwnerRecoveryOfItsOwnInvitationIdentity(t *testing.T) {
	service := excludedOwnerService()
	handler := excludedOwnerHandler(service)

	cancelled := cohortOwnerRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/cancel",
		"token-stranger", "", `{"schemaVersion":2}`)
	if cancelled.Code != http.StatusOK {
		t.Fatalf("the cancellation of the excluded inviter status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	if service.cancel.Canceller == nil || service.cancel.Canceller.Participant.ID != "user_stranger" {
		t.Fatalf("the service saw another canceller: %+v", service.cancel.Canceller)
	}
}

// TestTheCohortRefusesAnExcludedAccountWithoutTheOwnerProof covers the
// refusal of an excluded account that owns nothing.
//
// The account of the request is a candidate proof of the ownership, and the
// proof fails for an account that owns nothing. The answer is the answer of
// an unknown invitation, and the service is never consulted, so the answer
// cannot reveal whether an invitation exists.
func TestTheCohortRefusesAnExcludedAccountWithoutTheOwnerProof(t *testing.T) {
	service := excludedOwnerService()
	handler := excludedOwnerHandler(service)

	// The cancellation of an account that owns nothing is answered like an
	// unknown invitation.
	refused := cohortOwnerRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/cancel",
		"token-outsider", "", `{"schemaVersion":2}`)
	if refused.Code != http.StatusNotFound {
		t.Fatalf("the cancellation without a proof status=%d body=%s", refused.Code, refused.Body.String())
	}
	if !strings.Contains(refused.Body.String(), "not_found") {
		t.Fatalf("the answer does not name the unknown invitation: %s", refused.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused request reached the service: %v", service.calls)
	}
	for _, forbidden := range []string{"inv_0123456789", "kmoi1_owner_token", "inviterLabel"} {
		if strings.Contains(refused.Body.String(), forbidden) {
			t.Fatalf("the refusal leaked %q: %s", forbidden, refused.Body.String())
		}
	}

	// The preview without any owner credential is the ordinary refusal of
	// the cohort, and the service is never consulted.
	preview := cohortOwnerRequest(handler, http.MethodGet, "/v1/online/invitations/inv_0123456789",
		"token-outsider", "", "")
	if preview.Code != http.StatusForbidden {
		t.Fatalf("the preview without a proof status=%d body=%s", preview.Code, preview.Body.String())
	}
	if !strings.Contains(preview.Body.String(), "not_authorized") {
		t.Fatalf("the refusal does not name the refusal: %s", preview.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused preview reached the service: %v", service.calls)
	}
}

// TestTheCohortAnswersAWrongOwnerTokenLikeAnUnknownInvitation covers the
// answer of a proof that fails.
//
// A wrong owner token is answered exactly like an invitation that was never
// issued, so the answer never reveals whether the invitation exists.
func TestTheCohortAnswersAWrongOwnerTokenLikeAnUnknownInvitation(t *testing.T) {
	service := excludedOwnerService()
	handler := excludedOwnerHandler(service)

	// A wrong token is answered like an unknown invitation.
	wrong := cohortOwnerRequest(handler, http.MethodGet, "/v1/online/invitations/inv_0123456789",
		"token-stranger", "kmoi1_wrong_token", "")
	if wrong.Code != http.StatusNotFound {
		t.Fatalf("the preview with a wrong token status=%d body=%s", wrong.Code, wrong.Body.String())
	}
	if !strings.Contains(wrong.Body.String(), "not_found") {
		t.Fatalf("the answer does not name the unknown invitation: %s", wrong.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused preview reached the service: %v", service.calls)
	}
	if len(service.proofs) == 0 {
		t.Fatal("the route did not ask for the proof of the ownership")
	}

	// The token of another invitation is no proof of this one.
	other := cohortOwnerRequest(handler, http.MethodGet, "/v1/online/invitations/inv_9999999999",
		"token-stranger", "kmoi1_owner_token", "")
	if other.Code != http.StatusNotFound {
		t.Fatalf("the preview with the token of another invitation status=%d body=%s", other.Code, other.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused preview reached the service: %v", service.calls)
	}
}

// TestTheCohortNeverWidensTheExcludedAccount covers the routes that the
// proof never reaches.
//
// The proof covers the cancellation and the preview of the invitation of the
// request. It never covers the creation of an invitation, the acceptance of
// somebody else's challenge, or the reading of the state of a challenge of
// somebody else.
func TestTheCohortNeverWidensTheExcludedAccount(t *testing.T) {
	service := excludedOwnerService()
	service.invitation.Kind = invite.KindChallenge
	handler := excludedOwnerHandler(service)

	// The creation of an invitation stays refused.
	created := cohortOwnerRequest(handler, http.MethodPost, "/v1/online/invitations",
		"token-stranger", "kmoi1_owner_token", createLinkBody)
	if created.Code != http.StatusForbidden {
		t.Fatalf("the creation of an excluded account status=%d body=%s", created.Code, created.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused creation reached the service: %v", service.calls)
	}

	// The acceptance of a challenge stays refused.
	accepted := cohortOwnerRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/accept",
		"token-stranger", "kmoi1_owner_token",
		`{"schemaVersion":2,"acceptanceKey":"ak_0123456789abcdef","control":{"kind":"human"}}`)
	if accepted.Code != http.StatusForbidden {
		t.Fatalf("the acceptance of an excluded account status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused acceptance reached the service: %v", service.calls)
	}

	// The seat credential of the surface stays refused, because the proof
	// of the ownership covers the cancellation and the preview alone.
	seat := cohortOwnerRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/seat-credential",
		"token-stranger", "kmoi1_owner_token", `{"schemaVersion":2}`)
	if seat.Code != http.StatusForbidden {
		t.Fatalf("the seat credential of an excluded account status=%d body=%s", seat.Code, seat.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused seat credential reached the service: %v", service.calls)
	}
}

// friendsServiceWithoutProof is a friends service that cannot prove the
// ownership of an invitation.
//
// The wrapper carries the interface of the service, so it has exactly the
// methods of the surface and none of the optional capabilities.
type friendsServiceWithoutProof struct {
	FriendsService
}

// TestTheCohortFailsClosedWithoutTheOwnershipProof covers a service that
// cannot prove the ownership.
//
// The capability is optional, and a service without it fails closed: the
// excluded account is refused and the service is never consulted.
func TestTheCohortFailsClosedWithoutTheOwnershipProof(t *testing.T) {
	service := excludedOwnerService()
	handler := excludedOwnerHandler(&friendsServiceWithoutProof{FriendsService: service})

	cancelled := cohortOwnerRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/cancel",
		"token-stranger", "kmoi1_owner_token", `{"schemaVersion":2}`)
	if cancelled.Code != http.StatusForbidden {
		t.Fatalf("the cancellation without a proof capability status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused cancellation reached the service: %v", service.calls)
	}
}

// TestTheCohortNeverRefusesTheGuestOwner covers the guest rule of the owner
// recovery.
//
// A guest is never excluded by a cohort, so the guest that holds the owner
// token keeps the cancellation of the invitation it owns.
func TestTheCohortNeverRefusesTheGuestOwner(t *testing.T) {
	service := excludedOwnerService()
	handler := excludedOwnerHandler(service)

	cancelled := cohortOwnerRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/cancel",
		"", "kmoi1_owner_token", `{"schemaVersion":2}`)
	if cancelled.Code != http.StatusOK {
		t.Fatalf("the cancellation of the guest owner status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	if service.cancel.OwnerToken != "kmoi1_owner_token" {
		t.Fatalf("the service saw the owner token %q of the cancellation", service.cancel.OwnerToken)
	}
}
