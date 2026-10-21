package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The regressions of this file cover the order between the removal of a
// participant and the friend writes that name it.
//
// The privacy flow takes the account scope lock of the removed subject and
// then the row locks of the rows it sanitizes. A friend write therefore
// takes the same account scope lock before its own row lock, and it
// rechecks the durable removal after the lock. A request that was
// authenticated before the removal therefore never creates a personal row
// after it, and it never revives the credential of a removed participant.

// friendRemovalFixture composes the friend surface and the privacy service
// on one isolated schema.
type friendRemovalFixture struct {
	pool       *pgxpool.Pool
	service    *online.Service
	authorizer *onlineauth.Service
	allocator  *onlineauth.Allocator
	friends    *invite.Service
	removals   *privacy.Service
}

// newFriendRemovalFixture composes the friend surface and the privacy
// service on a pool of its own.
func newFriendRemovalFixture(t *testing.T) *friendRemovalFixture {
	t.Helper()
	return newFriendRemovalFixtureWithPool(t, testPool(t))
}

// newFriendRemovalFixtureWithPool composes the friend surface and the
// privacy service on a given pool.
func newFriendRemovalFixtureWithPool(t *testing.T, pool *pgxpool.Pool) *friendRemovalFixture {
	t.Helper()
	ctx := context.Background()
	if err := migrations.Apply(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	authorizer, err := onlineauth.Open(ctx, pool, nil, onlineauth.Options{GuestCredentialTTL: time.Hour, OwnershipProofTTL: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	service, err := online.Open(ctx, pool, moveEvaluator{}, online.WithSeatAuthorizer(authorizer))
	if err != nil {
		t.Fatal(err)
	}
	allocator := onlineauth.NewAllocator(authorizer)
	friends, err := invite.Open(ctx, pool, service, service, allocator, invite.Options{
		GuestCredentialTTL: time.Hour,
		InvitationTTL:      invite.InvitationTTL,
	})
	if err != nil {
		t.Fatal(err)
	}
	removals, err := privacy.Open(ctx, pool, authorizer, privacy.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return &friendRemovalFixture{pool: pool, service: service, authorizer: authorizer, allocator: allocator, friends: friends, removals: removals}
}

// friendRemovalCreate creates an invitation of an account inviter.
func friendRemovalCreate(t *testing.T, fixture *friendRemovalFixture, inviter string) invite.Created {
	t.Helper()
	created, err := fixture.friends.Create(context.Background(), invite.CreateRequest{
		Inviter:     friendIdentity(inviter, "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return created
}

// TestPostgresFriendCreationWaitsForTheAccountScopeLock covers the order
// between the creation of an invitation and the removal of its inviter.
//
// The creation takes the account scope lock of the inviter, so it waits for
// the removal that holds the same lock. The two flows are ordered instead of
// racing, and the creation never writes a row that names a removed
// participant.
func TestPostgresFriendCreationWaitsForTheAccountScopeLock(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()

	held, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback(ctx)
	if err = locks.LockAccountScope(ctx, held, locks.AccountScope(string(online.ParticipantAccount), "user_inviter")); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, createErr := fixture.friends.Create(ctx, invite.CreateRequest{
			Inviter:     friendIdentity("user_inviter", "Alice"),
			Seat:        online.SeatWhite,
			TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
			Control:     online.SeatControl{Kind: online.ControlHuman},
		})
		done <- createErr
	}()
	select {
	case err = <-done:
		t.Fatalf("the creation did not wait for the account scope lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	// The lock is released and the creation continues.
	if err = held.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatalf("the creation failed: %v", err)
	}
}

// TestPostgresFriendAcceptanceWaitsForTheAccountScopeLock covers the order
// between the acceptance of an invitation and the removal of its acceptor.
//
// The acceptance takes the account scope lock of the acceptor before the row
// lock of the invitation, so it waits for the removal that holds the same
// lock.
func TestPostgresFriendAcceptanceWaitsForTheAccountScopeLock(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")

	held, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback(ctx)
	if err = locks.LockAccountScope(ctx, held, locks.AccountScope(string(online.ParticipantAccount), "user_invitee")); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, acceptErr := fixture.friends.Accept(ctx, invite.AcceptRequest{
			InvitationID:  created.Invitation.InvitationID,
			AcceptanceKey: acceptanceKey("removal-order"),
			Acceptor:      friendIdentity("user_invitee", "Bob"),
			Control:       online.SeatControl{Kind: online.ControlHuman},
			Origin:        friendOrigin,
		})
		done <- acceptErr
	}()
	select {
	case err = <-done:
		t.Fatalf("the acceptance did not wait for the account scope lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if err = held.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatalf("the acceptance failed: %v", err)
	}
}

// TestPostgresFriendRemovedAccountCannotCreateAnInvitation covers the
// refusal of a removed account.
//
// The removal of the account is durable, so the creation of an invitation
// that names the removed account is refused and no row names it.
func TestPostgresFriendRemovedAccountCannotCreateAnInvitation(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	if _, err := fixture.removals.DeleteAccount(ctx, accountPrincipal("user_inviter", "session-user_inviter"), authTestOrigin); err != nil {
		t.Fatalf("delete the account: %v", err)
	}
	_, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the creation of a removed account error = %v, want ErrRemoved", err)
	}
	var rows int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_friend_invitations WHERE inviter_id='user_inviter'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("the removed account has %d invitations", rows)
	}
}

// TestPostgresFriendRemovedAccountCannotAcceptAnInvitation covers the
// refusal of a removed acceptor.
//
// The invitation is not consumed and no acceptance is recorded, so the
// invitation stays usable for somebody else.
func TestPostgresFriendRemovedAccountCannotAcceptAnInvitation(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")
	if _, err := fixture.removals.DeleteAccount(ctx, accountPrincipal("user_invitee", "session-user_invitee"), authTestOrigin); err != nil {
		t.Fatalf("delete the account: %v", err)
	}
	_, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("removed-acceptor"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the acceptance of a removed account error = %v, want ErrRemoved", err)
	}
	// The invitation was not consumed and no acceptance was recorded.
	var (
		status  string
		matches int
	)
	if err = fixture.pool.QueryRow(ctx, `SELECT status FROM online_friend_invitations WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "open" {
		t.Fatalf("the invitation after the refused acceptance = %q, want open", status)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_invitation_acceptances WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 0 {
		t.Fatalf("the refused acceptance recorded %d acceptances", matches)
	}
}

// TestPostgresFriendRemovedParticipantCannotProposeOrAcceptARematch covers
// the rematch paths of a removed participant.
//
// A removed participant may not propose a rematch, may not accept one and
// never gets a fresh credential of the new seat.
func TestPostgresFriendRemovedParticipantCannotProposeOrAcceptARematch(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")
	if _, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("removal-rematch"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	}); err != nil {
		t.Fatalf("accept: %v", err)
	}
	accepted, err := fixture.friends.Get(ctx, created.Invitation.InvitationID, "")
	if err != nil {
		t.Fatal(err)
	}
	if accepted.MatchID == nil {
		t.Fatal("the accepted invitation has no match")
	}
	matchID := *accepted.MatchID
	resign := resignOnlineCommand(matchID, "removal-rematch-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session-user_inviter"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	// The opponent is removed while the game is finished.
	if _, err = fixture.removals.DeleteAccount(ctx, accountPrincipal("user_invitee", "session-user_invitee"), authTestOrigin); err != nil {
		t.Fatalf("delete the account: %v", err)
	}
	// The proposal of the remaining participant is refused: the finished match
	// lost a participant, so the new game would seat a subject that no longer
	// exists.
	_, err = fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       matchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
		ProposerLabel: "Alice",
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the proposal of a removed opponent error = %v, want ErrRemoved", err)
	}
	var offers int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_rematch_offers WHERE match_id=$1`, matchID).Scan(&offers); err != nil {
		t.Fatal(err)
	}
	if offers != 0 {
		t.Fatalf("the refused proposal recorded %d offers", offers)
	}
	// The seats of the finished match no longer name the removed participant.
	var owners int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_seats WHERE match_id=$1 AND owner_id='user_invitee'`, matchID).Scan(&owners); err != nil {
		t.Fatal(err)
	}
	if owners != 0 {
		t.Fatalf("%d seats still name the removed participant", owners)
	}
}

// TestPostgresFriendRemovedInviterCannotResumeItsAcceptance covers the
// acceptance of an invitation whose inviter was removed.
//
// The privacy sanitation replaced the identifier of the inviter with the
// anonymized sentinel, so the acceptance of the invitation would name a
// subject that no longer exists. The resume is refused.
func TestPostgresFriendRemovedInviterCannotResumeItsAcceptance(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")
	key := acceptanceKey("removal-inviter")
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: key,
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if _, err = fixture.removals.DeleteAccount(ctx, accountPrincipal("user_inviter", "session-user_inviter"), authTestOrigin); err != nil {
		t.Fatalf("delete the account: %v", err)
	}
	// The sanitized invitation names the anonymized sentinel.
	var inviterID string
	if err = fixture.pool.QueryRow(ctx, `SELECT inviter_id FROM online_friend_invitations WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&inviterID); err != nil {
		t.Fatal(err)
	}
	if inviterID != "anonymized" {
		t.Fatalf("the sanitized inviter = %q, want the anonymized sentinel", inviterID)
	}
	// The resume of the acceptance is refused.
	_, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: key,
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the resume of a removed inviter error = %v, want ErrRemoved", err)
	}
	// The match of the removed inviter was not extended.
	var matches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, accepted.MatchID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 1 {
		t.Fatalf("the refused resume left %d matches", matches)
	}
}

// TestPostgresFriendRemovedProposerCannotHaveItsOfferAccepted covers the
// acceptance of a pending offer whose proposer was removed.
//
// The offer was created while the proposer was still there, and the removal
// anonymized the seat of the proposer and the proposer of the offer. The
// acceptance of that offer is refused, because the new match would seat a
// subject that no longer exists.
func TestPostgresFriendRemovedProposerCannotHaveItsOfferAccepted(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("removal-proposer"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	resign := resignOnlineCommand(accepted.MatchID, "removal-proposer-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session-user_inviter"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	// The proposer makes the offer, and the opponent is removed afterwards.
	proposal, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
		ProposerLabel: "Alice",
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	if _, err = fixture.removals.DeleteAccount(ctx, accountPrincipal("user_inviter", "session-user_inviter"), authTestOrigin); err != nil {
		t.Fatalf("delete the account: %v", err)
	}
	// The acceptance of the offer is refused.
	_, err = fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID: proposal.RematchID,
		Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"},
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the acceptance of a removed proposer error = %v, want ErrRemoved", err)
	}
	// No new match was created for the removed proposer.
	var matches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id<>$1`, accepted.MatchID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 0 {
		t.Fatalf("the refused acceptance created %d matches", matches)
	}
	var seats int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_seats WHERE owner_id='anonymized' AND match_id<>$1`, accepted.MatchID).Scan(&seats); err != nil {
		t.Fatal(err)
	}
	if seats != 0 {
		t.Fatalf("%d seats seat the anonymized participant", seats)
	}
}

// TestPostgresFriendDeadRematchOfferIsNotPublished covers the offer that can
// never be accepted.
//
// The offer of a match whose participant was removed is retired instead of
// being published as the live offer of the match until it expires.
func TestPostgresFriendDeadRematchOfferIsNotPublished(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("removal-dead-offer"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	resign := resignOnlineCommand(accepted.MatchID, "removal-dead-offer-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session-user_inviter"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	proposal, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
		ProposerLabel: "Alice",
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	// The offer is published while both participants are there.
	pending, found, err := fixture.friends.PendingRematch(ctx, accepted.MatchID, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"})
	if err != nil || !found {
		t.Fatalf("the pending offer of a live match = %v/%v", found, err)
	}
	if pending.RematchID != proposal.RematchID {
		t.Fatalf("the pending offer = %q, want %q", pending.RematchID, proposal.RematchID)
	}
	// The opponent of the offer is removed.
	if _, err = fixture.removals.DeleteAccount(ctx, accountPrincipal("user_invitee", "session-user_invitee"), authTestOrigin); err != nil {
		t.Fatalf("delete the account: %v", err)
	}
	// The dead offer is not published any more, and it is retired.
	_, found, err = fixture.friends.PendingRematch(ctx, accepted.MatchID, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"})
	if err != nil {
		t.Fatalf("the pending offer of a dead match: %v", err)
	}
	if found {
		t.Fatal("the dead offer is still published as the live offer")
	}
	var status string
	if err = fixture.pool.QueryRow(ctx, `SELECT status FROM online_rematch_offers WHERE rematch_id=$1`, proposal.RematchID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "declined" {
		t.Fatalf("the status of the dead offer = %q, want declined", status)
	}
}

// TestPostgresFriendRemovedParticipantCannotCancelItsInvitation covers the
// cancellation of a removed participant.
//
// The cancellation is a write that names the inviter, so it is fenced like
// every other write of the surface. A removed guest, whose row the privacy
// sanitation does not erase, is refused with the removal refusal, and the
// invitation keeps its state.
func TestPostgresFriendRemovedParticipantCannotCancelItsInvitation(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	const guestID = "guest_removal_canceller"
	guest := &invite.Identity{Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: guestID}, PublicLabel: invite.GuestLabel}
	// The guest owns an open invitation.
	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     guest,
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// The same guest plays a game, so it holds a live seat credential and the
	// removal can verify the ownership of the seat.
	played, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create the played invitation: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  played.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("removal-cancel"),
		Acceptor:      guest,
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if accepted.GuestCredential == nil {
		t.Fatal("the guest acceptance delivered no credential")
	}
	principal, err := fixture.authorizer.AuthenticateGuest(ctx, accepted.GuestCredential.Token, friendOrigin)
	if err != nil {
		t.Fatalf("authenticate the guest credential: %v", err)
	}
	if _, err = fixture.removals.RemoveGuest(ctx, principal, friendOrigin); err != nil {
		t.Fatalf("remove the guest: %v", err)
	}
	// The cancellation of the removed guest is refused.
	_, err = fixture.friends.Cancel(ctx, invite.CancelRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the cancellation of a removed guest error = %v, want ErrRemoved", err)
	}
	// The invitation was not cancelled: a removed participant never writes
	// its own personal row again.
	var status string
	if err = fixture.pool.QueryRow(ctx, `SELECT status FROM online_friend_invitations WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status == "cancelled" {
		t.Fatal("the removed guest cancelled its own invitation")
	}
}

// TestPostgresFriendRemovedGuestNeverGetsAFreshCredential covers the
// credential recovery path of a removed guest.
//
// A removed guest never receives a fresh seat credential, so a credential
// that was issued before the removal is not revived after it.
func TestPostgresFriendRemovedGuestNeverGetsAFreshCredential(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	// An anonymous guest inviter and a guest acceptor.
	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("removal-credential"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if accepted.MatchID == "" {
		t.Fatal("the acceptance created no match")
	}
	claimed, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if err != nil {
		t.Fatalf("claim the inviter credential: %v", err)
	}
	principal, err := fixture.authorizer.AuthenticateGuest(ctx, claimed.GuestCredential.Token, friendOrigin)
	if err != nil {
		t.Fatalf("authenticate the inviter credential: %v", err)
	}
	// The guest inviter is removed.
	if _, err = fixture.removals.RemoveGuest(ctx, principal, friendOrigin); err != nil {
		t.Fatalf("remove the guest: %v", err)
	}
	// The credential recovery of the removed guest is refused.
	_, err = fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the credential of a removed guest error = %v, want ErrRemoved", err)
	}
	// No fresh credential was issued for the removed guest.
	var fresh int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_guest_seat_credentials WHERE guest_id=$1 AND revoked_at IS NULL AND superseded_at IS NULL`, principal.Subject).Scan(&fresh); err != nil {
		t.Fatal(err)
	}
	if fresh != 0 {
		t.Fatalf("the removed guest has %d live credentials", fresh)
	}
	// The acceptance of the removed guest is refused as well, so no
	// credential of a removed participant is ever revived and the match of
	// the removed guest is never extended.
	_, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("removal-credential-retry"),
		Acceptor:      nil,
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the acceptance of a removed guest error = %v, want ErrRemoved", err)
	}
}

// TestPostgresFriendRematchAcceptanceWaitsForTheAccountScopeLock covers the
// order between the acceptance of a rematch and the removal of a participant
// of the finished match.
//
// The acceptance of a rematch takes the account scope lock of the
// participants before the row lock of the offer, so it waits for the removal
// that holds the same lock.
func TestPostgresFriendRematchAcceptanceWaitsForTheAccountScopeLock(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("removal-rematch-order"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	matchID := accepted.MatchID
	resign := resignOnlineCommand(matchID, "removal-rematch-order-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session-user_inviter"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	proposal, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       matchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
		ProposerLabel: "Alice",
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	held, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback(ctx)
	if err = locks.LockAccountScope(ctx, held, locks.AccountScope(string(online.ParticipantAccount), "user_invitee")); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, acceptErr := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
			RematchID: proposal.RematchID,
			Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"},
		})
		done <- acceptErr
	}()
	select {
	case err = <-done:
		t.Fatalf("the rematch acceptance did not wait for the account scope lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if err = held.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatalf("the rematch acceptance failed: %v", err)
	}
}

// TestPostgresFriendRemovalAndTheInvitationWriteNeverDeadlock covers the
// bounded race between the removal of a participant and the friend writes.
//
// The pool is smaller than the number of the racing flows, so a lock
// discipline that waits for a second connection while it holds a lock would
// deadlock here. Every flow finishes, and the outcome is one of the two
// ordered ones: the write happened before the removal, or the write was
// refused because the participant was already removed.
func TestPostgresFriendRemovalAndTheInvitationWriteNeverDeadlock(t *testing.T) {
	pool := friendTestPool(t, 4)
	fixture := newFriendRemovalFixtureWithPool(t, pool)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")

	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		_, acceptErr := fixture.friends.Accept(ctx, invite.AcceptRequest{
			InvitationID:  created.Invitation.InvitationID,
			AcceptanceKey: acceptanceKey("removal-deadlock"),
			Acceptor:      friendIdentity("user_invitee", "Bob"),
			Control:       online.SeatControl{Kind: online.ControlHuman},
			Origin:        friendOrigin,
		})
		results <- acceptErr
	}()
	go func() {
		<-start
		_, removeErr := fixture.removals.DeleteAccount(ctx, accountPrincipal("user_invitee", "session-user_invitee"), authTestOrigin)
		results <- removeErr
	}()
	close(start)
	for range 2 {
		select {
		case err := <-results:
			if err != nil && !errors.Is(err, invite.ErrRemoved) && !errors.Is(err, invite.ErrAlreadyConsumed) && !errors.Is(err, invite.ErrConflict) {
				t.Fatalf("a racing flow failed: %v", err)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("the racing flows deadlocked")
		}
	}
	// The removal is durable and the acceptance either created one game
	// before the removal or was refused.
	var acceptances int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_invitation_acceptances WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&acceptances); err != nil {
		t.Fatal(err)
	}
	if acceptances > 1 {
		t.Fatalf("the race recorded %d acceptances", acceptances)
	}
}
