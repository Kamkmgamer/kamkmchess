package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// The friend wire fixtures cover the private parts of the transport.
//
// The owner token of an invitation travels in the dedicated private header of
// the surface, and the public request of a named challenge carries a public
// name. Neither of them ever reaches a body.

// stubFriendsService is the invitation service the HTTP layer talks to.
type stubFriendsService struct {
	invitation invite.Invitation
	created    invite.Created
	accepted   invite.Accepted
	err        error

	view      invite.ViewRequest
	create    invite.CreateRequest
	cancel    invite.CancelRequest
	seat      invite.SeatCredentialRequest
	accept    invite.AcceptRequest
	calls     []string
	ownerSeen string

	// ownerToken is the token that proves the ownership of the invitation.
	ownerToken string
	// ownerInvitationID is the invitation the owner token belongs to.
	ownerInvitationID string
	// ownerAccountID is the account that owns the invitation.
	ownerAccountID string
	// proofs records the ownership proofs the routes asked for.
	proofs []string
}

func (s *stubFriendsService) Create(_ context.Context, request invite.CreateRequest) (invite.Created, error) {
	s.create = request
	s.calls = append(s.calls, "create")
	return s.created, s.err
}

func (s *stubFriendsService) Get(_ context.Context, request invite.ViewRequest) (invite.Invitation, error) {
	s.view = request
	s.ownerSeen = request.OwnerToken
	s.calls = append(s.calls, "get")
	return s.invitation, s.err
}

func (s *stubFriendsService) Accept(_ context.Context, request invite.AcceptRequest) (invite.Accepted, error) {
	s.accept = request
	s.calls = append(s.calls, "accept")
	return s.accepted, s.err
}

func (s *stubFriendsService) Cancel(_ context.Context, request invite.CancelRequest) (invite.Invitation, error) {
	s.cancel = request
	s.calls = append(s.calls, "cancel")
	return s.invitation, s.err
}

func (s *stubFriendsService) SeatCredential(_ context.Context, request invite.SeatCredentialRequest) (invite.SeatCredentialResult, error) {
	s.seat = request
	s.calls = append(s.calls, "seat")
	return invite.SeatCredentialResult{MatchID: "match-1", Seat: online.SeatWhite}, s.err
}

func (s *stubFriendsService) RematchSeatCredential(context.Context, invite.RematchSeatCredentialRequest) (invite.SeatCredentialResult, error) {
	return invite.SeatCredentialResult{}, s.err
}

func (s *stubFriendsService) ProposeRematch(context.Context, invite.RematchRequest) (invite.Rematch, error) {
	return invite.Rematch{}, s.err
}

func (s *stubFriendsService) AcceptRematch(context.Context, invite.AcceptRematchRequest) (invite.RematchResult, error) {
	return invite.RematchResult{}, s.err
}

func (s *stubFriendsService) PendingRematch(context.Context, string, online.ParticipantRef) (invite.Rematch, bool, error) {
	return invite.Rematch{}, false, s.err
}

// OwnsInvitation proves the ownership of the invitation.
//
// The proof is the read-only counterpart of the cancellation: it answers
// whether the caller owns the invitation and it changes nothing.
func (s *stubFriendsService) OwnsInvitation(_ context.Context, invitationID, ownerToken string, owner *invite.Identity) bool {
	s.proofs = append(s.proofs, invitationID)
	if s.ownerInvitationID == "" || invitationID != s.ownerInvitationID {
		return false
	}
	if ownerToken != "" && ownerToken == s.ownerToken {
		return true
	}
	if owner != nil && owner.Participant.Kind == online.ParticipantAccount && owner.Participant.ID == s.ownerAccountID {
		return true
	}
	return false
}

// friendWireHandler composes the friend routes with the stubs.
func friendWireHandler(friends FriendsService) http.Handler {
	authenticator := &stubAuthenticator{account: map[string]onlineauth.Principal{
		"session": {Kind: online.ParticipantAccount, Subject: "user_inviter", Origin: testOrigin, Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}},
	}}
	return NewFriends(friends, &stubOnlineService{}, authenticator, FriendsOptions{AllowedOrigins: []string{testOrigin}})
}

// friendWireRequest sends one request to the friend routes.
func friendWireRequest(handler http.Handler, method, path, token, ownerToken, body string) *httptest.ResponseRecorder {
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

// TestTheFriendOwnerTokenTravelsInThePrivateHeader covers the wire of the
// owner token.
func TestTheFriendOwnerTokenTravelsInThePrivateHeader(t *testing.T) {
	service := &stubFriendsService{invitation: invite.Invitation{
		InvitationID: "inv_0123456789",
		Kind:         invite.KindChallenge,
		Status:       invite.StatusOpen,
		InviterLabel: "Alice",
		InviterSeat:  online.SeatWhite,
		TimeControl:  online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		ExpiresAt:    time.Unix(1_900_000_000, 0).UTC(),
		CreatedAt:    time.Unix(1_800_000_000, 0).UTC(),
	}}
	handler := friendWireHandler(service)

	// The preview of the inviter carries the token in the header.
	preview := friendWireRequest(handler, http.MethodGet, "/v1/online/invitations/inv_0123456789", "session", "kmoi1_owner_token", "")
	if preview.Code != http.StatusOK {
		t.Fatalf("the preview status=%d body=%s", preview.Code, preview.Body.String())
	}
	if service.ownerSeen != "kmoi1_owner_token" {
		t.Fatalf("the service saw the owner token %q, want the header value", service.ownerSeen)
	}
	if service.view.ViewerAccountID != "user_inviter" {
		t.Fatalf("the service saw the viewer %q, want the account of the session", service.view.ViewerAccountID)
	}

	// The cancellation of the inviter carries the token in the header.
	cancelled := friendWireRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/cancel", "session", "kmoi1_owner_token", `{"schemaVersion":2}`)
	if cancelled.Code != http.StatusOK {
		t.Fatalf("the cancellation status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	if service.cancel.OwnerToken != "kmoi1_owner_token" {
		t.Fatalf("the service saw the owner token %q of the cancellation", service.cancel.OwnerToken)
	}
	if strings.Contains(cancelled.Body.String(), "kmoi1_owner_token") {
		t.Fatalf("the answer echoed the owner token: %s", cancelled.Body.String())
	}

	// The seat credential of the inviter carries the token in the header.
	seat := friendWireRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/seat-credential", "session", "kmoi1_owner_token", `{"schemaVersion":2}`)
	if seat.Code != http.StatusOK {
		t.Fatalf("the seat credential status=%d body=%s", seat.Code, seat.Body.String())
	}
	if service.seat.OwnerToken != "kmoi1_owner_token" {
		t.Fatalf("the service saw the owner token %q of the seat credential", service.seat.OwnerToken)
	}
}

// TestTheFriendOwnerTokenNeverTravelsInABody covers the refusal of a request
// that carries the owner token in its body.
func TestTheFriendOwnerTokenNeverTravelsInABody(t *testing.T) {
	service := &stubFriendsService{}
	handler := friendWireHandler(service)
	refused := friendWireRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/cancel", "session", "",
		`{"schemaVersion":2,"ownerToken":"kmoi1_owner_token"}`)
	if refused.Code != http.StatusBadRequest {
		t.Fatalf("the cancellation with a body token status=%d body=%s", refused.Code, refused.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused request reached the service: %v", service.calls)
	}
	if strings.Contains(refused.Body.String(), "kmoi1_owner_token") {
		t.Fatalf("the refused request echoed the owner token: %s", refused.Body.String())
	}
}

// TestTheFriendRequestNeverNamesAnAccountSubject covers the public request of
// a named challenge.
func TestTheFriendRequestNeverNamesAnAccountSubject(t *testing.T) {
	service := &stubFriendsService{created: invite.Created{
		Invitation: invite.Invitation{
			InvitationID: "inv_0123456789",
			Kind:         invite.KindChallenge,
			Status:       invite.StatusOpen,
			InviterLabel: "Alice",
			InviterSeat:  online.SeatWhite,
			TimeControl:  online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
			ExpiresAt:    time.Unix(1_900_000_000, 0).UTC(),
			CreatedAt:    time.Unix(1_800_000_000, 0).UTC(),
		},
		OwnerToken: "kmoi1_owner_token",
	}}
	handler := friendWireHandler(service)
	created := friendWireRequest(handler, http.MethodPost, "/v1/online/invitations", "session", "",
		`{"schemaVersion":2,"kind":"challenge","recipientUsername":"recipient_name","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("the creation status=%d body=%s", created.Code, created.Body.String())
	}
	if service.create.RecipientUsername != "recipient_name" {
		t.Fatalf("the service saw the recipient name %q", service.create.RecipientUsername)
	}
	if service.create.RecipientAccountID != "" {
		t.Fatalf("the service saw the account subject %q of the recipient", service.create.RecipientAccountID)
	}
	// A request that names an account subject is refused before the service
	// sees it.
	refused := friendWireRequest(handler, http.MethodPost, "/v1/online/invitations", "session", "",
		`{"schemaVersion":2,"kind":"challenge","recipientAccountId":"user_recipient","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if refused.Code != http.StatusBadRequest {
		t.Fatalf("the creation with an account subject status=%d body=%s", refused.Code, refused.Body.String())
	}
}

// TestTheClosedFriendSurfaceRefusesTheCreationAndFinishesTheInvitation
// covers the rollback switch at the HTTP boundary.
//
// A closed surface refuses a new creation, and it still serves the
// acceptance of an invitation that was issued while it was open.
func TestTheClosedFriendSurfaceRefusesTheCreationAndFinishesTheInvitation(t *testing.T) {
	service := &stubFriendsService{err: invite.ErrDisabled}
	handler := friendWireHandler(service)
	created := friendWireRequest(handler, http.MethodPost, "/v1/online/invitations", "session", "",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if created.Code != http.StatusServiceUnavailable {
		t.Fatalf("the creation of a closed surface status=%d body=%s", created.Code, created.Body.String())
	}
	if strings.Contains(created.Body.String(), "ownerToken") {
		t.Fatalf("the refusal of a closed surface carried an owner token: %s", created.Body.String())
	}

	// The acceptance of an issued invitation is still served.
	service.err = nil
	service.accepted = invite.Accepted{AcceptanceID: "acc_1", MatchID: "match-1", Seat: online.SeatBlack}
	accepted := friendWireRequest(handler, http.MethodPost, "/v1/online/invitations/inv_0123456789/accept", "session", "",
		`{"schemaVersion":2,"acceptanceKey":"ak_0123456789abcdef","control":{"kind":"human"}}`)
	if accepted.Code != http.StatusOK {
		t.Fatalf("the acceptance of an issued invitation status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	if service.accept.InvitationID != "inv_0123456789" {
		t.Fatalf("the service saw the invitation %q", service.accept.InvitationID)
	}
}

// TestTheFriendRequestWithTwoOwnerTokensIsRefused covers the duplicate
// header.
//
// The server never has to choose which of two owner tokens wins.
func TestTheFriendRequestWithTwoOwnerTokensIsRefused(t *testing.T) {
	service := &stubFriendsService{}
	handler := friendWireHandler(service)
	request := httptest.NewRequest(http.MethodGet, "/v1/online/invitations/inv_0123456789", nil)
	request.Header.Set("Origin", testOrigin)
	request.Header.Add(OwnerTokenHeader, "kmoi1_first")
	request.Header.Add(OwnerTokenHeader, "kmoi1_second")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("the request with two owner tokens status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(service.calls) != 0 {
		t.Fatalf("the refused request reached the service: %v", service.calls)
	}
}

// TestTheOwnerTokenHeaderIsAllowedByTheOnlineSurface covers the CORS
// allowlist of the surface that carries the friend routes.
func TestTheOwnerTokenHeaderIsAllowedByTheOnlineSurface(t *testing.T) {
	found := false
	for _, header := range OnlineRequestHeaders {
		if header == OwnerTokenHeader {
			found = true
		}
	}
	if !found {
		t.Fatalf("the owner token header is not allowed: %v", OnlineRequestHeaders)
	}
}

// TestTheInviteErrorsKeepTheirStatus covers the status of the refusals of the
// surface.
func TestTheInviteErrorsKeepTheirStatus(t *testing.T) {
	cases := []struct {
		err    error
		status int
	}{
		{invite.ErrNotFound, http.StatusNotFound},
		{invite.ErrRecipientNotFound, http.StatusNotFound},
		{invite.ErrNotAuthorized, http.StatusForbidden},
		{invite.ErrDisabled, http.StatusServiceUnavailable},
		{invite.ErrInvalidContract, http.StatusBadRequest},
		{invite.ErrExpired, http.StatusGone},
		{invite.ErrConflict, http.StatusConflict},
	}
	for _, testCase := range cases {
		recorder := httptest.NewRecorder()
		writeInviteError(recorder, testCase.err)
		if recorder.Code != testCase.status {
			t.Fatalf("the status of %v = %d, want %d", testCase.err, recorder.Code, testCase.status)
		}
	}
	if !errors.Is(invite.ErrDisabled, invite.ErrDisabled) {
		t.Fatal("the closed surface error is not itself")
	}
}
