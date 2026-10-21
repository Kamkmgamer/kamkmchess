package integration

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
	"github.com/jackc/pgx/v5/pgxpool"
)

// One outage, one interruption.
//
// The real monitor of the production composition runs against two instances
// of the service on one database. One instance has a broken rules process and
// the other one has a working one. The outage of the broken instance must be
// one interruption, one service epoch, one refund and one round of lease
// fencing, no matter how often the healthy instance recovers it.
//
// The controls are the two cases around it: the observation that arrives
// after the recovery of the peer plans nothing, and a failure after the
// dependency of the broken instance answered again is a new outage.

// outageEvaluator is the rules process of one instance. It is healthy until
// it is broken.
type outageEvaluator struct {
	moveEvaluator
	broken  atomic.Bool
	entered chan struct{}
	release <-chan struct{}
}

func (e *outageEvaluator) ValidateSetup(ctx context.Context, input online.RulesInput) error {
	if e.broken.Load() {
		return errors.New("the rules process is down")
	}
	return e.moveEvaluator.ValidateSetup(ctx, input)
}

func (e *outageEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	if e.broken.Load() {
		if e.entered != nil {
			close(e.entered)
			select {
			case <-e.release:
			case <-ctx.Done():
				return online.Candidate{}, ctx.Err()
			}
		}
		return online.Candidate{}, errors.New("the rules process is down")
	}
	return e.moveEvaluator.Evaluate(ctx, input)
}

// A request that was already evaluating when a peer recovered belongs to the
// earlier outage. Its late failure must not suspend the recovered epoch again.
func TestOnlineFailedRequestKeepsTheEpochBeforeItsEvaluation(t *testing.T) {
	evaluator := &outageEvaluator{}
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const matchID = "match-deferred-outage"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	evaluator.entered = make(chan struct{})
	release := make(chan struct{})
	evaluator.release = release
	evaluator.broken.Store(true)
	done := make(chan error, 1)
	go func() {
		_, moveErr := fixture.service.Execute(ctx, presenceAlice().ref,
			moveOnlineCommand(matchID, "op-deferred-outage", online.SeatWhite, before.Version, "g1f3"))
		done <- moveErr
	}()
	select {
	case <-evaluator.entered:
	case <-ctx.Done():
		t.Fatal("the participant request never entered the rules evaluation")
	}
	if _, err = fixture.service.PlanSuspension(ctx, fixture.clock.Now(), fixture.clock.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.service.RecoverFromInterruption(ctx); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err = <-done; !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the deferred evaluation returned %v, want unavailable", err)
	}
	if err = fixture.service.SuspendForDependency(ctx, online.DependencyRules); err != nil {
		t.Fatal(err)
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE adjusted_at IS NULL`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("pending boundaries = %d after a deferred failure of the recovered outage, want none", pending)
	}
}

// TestOnlineAStalePlanOfAFailedRequestFindsTheBoundaryOfTheOutage covers
// the identity of the episode of a failed participant request.
//
// A request that fails against the rules process is an observation of the
// outage, so it identifies the episode with the epoch of the outage. The
// interruption that follows is the one of that epoch: a plan that arrives
// after the recovery of a peer finds the boundary of the outage and plans
// nothing, so the clock of the unfinished matches is not refunded twice.
func TestOnlineAStalePlanOfAFailedRequestFindsTheBoundaryOfTheOutage(t *testing.T) {
	evaluator := &outageEvaluator{}
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx := context.Background()
	const matchID = "match-stale-plan"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}

	// The rules process of this instance breaks, and a participant request
	// fails against it.
	evaluator.broken.Store(true)
	_, err = fixture.service.Execute(ctx, presenceAlice().ref,
		moveOnlineCommand(matchID, "op-move-stale-plan", online.SeatWhite, before.Version, "g1f3"))
	if !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the move against a broken worker = %v, want %v", err, online.ErrUnavailable)
	}

	// A peer recovers an interruption of the same outage, so the epoch of
	// the service moves.
	if _, err = fixture.service.PlanSuspension(ctx, fixture.clock.Now(), fixture.clock.Now()); err != nil {
		t.Fatalf("plan the interruption of the peer: %v", err)
	}
	if _, err = fixture.service.RecoverFromInterruption(ctx); err != nil {
		t.Fatalf("recover the interruption of the peer: %v", err)
	}

	// The monitor of this instance plans the interruption of the outage. The
	// boundary of the outage exists, so the plan finds it and plans nothing.
	if err = fixture.service.SuspendForDependency(ctx, online.DependencyRules); err != nil {
		t.Fatalf("suspend the dependency: %v", err)
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE adjusted_at IS NULL`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("pending boundaries = %d after the recovery of the peer, want none", pending)
	}
}

// TestOnlineTheSharedHealthRecoversWhenAHealthyPeerAnswers covers the shared
// health of the rules dependency.
//
// The shared state is the newest checkpoint of every dependency, so the
// failure of one instance closes the claim path of every match of the
// deployment. A healthy instance that answers again restores it: the refresh
// is not a claim that every instance is healthy, the broken instance keeps
// its own state and its own claim path closed.
func TestOnlineTheSharedHealthRecoversWhenAHealthyPeerAnswers(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	broken := &outageEvaluator{}
	broken.broken.Store(true)
	working := &outageEvaluator{}
	// Every instance keeps its own reporter, and the durable checkpoints of
	// the dependency are shared.
	brokenHealth := online.NewHealthReporter(fixture.pool)
	workingHealth := online.NewHealthReporter(fixture.pool)
	brokenService, err := online.Open(ctx, fixture.pool, broken, online.WithHealthReporter(brokenHealth))
	if err != nil {
		t.Fatalf("open the broken instance: %v", err)
	}
	workingService, err := online.Open(ctx, fixture.pool, working, online.WithHealthReporter(workingHealth))
	if err != nil {
		t.Fatalf("open the working instance: %v", err)
	}

	// The healthy instance answers first, so the shared state is healthy.
	if err = workingService.ProbeRules(ctx); err != nil {
		t.Fatalf("the probe of the healthy worker: %v", err)
	}
	// The broken instance records the failure.
	if err = brokenService.ProbeRules(ctx); err == nil {
		t.Fatal("the probe of a broken worker answered")
	}
	shared, err := workingHealth.SharedState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if shared != online.HealthDegraded {
		t.Fatalf("the shared state = %q while one instance is degraded, want %q", shared, online.HealthDegraded)
	}

	// The healthy instance answers again. The shared state is restored, so
	// the claim path of the healthy instances opens again.
	if err = workingService.ProbeRules(ctx); err != nil {
		t.Fatalf("the probe of the healthy worker: %v", err)
	}
	shared, err = workingHealth.SharedState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if shared != online.HealthHealthy {
		t.Fatalf("the shared state = %q after the healthy peer answered, want %q", shared, online.HealthHealthy)
	}
	// The broken instance keeps its own state, so its own claim path stays
	// closed.
	local, err := brokenService.Health(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if local.Rules.State != online.HealthDegraded {
		t.Fatalf("the local state of the broken instance = %q, want %q", local.Rules.State, online.HealthDegraded)
	}
}

// TestOnlineAFailedHealthReportIsRetriedByTheNextSuccess covers the retry of
// a report that failed.
//
// The durable report of the dependency is a database write, and it happens
// while the episode of the instance is guarded, so it is bounded by a short
// budget. A write that could not happen leaves the durable state of the
// dependency unchanged, so the next success writes the checkpoint and
// refreshes the liveness of the service.
func TestOnlineAFailedHealthReportIsRetriedByTheNextSuccess(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()

	// The reporter writes on a pool with one connection, and the connection
	// is held by the test, so the first report cannot happen.
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
	blocked, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open the blocked pool: %v", err)
	}
	defer blocked.Close()
	held, err := blocked.Acquire(ctx)
	if err != nil {
		t.Fatalf("hold the only connection: %v", err)
	}
	defer held.Release()

	reporter := online.NewHealthReporter(blocked)
	service, err := online.Open(ctx, fixture.pool, moveEvaluator{}, online.WithHealthReporter(reporter))
	if err != nil {
		t.Fatalf("open the service: %v", err)
	}

	// The first success cannot write its checkpoint: the pool has no free
	// connection. The report is bounded, so the observation returns.
	if err = service.ProbeRules(ctx); err != nil {
		t.Fatalf("the probe of the healthy worker: %v", err)
	}
	var checkpoints int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE dependency=$1`, online.DependencyRules).Scan(&checkpoints); err != nil {
		t.Fatal(err)
	}
	if checkpoints != 0 {
		t.Fatalf("the checkpoints of the dependency = %d while the pool was blocked, want none", checkpoints)
	}

	// The pool is free again, so the next success writes the checkpoint and
	// refreshes the liveness.
	held.Release()
	if err = service.ProbeRules(ctx); err != nil {
		t.Fatalf("the probe of the healthy worker: %v", err)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE dependency=$1 AND state=$2`, online.DependencyRules, string(online.HealthHealthy)).Scan(&checkpoints); err != nil {
		t.Fatal(err)
	}
	if checkpoints != 1 {
		t.Fatalf("the healthy checkpoints of the dependency = %d after the retry, want 1", checkpoints)
	}
	var liveness time.Time
	if err = fixture.pool.QueryRow(ctx, `SELECT last_seen_at FROM online_service_liveness WHERE singleton`).Scan(&liveness); err != nil {
		t.Fatalf("read the liveness: %v", err)
	}
	if age := time.Since(liveness.UTC()); age > time.Minute {
		t.Fatalf("the liveness is %s old after the retry, want a fresh record", age)
	}
}

// TestOnlineMonitorPlansOneInterruptionForOneOutage covers the outage of one
// broken worker with the real monitor.
//
// The instance with the broken worker plans the interruption of the outage.
// The instance with the working worker recovers it, because its own worker
// answers, and the outage is over for it. The broken instance must not plan
// the outage again: the interruption of an outage is planned once.
func TestOnlineMonitorPlansOneInterruptionForOneOutage(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-monitor-outage"
	// The player of the match and the two instances of the service use the
	// clock of the database, so the interruption and the clock of the match
	// are measured with the same clock.
	player, err := online.Open(ctx, fixture.pool, moveEvaluator{})
	if err != nil {
		t.Fatalf("open the player: %v", err)
	}
	createAgentMatch(t, player, matchID, 20*60*1000)
	acceptMoves(t, player, matchID)
	before, err := player.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := *before.Clock.DeadlineAt

	// The two instances of the service. The rules process of the first one
	// is broken, the one of the second one works.
	broken := &outageEvaluator{}
	broken.broken.Store(true)
	working := &outageEvaluator{}
	brokenHealth := online.NewHealthReporter(fixture.pool)
	workingHealth := online.NewHealthReporter(fixture.pool)
	brokenService, err := online.Open(ctx, fixture.pool, broken, online.WithHealthReporter(brokenHealth))
	if err != nil {
		t.Fatalf("open the broken instance: %v", err)
	}
	workingService, err := online.Open(ctx, fixture.pool, working, online.WithHealthReporter(workingHealth))
	if err != nil {
		t.Fatalf("open the working instance: %v", err)
	}

	// The real monitor of the production composition, with the interval of
	// the fixture.
	stopBroken := serverapp.StartHealthMonitor(ctx, fixture.pool, brokenHealth, brokenService, serverapp.HealthMonitorConfig{Interval: 100 * time.Millisecond})
	defer stopBroken()
	stopWorking := serverapp.StartHealthMonitor(ctx, fixture.pool, workingHealth, workingService, serverapp.HealthMonitorConfig{Interval: 100 * time.Millisecond})
	defer stopWorking()

	// The runner lease of a peer is fenced by the recovery of the outage.
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO online_runner_leases(lease_id,match_id,seat,control_epoch,generation,runner_id,status,acquired_at,expires_at,runner_epoch)
VALUES('lease-monitor-0001',$1,'black',1,2,'runner-monitor','active',clock_timestamp(),clock_timestamp()+interval '15 seconds',1)`, matchID); err != nil {
		t.Fatalf("write the runner lease: %v", err)
	}

	// The monitor of the broken instance plans the interruption, and the
	// monitor of the working instance recovers it. The cycle must not
	// repeat.
	time.Sleep(2 * time.Second)

	var boundaries int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE kind='planned'`).Scan(&boundaries); err != nil {
		t.Fatal(err)
	}
	if boundaries != 1 {
		t.Fatalf("planned interruptions = %d for one broken worker, want exactly 1", boundaries)
	}
	var epochs int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs`).Scan(&epochs); err != nil {
		t.Fatal(err)
	}
	if epochs != 1 {
		t.Fatalf("service epochs = %d for one outage, want exactly 1", epochs)
	}
	var adjustments int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1`, matchID).Scan(&adjustments); err != nil {
		t.Fatal(err)
	}
	// The clock is refunded once for the outage. A refund of zero is a
	// valid answer when the outage was shorter than a millisecond.
	if adjustments > 1 {
		t.Fatalf("the adjustments of the clock = %d for one outage, want at most 1", adjustments)
	}
	var events int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='recovery_adjustment'`, matchID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events > 1 {
		t.Fatalf("the recovery events = %d for one outage, want at most 1", events)
	}
	recovered, err := player.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Clock.DeadlineAt == nil {
		t.Fatal("the recovered match has no deadline")
	}
	if moved := recovered.Clock.DeadlineAt.Sub(beforeDeadline); moved < 0 {
		t.Fatalf("the clock of the unfinished match moved by %v, want the interruption of the outage", moved)
	}
	var status string
	if err = fixture.pool.QueryRow(ctx, `SELECT status FROM online_runner_leases WHERE lease_id='lease-monitor-0001'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "revoked" {
		t.Fatalf("the runner lease of the peer = %q, want the fence of the outage", status)
	}

	// The control: the rules process of the broken instance answers again,
	// so its failure episode is over. The next failure is a new outage and
	// it is planned with a new interruption and a new epoch.
	broken.broken.Store(false)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if err = brokenService.ProbeRules(ctx); err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err = brokenService.ProbeRules(ctx); err != nil {
		t.Fatalf("the probe of the repaired worker: %v", err)
	}
	broken.broken.Store(true)
	deadline = time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE kind='planned'`).Scan(&boundaries); err != nil {
			t.Fatal(err)
		}
		if boundaries == 2 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if boundaries != 2 {
		t.Fatalf("planned interruptions = %d after the repair and a new outage, want 2", boundaries)
	}
}
