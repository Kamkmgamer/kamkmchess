package integration

import (
	"context"
	"sync"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
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

// TestOnlineTheReporterServesConcurrentObservationsOfOneDependency covers the
// concurrent observations of one dependency.
//
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
