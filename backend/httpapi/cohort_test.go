package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/cohort"
	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// The cohort tests cover the request path of the account narrowing.
//
// A cohort is an allowlist of accounts. It narrows the accounts that may use
// a surface, it never narrows a guest, and it never reaches a match that
// already exists.

// cohortAuthenticator resolves the credentials of the cohort tests.
//
// The account token is the account identifier, so a test can name the account
// it plays.
func cohortAuthenticator() *stubAuthenticator {
	return &stubAuthenticator{
		account: map[string]onlineauth.Principal{
			"token-inviter":  accountParticipant("user_inviter"),
			"token-stranger": accountParticipant("user_stranger"),
			"token-queue":    accountParticipant("user_queue"),
			"token-outsider": accountParticipant("user_outsider"),
		},
		guest: map[string]onlineauth.Principal{
			"token-guest": guestParticipant("guest_0123456789", "match-1", online.SeatWhite),
		},
	}
}

// cohortRequest sends one request to a surface of the online API.
func cohortRequest(handler http.Handler, method, path, token, guestToken, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", testOrigin)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if guestToken != "" {
		request.Header.Set(GuestCredentialHeader, guestToken)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// createLinkBody is the body of one shareable link.
const createLinkBody = `{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`

// TestTheCohortRefusesAnExcludedAccountOnTheFriendSurface covers the
// narrowing of the friend surface.
//
// An account that the cohort does not name is refused before the request
// reaches the service, so the refusal never reveals whether an invitation
// exists.
func TestTheCohortRefusesAnExcludedAccountOnTheFriendSurface(t *testing.T) {
	service := &stubFriendsService{created: invite.Created{
		Invitation: invite.Invitation{InvitationID: "inv_0123456789", Kind: invite.KindLink, Status: invite.StatusOpen},
		OwnerToken: "kmoi1_owner_token",
	}}
	handler := NewFriends(service, &stubOnlineService{}, cohortAuthenticator(), FriendsOptions{
		AllowedOrigins: []string{testOrigin},
		Cohort:         cohort.Parse("user_inviter"),
	})

	// The named account creates a link.
	allowed := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", "token-inviter", "", createLinkBody)
	if allowed.Code != http.StatusCreated {
		t.Fatalf("the creation of a named account status=%d body=%s", allowed.Code, allowed.Body.String())
	}
	if service.create.Inviter == nil || service.create.Inviter.Participant.ID != "user_inviter" {
		t.Fatalf("the service saw another inviter: %+v", service.create.Inviter)
	}

	// The excluded account is refused and the service never sees it.
	service.calls = nil
	refused := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", "token-stranger", "", createLinkBody)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("the creation of an excluded account status=%d body=%s", refused.Code, refused.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused request reached the service: %v", service.calls)
	}
	// The refusal carries no state of the surface.
	for _, forbidden := range []string{"inv_0123456789", "kmoi1_owner_token", "invitation"} {
		if strings.Contains(refused.Body.String(), forbidden) {
			t.Fatalf("the refusal leaked %q: %s", forbidden, refused.Body.String())
		}
	}

	// The excluded account is refused on a read as well, so it cannot learn
	// that an invitation exists.
	preview := cohortRequest(handler, http.MethodGet, "/v1/online/invitations/inv_0123456789", "token-stranger", "", "")
	if preview.Code != http.StatusForbidden {
		t.Fatalf("the preview of an excluded account status=%d body=%s", preview.Code, preview.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused preview reached the service: %v", service.calls)
	}
}

// TestTheCohortNeverRefusesAGuestOnTheFriendSurface covers the guest rule.
//
// A guest has to be able to create a friend link, so no cohort may refuse a
// guest, and the anonymous inviter of a link is a guest as well.
func TestTheCohortNeverRefusesAGuestOnTheFriendSurface(t *testing.T) {
	service := &stubFriendsService{created: invite.Created{
		Invitation: invite.Invitation{InvitationID: "inv_0123456789", Kind: invite.KindLink, Status: invite.StatusOpen},
		OwnerToken: "kmoi1_owner_token",
	}}
	handler := NewFriends(service, &stubOnlineService{}, cohortAuthenticator(), FriendsOptions{
		AllowedOrigins: []string{testOrigin},
		Cohort:         cohort.Parse("user_inviter"),
	})

	// An anonymous guest creates a link.
	anonymous := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", "", "", createLinkBody)
	if anonymous.Code != http.StatusCreated {
		t.Fatalf("the creation of an anonymous guest status=%d body=%s", anonymous.Code, anonymous.Body.String())
	}
	if service.create.Inviter != nil {
		t.Fatalf("the anonymous guest was seated as an account: %+v", service.create.Inviter)
	}

	// A guest that holds a seat credential creates a link.
	service.calls = nil
	guest := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", "", "token-guest", createLinkBody)
	if guest.Code != http.StatusCreated {
		t.Fatalf("the creation of a guest status=%d body=%s", guest.Code, guest.Body.String())
	}
	if service.create.Inviter == nil || service.create.Inviter.Participant.Kind != online.ParticipantGuest {
		t.Fatalf("the guest was not seated as a guest: %+v", service.create.Inviter)
	}
}

// TestTheCohortAdmitsEveryAccountWhenItIsEmpty covers the default.
//
// An empty cohort is the default of the server configuration, and it admits
// every signed-in account.
func TestTheCohortAdmitsEveryAccountWhenItIsEmpty(t *testing.T) {
	service := &stubFriendsService{created: invite.Created{
		Invitation: invite.Invitation{InvitationID: "inv_0123456789", Kind: invite.KindLink, Status: invite.StatusOpen},
		OwnerToken: "kmoi1_owner_token",
	}}
	handler := NewFriends(service, &stubOnlineService{}, cohortAuthenticator(), FriendsOptions{
		AllowedOrigins: []string{testOrigin},
		Cohort:         cohort.Parse(""),
	})
	created := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", "token-stranger", "", createLinkBody)
	if created.Code != http.StatusCreated {
		t.Fatalf("the creation with an empty cohort status=%d body=%s", created.Code, created.Body.String())
	}
}

// TestTheCohortRefusesAnExcludedAccountOnTheQueueSurface covers the
// narrowing of the public queue.
//
// The queue is account-only, so the cohort narrows exactly the accounts that
// may enter it.
func TestTheCohortRefusesAnExcludedAccountOnTheQueueSurface(t *testing.T) {
	service := &stubQueueService{created: true}
	handler := NewQueue(service, cohortAuthenticator(), QueueOptions{
		AllowedOrigins: []string{testOrigin},
		Cohort:         cohort.Parse("user_queue"),
	})
	body := `{"schemaVersion":2,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":0}}`

	// The named account enters the queue.
	allowed := cohortRequest(handler, http.MethodPost, "/v1/online/queue/entries", "token-queue", "", body)
	if allowed.Code != http.StatusCreated {
		t.Fatalf("the entry of a named account status=%d body=%s", allowed.Code, allowed.Body.String())
	}

	// The excluded account is refused and the service never sees it.
	service.calls = nil
	refused := cohortRequest(handler, http.MethodPost, "/v1/online/queue/entries", "token-outsider", "", body)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("the entry of an excluded account status=%d body=%s", refused.Code, refused.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused request reached the service: %v", service.calls)
	}
	for _, forbidden := range []string{"entryId", "qe_entry0001", "cutoffAt"} {
		if strings.Contains(refused.Body.String(), forbidden) {
			t.Fatalf("the refusal leaked %q: %s", forbidden, refused.Body.String())
		}
	}
}

// cohortStubOnlineService is the online service of the match surface.
//
// It records the participant of a read, so the test can prove that the
// participant surface still serves a match that already exists.
type cohortStubOnlineService struct {
	match    online.Match
	readKind online.ParticipantKind
	readID   string
}

func (s *cohortStubOnlineService) Execute(context.Context, online.ParticipantRef, online.Command) (online.CommandResult, error) {
	return online.CommandResult{}, nil
}

func (s *cohortStubOnlineService) GetMatchForParticipant(_ context.Context, _ string, participant online.ParticipantRef) (online.Match, error) {
	s.readKind = participant.Kind
	s.readID = participant.ID
	return s.match, nil
}

func (s *cohortStubOnlineService) GetReceiptForParticipant(context.Context, string, string, online.ParticipantRef) (online.CommandResult, error) {
	return online.CommandResult{}, nil
}

func (s *cohortStubOnlineService) GetPublicProjection(context.Context, string) (online.PublicProjection, error) {
	return online.PublicProjection{}, nil
}

// TestTheCohortNeverNarrowsAnExistingMatch covers the surviving match.
//
// A cohort narrows the access to a surface. It does not reach a match that
// already exists: the participant surface keeps serving the match of an
// account that the cohort does not name, so a narrowing never invalidates a
// running game.
func TestTheCohortNeverNarrowsAnExistingMatch(t *testing.T) {
	service := &cohortStubOnlineService{match: online.Match{
		MatchID:     "match-1",
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Seats: []online.MatchSeat{
			{Seat: online.SeatWhite, Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_outsider"}, PublicLabel: "Player"},
		},
		Version: 1,
	}}
	handler := NewOnline(service, cohortAuthenticator(), OnlineOptions{AllowedOrigins: []string{testOrigin}})
	live := cohortRequest(handler, http.MethodGet, "/v1/online/matches/match-1", "token-outsider", "", "")
	if live.Code != http.StatusOK {
		t.Fatalf("the live match of an excluded account status=%d body=%s", live.Code, live.Body.String())
	}
	if service.readKind != online.ParticipantAccount || service.readID != "user_outsider" {
		t.Fatalf("the match was read for another participant: %s/%s", service.readKind, service.readID)
	}
}

// The refusal of the cohort keeps the vocabulary of the surface.
func TestTheCohortRefusalUsesTheNotAuthorizedAnswer(t *testing.T) {
	service := &stubFriendsService{}
	handler := NewFriends(service, &stubOnlineService{}, cohortAuthenticator(), FriendsOptions{
		AllowedOrigins: []string{testOrigin},
		Cohort:         cohort.Parse("user_inviter"),
	})
	refused := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", "token-stranger", "", createLinkBody)
	if !strings.Contains(refused.Body.String(), "not_authorized") {
		t.Fatalf("the refusal does not name the refusal: %s", refused.Body.String())
	}
	// The answer carries no timestamp of the surface and no state of it.
	if refused.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("the refusal is not the answer of the surface: %q", refused.Header().Get("Content-Type"))
	}
}

// An authorizer that cannot answer fails closed.
func TestTheCohortFailsClosedWhenTheAuthorizerFails(t *testing.T) {
	service := &stubFriendsService{}
	handler := NewFriends(service, &stubOnlineService{}, cohortAuthenticator(), FriendsOptions{
		AllowedOrigins: []string{testOrigin},
		Cohort:         failingAuthorizer{},
	})
	refused := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", "token-inviter", "", createLinkBody)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("the refusal of a failing authorizer status=%d body=%s", refused.Code, refused.Body.String())
	}
}

// failingAuthorizer refuses every account.
type failingAuthorizer struct{}

func (failingAuthorizer) AccountAllowed(context.Context, online.ParticipantRef) (bool, error) {
	return false, context.DeadlineExceeded
}

// The queue answers an excluded account with the same refusal as the friend
// surface.
func TestTheCohortRefusalOfTheQueueUsesTheSameAnswer(t *testing.T) {
	service := &stubQueueService{created: true}
	handler := NewQueue(service, cohortAuthenticator(), QueueOptions{
		AllowedOrigins: []string{testOrigin},
		Cohort:         cohort.Parse("user_queue"),
	})
	refused := cohortRequest(handler, http.MethodPost, "/v1/online/queue/entries", "token-outsider", "",
		`{"schemaVersion":2,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":0}}`)
	if !strings.Contains(refused.Body.String(), "not_authorized") {
		t.Fatalf("the refusal does not name the refusal: %s", refused.Body.String())
	}
}
