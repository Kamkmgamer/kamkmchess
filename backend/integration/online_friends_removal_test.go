package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5"
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

// friendRemovalHandler mounts the real friend routes for the removal
// fixture, with an authenticator that reaches the real credential service.
func friendRemovalHandler(t *testing.T, fixture *friendRemovalFixture) http.Handler {
	t.Helper()
	authorizer := friendAuthorizer(t, fixture.pool)
	authenticator := &friendGuestAuthenticator{
		accounts: map[string]onlineauth.Principal{
			"user_inviter":   accountPrincipal("user_inviter", "session-user_inviter"),
			"user_recipient": accountPrincipal("user_recipient", "session-user_recipient"),
			"user_invitee":   accountPrincipal("user_invitee", "session-user_invitee"),
		},
		authorizer: authorizer,
	}
	return httpapi.NewFriends(fixture.friends, fixture.service, authenticator, httpapi.FriendsOptions{
		AllowedOrigins: []string{friendOrigin},
	})
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

// TestPostgresFriendRemovedInviterDoesNotTakeTheAcceptorSeatAway covers
// the resumed acceptance of an invitation whose inviter was removed.
//
// The privacy sanitation replaced the identifier of the inviter with the
// anonymized sentinel. The acceptance already happened, so the seat of the
// acceptor exists and the resume has to answer it: the removal of the
// inviter does not take the seat of the acceptor away, and the resume does
// not create a second match.
//
// The resume names the acceptor alone, so the acceptor is the only participant
// whose removal is rechecked. A write that creates a new match names both
// participants, and that write is still refused.
func TestPostgresFriendRemovedInviterDoesNotTakeTheAcceptorSeatAway(t *testing.T) {
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
	// The resume of the acceptance answers the match of the acceptor.
	resumed, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: key,
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("the resume of the surviving acceptor: %v", err)
	}
	if resumed.MatchID != accepted.MatchID {
		t.Fatalf("the resume named %q, want %q", resumed.MatchID, accepted.MatchID)
	}
	if resumed.Seat != accepted.Seat {
		t.Fatalf("the resume named the seat %q, want %q", resumed.Seat, accepted.Seat)
	}
	// The match of the removed inviter was not extended.
	var matches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, accepted.MatchID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 1 {
		t.Fatalf("the resume left %d matches", matches)
	}
	// The removed inviter is named by no row of the surface.
	var named int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_friend_invitations WHERE inviter_id='user_inviter' UNION ALL SELECT count(*) FROM online_seats WHERE owner_id='user_inviter'`).Scan(&named); err != nil {
		t.Fatal(err)
	}
	if named != 0 {
		t.Fatalf("%d rows still name the removed inviter", named)
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
	// The dead offer is not published any more.
	_, found, err = fixture.friends.PendingRematch(ctx, accepted.MatchID, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"})
	if err != nil {
		t.Fatalf("the pending offer of a dead match: %v", err)
	}
	if found {
		t.Fatal("the dead offer is still published as the live offer")
	}
	// The read is a projection: it never writes the offer, and it never
	// writes the row of the proposer of the offer.
	var (
		status     string
		proposerID string
		updatedAt  time.Time
	)
	if err = fixture.pool.QueryRow(ctx, `SELECT status,proposer_id,updated_at FROM online_rematch_offers WHERE rematch_id=$1`, proposal.RematchID).Scan(&status, &proposerID, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("the read wrote the offer: the status is %q, want pending", status)
	}
	if proposerID != "user_inviter" {
		t.Fatalf("the read wrote the proposer of the offer: it is %q", proposerID)
	}
}

// TestPostgresFriendSurvivingGuestKeepsItsOwnSeatCredential covers the
// survivor of a match whose opponent was removed.
//
// The removal of the opponent does not remove the survivor. The guest inviter
// keeps the seat of its own live match, so the claim of its own seat
// credential is answered with a credential, over the service and over the
// wire.
func TestPostgresFriendSurvivingGuestKeepsItsOwnSeatCredential(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	handler := friendRemovalHandler(t, fixture)
	const guestID = "guest_survivor_inviter"
	guest := &invite.Identity{Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: guestID}, PublicLabel: invite.GuestLabel}
	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     guest,
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("survivor-credential"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	// The control: the claim of the own seat credential works while the match
	// is intact.
	before, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if err != nil {
		t.Fatalf("the seat credential before the removal: %v", err)
	}
	if before.GuestCredential == nil {
		t.Fatal("the claim before the removal delivered no credential")
	}
	// The opponent of the guest is removed. The guest is not.
	if _, err = fixture.removals.DeleteAccount(ctx, accountPrincipal("user_invitee", "session-user_invitee"), authTestOrigin); err != nil {
		t.Fatalf("delete the opponent: %v", err)
	}
	// The survivor keeps the credential of its own seat.
	after, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if err != nil {
		t.Fatalf("the seat credential of the survivor: %v", err)
	}
	if after.GuestCredential == nil {
		t.Fatal("the claim of the survivor delivered no credential")
	}
	if after.MatchID != accepted.MatchID {
		t.Fatalf("the claim of the survivor named %q, want %q", after.MatchID, accepted.MatchID)
	}
	// The match is still live: the removal of the opponent does not end it.
	var status string
	if err = fixture.pool.QueryRow(ctx, `SELECT status FROM online_matches WHERE match_id=$1`, accepted.MatchID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "active" {
		t.Fatalf("the status of the match of the survivor = %q, want active", status)
	}
	// The same answer over the wire.
	body := fmt.Sprintf(`{"schemaVersion":2,"ownerToken":%q}`, created.OwnerToken)
	recorder := friendGuestRequest(t, handler, http.MethodPost, "/v1/online/invitations/"+created.Invitation.InvitationID+"/seat-credential", "", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("the wire claim of the survivor status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var answer struct {
		GuestCredential *struct {
			Token string `json:"token"`
		} `json:"guestCredential"`
	}
	if err = json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.GuestCredential == nil || answer.GuestCredential.Token == "" {
		t.Fatalf("the wire claim of the survivor delivered no credential: %s", recorder.Body.String())
	}
}

// TestPostgresFriendSurvivingGuestRecoversItsAcceptanceCredential covers the
// resumed acceptance of a surviving guest.
//
// The inviter is removed, the guest acceptor is not. The acceptance already
// happened, so the seat of the guest exists and the resume has to answer it
// with the credential of that seat.
func TestPostgresFriendSurvivingGuestRecoversItsAcceptanceCredential(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	const guestID = "guest_survivor_acceptor"
	guest := &invite.Identity{Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: guestID}, PublicLabel: invite.GuestLabel}
	created := friendRemovalCreate(t, fixture, "user_inviter")
	key := acceptanceKey("survivor-resume")
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: key,
		Acceptor:      guest,
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if accepted.GuestCredential == nil {
		t.Fatal("the acceptance delivered no credential")
	}
	// The inviter is removed. The guest acceptor is not.
	if _, err = fixture.removals.DeleteAccount(ctx, accountPrincipal("user_inviter", "session-user_inviter"), authTestOrigin); err != nil {
		t.Fatalf("delete the inviter: %v", err)
	}
	// The resume answers the match of the guest and the credential of its
	// seat.
	resumed, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:     created.Invitation.InvitationID,
		AcceptanceKey:    key,
		Acceptor:         guest,
		Control:          online.SeatControl{Kind: online.ControlHuman},
		Origin:           friendOrigin,
		RotateCredential: true,
	})
	if err != nil {
		t.Fatalf("the resume of the surviving guest: %v", err)
	}
	if resumed.MatchID != accepted.MatchID {
		t.Fatalf("the resume named %q, want %q", resumed.MatchID, accepted.MatchID)
	}
	if resumed.GuestCredential == nil {
		t.Fatal("the resume of the surviving guest delivered no credential")
	}
	// The match was not created again.
	var matches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, accepted.MatchID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 1 {
		t.Fatalf("the resume left %d matches", matches)
	}
}

// TestPostgresFriendRestoredSeatIdentityIsRefused covers the restored
// original of a removed participant.
//
// A restore of an older backup can carry the seat row of a participant that
// was removed after the backup was taken. The seat then names the removed
// subject again, and the participant scoped ledger row of the match still
// names it, so the write is refused.
func TestPostgresFriendRestoredSeatIdentityIsRefused(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	created := friendRemovalCreate(t, fixture, "user_inviter")
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("restored-identity"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	resign := resignOnlineCommand(accepted.MatchID, "restored-identity-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session-user_inviter"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	if _, err = fixture.removals.DeleteAccount(ctx, accountPrincipal("user_invitee", "session-user_invitee"), authTestOrigin); err != nil {
		t.Fatalf("delete the opponent: %v", err)
	}
	// The state of an older backup: the seat row still names the removed
	// subject. A restore replaces the row instead of updating it, so the
	// guard of the seat is dropped in this isolated schema.
	if _, err = fixture.pool.Exec(ctx, `DROP TRIGGER online_seats_guard ON online_seats`); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.pool.Exec(ctx, `UPDATE online_seats SET owner_id='user_invitee',public_label='Bob' WHERE match_id=$1 AND seat='black'`, accepted.MatchID); err != nil {
		t.Fatal(err)
	}
	// The removal ledger of the match still names the removed participant.
	var ledger int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_removal_ledger WHERE match_id=$1 AND subject_id=$2`, accepted.MatchID, subject.Reference("user_invitee")).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if ledger == 0 {
		t.Fatal("the removal ledger of the match does not name the removed participant")
	}
	// The proposal of the surviving participant is refused: the restored seat
	// names a participant that was removed from that match.
	_, err = fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
		ProposerLabel: "Alice",
	})
	if !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the proposal with a restored seat identity error = %v, want ErrRemoved", err)
	}
	var offers int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_rematch_offers WHERE match_id=$1`, accepted.MatchID).Scan(&offers); err != nil {
		t.Fatal(err)
	}
	if offers != 0 {
		t.Fatalf("the refused proposal recorded %d offers", offers)
	}
}

// TestPostgresFriendLegacyAcceptingOfferIsReadWithoutAnError covers the offer
// of an older build.
//
// The current build never writes the `accepting` state, but the value
// survives in the offers of an older build and in any restored older backup.
// Such an offer names its accepter, so it cannot be declined without clearing
// the accepter, and the read of a dead offer has to answer without a write
// and without a database error.
func TestPostgresFriendLegacyAcceptingOfferIsReadWithoutAnError(t *testing.T) {
	fixture := newFriendRemovalFixture(t)
	ctx := context.Background()
	handler := friendRemovalHandler(t, fixture)
	created := friendRemovalCreate(t, fixture, "user_inviter")
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("legacy-accepting"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	resign := resignOnlineCommand(accepted.MatchID, "legacy-accepting-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session-user_inviter"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	// The offer of an older build: it is accepting and it names its accepter.
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO online_rematch_offers(rematch_id,match_id,proposer_kind,proposer_id,proposer_public_label,proposer_seat,starting_time_ms,increment_ms,starting_fen,status,version,accepted_by_kind,accepted_by_id,created_at,updated_at,expires_at)
		VALUES('rmt_legacyaccepting1',$1,'account','user_inviter','Alice','black',300000,0,NULL,'accepting',1,'account','user_invitee',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '12 hours')`, accepted.MatchID); err != nil {
		t.Fatal(err)
	}
	// The proposer of the offer is removed. The offer is dead, because a
	// removed participant cannot consent.
	if _, err = fixture.removals.DeleteAccount(ctx, accountPrincipal("user_inviter", "session-user_inviter"), authTestOrigin); err != nil {
		t.Fatalf("delete the proposer: %v", err)
	}
	// The read answers without a database error and without a write.
	_, found, err := fixture.friends.PendingRematch(ctx, accepted.MatchID, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"})
	if err != nil {
		t.Fatalf("the read of the legacy offer: %v", err)
	}
	if found {
		t.Fatal("the dead legacy offer is published")
	}
	var (
		status     string
		acceptedBy *string
	)
	if err = fixture.pool.QueryRow(ctx, `SELECT status,accepted_by_id FROM online_rematch_offers WHERE rematch_id='rmt_legacyaccepting1'`).Scan(&status, &acceptedBy); err != nil {
		t.Fatal(err)
	}
	if status != "accepting" {
		t.Fatalf("the read wrote the legacy offer: the status is %q", status)
	}
	if acceptedBy == nil {
		t.Fatal("the read cleared the accepter of the legacy offer")
	}
	// The wire answers the refusal of the surface, not a service failure.
	request := httptest.NewRequest(http.MethodGet, "/v1/online/matches/"+accepted.MatchID+"/rematch", nil)
	request.Header.Set("Origin", friendOrigin)
	request.Header.Set("Authorization", "Bearer user_invitee")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code == http.StatusServiceUnavailable {
		t.Fatalf("the wire of the legacy offer answered 503: %s", recorder.Body.String())
	}
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("the wire of the legacy offer status=%d body=%s", recorder.Code, recorder.Body.String())
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
	//
	// The privacy sanitation erases the rows of a removed guest, so the
	// invitation of the removed guest is gone and the cancellation answers
	// "not found". The refusal is the contractual answer, and the row of
	// the removed participant is never written.
	_, err = fixture.friends.Cancel(ctx, invite.CancelRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
	})
	if !errors.Is(err, invite.ErrNotFound) && !errors.Is(err, invite.ErrRemoved) {
		t.Fatalf("the cancellation of a removed guest error = %v, want a refusal", err)
	}
	// The invitation was not cancelled: a removed participant never writes
	// its own personal row again.
	var status string
	err = fixture.pool.QueryRow(ctx, `SELECT status FROM online_friend_invitations WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&status)
	if err == nil && status == "cancelled" {
		t.Fatal("the removed guest cancelled its own invitation")
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
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
	//
	// The privacy sanitation redacts the rows of the removed guest, so the
	// ownership of the invitation is gone and the claim answers "not
	// authorized". The refusal is the contractual answer, and no credential
	// of the removed participant is minted.
	_, err = fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if !errors.Is(err, invite.ErrNotAuthorized) && !errors.Is(err, invite.ErrRemoved) && !errors.Is(err, invite.ErrNotFound) {
		t.Fatalf("the credential of a removed guest error = %v, want a refusal", err)
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
	if err == nil {
		t.Fatal("the acceptance of a removed guest was answered")
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
