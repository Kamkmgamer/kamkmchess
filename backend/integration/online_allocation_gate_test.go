package integration

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
)

// The allocation races, the runner fences and the health boundary.

// TestOnlineAllocationIsIdempotentUnderCompetingOwners covers the shared
// allocation writer.
//
// Two owners that complete the same reservation at the same time must produce
// one match and one receipt, and both must see the same accepted result. The
// second one waits for the first instead of racing for the insert.
func TestOnlineAllocationIsIdempotentUnderCompetingOwners(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	setup := allocationSetup()
	command, err := online.NewAllocationCommand(presenceAlice().ref, setup, "op-alloc-race")
	if err != nil {
		t.Fatal(err)
	}
	results := make([]online.CommandResult, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for index := 0; index < 2; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			results[index], errs[index] = fixture.service.CreateAllocatedMatch(ctx, presenceAlice().ref, setup, "op-alloc-race")
		}(index)
	}
	wg.Wait()
	for index, err := range errs {
		if err != nil {
			t.Fatalf("allocation %d = %v, want an accepted result", index, err)
		}
	}
	if results[0].Receipt.OperationID != results[1].Receipt.OperationID {
		t.Fatalf("the two allocations returned different operations: %q and %q", results[0].Receipt.OperationID, results[1].Receipt.OperationID)
	}
	if results[0].Receipt.Version != results[1].Receipt.Version {
		t.Fatalf("the two allocations returned different versions: %d and %d", results[0].Receipt.Version, results[1].Receipt.Version)
	}
	var matches, receipts int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, command.MatchID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_operation_receipts WHERE scope_kind='match' AND scope_id=$1 AND operation_id=$2`, command.MatchID, "op-alloc-race").Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if matches != 1 {
		t.Fatalf("matches = %d, want 1", matches)
	}
	if receipts != 1 {
		t.Fatalf("receipts = %d, want 1", receipts)
	}
}

// TestOnlineAllocationRefusesAMatchThatAlreadyExists covers the second
// allocation of an existing match.
//
// The match scope lock orders the allocations, so the second one finds the
// match and is told that it exists. It is not a service failure, and it never
// writes a second match.
func TestOnlineAllocationRefusesAMatchThatAlreadyExists(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	setup := allocationSetup()
	command, err := online.NewAllocationCommand(presenceAlice().ref, setup, "op-alloc-first")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.service.CreateAllocatedMatch(ctx, presenceAlice().ref, setup, "op-alloc-first"); err != nil {
		t.Fatalf("the first allocation: %v", err)
	}
	// The same match id with another operation belongs to another owner of
	// the same reservation.
	other := command
	other.OperationID = "op-alloc-second"
	other.Action = online.Action{Kind: online.ActionCreateMatch, CreateMatch: &setup}
	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	_, err = fixture.service.CreateMatchInTx(ctx, tx, other)
	if !errors.Is(err, online.ErrAlreadyExists) {
		t.Fatalf("the second allocation = %v, want %v", err, online.ErrAlreadyExists)
	}
}

// TestOnlineAllocationIsOrderedAgainstTheRemovalOfItsParticipant covers the
// account scope lock.
//
// An allocation and the removal of the same participant are ordered instead
// of racing, so the allocation never recreates a removed seat after the
// removal committed.
func TestOnlineAllocationIsOrderedAgainstTheRemovalOfItsParticipant(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	setup := allocationSetup()
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,live_delete_due_at,recovery_sanitize_due_at)
VALUES('rm_gate_race','account',$1,'account_deletion','verified',clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp())`, subject.Reference("user_b")); err != nil {
		t.Fatalf("record the removal request: %v", err)
	}
	if _, err := fixture.service.CreateAllocatedMatch(ctx, presenceAlice().ref, setup, "op-alloc-removed"); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("the allocation of a removed participant = %v, want %v", err, online.ErrNotAuthorized)
	}
}

// TestOnlineRunnerFencesTheTerminalActionsOfAStaleRunner covers the runner
// fence of the terminal actions.
//
// A stale runner may not resign and may not spend a recovery attempt. The
// owner may always resign, because that is the owner's own decision.
func TestOnlineRunnerFencesTheTerminalActionsOfAStaleRunner(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-runner-terminal"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)
	lease, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-terminal", "", version, 1))
	if err != nil {
		t.Fatalf("acquire the lease: %v", err)
	}
	// The control change fences the runner of the seat.
	control := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-takeover-terminal",
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
	// The stale runner may not resign the seat.
	resign := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-stale-resign",
		ExpectedVersion: version + 1,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionResign},
		LeaseID:         lease.LeaseID,
	}
	if _, err = fixture.service.Execute(ctx, presenceBob().ref, resign); err == nil {
		t.Fatal("the stale runner resigned the seat")
	}
	// The owner may still resign, because that is the owner's own decision.
	ownerResign := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-owner-resign",
		ExpectedVersion: version + 1,
		Seat:            online.SeatBlack,
		ControlEpoch:    2,
		Action:          online.Action{Kind: online.ActionResign},
	}
	if _, err = fixture.service.Execute(ctx, presenceBob().ref, ownerResign); err != nil {
		t.Fatalf("the owner resign: %v", err)
	}
}

// TestOnlineRunnerLeaseEndsWithItsMatch covers the end of a lease.
//
// A lease of a finished match is not renewed, so a runner cannot hold the
// seat of a game that is over.
func TestOnlineRunnerLeaseEndsWithItsMatch(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-runner-finished"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)
	lease, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-finished", "", version, 1))
	if err != nil {
		t.Fatalf("acquire the lease: %v", err)
	}
	resign := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-finish-resign",
		ExpectedVersion: version,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionResign},
	}
	if _, err = fixture.service.Execute(ctx, presenceBob().ref, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	if _, err = fixture.service.RenewRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-finished", lease.LeaseID, version, 1)); !errors.Is(err, online.ErrMatchEnded) {
		t.Fatalf("the renewal of a finished match = %v, want %v", err, online.ErrMatchEnded)
	}
	after, err := fixture.service.GetSeatRunnerLease(ctx, presenceBob().ref, matchID, online.SeatBlack)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.LeaseRevoked || after.RevokedReason == nil || *after.RevokedReason != online.LeaseRevokeMatchEnded {
		t.Fatalf("the lease of a finished match = %+v, want a revoked lease", after)
	}
}

// allocationSetup is the setup of a trusted allocation.
func allocationSetup() online.CreateMatchSetup {
	return online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Seats: online.CreateMatchSeats{
			White: online.CreateSeat{
				Participant: presenceAlice().ref,
				PublicLabel: "Alice",
				Control:     online.SeatControl{Kind: online.ControlHuman},
			},
			Black: online.CreateSeat{
				Participant: presenceBob().ref,
				PublicLabel: "Bob",
				Control:     online.SeatControl{Kind: online.ControlHuman},
			},
		},
	}
}

// unused keeps the time import honest when the file changes.
var _ = time.Second
