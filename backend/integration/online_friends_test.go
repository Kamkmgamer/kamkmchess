package integration

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The friend invitation fixtures exercise the real invitation service, the
// real online writer and the real guest credential allocator against a real
// PostgreSQL database. Nothing here is a memory double.

const friendOrigin = "https://app.example"

// friendFixture composes the invitation service with the real writer and the
// real allocator.
type friendFixture struct {
	pool      *pgxpool.Pool
	service   *online.Service
	allocator *onlineauth.Allocator
	friends   *invite.Service
	now       time.Time
}

func newFriendFixture(t *testing.T, evaluator online.Evaluator) *friendFixture {
	t.Helper()
	ctx := context.Background()
	pool := testPool(t)
	if err := migrations.Apply(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	authorizer, err := onlineauth.Open(ctx, pool, nil, onlineauth.Options{GuestCredentialTTL: time.Hour, OwnershipProofTTL: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	service, err := online.Open(ctx, pool, evaluator, online.WithSeatAuthorizer(authorizer))
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
	return &friendFixture{pool: pool, service: service, allocator: allocator, friends: friends, now: time.Now().UTC()}
}

// strictSetupEvaluator refuses one starting position, so an invalid position
// can be exercised against the real validation path.
type strictSetupEvaluator struct {
	moveEvaluator
	rejected string
}

func (e strictSetupEvaluator) ValidateSetup(_ context.Context, input online.RulesInput) error {
	if e.rejected != "" && strings.Contains(input.StartingFEN, e.rejected) {
		return fmt.Errorf("%w: the position is not legal", online.ErrInvalidContract)
	}
	return nil
}

// friendIdentity builds an account identity.
func friendIdentity(id, label string) *invite.Identity {
	return &invite.Identity{Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: id}, PublicLabel: label}
}

// acceptanceKey builds a client supplied idempotency key.
func acceptanceKey(seed string) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, seed)
	return "acceptance-key-" + safe + "-0123456789"
}

func TestPostgresFriendInvitationLinkAndChallengePaths(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	// A shareable link may be created by an anonymous guest inviter. The
	// preview shows Guest and the real setup, and never a pairing.
	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Kind:        invite.KindLink,
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create link invitation: %v", err)
	}
	if created.Invitation.InviterLabel != invite.GuestLabel {
		t.Fatalf("anonymous inviter label = %q, want Guest", created.Invitation.InviterLabel)
	}
	if created.OwnerToken == "" {
		t.Fatal("the inviter received no owner token")
	}
	preview, err := fixture.friends.Get(ctx, created.Invitation.InvitationID, "")
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.InviterSeat != online.SeatWhite || preview.TimeControl.IncrementMs != 2_000 {
		t.Fatalf("preview setup = %+v", preview)
	}
	if preview.Status != invite.StatusOpen {
		t.Fatalf("preview status = %q", preview.Status)
	}

	// A guest accepts the link and receives a guest seat credential.
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("guest-link"),
		Acceptor:      nil,
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept as guest: %v", err)
	}
	if accepted.Seat != online.SeatBlack {
		t.Fatalf("guest seat = %q, want black", accepted.Seat)
	}
	if accepted.GuestCredential == nil || accepted.GuestCredential.Token == "" {
		t.Fatal("the guest acceptor received no seat credential")
	}
	if accepted.GuestCredential.MatchID != accepted.MatchID {
		t.Fatalf("credential match = %q, want %q", accepted.GuestCredential.MatchID, accepted.MatchID)
	}
	// The credential authorizes the seat of the created match.
	authorizer, err := onlineauth.Open(ctx, fixture.pool, nil, onlineauth.Options{GuestCredentialTTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := authorizer.AuthenticateGuest(ctx, accepted.GuestCredential.Token, friendOrigin)
	if err != nil {
		t.Fatalf("authenticate the issued guest credential: %v", err)
	}
	if principal.MatchID != accepted.MatchID || principal.Seat != online.SeatBlack {
		t.Fatalf("guest principal = %+v", principal)
	}

	// The invitation is consumed exactly once. A second acceptance with
	// another key is refused and creates no second match.
	if _, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("other-guest"),
		Acceptor:      nil,
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	}); !errors.Is(err, invite.ErrAlreadyConsumed) {
		t.Fatalf("second acceptance error = %v, want ErrAlreadyConsumed", err)
	}

	// A named challenge belongs to one account. Another account may neither
	// preview nor accept it.
	challenge, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Kind:               invite.KindChallenge,
		Inviter:            friendIdentity("user_inviter", "Alice"),
		RecipientAccountID: "user_recipient",
		Seat:               online.SeatBlack,
		TimeControl:        online.TimeControl{StartingTimeMs: 600_000, IncrementMs: 0},
		Control:            online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create challenge: %v", err)
	}
	if _, err = fixture.friends.Get(ctx, challenge.Invitation.InvitationID, "user_stranger"); !errors.Is(err, invite.ErrNotFound) {
		t.Fatalf("stranger preview error = %v, want ErrNotFound", err)
	}
	if _, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  challenge.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("stranger"),
		Acceptor:      friendIdentity("user_stranger", "Mallory"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	}); !errors.Is(err, invite.ErrNotAuthorized) {
		t.Fatalf("stranger acceptance error = %v, want ErrNotAuthorized", err)
	}
	// The challenge is still open after the refused attempt.
	preview, err = fixture.friends.Get(ctx, challenge.Invitation.InvitationID, "user_recipient")
	if err != nil {
		t.Fatalf("recipient preview: %v", err)
	}
	if preview.Status != invite.StatusOpen {
		t.Fatalf("challenge status after a refused attempt = %q, want open", preview.Status)
	}
	accepted, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  challenge.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("recipient"),
		Acceptor:      friendIdentity("user_recipient", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("recipient acceptance: %v", err)
	}
	if accepted.Seat != online.SeatWhite {
		t.Fatalf("recipient seat = %q, want white", accepted.Seat)
	}
	if accepted.GuestCredential != nil {
		t.Fatal("an account acceptor received a guest credential")
	}
}

func TestPostgresFriendInvitationCancellationAndExpiry(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_owner", "Owner"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	cancelled, err := fixture.friends.Cancel(ctx, invite.CancelRequest{InvitationID: created.Invitation.InvitationID, OwnerToken: created.OwnerToken})
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if cancelled.Status != invite.StatusCancelled {
		t.Fatalf("cancelled status = %q", cancelled.Status)
	}
	if _, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("cancelled"),
		Acceptor:      friendIdentity("user_other", "Other"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	}); err == nil {
		t.Fatal("a cancelled invitation was accepted")
	}

	// An expired invitation can never be consumed.
	expired, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_owner", "Owner"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err = fixture.pool.Exec(ctx, `UPDATE online_friend_invitations SET created_at=clock_timestamp()-interval '13 hours', expires_at=clock_timestamp()-interval '1 hour' WHERE invitation_id=$1`, expired.Invitation.InvitationID); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  expired.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("expired"),
		Acceptor:      friendIdentity("user_other", "Other"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	}); !errors.Is(err, invite.ErrExpired) {
		t.Fatalf("expired acceptance error = %v, want ErrExpired", err)
	}
}

func TestPostgresFriendSeatCombinationsAndVisibleSetup(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	cases := []struct {
		name          string
		inviter       online.SeatControl
		acceptor      online.SeatControl
		wantWhiteKind online.ControlKind
		wantBlackKind online.ControlKind
	}{
		{"human human", online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman}, online.ControlHuman, online.ControlHuman},
		{"human agent", online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlAgent, ModelLabel: stringPointer("Declared Model")}, online.ControlHuman, online.ControlAgent},
		{"agent agent", online.SeatControl{Kind: online.ControlAgent, ModelLabel: stringPointer("Inviter Model")}, online.SeatControl{Kind: online.ControlAgent, ModelLabel: stringPointer("Invitee Model")}, online.ControlAgent, online.ControlAgent},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			created, err := fixture.friends.Create(ctx, invite.CreateRequest{
				Inviter:     friendIdentity("user_inviter", "Alice"),
				Seat:        online.SeatWhite,
				TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
				Control:     testCase.inviter,
			})
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
				InvitationID:  created.Invitation.InvitationID,
				AcceptanceKey: acceptanceKey(testCase.name),
				Acceptor:      friendIdentity("user_invitee", "Bob"),
				Control:       testCase.acceptor,
				Origin:        friendOrigin,
			})
			if err != nil {
				t.Fatalf("accept: %v", err)
			}
			match, err := fixture.service.GetMatch(ctx, accepted.MatchID)
			if err != nil {
				t.Fatalf("read the created match: %v", err)
			}
			white, _ := match.Seat(online.SeatWhite)
			black, _ := match.Seat(online.SeatBlack)
			if white.Control.Kind != testCase.wantWhiteKind || black.Control.Kind != testCase.wantBlackKind {
				t.Fatalf("seat controls = %q/%q, want %q/%q", white.Control.Kind, black.Control.Kind, testCase.wantWhiteKind, testCase.wantBlackKind)
			}
			if white.PublicLabel != "Alice" || black.PublicLabel != "Bob" {
				t.Fatalf("seat labels = %q/%q", white.PublicLabel, black.PublicLabel)
			}
			if match.StartingFEN != invite.StandardStartingFEN {
				t.Fatalf("starting position = %q", match.StartingFEN)
			}
			if match.TimeControl != (online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}) {
				t.Fatalf("time control = %+v", match.TimeControl)
			}
		})
	}
}

func TestPostgresFriendCustomPositionIsVisibleAndValidated(t *testing.T) {
	fixture := newFriendFixture(t, strictSetupEvaluator{rejected: "8/8/8/8/8/8/8/K6k"})
	ctx := context.Background()

	// An invalid position never becomes an invitation.
	if _, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		StartingFEN: "8/8/8/8/8/8/8/K6k w - - 0 1",
		Control:     online.SeatControl{Kind: online.ControlHuman},
	}); !errors.Is(err, invite.ErrInvalidContract) {
		t.Fatalf("invalid position error = %v, want ErrInvalidContract", err)
	}

	// A valid custom position is visible in the preview and in the created
	// match.
	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatBlack,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		StartingFEN: "8/8/8/8/8/8/4k3/4K3 w - - 0 1",
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create custom position: %v", err)
	}
	preview, err := fixture.friends.Get(ctx, created.Invitation.InvitationID, "")
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.StartingFEN != "8/8/8/8/8/8/4k3/4K3 w - - 0 1" {
		t.Fatalf("preview position = %q", preview.StartingFEN)
	}
	if preview.InviterSeat != online.SeatBlack {
		t.Fatalf("preview seat = %q", preview.InviterSeat)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("custom-position"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept custom position: %v", err)
	}
	match, err := fixture.service.GetMatch(ctx, accepted.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.StartingFEN != "8/8/8/8/8/8/4k3/4K3 w - - 0 1" {
		t.Fatalf("match position = %q", match.StartingFEN)
	}
	if accepted.Seat != online.SeatWhite {
		t.Fatalf("invitee seat = %q, want white", accepted.Seat)
	}
}

func TestPostgresFriendLostAnswerRetryRecoversTheSameAcceptance(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	key := acceptanceKey("lost-answer")
	first, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: key,
		Acceptor:      nil,
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("first acceptance: %v", err)
	}
	if first.GuestCredential == nil {
		t.Fatal("the first acceptance delivered no credential")
	}
	// The retry of a lost answer resumes the same acceptance. It returns
	// the same match and the same seat, and it does not consume a second
	// invitation.
	retry, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: key,
		Acceptor:      nil,
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("retry acceptance: %v", err)
	}
	if retry.MatchID != first.MatchID || retry.Seat != first.Seat {
		t.Fatalf("retry = %q/%q, want %q/%q", retry.MatchID, retry.Seat, first.MatchID, first.Seat)
	}
	// A routine retry never supersedes the credential another request
	// already delivered.
	if retry.GuestCredential != nil {
		t.Fatal("the routine retry superseded a live credential")
	}
	// The rotation is explicit: the caller that holds no working
	// credential asks for it.
	rotated, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:    created.Invitation.InvitationID,
		AcceptanceKey:   key,
		Acceptor:        nil,
		Control:         online.SeatControl{Kind: online.ControlHuman},
		Origin:          friendOrigin,
		RotateCredential: true,
	})
	if err != nil {
		t.Fatalf("rotated acceptance: %v", err)
	}
	if rotated.GuestCredential == nil || rotated.GuestCredential.Token == first.GuestCredential.Token {
		t.Fatal("the rotation delivered no new credential")
	}
	// The old credential is superseded and no longer authorizes the seat.
	authorizer, err := onlineauth.Open(ctx, fixture.pool, nil, onlineauth.Options{GuestCredentialTTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = authorizer.AuthenticateGuest(ctx, first.GuestCredential.Token, friendOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("superseded credential error = %v, want ErrUnauthenticated", err)
	}
	if _, err = authorizer.AuthenticateGuest(ctx, rotated.GuestCredential.Token, friendOrigin); err != nil {
		t.Fatalf("the rotated credential does not authorize the seat: %v", err)
	}
	// Exactly one match exists for the invitation.
	var matches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, first.MatchID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 1 {
		t.Fatalf("the accepted invitation produced %d matches", matches)
	}
}

func TestPostgresFriendConcurrentAcceptanceHasOneWinner(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var (
		wait   sync.WaitGroup
		mutex  sync.Mutex
		wins   []string
		errors_ []error
	)
	for index := 0; index < 4; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
				InvitationID:  created.Invitation.InvitationID,
				AcceptanceKey: acceptanceKey(fmt.Sprintf("race-%d", index)),
				Acceptor:      friendIdentity(fmt.Sprintf("user_racer_%d", index), "Racer"),
				Control:       online.SeatControl{Kind: online.ControlHuman},
				Origin:        friendOrigin,
			})
			mutex.Lock()
			defer mutex.Unlock()
			if err != nil {
				errors_ = append(errors_, err)
				return
			}
			wins = append(wins, accepted.MatchID)
		}(index)
	}
	wait.Wait()
	if len(wins) != 1 {
		t.Fatalf("concurrent acceptance produced %d winners: %v", len(wins), errors_)
	}
	for _, err := range errors_ {
		if !errors.Is(err, invite.ErrAlreadyConsumed) && !errors.Is(err, invite.ErrConflict) {
			t.Fatalf("a losing acceptance returned %v", err)
		}
	}
	var acceptances int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_invitation_acceptances WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&acceptances); err != nil {
		t.Fatal(err)
	}
	if acceptances != 1 {
		t.Fatalf("the invitation recorded %d acceptances", acceptances)
	}
}

func TestPostgresFriendSelfAcceptanceIsRefusedBeforeConsumption(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("self"),
		Acceptor:      friendIdentity("user_inviter", "Alice"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	}); !errors.Is(err, invite.ErrInvalidContract) {
		t.Fatalf("self acceptance error = %v, want ErrInvalidContract", err)
	}
	// The invitation is still open: the refused attempt consumed nothing.
	preview, err := fixture.friends.Get(ctx, created.Invitation.InvitationID, "")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Status != invite.StatusOpen {
		t.Fatalf("status after a self acceptance = %q, want open", preview.Status)
	}
	var acceptances int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_invitation_acceptances WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&acceptances); err != nil {
		t.Fatal(err)
	}
	if acceptances != 0 {
		t.Fatalf("the refused self acceptance recorded %d acceptances", acceptances)
	}
}

func TestPostgresFriendCancelAfterConcurrentAcceptanceReportsTheRealState(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("cancel-race"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	// The cancellation of a consumed invitation is refused. It never
	// reports a cancelled invitation that was consumed.
	if _, err = fixture.friends.Cancel(ctx, invite.CancelRequest{InvitationID: created.Invitation.InvitationID, OwnerToken: created.OwnerToken}); !errors.Is(err, invite.ErrConflict) {
		t.Fatalf("cancel after acceptance error = %v, want ErrConflict", err)
	}
	preview, err := fixture.friends.Get(ctx, created.Invitation.InvitationID, "")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Status != invite.StatusConsumed {
		t.Fatalf("status after the refused cancellation = %q, want consumed", preview.Status)
	}
	if preview.MatchID == nil || *preview.MatchID != accepted.MatchID {
		t.Fatalf("the consumed invitation lost its match: %+v", preview.MatchID)
	}
}

func TestPostgresFriendGuestInviterClaimsItsSeatCredential(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	// An anonymous guest inviter owns the invitation through its owner
	// token. The guest seat credential of the created match can only be
	// minted after the match exists.
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
		AcceptanceKey: acceptanceKey("guest-inviter"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	claimed, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if err != nil {
		t.Fatalf("claim the guest seat credential: %v", err)
	}
	if claimed.MatchID != accepted.MatchID || claimed.Seat != online.SeatWhite {
		t.Fatalf("claimed credential = %+v", claimed)
	}
	if claimed.GuestCredential == nil || claimed.GuestCredential.Token == "" {
		t.Fatal("the guest inviter received no seat credential")
	}
	authorizer, err := onlineauth.Open(ctx, fixture.pool, nil, onlineauth.Options{GuestCredentialTTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := authorizer.AuthenticateGuest(ctx, claimed.GuestCredential.Token, friendOrigin)
	if err != nil {
		t.Fatalf("authenticate the inviter credential: %v", err)
	}
	if principal.MatchID != accepted.MatchID || principal.Seat != online.SeatWhite {
		t.Fatalf("inviter principal = %+v", principal)
	}
	// A wrong owner token is refused.
	if _, err = fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   "wrong-owner-token-value",
		Origin:       friendOrigin,
	}); !errors.Is(err, invite.ErrNotAuthorized) {
		t.Fatalf("wrong owner token error = %v, want ErrNotAuthorized", err)
	}
}

func TestPostgresFriendMutualRematchReversesColorsAndKeepsTheSetup(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("rematch"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	// The match ends. The result of the old match stays final.
	resign := resignOnlineCommand(accepted.MatchID, "rematch-resign-op", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session_rematch"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
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
	if proposal.Status != invite.RematchPending || proposal.ProposerSeat != online.SeatBlack {
		t.Fatalf("proposal = %+v", proposal)
	}
	if proposal.TimeControl != (online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}) {
		t.Fatalf("the proposal did not retain the setup: %+v", proposal.TimeControl)
	}
	// The proposer alone cannot create the new match.
	if _, err = fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID: proposal.RematchID,
		Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
	}); !errors.Is(err, invite.ErrConflict) {
		t.Fatalf("proposer acceptance error = %v, want ErrConflict", err)
	}
	result, err := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID: proposal.RematchID,
		Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"},
	})
	if err != nil {
		t.Fatalf("accept the rematch: %v", err)
	}
	if result.MatchID == accepted.MatchID {
		t.Fatal("the rematch reused the finished match")
	}
	// The colors are reversed and the setup is retained.
	rematch, err := fixture.service.GetMatch(ctx, result.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	white, _ := rematch.Seat(online.SeatWhite)
	black, _ := rematch.Seat(online.SeatBlack)
	if white.Participant.ID != "user_invitee" || black.Participant.ID != "user_inviter" {
		t.Fatalf("the colors were not reversed: white=%q black=%q", white.Participant.ID, black.Participant.ID)
	}
	if rematch.TimeControl != (online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}) {
		t.Fatalf("the rematch did not retain the clock: %+v", rematch.TimeControl)
	}
	if rematch.Status != online.MatchActive {
		t.Fatalf("the rematch status = %q", rematch.Status)
	}
	// The old match keeps its final result.
	finished, err := fixture.service.GetMatch(ctx, accepted.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != online.MatchCompleted || finished.Result == nil {
		t.Fatalf("the finished match changed: %+v", finished.Result)
	}
	// A duplicate acceptance returns the same new match and creates no
	// second one.
	duplicate, err := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID: proposal.RematchID,
		Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"},
	})
	if err != nil {
		t.Fatalf("duplicate acceptance: %v", err)
	}
	if duplicate.MatchID != result.MatchID {
		t.Fatalf("the duplicate acceptance created %q, want %q", duplicate.MatchID, result.MatchID)
	}
	var rematchMatches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_rematch_offers WHERE match_id=$1 AND new_match_id=$2`, accepted.MatchID, result.MatchID).Scan(&rematchMatches); err != nil {
		t.Fatal(err)
	}
	if rematchMatches != 1 {
		t.Fatalf("the rematch recorded %d offers", rematchMatches)
	}
}

// stringPointer returns a pointer to a copy of the value.
func stringPointer(value string) *string {
	return &value
}
