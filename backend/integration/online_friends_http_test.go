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
	// The public profile publishes the public name of the recipient. The
	// account subject of the recipient stays private.
	if _, err := fixture.pool.Exec(context.Background(),
		`INSERT INTO online_public_profiles(profile_id,account_id,username,username_key) VALUES($1,$2,$3,$4)`,
		"kp_recipient_profile_0001", "user_recipient", "recipient_name", "recipient_name"); err != nil {
		t.Fatalf("publish the public profile of the recipient: %v", err)
	}
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

	// An account inviter creates a named challenge for the public name of
	// another account.
	created := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations", "user_inviter",
		`{"schemaVersion":2,"kind":"challenge","recipientUsername":"recipient_name","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":2000},"control":{"kind":"human"}}`)
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
	// The answer never names the account of the recipient. The public
	// request carried its public name and the service resolved it.
	if strings.Contains(created.Body.String(), "user_recipient") {
		t.Fatalf("the created invitation leaked the account of the recipient: %s", created.Body.String())
	}

	// A request that names an account subject is refused: the public
	// request of a challenge carries a public name only.
	bySubject := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations", "user_inviter",
		`{"schemaVersion":2,"kind":"challenge","recipientAccountId":"user_recipient","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":2000},"control":{"kind":"human"}}`)
	if bySubject.Code != http.StatusBadRequest {
		t.Fatalf("the challenge of an account subject status=%d body=%s", bySubject.Code, bySubject.Body.String())
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
	// The inviter may preview it with the owner token of the invitation.
	// The token travels in the private header of the surface, so the
	// challenge never has to be published.
	ownerPreview := friendOwnerRequest(t, handler, http.MethodGet, "/v1/online/invitations/"+createdBody.Invitation.InvitationID, createdBody.OwnerToken, "")
	if ownerPreview.Code != http.StatusOK {
		t.Fatalf("owner preview status=%d body=%s", ownerPreview.Code, ownerPreview.Body.String())
	}
	// A wrong owner token learns nothing about the challenge.
	wrongToken := friendOwnerRequest(t, handler, http.MethodGet, "/v1/online/invitations/"+createdBody.Invitation.InvitationID, "kmoi1_not_the_owner_token", "")
	if wrongToken.Code != http.StatusNotFound {
		t.Fatalf("wrong owner token preview status=%d body=%s", wrongToken.Code, wrongToken.Body.String())
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

// TestPostgresFriendNamedChallengeNeedsAnAccount covers the authority of a
// named challenge at the HTTP surface.
//
// A shareable link is a bearer secret, and a guest may create one. A named
// challenge names an account, so only an account may create it. The service
// decides that, so the rule holds for a caller that did not come from the
// browser of the product.
func TestPostgresFriendNamedChallengeNeedsAnAccount(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	friendProfileRow(t, fixture, "kp_recipient_profile_0002", "user_recipient", "recipient_name")
	handler, _ := friendGuestHandler(t, fixture)
	challenge := `{"schemaVersion":2,"kind":"challenge","recipientUsername":"recipient_name","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`
	link := `{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`

	// An anonymous caller may not create a named challenge.
	anonymous := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations", "", challenge)
	if anonymous.Code != http.StatusForbidden {
		t.Fatalf("the challenge of an anonymous caller status=%d body=%s", anonymous.Code, anonymous.Body.String())
	}
	// The refusal is the same refusal for a named recipient that no account
	// owns, so it never reveals whether the recipient exists.
	unknown := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations", "",
		`{"schemaVersion":2,"kind":"challenge","recipientUsername":"nobody_owns_this_name","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if unknown.Code != anonymous.Code {
		t.Fatalf("the challenge of an unknown name status=%d, want %d", unknown.Code, anonymous.Code)
	}

	// A guest that holds a seat credential may not create a named challenge
	// either. The credential is a real one: the guest accepts a shareable
	// link first and keeps the credential of the seat.
	guestToken := friendGuestSeatToken(t, handler)
	refused := friendGuestRequest(t, handler, http.MethodPost, "/v1/online/invitations", guestToken, challenge)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("the challenge of a guest status=%d body=%s", refused.Code, refused.Body.String())
	}
	// The refused challenges wrote no invitation.
	var challenges int
	if err := fixture.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM online_friend_invitations WHERE kind='challenge'`).Scan(&challenges); err != nil {
		t.Fatal(err)
	}
	if challenges != 0 {
		t.Fatalf("the refused challenges wrote %d invitations", challenges)
	}
	// A guest may still create a shareable link.
	guestLink := friendGuestRequest(t, handler, http.MethodPost, "/v1/online/invitations", guestToken, link)
	if guestLink.Code != http.StatusCreated {
		t.Fatalf("the link of a guest status=%d body=%s", guestLink.Code, guestLink.Body.String())
	}
	// An account may still create a named challenge.
	accountChallenge := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations", "user_inviter", challenge)
	if accountChallenge.Code != http.StatusCreated {
		t.Fatalf("the challenge of an account status=%d body=%s", accountChallenge.Code, accountChallenge.Body.String())
	}
	var stored string
	if err := fixture.pool.QueryRow(context.Background(),
		`SELECT kind FROM online_friend_invitations WHERE invitation_id=$1`,
		invitationIDOf(t, accountChallenge.Body.Bytes())).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != string(invite.KindChallenge) {
		t.Fatalf("the stored kind = %q, want a challenge", stored)
	}
}

// friendGuestSeatToken returns the guest seat credential of a real guest.
//
// The guest accepts a shareable link and keeps the credential of its seat, so
// the guest paths of the surface run with a credential the credential service
// issued.
func friendGuestSeatToken(t *testing.T, handler http.Handler) string {
	t.Helper()
	created := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations", "",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("the link of a guest status=%d body=%s", created.Code, created.Body.String())
	}
	accepted := friendRequest(t, handler, http.MethodPost,
		"/v1/online/invitations/"+invitationIDOf(t, created.Body.Bytes())+"/accept", "",
		`{"schemaVersion":2,"acceptanceKey":"challenge-authority-acceptance-0123456789","control":{"kind":"human"}}`)
	if accepted.Code != http.StatusOK {
		t.Fatalf("the acceptance of a guest status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	var answer struct {
		GuestCredential *struct {
			Token string `json:"token"`
		} `json:"guestCredential"`
	}
	if err := json.Unmarshal(accepted.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.GuestCredential == nil || answer.GuestCredential.Token == "" {
		t.Fatalf("the guest acceptance delivered no credential: %s", accepted.Body.String())
	}
	return answer.GuestCredential.Token
}

// invitationIDOf reads the identifier of a created invitation from an answer.
func invitationIDOf(t *testing.T, body []byte) string {
	t.Helper()
	var answer struct {
		Invitation struct {
			InvitationID string `json:"invitationId"`
		} `json:"invitation"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Invitation.InvitationID == "" {
		t.Fatalf("the answer carries no invitation: %s", body)
	}
	return answer.Invitation.InvitationID
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

// TestPostgresFriendOwnerTokenTravelsInThePrivateHeader covers the wire of
// the owner token.
//
// The token travels in the dedicated private header of the surface. A request
// that carries it in the body is refused, so the token never becomes part of
// a body that a proxy may record.
func TestPostgresFriendOwnerTokenTravelsInThePrivateHeader(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	authenticator := &friendStubAuthenticator{accounts: map[string]onlineauth.Principal{
		"user_inviter": accountPrincipal("user_inviter", "session_inviter"),
	}}
	handler := httpapi.NewFriends(fixture.friends, fixture.service, authenticator, httpapi.FriendsOptions{
		AllowedOrigins: []string{friendOrigin},
	})
	created, err := fixture.friends.Create(context.Background(), invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatal(err)
	}

	// A body that carries the owner token is refused.
	inBody := friendRequest(t, handler, http.MethodPost, "/v1/online/invitations/"+created.Invitation.InvitationID+"/cancel", "user_inviter",
		`{"schemaVersion":2,"ownerToken":"`+created.OwnerToken+`"}`)
	if inBody.Code != http.StatusBadRequest {
		t.Fatalf("the cancellation with an owner token in the body status=%d body=%s", inBody.Code, inBody.Body.String())
	}
	if strings.Contains(inBody.Body.String(), created.OwnerToken) {
		t.Fatalf("the refused request echoed the owner token: %s", inBody.Body.String())
	}

	// The header authorizes the cancellation of the inviter.
	cancelled := friendOwnerRequest(t, handler, http.MethodPost, "/v1/online/invitations/"+created.Invitation.InvitationID+"/cancel", created.OwnerToken, `{"schemaVersion":2}`)
	if cancelled.Code != http.StatusOK {
		t.Fatalf("the cancellation with the owner token header status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	if strings.Contains(cancelled.Body.String(), created.OwnerToken) {
		t.Fatalf("the answer echoed the owner token: %s", cancelled.Body.String())
	}
	var answer struct {
		Status string `json:"status"`
	}
	if err = json.Unmarshal(cancelled.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Status != string(invite.StatusCancelled) {
		t.Fatalf("the cancelled status = %q, want cancelled", answer.Status)
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
