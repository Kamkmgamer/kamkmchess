package integration

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The friend privacy fixtures cover the private parts of the surface: the
// named recipient of a challenge, the owner read of a challenge and the
// rollback switch of the surface.
//
// Nothing here is a memory double: the real invitation service, the real
// online writer and the real guest credential allocator run against a real
// PostgreSQL database.

// friendProfileRow publishes the public name of an account.
//
// The public profile is the only place a public name lives. The account
// subject stays in the authorization tables and never reaches a public
// payload.
func friendProfileRow(t *testing.T, fixture *friendFixture, profileID, accountID, username string) {
	t.Helper()
	if _, err := fixture.pool.Exec(context.Background(),
		`INSERT INTO online_public_profiles(profile_id,account_id,username,username_key) VALUES($1,$2,$3,$4)`,
		profileID, accountID, username, strings.ToLower(username)); err != nil {
		t.Fatalf("publish the public profile of %s: %v", accountID, err)
	}
}

// TestPostgresFriendChallengeResolvesThePublicNameOfTheRecipient covers the
// named recipient of a challenge.
//
// The public request names a public name. The service resolves it to the
// account itself, so the account subject never crosses the boundary of the
// request and never reaches an answer.
func TestPostgresFriendChallengeResolvesThePublicNameOfTheRecipient(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	friendProfileRow(t, fixture, "kp_recipient_profile_0001", "user_recipient", "recipient_name")

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Kind:              invite.KindChallenge,
		Inviter:           friendIdentity("user_inviter", "Alice"),
		RecipientUsername: "Recipient_Name",
		Seat:              online.SeatBlack,
		TimeControl:       online.TimeControl{StartingTimeMs: 600_000, IncrementMs: 0},
		Control:           online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create the challenge of a public name: %v", err)
	}
	// The row names the account, not the public name.
	var recipient string
	if err = fixture.pool.QueryRow(ctx, `SELECT recipient_account_id FROM online_friend_invitations WHERE invitation_id=$1`,
		created.Invitation.InvitationID).Scan(&recipient); err != nil {
		t.Fatal(err)
	}
	if recipient != "user_recipient" {
		t.Fatalf("the stored recipient = %q, want the resolved account", recipient)
	}
	// The public name is the only recipient the request carried, and the
	// answer never names the account.
	if strings.Contains(strings.ToLower(created.Invitation.InvitationID), "recipient_name") {
		t.Fatal("the invitation identifier carries the public name")
	}
	// The public view of the invitation never names an account.
	preview, err := fixture.friends.Get(ctx, invite.ViewRequest{InvitationID: created.Invitation.InvitationID, ViewerAccountID: "user_recipient"})
	if err != nil {
		t.Fatalf("preview the challenge: %v", err)
	}
	if preview.InviterLabel != "Alice" {
		t.Fatalf("the inviter label = %q, want Alice", preview.InviterLabel)
	}

	// An unknown public name is refused, and the refusal never reveals
	// whether the account exists.
	if _, err = fixture.friends.Create(ctx, invite.CreateRequest{
		Kind:              invite.KindChallenge,
		Inviter:           friendIdentity("user_inviter", "Alice"),
		RecipientUsername: "nobody_owns_this_name",
		Seat:              online.SeatBlack,
		TimeControl:       online.TimeControl{StartingTimeMs: 600_000, IncrementMs: 0},
		Control:           online.SeatControl{Kind: online.ControlHuman},
	}); !errors.Is(err, invite.ErrRecipientNotFound) {
		t.Fatalf("the challenge of an unknown name = %v, want ErrRecipientNotFound", err)
	}

	// A shareable link names no recipient at all.
	if _, err = fixture.friends.Create(ctx, invite.CreateRequest{
		Kind:              invite.KindLink,
		Inviter:           friendIdentity("user_inviter", "Alice"),
		RecipientUsername: "recipient_name",
		Seat:              online.SeatBlack,
		TimeControl:       online.TimeControl{StartingTimeMs: 600_000, IncrementMs: 0},
		Control:           online.SeatControl{Kind: online.ControlHuman},
	}); !errors.Is(err, invite.ErrInvalidContract) {
		t.Fatalf("the link of a named recipient = %v, want ErrInvalidContract", err)
	}
}

// TestPostgresFriendOwnerTokenReadsItsOwnChallenge covers the private read of
// a named challenge.
//
// A challenge is visible to its named recipient and to its inviter. The
// inviter proves the ownership with the owner token, so the challenge never
// has to be published and its status is never public.
func TestPostgresFriendOwnerTokenReadsItsOwnChallenge(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Kind:               invite.KindChallenge,
		Inviter:            friendIdentity("user_inviter", "Alice"),
		RecipientAccountID: "user_recipient",
		Seat:               online.SeatBlack,
		TimeControl:        online.TimeControl{StartingTimeMs: 600_000, IncrementMs: 0},
		Control:            online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create the challenge: %v", err)
	}

	// A stranger learns nothing about the challenge.
	if _, err = fixture.friends.Get(ctx, invite.ViewRequest{InvitationID: created.Invitation.InvitationID, ViewerAccountID: "user_stranger"}); !errors.Is(err, invite.ErrNotFound) {
		t.Fatalf("the preview of a stranger = %v, want ErrNotFound", err)
	}
	// A wrong owner token learns nothing about the challenge either.
	if _, err = fixture.friends.Get(ctx, invite.ViewRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   "kmoi1_not_the_owner_token",
	}); !errors.Is(err, invite.ErrNotFound) {
		t.Fatalf("the preview of a wrong owner token = %v, want ErrNotFound", err)
	}
	// The inviter reads its own challenge with the owner token.
	own, err := fixture.friends.Get(ctx, invite.ViewRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
	})
	if err != nil {
		t.Fatalf("the preview of the inviter = %v, want the invitation", err)
	}
	if own.Status != invite.StatusOpen || own.InvitationID != created.Invitation.InvitationID {
		t.Fatalf("the preview of the inviter = %+v", own)
	}
	// The named recipient reads the challenge with its own session.
	received, err := fixture.friends.Get(ctx, invite.ViewRequest{
		InvitationID:    created.Invitation.InvitationID,
		ViewerAccountID: "user_recipient",
	})
	if err != nil {
		t.Fatalf("the preview of the recipient = %v, want the invitation", err)
	}
	if received.InvitationID != created.Invitation.InvitationID {
		t.Fatalf("the preview of the recipient = %+v", received)
	}
	// The owner token is the proof of the ownership, so it authorizes the
	// read of the inviter. It never widens the challenge to a public
	// status: a caller without the token learns nothing.
	if _, err = fixture.friends.Get(ctx, invite.ViewRequest{
		InvitationID:    created.Invitation.InvitationID,
		ViewerAccountID: "user_stranger",
	}); !errors.Is(err, invite.ErrNotFound) {
		t.Fatalf("the preview of a stranger = %v, want ErrNotFound", err)
	}
	// The public view never names the recipient of the challenge.
	if strings.Contains(strings.ToLower(own.InvitationID), "user_recipient") {
		t.Fatal("the public view carries the account of the recipient")
	}
}

// TestPostgresFriendClosedSurfaceFinishesAnIssuedInvitation covers the
// rollback switch of the friend surface.
//
// Turning the switch off stops new creations immediately. It never
// invalidates an invitation that was issued while the switch was open: a
// guest may still accept it, and the inviter may still cancel it and claim
// the seat credential of the created match.
func TestPostgresFriendClosedSurfaceFinishesAnIssuedInvitation(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	closed, err := invite.Open(ctx, fixture.pool, fixture.service, fixture.service, fixture.allocator, invite.Options{
		GuestCredentialTTL: time.Hour,
		InvitationTTL:      invite.InvitationTTL,
		Gate:               invite.StaticGate(false),
	})
	if err != nil {
		t.Fatal(err)
	}

	// A closed surface refuses a new invitation.
	if _, err = closed.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	}); !errors.Is(err, invite.ErrDisabled) {
		t.Fatalf("the creation of a closed surface = %v, want ErrDisabled", err)
	}

	// An invitation that was issued while the surface was open is still
	// accepted by a guest.
	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     nil,
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create the issued invitation: %v", err)
	}
	accepted, err := closed.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("closed-surface-guest"),
		Acceptor:      nil,
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept the issued invitation of a closed surface: %v", err)
	}
	if accepted.MatchID == "" || accepted.GuestCredential == nil {
		t.Fatalf("the acceptance of a closed surface = %+v", accepted)
	}
	// The seat of the inviter is still recoverable after the switch was
	// turned off.
	credential, err := closed.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if err != nil {
		t.Fatalf("claim the seat of a closed surface: %v", err)
	}
	if credential.MatchID != accepted.MatchID || credential.GuestCredential == nil {
		t.Fatalf("the claimed seat of a closed surface = %+v", credential)
	}

	// An invitation that is still open is still cancelled by its inviter.
	cancellable, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     nil,
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create the cancellable invitation: %v", err)
	}
	cancelled, err := closed.Cancel(ctx, invite.CancelRequest{
		InvitationID: cancellable.Invitation.InvitationID,
		OwnerToken:   cancellable.OwnerToken,
	})
	if err != nil {
		t.Fatalf("cancel the issued invitation of a closed surface: %v", err)
	}
	if cancelled.Status != invite.StatusCancelled {
		t.Fatalf("the cancelled status = %q, want cancelled", cancelled.Status)
	}

	// The closed surface never proposes or accepts a rematch, because a
	// rematch creates a new game.
	if _, err = closed.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_proposer"},
		ProposerLabel: "Guest",
	}); !errors.Is(err, invite.ErrDisabled) {
		t.Fatalf("the rematch of a closed surface = %v, want ErrDisabled", err)
	}
}
