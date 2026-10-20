package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// friendStubAuthenticator resolves the test credentials. An account token is
// the account identifier and a guest token is the guest seat secret.
type friendStubAuthenticator struct {
	accounts map[string]onlineauth.Principal
}

func (s *friendStubAuthenticator) AuthenticateAccount(_ context.Context, token, origin string) (onlineauth.Principal, error) {
	principal, ok := s.accounts[token]
	if !ok || principal.Origin != origin {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	return principal, nil
}

func (s *friendStubAuthenticator) AuthenticateGuest(_ context.Context, secret, origin string) (onlineauth.Principal, error) {
	return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
}

// friendRequest sends one request to the friend handler.
func friendRequest(t *testing.T, handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", friendOrigin)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// TestPostgresFriendHTTPRoutesAndAnswers exercises the real friend routes
// against the real service.
func TestPostgresFriendHTTPRoutesAndAnswers(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	authenticator := &friendStubAuthenticator{accounts: map[string]onlineauth.Principal{
		"user_inviter":   accountPrincipal("user_inviter", "session_inviter"),
		"user_recipient": accountPrincipal("user_recipient", "session_recipient"),
		"user_stranger":  accountPrincipal("user_stranger", "session_stranger"),
	}}
	handler := httpapi.NewFriends(fixture.friends, fixture.service, authenticator, httpapi.FriendsOptions{
		AllowedOrigins: []string{friendOrigin},
	})

	// A mutation without an explicit origin is refused.
	withoutOrigin := httptest.NewRequest(http.MethodPost, "/v1/online/invitations", strings.NewReader(`{"schemaVersion":2}`))
	withoutOrigin.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, withoutOrigin)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("mutation without an origin status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	// An account inviter creates a named challenge for another account.
	created := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations", "user_inviter",
		`{"schemaVersion":2,"kind":"challenge","recipientAccountId":"user_recipient","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":2000},"control":{"kind":"human"}}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var createdBody struct {
		SchemaVersion int `json:"schemaVersion"`
		Invitation    struct {
			InvitationID string             `json:"invitationId"`
			Kind         string             `json:"kind"`
			Status       string             `json:"status"`
			InviterLabel string             `json:"inviterLabel"`
			InviterSeat  string             `json:"inviterSeat"`
			TimeControl  online.TimeControl `json:"timeControl"`
		} `json:"invitation"`
		OwnerToken string `json:"ownerToken"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil {
		t.Fatal(err)
	}
	if createdBody.Invitation.InvitationID == "" || createdBody.OwnerToken == "" {
		t.Fatalf("the created invitation is incomplete: %+v", createdBody)
	}
	if createdBody.Invitation.InviterSeat != "white" || createdBody.Invitation.TimeControl.IncrementMs != 2000 {
		t.Fatalf("the created invitation lost the setup: %+v", createdBody.Invitation)
	}
	// The answer carries no participant reference and no credential.
	for _, forbidden := range []string{"participant", "ownerId", "guestId", "credential", "seatToken"} {
		if strings.Contains(strings.ToLower(created.Body.String()), strings.ToLower(forbidden)) {
			t.Fatalf("the created invitation leaked %q: %s", forbidden, created.Body.String())
		}
	}

	// A stranger may not preview a named challenge.
	stranger := friendRequest(t, handler, http.MethodGet, "/v1/online/invitations/"+createdBody.Invitation.InvitationID, "user_stranger", "")
	if stranger.Code != http.StatusNotFound {
		t.Fatalf("stranger preview status=%d body=%s", stranger.Code, stranger.Body.String())
	}
	// The recipient may preview it.
	preview := friendRequest(t, handler, http.MethodGet, "/v1/online/invitations/"+createdBody.Invitation.InvitationID, "user_recipient", "")
	if preview.Code != http.StatusOK {
		t.Fatalf("recipient preview status=%d body=%s", preview.Code, preview.Body.String())
	}

	// The recipient accepts the challenge and receives the live match view.
	accepted := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations/"+createdBody.Invitation.InvitationID+"/accept", "user_recipient",
		`{"schemaVersion":2,"acceptanceKey":"http-acceptance-key-0123456789","control":{"kind":"human"}}`)
	if accepted.Code != http.StatusOK {
		t.Fatalf("accept status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	var acceptedBody struct {
		SchemaVersion int `json:"schemaVersion"`
		Match         struct {
			MatchID string `json:"matchId"`
			Seats   []struct {
				Seat        string `json:"seat"`
				PublicLabel string `json:"publicLabel"`
			} `json:"seats"`
			YourSeat *string `json:"yourSeat"`
		} `json:"match"`
		Seat            string `json:"seat"`
		AcceptanceID    string `json:"acceptanceId"`
		GuestCredential *struct {
			Token string `json:"token"`
		} `json:"guestCredential"`
	}
	if err := json.Unmarshal(accepted.Body.Bytes(), &acceptedBody); err != nil {
		t.Fatal(err)
	}
	if acceptedBody.Match.MatchID == "" || acceptedBody.Seat != "black" {
		t.Fatalf("the acceptance answer is incomplete: %+v", acceptedBody)
	}
	if acceptedBody.Match.YourSeat == nil || *acceptedBody.Match.YourSeat != "black" {
		t.Fatalf("the live view does not name the seat of the acceptor: %+v", acceptedBody.Match.YourSeat)
	}
	if acceptedBody.GuestCredential != nil {
		t.Fatal("an account acceptor received a guest credential")
	}
	// The live view of the match carries no participant reference.
	if strings.Contains(accepted.Body.String(), "user_recipient") {
		t.Fatalf("the live view leaked the participant reference: %s", accepted.Body.String())
	}

	// The guest path answers a guest credential for a guest acceptor.
	link := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations", "",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if link.Code != http.StatusCreated {
		t.Fatalf("guest link status=%d body=%s", link.Code, link.Body.String())
	}
	var linkBody struct {
		Invitation struct {
			InvitationID string `json:"invitationId"`
			InviterLabel string `json:"inviterLabel"`
		} `json:"invitation"`
	}
	if err := json.Unmarshal(link.Body.Bytes(), &linkBody); err != nil {
		t.Fatal(err)
	}
	if linkBody.Invitation.InviterLabel != invite.GuestLabel {
		t.Fatalf("the anonymous inviter label = %q, want Guest", linkBody.Invitation.InviterLabel)
	}
	guestAccepted := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations/"+linkBody.Invitation.InvitationID+"/accept", "",
		`{"schemaVersion":2,"acceptanceKey":"http-guest-acceptance-0123456789","control":{"kind":"human"}}`)
	if guestAccepted.Code != http.StatusOK {
		t.Fatalf("guest accept status=%d body=%s", guestAccepted.Code, guestAccepted.Body.String())
	}
	var guestBody struct {
		GuestCredential *struct {
			GuestID string `json:"guestId"`
			Token   string `json:"token"`
			Seat    string `json:"seat"`
		} `json:"guestCredential"`
	}
	if err := json.Unmarshal(guestAccepted.Body.Bytes(), &guestBody); err != nil {
		t.Fatal(err)
	}
	if guestBody.GuestCredential == nil || guestBody.GuestCredential.Token == "" {
		t.Fatalf("the guest acceptance delivered no credential: %s", guestAccepted.Body.String())
	}
	if guestBody.GuestCredential.Seat != "black" {
		t.Fatalf("the guest credential seat = %q, want black", guestBody.GuestCredential.Seat)
	}
}

// TestPostgresFriendFeatureStateRoute answers the rollout state of the two
// online surfaces.
func TestPostgresFriendFeatureStateRoute(t *testing.T) {
	handler := httpapi.NewFeatures(httpapi.OnlineFeatures{Friends: true, Queue: false})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/online/features", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("features status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Friends bool `json:"friends"`
		Queue   bool `json:"queue"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Friends || body.Queue {
		t.Fatalf("the feature answer = %+v", body)
	}
	if strings.Contains(recorder.Body.String(), "apiBaseUrl") {
		t.Fatalf("the feature answer leaked a configuration value: %s", recorder.Body.String())
	}
}

// TestPostgresFriendInvitationTTLIsTwelveHours documents the lifetime of an
// invitation.
func TestPostgresFriendInvitationTTLIsTwelveHours(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	created, err := fixture.friends.Create(context.Background(), invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatal(err)
	}
	lifetime := created.Invitation.ExpiresAt.Sub(created.Invitation.CreatedAt)
	if lifetime != invite.InvitationTTL {
		t.Fatalf("the invitation lifetime = %s, want %s", lifetime, invite.InvitationTTL)
	}
	if invite.InvitationTTL != 12*time.Hour {
		t.Fatalf("the invitation lifetime constant = %s, want 12h", invite.InvitationTTL)
	}
}
