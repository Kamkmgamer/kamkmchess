package integration

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The durable reporter of the health boundary.
//
// The reporter is written by the observations of the instance, and the
// observations of the request paths are written by the monitor. The durable
// state of a dependency is the state of the last checkpoint that was
// written, so a report that failed is written again by the next flush.

// TestOnlineTheReporterWritesThePendingObservationsOnce covers the flush of
// the reporter.
//
// The observations of the request paths are remembered and not written. The
// flush writes them once, and the second flush writes nothing, so a healthy
// service does not grow a checkpoint row on every tick.
func TestOnlineTheReporterWritesThePendingObservationsOnce(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	reporter := online.NewHealthReporter(fixture.pool)

	reporter.Record(online.DependencyRules, online.HealthHealthy, "the rules process answered")
	var checkpoints int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE dependency=$1`, online.DependencyRules).Scan(&checkpoints); err != nil {
		t.Fatal(err)
	}
	if checkpoints != 0 {
		t.Fatalf("the checkpoints of the dependency = %d before the flush, want none", checkpoints)
	}
	reporter.Flush(ctx)
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE dependency=$1`, online.DependencyRules).Scan(&checkpoints); err != nil {
		t.Fatal(err)
	}
	if checkpoints != 1 {
		t.Fatalf("the checkpoints of the dependency = %d after the flush, want 1", checkpoints)
	}
	// The second flush writes nothing: the durable state is the observation.
	reporter.Flush(ctx)
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE dependency=$1`, online.DependencyRules).Scan(&checkpoints); err != nil {
		t.Fatal(err)
	}
	if checkpoints != 1 {
		t.Fatalf("the checkpoints of the dependency = %d after the second flush, want 1", checkpoints)
	}
}

// TestOnlineTheMigrationBackfillsTheOrderOfTheExistingCheckpoints covers the
// upgrade of the health checkpoints.
//
// The rows that existed before the order existed are backfilled by their
// recorded_at and their identity, so the newest of them stays the newest. A
// checkpoint without an order sorts before every ordered checkpoint in a
// descending order, so it would be read as the newest one for ever.
func TestOnlineTheMigrationBackfillsTheOrderOfTheExistingCheckpoints(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	// The schema of the release before the order existed.
	names, err := filepath.Glob("../migrations/00*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	for _, name := range names {
		if strings.Contains(name, "0020_") {
			continue
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	// The checkpoints of that release: a healthy one and a degraded one that
	// was written later.
	if _, err = pool.Exec(ctx, `INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at) VALUES
('chk-upgrade-healthy-01',$1,'healthy','the rules process answered','2026-01-01T00:00:00Z'),
('chk-upgrade-degraded-01',$1,'degraded','the rules process did not answer','2026-01-01T00:00:10Z')`, online.DependencyRules); err != nil {
		t.Fatalf("write the checkpoints of the old release: %v", err)
	}
	// The order of the release that carries the order.
	raw, err := os.ReadFile("../migrations/0020_online_health_order.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(raw)); err != nil {
		t.Fatalf("apply the order of the checkpoints: %v", err)
	}
	// Every checkpoint has an order, and the order follows the recorded_at.
	var without int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE observation_order IS NULL`).Scan(&without); err != nil {
		t.Fatal(err)
	}
	if without != 0 {
		t.Fatalf("the checkpoints without an order = %d after the upgrade, want none", without)
	}
	reporter := online.NewHealthReporter(pool)
	shared, err := reporter.SharedState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if shared != online.HealthDegraded {
		t.Fatalf("the shared state = %q after the upgrade, want the newest checkpoint %q", shared, online.HealthDegraded)
	}
	// The sequence continues above the backfilled orders.
	var next int64
	if err = pool.QueryRow(ctx, `SELECT nextval('online_service_health_order')`).Scan(&next); err != nil {
		t.Fatal(err)
	}
	var greatest int64
	if err = pool.QueryRow(ctx, `SELECT max(observation_order) FROM online_service_health`).Scan(&greatest); err != nil {
		t.Fatal(err)
	}
	if next <= greatest {
		t.Fatalf("the next order = %d and the greatest order = %d, want the sequence above the backfilled orders", next, greatest)
	}
}

// TestOnlineTheSharedStateFollowsTheOrderAndNotTheClock covers the durable
// order of the checkpoints.
//
// The order of the checkpoints is the order of the observations, so the
// newest checkpoint of a dependency is the one with the greatest order, even
// when two checkpoints carry the same moment and when a later checkpoint
// carries an earlier one.
func TestOnlineTheSharedStateFollowsTheOrderAndNotTheClock(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	// Two checkpoints with the same moment, and one with a moment that lies
	// in the past. The order is what decides.
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at,observation_order) VALUES
('chk_order_same_01',$1,'degraded','the first observation','2026-01-01T00:00:00Z',nextval('online_service_health_order')),
('chk_order_same_02',$1,'healthy','the second observation','2026-01-01T00:00:00Z',nextval('online_service_health_order')),
('chk_order_back_03',$1,'degraded','the third observation','2025-01-01T00:00:00Z',nextval('online_service_health_order'))`, online.DependencyRules); err != nil {
		t.Fatalf("write the checkpoints: %v", err)
	}
	shared, err := fixture.health.SharedState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if shared != online.HealthDegraded {
		t.Fatalf("the shared state = %q, want the state of the greatest order %q", shared, online.HealthDegraded)
	}
	// The refresh decision uses the same order: the shared state is worse
	// than a healthy observation, so a healthy observation is written.
	reporter := online.NewHealthReporter(fixture.pool)
	// The refresh publishes the observation of the instance, so the
	// instance has to have observed the dependency.
	reporter.Record(online.DependencyRules, online.HealthHealthy, "the rules process answered")
	if err = reporter.RefreshDependency(ctx, online.DependencyRules, online.HealthHealthy, "the rules process answered"); err != nil {
		t.Fatalf("refresh the shared state: %v", err)
	}
	rows, err := fixture.pool.Query(ctx, `SELECT checkpoint_id,state,recorded_at,observation_order FROM online_service_health ORDER BY observation_order`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, state string
		var at time.Time
		var order int64
		if err = rows.Scan(&id, &state, &at, &order); err != nil {
			t.Fatal(err)
		}
	}
	rows.Close()
	shared, err = reporter.SharedState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if shared != online.HealthHealthy {
		t.Fatalf("the shared state = %q after the refresh, want %q", shared, online.HealthHealthy)
	}
}

// blockedMarker marks the context of the writer that waits for the barrier.
type blockedMarker struct{}

// barrierPool opens a pool whose acquisition waits for a release when the
// context of the caller carries the marker.
//
// The barrier is an arrival barrier of the pool itself, so the order of the two
// writers is decided by the test and not by a sleep.
func barrierPool(t *testing.T, schema string) (*pgxpool.Pool, chan struct{}) {
	t.Helper()
	config, err := pgxpool.ParseConfig(os.Getenv(databaseEnv))
	if err != nil {
		t.Fatal(err)
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = map[string]string{}
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.MaxConns = 2
	config.MinConns = 1
	release := make(chan struct{})
	config.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
		if ctx.Value(blockedMarker{}) != nil {
			<-release
		}
		return true
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatalf("open the barrier pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, release
}

// TestOnlineAHealthySnapshotCannotBorrowTheNewFailureRevision covers the
// healthy snapshot of a flush.
//
// The flush captures the healthy observations of the instance, and the
// capture happens while a refresh of another dependency waits for the pool. A
// failure of the dependency arrives in the meantime, and the refresh of the
// captured snapshot must not publish the healthy state with the revision of
// that failure.
func TestOnlineAHealthySnapshotCannotBorrowTheNewFailureRevision(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	var schema string
	if err := fixture.pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	pool, release := barrierPool(t, schema)
	reporter := online.NewHealthReporter(pool)

	// The healthy observations of both dependencies are flushed and
	// acknowledged.
	reporter.Record(online.DependencyDatabase, online.HealthHealthy, "the database answered")
	reporter.Record(online.DependencyRules, online.HealthHealthy, "the rules process answered")
	reporter.Flush(ctx)

	// The old flush captures the healthy observations and waits for the pool
	// with the first refresh.
	oldFlush := make(chan struct{})
	blocked := context.WithValue(ctx, blockedMarker{}, "old flush")
	go func() {
		defer close(oldFlush)
		reporter.Flush(blocked)
	}()

	// The failure of the rules dependency arrives and is flushed.
	reporter.Record(online.DependencyRules, online.HealthDegraded, "the rules process did not answer")
	reporter.Flush(ctx)
	close(release)
	<-oldFlush
	reporter.Flush(ctx)

	shared, err := reporter.SharedState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if shared != online.HealthDegraded {
		t.Fatalf("the shared state = %q, want the failure of the rules dependency %q", shared, online.HealthDegraded)
	}
	local := reporter.Current()
	if local.Rules.State != online.HealthDegraded {
		t.Fatalf("the local state of the rules dependency = %q, want %q", local.Rules.State, online.HealthDegraded)
	}
}

// TestOnlineAnOldFlushCannotOverwriteANewerObservation covers the reversed
// completion of two flushes.
//
// The older flush waits for the pool while the newer observation is flushed
// and acknowledged. The older flush must not write its answer: the
// acknowledgement removed the pending observation, so the guard has to compare
// against the lifetime of the observations.
func TestOnlineAnOldFlushCannotOverwriteANewerObservation(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		older   online.HealthState
		newer   online.HealthState
		blocked string
	}{
		{name: "the older flush is healthy", older: online.HealthHealthy, newer: online.HealthDegraded},
		{name: "the older flush is degraded", older: online.HealthDegraded, newer: online.HealthHealthy},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newPresenceFixture(t)
			ctx := context.Background()
			var schema string
			if err := fixture.pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
				t.Fatal(err)
			}
			pool, release := barrierPool(t, schema)
			reporter := online.NewHealthReporter(pool)

			// The older observation waits for the pool.
			reporter.Record(online.DependencyRules, testCase.older, "the older observation")
			older := make(chan struct{})
			blocked := context.WithValue(ctx, blockedMarker{}, "older")
			go func() {
				defer close(older)
				reporter.Flush(blocked)
			}()
			// The newer observation is flushed and acknowledged while the
			// older one waits.
			reporter.Record(online.DependencyRules, testCase.newer, "the newer observation")
			reporter.Flush(ctx)
			close(release)
			<-older
			// The newer observation survives the older flush.
			reporter.Flush(ctx)

			shared, err := reporter.SharedState(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if shared != testCase.newer {
				t.Fatalf("the shared state = %q, want the newer observation %q", shared, testCase.newer)
			}
			local := reporter.Current()
			if local.Rules.State != testCase.newer {
				t.Fatalf("the local state = %q, want the newer observation %q", local.Rules.State, testCase.newer)
			}
			var newest string
			if err = fixture.pool.QueryRow(ctx, `SELECT state FROM online_service_health WHERE dependency=$1 ORDER BY observation_order DESC LIMIT 1`, online.DependencyRules).Scan(&newest); err != nil {
				t.Fatal(err)
			}
			if newest != string(testCase.newer) {
				t.Fatalf("the newest checkpoint = %q, want the newer observation %q", newest, string(testCase.newer))
			}
		})
	}
}

// TestOnlineALegalMoveDoesNotWaitForTheDurableWriteOfTheMonitor covers the
// episode guard and the durable write.
//
// The monitor holds the durable write of its observation, and a legal move of
// a healthy worker must not wait for it: the decision and the local
// observation are one step under the guard, and the write happens after it.
func TestOnlineALegalMoveDoesNotWaitForTheDurableWriteOfTheMonitor(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	var schema string
	if err := fixture.pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	pool, release := barrierPool(t, schema)
	reporter := online.NewHealthReporter(pool)
	service, err := online.Open(ctx, fixture.pool, moveEvaluator{}, online.WithHealthReporter(reporter))
	if err != nil {
		t.Fatalf("open the service: %v", err)
	}
	// The monitor of the instance observes the dependency, and its durable
	// write waits for the pool.
	monitoring := make(chan struct{})
	blocked := context.WithValue(ctx, blockedMarker{}, "monitor")
	go func() {
		defer close(monitoring)
		_ = service.ProbeRules(blocked)
	}()
	// The move of a healthy worker is accepted while the monitor waits.
	moveCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err = service.ProbeRules(moveCtx); err != nil {
		close(release)
		t.Fatalf("the probe of the healthy worker: %v", err)
	}
	close(release)
	<-monitoring
}

// TestOnlineTheNewerObservationSurvivesABlockedFlush covers the revision of
// the observations of a dependency.
//
// The flush of an observation blocks while the only connection of the pool is
// held. A newer observation arrives in the meantime, and it survives the
// flush of the older one: the flush acknowledges the observation it wrote by
// its revision, so it never removes a newer pending observation. The shared
// state and the local state agree on the newest observation at the end.
func TestOnlineTheNewerObservationSurvivesABlockedFlush(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
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
	// The degraded observation is the one that is flushed first.
	reporter.Record(online.DependencyRules, online.HealthDegraded, "the rules process did not answer")
	flushed := make(chan struct{})
	go func() {
		defer close(flushed)
		reporter.Flush(ctx)
	}()
	// The newer observation arrives while the flush waits for the pool.
	time.Sleep(200 * time.Millisecond)
	reporter.Record(online.DependencyRules, online.HealthHealthy, "the rules process answered")
	// The pool is free again, so the flush of the older observation runs
	// after the newer one was recorded.
	held.Release()
	<-flushed
	// The flush of the older observation may not remove the newer one, so
	// the next flush writes it.
	reporter.Flush(ctx)

	shared, err := reporter.SharedState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	local := reporter.Current()
	if shared != local.Rules.State {
		t.Fatalf("the shared state = %q and the local state = %q, want the newest observation", shared, local.Rules.State)
	}
	if local.Rules.State != online.HealthHealthy {
		t.Fatalf("the local state of the dependency = %q, want the newest observation %q", local.Rules.State, online.HealthHealthy)
	}
	var newest string
	if err = fixture.pool.QueryRow(ctx, `SELECT state FROM online_service_health WHERE dependency=$1 ORDER BY observation_order DESC LIMIT 1`, online.DependencyRules).Scan(&newest); err != nil {
		t.Fatal(err)
	}
	if newest != string(online.HealthHealthy) {
		t.Fatalf("the newest checkpoint of the dependency = %q, want %q", newest, string(online.HealthHealthy))
	}
}

// The reporter keeps the durable state and the pending observations of every
// dependency, and the observations of one dependency come from the episode of
// the instance, from the monitor and from the request paths. Every access is
// guarded, so the reporter never reads its maps while another observation
// writes them, and the durable state of the dependency is the state of the
// last checkpoint that was written.
func TestOnlineTheReporterServesConcurrentObservationsOfOneDependency(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	reporter := online.NewHealthReporter(fixture.pool)

	var group sync.WaitGroup
	for index := 0; index < 16; index++ {
		group.Add(1)
		go func(observation int) {
			defer group.Done()
			state := online.HealthHealthy
			if observation%2 == 0 {
				state = online.HealthDegraded
			}
			reporter.Record(online.DependencyRules, state, "the observation of the instance")
			reporter.Flush(ctx)
		}(index)
	}
	group.Wait()
	// The controlled final observation is the newest one, and it is the one
	// the shared state and the local state have to agree on.
	reporter.Record(online.DependencyRules, online.HealthHealthy, "the final observation")
	reporter.Flush(ctx)
	shared, err := reporter.SharedState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if shared != online.HealthHealthy {
		t.Fatalf("the shared state = %q after the concurrent observations, want the final observation %q", shared, online.HealthHealthy)
	}
	local := reporter.Current()
	if local.Rules.State != online.HealthHealthy {
		t.Fatalf("the local state of the dependency = %q after the concurrent observations, want %q", local.Rules.State, online.HealthHealthy)
	}
	// The second flush writes nothing: the durable state is the final
	// observation already.
	var before, after int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE dependency=$1`, online.DependencyRules).Scan(&before); err != nil {
		t.Fatal(err)
	}
	reporter.Flush(ctx)
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE dependency=$1`, online.DependencyRules).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("the checkpoints of the dependency = %d after the stable flush, want %d", after, before)
	}
}
