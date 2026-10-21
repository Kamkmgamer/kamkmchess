package integration

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
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
	// The durable state is one of the observations, and the rows of the
	// dependency are the observations that changed it.
	var distinct int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(DISTINCT state) FROM online_service_health WHERE dependency=$1`, online.DependencyRules).Scan(&distinct); err != nil {
		t.Fatal(err)
	}
	if distinct < 1 || distinct > 2 {
		t.Fatalf("the durable states of the dependency = %d, want the observed ones", distinct)
	}
	// The local state is the newest observation, and the durable rows are
	// the observations that changed the durable state.
	local := reporter.Current()
	if local.Rules.State != online.HealthHealthy && local.Rules.State != online.HealthDegraded {
		t.Fatalf("the local state of the dependency = %q after the concurrent observations", local.Rules.State)
	}
}
