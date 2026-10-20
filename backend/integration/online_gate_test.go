package integration

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The durable admission gate of the online service.
//
// Every mutation passes the gate inside the transaction that writes it, so a
// service that is suspended, restoring or still recovering refuses the same
// mutations in every instance, and a command that started before a
// suspension cannot commit after it.

// blockingEvaluator holds a move evaluation until the test releases it.
//
// It is the race fixture of the gate: the acceptance transaction of a move
// starts after the rules process answered, so a suspension that is committed
// while the evaluation runs must be visible to the acceptance.
type blockingEvaluator struct {
	moveEvaluator
	entered chan struct{}
	release chan struct{}
	armed   atomic.Bool
}

func newBlockingEvaluator() *blockingEvaluator {
	return &blockingEvaluator{entered: make(chan struct{}, 1), release: make(chan struct{})}
}

// Arm makes the next evaluation block.
func (e *blockingEvaluator) Arm() { e.armed.Store(true) }

func (e *blockingEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	if e.armed.Load() {
		select {
		case e.entered <- struct{}{}:
		default:
		}
		select {
		case <-e.release:
		case <-ctx.Done():
			return online.Candidate{}, ctx.Err()
		}
	}
	return e.moveEvaluator.Evaluate(ctx, input)
}

// planSuspension closes the durable gate of the service.
func planSuspension(t *testing.T, fixture presenceFixture) {
	t.Helper()
	started := fixture.clock.Now()
	if _, err := fixture.service.PlanSuspension(context.Background(), started, started); err != nil {
		t.Fatalf("plan the suspension: %v", err)
	}
}

// TestOnlineGateRefusesTheAcceptanceOfASuspensionDuringEvaluation covers the
// race of the gate.
//
// The rules process answers after the suspension was committed, so the
// acceptance transaction must see the closed gate and refuse the move.
func TestOnlineGateRefusesTheAcceptanceOfASuspensionDuringEvaluation(t *testing.T) {
	evaluator := newBlockingEvaluator()
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx := context.Background()
	const matchID = "match-gate-evaluation"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)

	evaluator.Arm()
	command := moveOnlineCommand(matchID, "op-move-gated", online.SeatWhite, version, "g1f3")
	result := make(chan error, 1)
	go func() {
		_, err := fixture.service.Execute(ctx, presenceAlice().ref, command)
		result <- err
	}()
	// The evaluation is running.
	<-evaluator.entered
	// The service is suspended while the rules process is busy.
	planSuspension(t, fixture)
	evaluator.release <- struct{}{}

	if err := <-result; !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the gated acceptance = %v, want %v", err, online.ErrUnavailable)
	}
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Version != version {
		t.Fatalf("the gated acceptance advanced the match to version %d, want %d", match.Version, version)
	}
	if len(match.Moves) != 2 {
		t.Fatalf("the gated acceptance stored %d moves, want 2", len(match.Moves))
	}
}

// TestOnlineGateRefusesTheAllocationWhileItIsClosed covers the trusted
// allocation.
//
// A trusted allocation presents no credential, so the gate is what stops a
// match from being created while the service is not serving.
func TestOnlineGateRefusesTheAllocationWhileItIsClosed(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	planSuspension(t, fixture)

	setup := online.CreateMatchSetup{
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
	if _, err := fixture.service.CreateAllocatedMatch(ctx, presenceAlice().ref, setup, "op-gated-allocation"); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the gated allocation = %v, want %v", err, online.ErrUnavailable)
	}
	if _, err := fixture.service.GetMatch(ctx, online.AllocatedMatchID(presenceAlice().ref, "op-gated-allocation")); !errors.Is(err, online.ErrNotFound) {
		t.Fatalf("the gated allocation created a match: %v", err)
	}
}

// TestOnlineGateRefusesPresenceAndLeaseWorkWhileUnrecovered covers the
// presence and runner seams.
//
// A heartbeat, a keep waiting choice, a runner lease and the record of a
// provider request are all statements about a live service, so a service
// that is not serving refuses them.
func TestOnlineGateRefusesPresenceAndLeaseWorkWhileUnrecovered(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-gate-presence"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)
	lease, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-gate", "", version, 1))
	if err != nil {
		t.Fatalf("acquire the lease: %v", err)
	}
	planSuspension(t, fixture)

	if _, err = fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the gated heartbeat = %v, want %v", err, online.ErrUnavailable)
	}
	if _, err = fixture.service.KeepWaiting(ctx, presenceAlice().ref, matchID, online.SeatWhite); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the gated keep waiting = %v, want %v", err, online.ErrUnavailable)
	}
	if _, err = fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-gate", "", version, 1)); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the gated lease = %v, want %v", err, online.ErrUnavailable)
	}
	request := online.RunnerRequestRequest{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       matchID,
		Seat:          online.SeatBlack,
		RunnerID:      "runner-gate",
		LeaseID:       lease.LeaseID,
		RequestID:     "request-gate-01",
		ControlEpoch:  1,
		TurnVersion:   version,
	}
	if _, err = fixture.service.BeginRunnerRequest(ctx, presenceBob().ref, request); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the gated provider request = %v, want %v", err, online.ErrUnavailable)
	}
	// The reads keep working, so a client still sees its match.
	if _, err = fixture.service.GetMatch(ctx, matchID); err != nil {
		t.Fatalf("the gated read: %v", err)
	}
	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatalf("the gated presence read: %v", err)
	}
	if view.Recovered {
		t.Fatal("the presence view must report the recovering state")
	}
}

// TestOnlineGateOrdersASuspensionAfterTheRunningMutations covers the
// ordering of the gate.
//
// A mutation that is already running commits before the suspension, and the
// suspension waits for it.
func TestOnlineGateOrdersASuspensionAfterTheRunningMutations(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	// The mutation holds the shared gate lock.
	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1)`, online.GateAdvisoryKey); err != nil {
		t.Fatal(err)
	}
	planned := make(chan error, 1)
	go func() {
		started := fixture.clock.Now()
		_, err := fixture.service.PlanSuspension(ctx, started, started)
		planned <- err
	}()
	select {
	case err = <-planned:
		t.Fatalf("the suspension did not wait for the running mutation: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-planned:
		if err != nil {
			t.Fatalf("the suspension failed after the mutation committed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the suspension did not finish after the mutation committed")
	}
}

// TestOnlineGateKeepsAHealthyPeerJoinOpen covers the healthy peer join.
//
// A second instance of the service joins a healthy service, and the gate
// stays open: no epoch is pending, no suspension is planned, and no restore
// gate is waiting.
func TestOnlineGateKeepsAHealthyPeerJoinOpen(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	peer, err := online.Open(ctx, fixture.pool, moveEvaluator{}, online.WithClockSource(fixture.clock.Source()))
	if err != nil {
		t.Fatal(err)
	}
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Open {
		t.Fatalf("the gate of a healthy service = %+v, want an open gate", state)
	}
	// The peer writes an ordinary match.
	const matchID = "match-gate-peer"
	createAgentMatch(t, peer, matchID, 20*60*1000)
	if _, err = peer.Execute(ctx, presenceAlice().ref, moveOnlineCommand(matchID, "op-move-peer", online.SeatWhite, 1, "e2e4")); err != nil {
		t.Fatalf("the peer move: %v", err)
	}
}

// TestOnlineGateReopensAfterTheRecovery covers the lifecycle of the gate.
//
// The recovery completes the epoch and applies the boundary, so the gate
// opens again and the mutations are accepted.
func TestOnlineGateReopensAfterTheRecovery(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-gate-recovery"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	planSuspension(t, fixture)
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if state.Open {
		t.Fatal("the gate must be closed while the suspension is pending")
	}
	// The recovery applies the planned boundary.
	if _, err = fixture.service.RecoverFromInterruption(ctx); err != nil {
		t.Fatalf("recover: %v", err)
	}
	state, err = online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Open {
		t.Fatalf("the gate after the recovery = %+v, want an open gate", state)
	}
	if _, err = fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatalf("the heartbeat after the recovery: %v", err)
	}
	// The recovery published the adjusted state, so the move uses the
	// version the recovery produced.
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, moveOnlineCommand(matchID, "op-move-after-recovery", online.SeatWhite, match.Version, "g1f3")); err != nil {
		t.Fatalf("the move after the recovery: %v", err)
	}
}

// TestOnlineGateRefusesAnAllocationOfARemovedParticipant covers the removal
// fence of the trusted allocation.
//
// A trusted allocation presents no credential, so the removal ledger and the
// account deletions decide whether a participant may still receive a seat.
func TestOnlineGateRefusesAnAllocationOfARemovedParticipant(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	// The account of the second participant was removed.
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,live_delete_due_at,recovery_sanitize_due_at)
VALUES('rm_gate_0001','account','user_b','account_deletion','verified',clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp())`); err != nil {
		t.Fatalf("record the removal request: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_account_deletions(deletion_id,account_id,requested_at,applied_at,removal_id)
VALUES('rd_gate_0001','user_b',clock_timestamp(),clock_timestamp(),'rm_gate_0001')`); err != nil {
		t.Fatalf("record the account deletion: %v", err)
	}
	setup := online.CreateMatchSetup{
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
	if _, err := fixture.service.CreateAllocatedMatch(ctx, presenceAlice().ref, setup, "op-removed-allocation"); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("the allocation of a removed participant = %v, want %v", err, online.ErrNotAuthorized)
	}
	if _, err := fixture.service.GetMatch(ctx, online.AllocatedMatchID(presenceAlice().ref, "op-removed-allocation")); !errors.Is(err, online.ErrNotFound) {
		t.Fatalf("the allocation of a removed participant created a match: %v", err)
	}
	// A participant that was not removed is allocated normally.
	setup.Seats.Black.Participant = online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_c"}
	if _, err := fixture.service.CreateAllocatedMatch(ctx, presenceAlice().ref, setup, "op-open-allocation"); err != nil {
		t.Fatalf("the allocation of a live participant: %v", err)
	}
}
