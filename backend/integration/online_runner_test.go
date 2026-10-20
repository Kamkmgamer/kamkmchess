package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The runner lease fixtures.
//
// A lease holds the right to act for one seat of one match. The fixtures use
// agent controlled seats, so the lease rules apply to them.

// createRunnerMatch creates a match whose seats are agent controlled.
func createRunnerMatch(t *testing.T, service *online.Service, matchID string, startingTimeMs int64) {
	t.Helper()
	command := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-create-" + matchID,
		ExpectedVersion: 0,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action: online.Action{
			Kind: online.ActionCreateMatch,
			CreateMatch: &online.CreateMatchSetup{
				Variant:     "orthodox",
				StartingFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
				TimeControl: online.TimeControl{StartingTimeMs: startingTimeMs, IncrementMs: 0},
				Seats: online.CreateMatchSeats{
					White: online.CreateSeat{
						Participant: presenceAlice().ref,
						PublicLabel: "Alice",
						Control:     online.SeatControl{Kind: online.ControlAgent, ModelLabel: modelLabel("Model A")},
					},
					Black: online.CreateSeat{
						Participant: presenceBob().ref,
						PublicLabel: "Bob",
						Control:     online.SeatControl{Kind: online.ControlAgent, ModelLabel: modelLabel("Model B")},
					},
				},
			},
		},
	}
	if _, err := service.Execute(context.Background(), presenceAlice().ref, command); err != nil {
		t.Fatalf("create match %s: %v", matchID, err)
	}
}

// acceptMovesWithLeases makes both sides move once through their runner
// leases.
//
// An agent seat acts through a browser runner, so the fixture takes the
// lease of the seat, submits the move with it, and releases it again. The
// seat is free for the fixtures that follow.
func acceptMovesWithLeases(t *testing.T, service *online.Service, matchID string) int64 {
	t.Helper()
	ctx := context.Background()
	whiteLease, err := service.AcquireRunnerLease(ctx, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-white", "", 1, 1))
	if err != nil {
		t.Fatalf("acquire the white seat: %v", err)
	}
	whiteMove := moveOnlineCommandAt(matchID, "op-move-white-"+matchID, online.SeatWhite, 1, 1, "e2e4")
	whiteMove.LeaseID = whiteLease.LeaseID
	if _, err = service.Execute(ctx, presenceAlice().ref, whiteMove); err != nil {
		t.Fatalf("white move: %v", err)
	}
	if _, err = service.ReleaseRunnerLease(ctx, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-white", whiteLease.LeaseID, 1, 1)); err != nil {
		t.Fatalf("release the white seat: %v", err)
	}
	blackLease, err := service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-black", "", 2, 1))
	if err != nil {
		t.Fatalf("acquire the black seat: %v", err)
	}
	blackMove := moveOnlineCommandAt(matchID, "op-move-black-"+matchID, online.SeatBlack, 2, 1, "e7e5")
	blackMove.LeaseID = blackLease.LeaseID
	if _, err = service.Execute(ctx, presenceBob().ref, blackMove); err != nil {
		t.Fatalf("black move: %v", err)
	}
	if _, err = service.ReleaseRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-black", blackLease.LeaseID, 2, 1)); err != nil {
		t.Fatalf("release the black seat: %v", err)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	return match.Version
}

// leaseRequest builds a runner lease request.
func leaseRequest(matchID string, seat online.Seat, runnerID string, leaseID string, turnVersion, controlEpoch int64) online.RunnerLeaseRequest {
	return online.RunnerLeaseRequest{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       matchID,
		Seat:          seat,
		RunnerID:      runnerID,
		LeaseID:       leaseID,
		TurnVersion:   turnVersion,
		ControlEpoch:  controlEpoch,
	}
}

// TestOnlineRunnerLeaseDuplicateTabIsRefused covers ARC-08.
//
// A second tab of the same owner shares the game. It cannot take the seat
// while the first tab holds the lease, and the runner that holds the lease
// gets the same lease back when it asks again.
func TestOnlineRunnerLeaseDuplicateTabIsRefused(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-runner-duplicate"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)

	first, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-tab-1", "", version, 1))
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if first.Status != online.LeaseActive {
		t.Fatalf("lease status = %q, want %q", first.Status, online.LeaseActive)
	}
	if first.TurnVersion == nil || *first.TurnVersion != version {
		t.Fatalf("the lease is bound to %v, want the turn %d", first.TurnVersion, version)
	}
	// A second tab of the same owner cannot take the seat.
	if _, err = fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-tab-2", "", version, 1)); !errors.Is(err, online.ErrConflict) {
		t.Fatalf("the second tab acquired the seat: %v", err)
	}
	// The holder gets its own lease back.
	again, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-tab-1", "", version, 1))
	if err != nil {
		t.Fatalf("re-acquire: %v", err)
	}
	if again.LeaseID != first.LeaseID {
		t.Fatalf("the lease identity changed from %q to %q", first.LeaseID, again.LeaseID)
	}
}

// TestOnlineRunnerLeaseIsPerSeatAndPerGame covers ARC-08.
//
// Separate explicit games run concurrently, and the two seats of one game
// have their own lease.
func TestOnlineRunnerLeaseIsPerSeatAndPerGame(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const firstGame = "match-runner-game-one"
	const secondGame = "match-runner-game-two"
	createRunnerMatch(t, fixture.service, firstGame, 20*60*1000)
	createRunnerMatch(t, fixture.service, secondGame, 20*60*1000)
	firstVersion := acceptMovesWithLeases(t, fixture.service, firstGame)
	secondVersion := acceptMovesWithLeases(t, fixture.service, secondGame)

	black, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(firstGame, online.SeatBlack, "runner-one", "", firstVersion, 1))
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	other, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(secondGame, online.SeatBlack, "runner-two", "", secondVersion, 1))
	if err != nil {
		t.Fatalf("acquire the second game: %v", err)
	}
	if black.LeaseID == other.LeaseID {
		t.Fatal("two games must not share one lease")
	}
	white, err := fixture.service.AcquireRunnerLease(ctx, presenceAlice().ref, leaseRequest(firstGame, online.SeatWhite, "runner-white", "", firstVersion, 1))
	if err != nil {
		t.Fatalf("acquire the white seat: %v", err)
	}
	if white.LeaseID == black.LeaseID {
		t.Fatal("two seats must not share one lease")
	}
}

// TestOnlineRunnerLeaseExpiryFencesMoves covers the runner loss fence.
//
// An expired lease cannot act, even when no other runner has taken the seat
// yet, and it is never revived by a renewal.
func TestOnlineRunnerLeaseExpiryFencesMoves(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-runner-expiry"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)

	lease, err := fixture.service.AcquireRunnerLease(ctx, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-sleepy", "", version, 1))
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	// The runner sleeps past the lease.
	fixture.clock.Advance(online.RunnerLeaseTTL + time.Second)

	// The expired lease cannot renew itself.
	if _, err = fixture.service.RenewRunnerLease(ctx, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-sleepy", lease.LeaseID, version, 1)); !errors.Is(err, online.ErrConflict) {
		t.Fatalf("an expired lease was renewed: %v", err)
	}
	// The expired lease cannot submit a move.
	move := moveOnlineCommandAt(matchID, "op-move-expired", online.SeatWhite, version, 1, "g1f3")
	move.LeaseID = lease.LeaseID
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, move); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("an expired lease submitted a move: %v", err)
	}
}

// TestOnlineRunnerControlChangeRevokesTheLease covers MAT-09.
//
// A control change fences the runner of that seat at once, and the reply of
// the old runner cannot become an accepted move.
func TestOnlineRunnerControlChangeRevokesTheLease(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-runner-control"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)

	lease, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-old", "", version, 1))
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	// The owner takes the seat over.
	control := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-takeover-" + matchID,
		ExpectedVersion: version,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action: online.Action{
			Kind:       online.ActionSetControl,
			SetControl: &online.SetControlAction{Control: online.SeatControl{Kind: online.ControlHuman}},
		},
	}
	if _, err = fixture.service.Execute(ctx, presenceBob().ref, control); err != nil {
		t.Fatalf("take over: %v", err)
	}
	after, err := fixture.service.GetSeatRunnerLease(ctx, presenceBob().ref, matchID, online.SeatBlack)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.LeaseRevoked {
		t.Fatalf("the lease status = %q, want %q", after.Status, online.LeaseRevoked)
	}
	if after.RevokedReason == nil || *after.RevokedReason != online.LeaseRevokeControlChange {
		t.Fatalf("the lease revocation reason = %v, want %q", after.RevokedReason, online.LeaseRevokeControlChange)
	}
	// The reply of the old runner is fenced, both by the control epoch and
	// by the revoked lease.
	move := moveOnlineCommandAt(matchID, "op-move-after-takeover", online.SeatBlack, version+1, 1, "e7e5")
	move.LeaseID = lease.LeaseID
	if _, err = fixture.service.Execute(ctx, presenceBob().ref, move); err == nil {
		t.Fatal("the old runner submitted a move")
	} else if !errors.Is(err, online.ErrNotAuthorized) && !errors.Is(err, online.ErrConflict) {
		t.Fatalf("the old runner submitted a move: %v", err)
	}
	after2, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after2.Version != version+1 {
		t.Fatalf("the fenced reply advanced the match to version %d", after2.Version)
	}
}

// TestOnlineRunnerUncertainRequestSurvivesTheLeaseChange covers ARC-09.
//
// The uncertain provider request of a lost runner survives the lease change,
// so the next runner offers an explicit recovery instead of issuing another
// provider request.
func TestOnlineRunnerUncertainRequestSurvivesTheLeaseChange(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-runner-uncertain"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)

	lease, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-lost", "", version, 1))
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	begin := online.RunnerRequestRequest{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       matchID,
		Seat:          online.SeatBlack,
		RunnerID:      "runner-lost",
		LeaseID:       lease.LeaseID,
		RequestID:     "request-0001",
		ControlEpoch:  1,
		TurnVersion:   version,
	}
	started, err := fixture.service.BeginRunnerRequest(ctx, presenceBob().ref, begin)
	if err != nil {
		t.Fatalf("begin the request: %v", err)
	}
	if started.PendingRequestID == nil || *started.PendingRequestID != "request-0001" {
		t.Fatalf("the pending request = %v, want request-0001", started.PendingRequestID)
	}

	// The runner is lost and its lease expires.
	fixture.clock.Advance(online.RunnerLeaseTTL + time.Second)
	taken, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-new", "", version, 1))
	if err != nil {
		t.Fatalf("acquire after the loss: %v", err)
	}
	if taken.PendingRequestID == nil || *taken.PendingRequestID != "request-0001" {
		t.Fatalf("the uncertain request did not survive the lease change: %v", taken.PendingRequestID)
	}
	// The new runner settles the uncertain request explicitly.
	clear := begin
	clear.RunnerID = "runner-new"
	clear.LeaseID = taken.LeaseID
	settled, err := fixture.service.ClearRunnerRequest(ctx, presenceBob().ref, clear)
	if err != nil {
		t.Fatalf("clear the request: %v", err)
	}
	if settled.PendingRequestID != nil {
		t.Fatalf("the pending request survived the explicit settlement: %v", settled.PendingRequestID)
	}
}

// TestOnlineRunnerLeaseIsBoundToTheTurn covers the per-turn fence.
//
// A lease of an older turn cannot submit a move of a later turn.
func TestOnlineRunnerLeaseIsBoundToTheTurn(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-runner-turn"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)

	lease, err := fixture.service.AcquireRunnerLease(ctx, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-turn", "", version, 1))
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	// The lease may not be bound to a turn that is not the current one.
	if _, err = fixture.service.AcquireRunnerLease(ctx, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-turn", "", version+7, 1)); !errors.Is(err, online.ErrConflict) {
		t.Fatalf("the lease was bound to a turn that does not exist: %v", err)
	}
	// The move of the bound turn is accepted.
	move := moveOnlineCommandAt(matchID, "op-move-turn", online.SeatWhite, version, 1, "g1f3")
	move.LeaseID = lease.LeaseID
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, move); err != nil {
		t.Fatalf("the bound turn was refused: %v", err)
	}
	// The same lease cannot act for the next turn.
	stale := moveOnlineCommandAt(matchID, "op-move-stale-turn", online.SeatBlack, version+1, 1, "b8c6")
	stale.LeaseID = lease.LeaseID
	if _, err = fixture.service.Execute(ctx, presenceBob().ref, stale); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("a lease of an older turn submitted a move: %v", err)
	}
}

// TestOnlineRunnerLeaseReadIsLimitedToItsSeat covers the disclosure
// boundary.
//
// A lease names the runner of a seat, so it is only readable by the
// participant that owns the seat.
func TestOnlineRunnerLeaseReadIsLimitedToItsSeat(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-runner-read"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)
	if _, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-private", "", version, 1)); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := fixture.service.GetSeatRunnerLease(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatalf("the owner of the seat cannot read its lease: %v", err)
	}
	if _, err := fixture.service.GetSeatRunnerLease(ctx, presenceAlice().ref, matchID, online.SeatBlack); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("the other participant read the lease: %v", err)
	}
}
