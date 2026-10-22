package integration

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// The hidden challenge fixtures cover the privacy of a named challenge on the
// routes that answer the state of an invitation.
//
// A named challenge is visible to its named recipient and to its inviter. A
// caller that is neither of them may not learn that the challenge exists, so
// the challenge answers exactly like an invitation that was never issued: its
// status, its public view, its expiry and its conflicts stay private.
//
// Nothing here is a memory double: the real invitation service, the real
// online writer and the real guest credential allocator run against a real
// PostgreSQL database.

// friendHiddenChallengeInStatus creates a named challenge for the named
// recipient and puts it into the named status.
//
// The status is reached the way the service reaches it: the cancellation is
// the cancellation of the inviter, the expiry is the deadline that passed and
// the consumption is the acceptance of the named recipient.
func friendHiddenChallengeInStatus(t *testing.T, fixture *friendFixture, status invite.Status) invite.Created {
	t.Helper()
	ctx := context.Background()
	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Kind:               invite.KindChallenge,
		Inviter:            friendIdentity("user_inviter", "Alice"),
		RecipientAccountID: "user_recipient",
		Seat:               online.SeatWhite,
		TimeControl:        online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:            online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create the named challenge: %v", err)
	}
	switch status {
	case invite.StatusOpen:
	case invite.StatusCancelled:
		if _, err = fixture.friends.Cancel(ctx, invite.CancelRequest{
			InvitationID: created.Invitation.InvitationID,
			OwnerToken:   created.OwnerToken,
		}); err != nil {
			t.Fatalf("cancel the named challenge: %v", err)
		}
	case invite.StatusExpired:
		if _, err = fixture.pool.Exec(ctx,
			`UPDATE online_friend_invitations SET created_at=clock_timestamp()-interval '13 hours', expires_at=clock_timestamp()-interval '1 hour' WHERE invitation_id=$1`,
			created.Invitation.InvitationID); err != nil {
			t.Fatalf("expire the named challenge: %v", err)
		}
	case invite.StatusConsumed:
		if _, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
			InvitationID:  created.Invitation.InvitationID,
			AcceptanceKey: acceptanceKey("hidden-challenge-" + string(status)),
			Acceptor:      friendIdentity("user_recipient", "Recipient"),
			Control:       online.SeatControl{Kind: online.ControlHuman},
			Origin:        friendOrigin,
		}); err != nil {
			t.Fatalf("accept the named challenge: %v", err)
		}
	default:
		t.Fatalf("the unknown status %q", status)
	}
	return created
}

// friendHiddenStatuses are the statuses a named challenge may hold.
//
// Every status is a different answer of the state dependent routes, so every
// status is a different way to leak the existence of the challenge.
var friendHiddenStatuses = []invite.Status{
	invite.StatusOpen,
	invite.StatusCancelled,
	invite.StatusExpired,
	invite.StatusConsumed,
}

// TestPostgresFriendHiddenNamedChallengeAnswersLikeAnUnknownInvitation
// covers the privacy of a named challenge in the service.
//
// The cancellation and the seat credential of a challenge that the caller may
// not see are answered exactly like the same request of an invitation that was
// never issued. The answer never carries the status of the challenge, its
// public view, its expiry or its conflict.
func TestPostgresFriendHiddenNamedChallengeAnswersLikeAnUnknownInvitation(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	const unknownInvitation = "inv_never_issued_0001"

	for _, status := range friendHiddenStatuses {
		t.Run(string(status), func(t *testing.T) {
			created := friendHiddenChallengeInStatus(t, fixture, status)
			invitationID := created.Invitation.InvitationID

			// The unknown invitation is the reference of the answer.
			if _, err := fixture.friends.Cancel(ctx, invite.CancelRequest{InvitationID: unknownInvitation}); !errors.Is(err, invite.ErrNotFound) {
				t.Fatalf("the cancellation of an unknown invitation = %v, want ErrNotFound", err)
			}
			if _, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{InvitationID: unknownInvitation}); !errors.Is(err, invite.ErrNotFound) {
				t.Fatalf("the seat credential of an unknown invitation = %v, want ErrNotFound", err)
			}

			for _, caller := range []struct {
				name   string
				viewer *invite.Identity
			}{
				{name: "an anonymous caller", viewer: nil},
				{name: "an unrelated account", viewer: friendIdentity("user_stranger", "Stranger")},
			} {
				answer, err := fixture.friends.Cancel(ctx, invite.CancelRequest{
					InvitationID: invitationID,
					Canceller:    caller.viewer,
				})
				if !errors.Is(err, invite.ErrNotFound) {
					t.Fatalf("the cancellation of a hidden challenge by %s = %v, want ErrNotFound", caller.name, err)
				}
				// The answer carries no part of the challenge.
				if answer != (invite.Invitation{}) {
					t.Fatalf("the cancellation of a hidden challenge by %s answered %+v", caller.name, answer)
				}
				seat, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
					InvitationID: invitationID,
					Viewer:       caller.viewer,
				})
				if !errors.Is(err, invite.ErrNotFound) {
					t.Fatalf("the seat credential of a hidden challenge by %s = %v, want ErrNotFound", caller.name, err)
				}
				// The answer carries no match and no seat of the challenge.
				if seat != (invite.SeatCredentialResult{}) {
					t.Fatalf("the seat credential of a hidden challenge by %s answered %+v", caller.name, seat)
				}
				// The acceptance of a hidden challenge is refused the same
				// way, so every route of the surface answers alike.
				if _, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
					InvitationID:  invitationID,
					AcceptanceKey: acceptanceKey("hidden-accept-" + strings.ReplaceAll(caller.name, " ", "-")),
					Acceptor:      caller.viewer,
					Control:       online.SeatControl{Kind: online.ControlHuman},
					Origin:        friendOrigin,
				}); !errors.Is(err, invite.ErrNotFound) {
					t.Fatalf("the acceptance of a hidden challenge by %s = %v, want ErrNotFound", caller.name, err)
				}
			}

			// The named recipient still sees its own challenge, in every
			// status of the challenge.
			preview, err := fixture.friends.Get(ctx, invite.ViewRequest{
				InvitationID:    invitationID,
				ViewerAccountID: "user_recipient",
			})
			if err != nil {
				t.Fatalf("the preview of the named recipient = %v, want the challenge", err)
			}
			if preview.Status != status {
				t.Fatalf("the status of the challenge = %q, want %q", preview.Status, status)
			}

			// The inviter keeps its own answer: the cancellation of the
			// owner stays state dependent, because the owner may see the
			// challenge.
			switch status {
			case invite.StatusOpen:
				cancelled, err := fixture.friends.Cancel(ctx, invite.CancelRequest{
					InvitationID: invitationID,
					OwnerToken:   created.OwnerToken,
				})
				if err != nil {
					t.Fatalf("the cancellation of the inviter = %v, want the cancelled challenge", err)
				}
				if cancelled.Status != invite.StatusCancelled {
					t.Fatalf("the cancelled status = %q, want cancelled", cancelled.Status)
				}
			case invite.StatusCancelled:
				cancelled, err := fixture.friends.Cancel(ctx, invite.CancelRequest{
					InvitationID: invitationID,
					OwnerToken:   created.OwnerToken,
				})
				if err != nil {
					t.Fatalf("the repeated cancellation of the inviter = %v, want the cancelled challenge", err)
				}
				if cancelled.Status != invite.StatusCancelled {
					t.Fatalf("the cancelled status = %q, want cancelled", cancelled.Status)
				}
			case invite.StatusExpired:
				if _, err = fixture.friends.Cancel(ctx, invite.CancelRequest{
					InvitationID: invitationID,
					OwnerToken:   created.OwnerToken,
				}); !errors.Is(err, invite.ErrExpired) {
					t.Fatalf("the cancellation of an expired challenge = %v, want ErrExpired", err)
				}
			case invite.StatusConsumed:
				if _, err = fixture.friends.Cancel(ctx, invite.CancelRequest{
					InvitationID: invitationID,
					OwnerToken:   created.OwnerToken,
				}); !errors.Is(err, invite.ErrConflict) {
					t.Fatalf("the cancellation of a consumed challenge = %v, want ErrConflict", err)
				}
				// The inviter claims the seat of its own match.
				seat, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
					InvitationID: invitationID,
					OwnerToken:   created.OwnerToken,
					Origin:       friendOrigin,
				})
				if err != nil {
					t.Fatalf("the seat credential of the inviter = %v, want the seat of its match", err)
				}
				if seat.MatchID == "" || seat.Seat == "" {
					t.Fatalf("the seat credential of the inviter answered %+v", seat)
				}
				// The named recipient may see the challenge, so it is
				// refused as a stranger and not as an unknown invitation.
				if _, err = fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
					InvitationID: invitationID,
					Viewer:       friendIdentity("user_recipient", "Recipient"),
				}); !errors.Is(err, invite.ErrNotAuthorized) {
					t.Fatalf("the seat credential of the named recipient = %v, want ErrNotAuthorized", err)
				}
			}
		})
	}
}

// TestPostgresFriendHiddenNamedChallengeAnswersNotFoundOnTheRoutes covers the
// privacy of a named challenge at the HTTP surface.
//
// The two routes that answer the state of an invitation answer a challenge
// that the caller may not see exactly like an invitation that was never
// issued: the same status, the same code and no detail of the challenge.
//
// The owner of the challenge keeps its own answer, so the fix never hides the
// challenge from the inviter and never hides it from the named recipient.
func TestPostgresFriendHiddenNamedChallengeAnswersNotFoundOnTheRoutes(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	friendProfileRow(t, fixture, "kp_hidden_profile_0001", "user_recipient", "recipient_name")
	authenticator := &friendStubAuthenticator{accounts: map[string]onlineauth.Principal{
		"user_inviter":   accountPrincipal("user_inviter", "session_inviter"),
		"user_recipient": accountPrincipal("user_recipient", "session_recipient"),
		"user_stranger":  accountPrincipal("user_stranger", "session_stranger"),
	}}
	handler := httpapi.NewFriends(fixture.friends, fixture.service, authenticator, httpapi.FriendsOptions{
		AllowedOrigins: []string{friendOrigin},
	})
	const unknownInvitation = "inv_never_issued_0001"

	for _, status := range friendHiddenStatuses {
		t.Run(string(status), func(t *testing.T) {
			created := friendHiddenChallengeInStatus(t, fixture, status)
			invitationID := created.Invitation.InvitationID

			// The unknown invitation is the reference of the answer.
			unknownCancel := friendRequest(t, handler, http.MethodPost,
				"/v1/online/invitations/"+unknownInvitation+"/cancel", "", `{"schemaVersion":2}`)
			if unknownCancel.Code != http.StatusNotFound {
				t.Fatalf("the cancellation of an unknown invitation status=%d body=%s", unknownCancel.Code, unknownCancel.Body.String())
			}
			unknownSeat := friendRequest(t, handler, http.MethodPost,
				"/v1/online/invitations/"+unknownInvitation+"/seat-credential", "", `{"schemaVersion":2}`)
			if unknownSeat.Code != http.StatusNotFound {
				t.Fatalf("the seat credential of an unknown invitation status=%d body=%s", unknownSeat.Code, unknownSeat.Body.String())
			}

			for _, caller := range []struct {
				name  string
				token string
			}{
				{name: "an anonymous caller", token: ""},
				{name: "an unrelated account", token: "user_stranger"},
			} {
				cancel := friendRequest(t, handler, http.MethodPost,
					"/v1/online/invitations/"+invitationID+"/cancel", caller.token, `{"schemaVersion":2}`)
				if cancel.Code != http.StatusNotFound {
					t.Fatalf("the cancellation of a hidden challenge by %s status=%d body=%s", caller.name, cancel.Code, cancel.Body.String())
				}
				if cancel.Body.String() != unknownCancel.Body.String() {
					t.Fatalf("the cancellation of a hidden challenge by %s answered %q, want the answer of an unknown invitation %q",
						caller.name, cancel.Body.String(), unknownCancel.Body.String())
				}
				friendAssertNoChallengeDetail(t, cancel.Body.String(), invitationID)

				seat := friendRequest(t, handler, http.MethodPost,
					"/v1/online/invitations/"+invitationID+"/seat-credential", caller.token, `{"schemaVersion":2}`)
				if seat.Code != http.StatusNotFound {
					t.Fatalf("the seat credential of a hidden challenge by %s status=%d body=%s", caller.name, seat.Code, seat.Body.String())
				}
				if seat.Body.String() != unknownSeat.Body.String() {
					t.Fatalf("the seat credential of a hidden challenge by %s answered %q, want the answer of an unknown invitation %q",
						caller.name, seat.Body.String(), unknownSeat.Body.String())
				}
				friendAssertNoChallengeDetail(t, seat.Body.String(), invitationID)
			}

			// The named recipient still previews its own challenge.
			preview := friendRequest(t, handler, http.MethodGet, "/v1/online/invitations/"+invitationID, "user_recipient", "")
			if preview.Code != http.StatusOK {
				t.Fatalf("the preview of the named recipient status=%d body=%s", preview.Code, preview.Body.String())
			}
			if !strings.Contains(preview.Body.String(), string(status)) {
				t.Fatalf("the preview of the named recipient lost the status: %s", preview.Body.String())
			}

			// The inviter keeps its own answer: the cancellation of the
			// owner stays state dependent.
			ownerCancel := friendOwnerRequest(t, handler, http.MethodPost,
				"/v1/online/invitations/"+invitationID+"/cancel", created.OwnerToken, `{"schemaVersion":2}`)
			switch status {
			case invite.StatusOpen, invite.StatusCancelled:
				if ownerCancel.Code != http.StatusOK {
					t.Fatalf("the cancellation of the inviter status=%d body=%s", ownerCancel.Code, ownerCancel.Body.String())
				}
			case invite.StatusExpired:
				if ownerCancel.Code != http.StatusGone {
					t.Fatalf("the cancellation of an expired challenge by the inviter status=%d body=%s", ownerCancel.Code, ownerCancel.Body.String())
				}
			case invite.StatusConsumed:
				if ownerCancel.Code != http.StatusConflict {
					t.Fatalf("the cancellation of a consumed challenge by the inviter status=%d body=%s", ownerCancel.Code, ownerCancel.Body.String())
				}
			}
		})
	}
}

// friendAssertNoChallengeDetail fails when an answer carries a detail of a
// challenge that the caller may not see.
//
// The answer of a hidden challenge is the answer of an unknown invitation, so
// it carries no identifier, no status, no clock, no position, no label of the
// inviter and no name of the recipient.
func friendAssertNoChallengeDetail(t *testing.T, body, invitationID string) {
	t.Helper()
	forbidden := []string{
		invitationID,
		"invitationId",
		"inviterLabel",
		"inviterSeat",
		"inviterControl",
		"timeControl",
		"startingFen",
		"matchId",
		"guestCredential",
		"Alice",
		"user_recipient",
		"user_inviter",
		string(invite.StatusOpen),
		string(invite.StatusCancelled),
		string(invite.StatusExpired),
		string(invite.StatusConsumed),
		"expired",
		"conflict",
	}
	for _, detail := range forbidden {
		if detail == "" {
			continue
		}
		if strings.Contains(strings.ToLower(body), strings.ToLower(detail)) {
			t.Fatalf("the answer of a hidden challenge carried %q: %s", detail, body)
		}
	}
}
