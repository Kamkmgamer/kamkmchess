package integration

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The planned interruption of one outage, under the gate lock.
//
// The plan of a boundary holds the exclusive gate lock and a connection of
// the pool. A read of the pending boundary on a second connection would wait
// for a free one, so a pool without one would block the plan that holds the
// only connection.
//
// The observation of a failure is fenced by the epoch it happened in: an
// interruption that was recovered after the observation opened a new epoch,
// so the observation belongs to an interruption that is already over.

// armedEvaluator fails every evaluation when it is armed.
//
// The fixture plays the match with a healthy worker and arms the evaluator
// afterwards, so the observation of the broken worker is the observation of
// this instance.
type armedEvaluator struct {
	moveEvaluator
	broken atomic.Bool
}

func (e *armedEvaluator) ValidateSetup(ctx context.Context, input online.RulesInput) error {
	if e.broken.Load() {
		return errors.New("the rules process is down")
	}
	return e.moveEvaluator.ValidateSetup(ctx, input)
}

func (e *armedEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	if e.broken.Load() {
		return online.Candidate{}, errors.New("the rules process is down")
	}
	return e.moveEvaluator.Evaluate(ctx, input)
}

// TestOnlinePlanOfAPendingBoundaryDoesNotNeedASecondConnection covers the
// bounded pool.
//
// The pool has one connection. The plan of the pending boundary holds it
// under the gate lock, so a read on a second connection would wait for a
// free one that never comes.
func TestOnlinePlanOfAPendingBoundaryDoesNotNeedASecondConnection(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	// The bounded pool reads the same schema as the fixture and has one
	// connection, so the plan cannot take a second one.
	var schema string
	if err := fixture.pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(os.Getenv(databaseEnv))
	if err != nil {
		t.Fatal(err)
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = map[string]string{}
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.MaxConns = 1
	config.MinConns = 1
	bounded, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open the bounded pool: %v", err)
	}
	defer bounded.Close()

	service, err := online.Open(ctx, bounded, moveEvaluator{})
	if err != nil {
		t.Fatalf("open the service: %v", err)
	}
	started := fixture.clock.Now()
	if _, err = service.PlanSuspension(ctx, started, started); err != nil {
		t.Fatalf("plan the interruption: %v", err)
	}
	// The second plan finds the pending boundary. It holds the only
	// connection of the pool, so it may not need a second one.
	done := make(chan error, 1)
	go func() {
		_, err := service.PlanSuspension(ctx, started, started)
		done <- err
	}()
	select {
	case err = <-done:
		if err != nil {
			t.Fatalf("the plan of the pending boundary failed: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the plan of the pending boundary waited for a second connection")
	}
	var pending int
	if err = bounded.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE adjusted_at IS NULL`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("pending boundaries = %d, want exactly 1", pending)
	}
}

// TestOnlineStaleObservationIsNotPlannedAgain covers the observation that
// arrives after the recovery of a peer.
//
// The observation of the broken worker is fenced by the epoch it happened in.
// The peer recovers the interruption and opens a new epoch, so the
// observation belongs to an interruption that is already over: planning it
// again would open a second epoch, refund the clock a second time and fence
// the runner leases of the peers.
//
// The control is the true subsequent outage: a failure in the current epoch
// is planned, so the fence never hides a real outage.
func TestOnlineStaleObservationIsNotPlannedAgain(t *testing.T) {
	evaluator := &armedEvaluator{}
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx := context.Background()
	const matchID = "match-stale-observation"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := *before.Clock.DeadlineAt

	// The worker of this instance is broken, so the probe fails and the
	// observation is fenced by the epoch it happened in.
	evaluator.broken.Store(true)
	if err = fixture.service.ProbeRules(ctx); err == nil {
		t.Fatal("the probe of a broken worker answered")
	}
	epoch, err := fixture.service.ServiceEpoch(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// The peer recovers an interruption, so a new epoch is opened.
	if _, err = fixture.service.PlanSuspension(ctx, before.UpdatedAt, before.UpdatedAt); err != nil {
		t.Fatalf("plan the interruption of the peer: %v", err)
	}
	if _, err = fixture.service.RecoverFromInterruption(ctx); err != nil {
		t.Fatalf("recover the interruption of the peer: %v", err)
	}
	recovered, err := fixture.service.ServiceEpoch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if recovered == epoch {
		t.Fatalf("the epoch of the service = %d after the recovery of the peer, want a new epoch", recovered)
	}
	// The runner lease of a peer survives the stale observation.
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO online_runner_leases(lease_id,match_id,seat,control_epoch,generation,runner_id,status,acquired_at,expires_at,runner_epoch)
VALUES('lease-stale-0001',$1,'black',1,2,'runner-stale','active',clock_timestamp(),clock_timestamp()+interval '15 seconds',1)`, matchID); err != nil {
		t.Fatalf("write the runner lease: %v", err)
	}

	// The monitor of this instance plans the interruption of the stale
	// observation. The interruption of the peer is already over, so nothing
	// is planned.
	if err = fixture.service.SuspendForDependency(ctx, online.DependencyRules); err != nil {
		t.Fatalf("suspend the dependency: %v", err)
	}
	var planned int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE adjusted_at IS NULL`).Scan(&planned); err != nil {
		t.Fatal(err)
	}
	if planned != 0 {
		t.Fatalf("pending boundaries = %d after a stale observation, want none", planned)
	}
	var epochs int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs`).Scan(&epochs); err != nil {
		t.Fatal(err)
	}
	if epochs != 1 {
		t.Fatalf("epochs opened = %d after a stale observation, want the epoch of the peer only", epochs)
	}
	var status string
	if err = fixture.pool.QueryRow(ctx, `SELECT status FROM online_runner_leases WHERE lease_id='lease-stale-0001'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "active" {
		t.Fatalf("the runner lease of the peer = %q after a stale observation, want %q", status, "active")
	}
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Clock.DeadlineAt == nil || !after.Clock.DeadlineAt.Equal(beforeDeadline) {
		t.Fatalf("the clock of the unfinished match moved from %v to %v", beforeDeadline, after.Clock.DeadlineAt)
	}

	// The control: the dependency of this instance answers again, so its
	// failure episode is over. A failure after that answer is a new outage,
	// and it is planned with a new interruption.
	evaluator.broken.Store(false)
	if err = fixture.service.ProbeRules(ctx); err != nil {
		t.Fatalf("the probe of the repaired worker: %v", err)
	}
	evaluator.broken.Store(true)
	if err = fixture.service.ProbeRules(ctx); err == nil {
		t.Fatal("the probe of a broken worker answered")
	}
	if err = fixture.service.SuspendForDependency(ctx, online.DependencyRules); err != nil {
		t.Fatalf("suspend the dependency: %v", err)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE adjusted_at IS NULL`).Scan(&planned); err != nil {
		t.Fatal(err)
	}
	if planned != 1 {
		t.Fatalf("pending boundaries = %d for a true outage, want exactly 1", planned)
	}
}

// TestOnlineRecoveryOfABoundaryThatStartsInTheFutureIsClamped covers the
// interval of a boundary that starts after the resume.
//
// The clock of the database may move backwards, and the explicit planning of
// an administrator may name a start in the future. The interval of an
// interruption is never negative, so the recovery clamps it instead of
// failing with a constraint violation that would keep the gate closed for
// good.
func TestOnlineRecoveryOfABoundaryThatStartsInTheFutureIsClamped(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	// The boundary starts after the resume.
	future := time.Now().UTC().Add(30 * time.Second)
	if _, err := fixture.service.PlanSuspension(ctx, future, future); err != nil {
		t.Fatalf("plan the interruption: %v", err)
	}
	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("the recovery of a boundary that starts in the future failed: %v", err)
	}
	if plan.InterruptionMs != 0 {
		t.Fatalf("the interruption = %d ms, want the empty interval", plan.InterruptionMs)
	}
	// The gate is open again, so the service serves.
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Open {
		t.Fatalf("the gate = %+v after the recovery, want an open gate", state)
	}
}
