package integration

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The traffic of a closed gate.
//
// The authoritative gate check is inside the acceptance transaction of a
// mutation, so a refused move would still evaluate its proposal with the
// rules process. The refused traffic must not use the worker: it would start
// a cold worker and it would hold the slot that the repair of the closed
// gate needs.

// countingEvaluator counts the evaluations of the rules process.
type countingEvaluator struct {
	moveEvaluator
	evaluations atomic.Int64
	setups      atomic.Int64
}

func (e *countingEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	e.evaluations.Add(1)
	return e.moveEvaluator.Evaluate(ctx, input)
}

func (e *countingEvaluator) ValidateSetup(ctx context.Context, input online.RulesInput) error {
	e.setups.Add(1)
	return e.moveEvaluator.ValidateSetup(ctx, input)
}

// TestOnlineGateRefusesAMoveWithoutUsingTheWorker covers the traffic of a
// closed gate.
//
// The move is refused, and the rules process is never asked: the refused
// traffic may not warm a cold worker, and it may not take the slot that the
// repair of the closed gate needs.
func TestOnlineGateRefusesAMoveWithoutUsingTheWorker(t *testing.T) {
	evaluator := &countingEvaluator{}
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx := context.Background()
	const matchID = "match-gate-traffic"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)
	before := evaluator.evaluations.Load()

	// The service is suspended, so the durable gate is closed.
	planSuspension(t, fixture)
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if state.Open {
		t.Fatalf("the gate = %+v after the suspension, want a closed gate", state)
	}

	command := moveOnlineCommand(matchID, "op-move-gated-traffic", online.SeatWhite, version, "g1f3")
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, command); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the move of a closed gate = %v, want %v", err, online.ErrUnavailable)
	}
	if got := evaluator.evaluations.Load(); got != before {
		t.Fatalf("the evaluations = %d for a refused move, want %d", got, before)
	}
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Version != version {
		t.Fatalf("the refused move advanced the match to version %d, want %d", match.Version, version)
	}
}

// TestOnlineGateRefusesACreateWithoutUsingTheWorker covers the creation of a
// closed gate.
//
// The creation validates its immutable setup with the rules process before the
// acceptance transaction takes the gate lock, so the refused creation would
// ask the worker first. The refused traffic must not use the worker: a closed
// gate must not start a cold worker, and it must not hold the slot that the
// repair of the closed gate needs.
func TestOnlineGateRefusesACreateWithoutUsingTheWorker(t *testing.T) {
	evaluator := &countingEvaluator{}
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx := context.Background()
	const matchID = "match-gate-create"

	// The service is suspended, so the durable gate is closed.
	planSuspension(t, fixture)
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if state.Open {
		t.Fatalf("the gate = %+v after the suspension, want a closed gate", state)
	}
	before := evaluator.setups.Load()

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
				TimeControl: online.TimeControl{StartingTimeMs: 20 * 60 * 1000, IncrementMs: 0},
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
			},
		},
	}
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, command); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the create of a closed gate = %v, want %v", err, online.ErrUnavailable)
	}
	if got := evaluator.setups.Load(); got != before {
		t.Fatalf("the setup evaluations = %d for a refused create, want %d: the refused create still asked the rules process", got, before)
	}
	var matches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, matchID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 0 {
		t.Fatalf("the refused create wrote %d matches", matches)
	}
}
