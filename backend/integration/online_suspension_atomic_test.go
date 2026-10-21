package integration

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The planned interruption of one outage.
//
// Two instances of the service that detect the same broken worker at the same
// time must plan one interruption, not two. Two boundaries would open two
// service epochs, publish two adjustments and refund the clock of the
// unfinished matches twice.

// TestOnlinePlanDoesNotAddASecondPendingBoundaryForOneOutage covers the
// overlapping boundary of one outage.
//
// A recovery opens the new epoch before it applies the boundary, so there is
// a window in which the epoch moved and the boundary of the outage is still
// pending. A plan in that window must find the pending boundary and change
// nothing: one outage is one pending boundary, and the recovery applies it
// once.
func TestOnlinePlanDoesNotAddASecondPendingBoundaryForOneOutage(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	// The boundary of the outage is planned and still pending.
	started := fixture.clock.Now()
	if _, err := fixture.service.PlanSuspension(ctx, started, started); err != nil {
		t.Fatalf("plan the interruption: %v", err)
	}
	// The recovery opened the new epoch, but the boundary is not applied
	// yet.
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_service_epochs(epoch,started_at,note) VALUES(2,clock_timestamp(),'the recovery of the outage') ON CONFLICT (epoch) DO NOTHING`); err != nil {
		t.Fatalf("open the epoch of the recovery: %v", err)
	}
	// A plan in that window finds the pending boundary.
	if _, err := fixture.service.PlanSuspension(ctx, started, started); err != nil {
		t.Fatalf("plan the interruption again: %v", err)
	}
	var pending int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE adjusted_at IS NULL`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("pending boundaries = %d for one outage, want exactly 1", pending)
	}
	// The boundary of the outage is still the one of the first plan.
	var boundaryID string
	var startedAt time.Time
	if err := fixture.pool.QueryRow(ctx, `SELECT boundary_id,started_at FROM online_suspension_boundaries WHERE adjusted_at IS NULL`).Scan(&boundaryID, &startedAt); err != nil {
		t.Fatal(err)
	}
	// The database keeps microseconds, so the interval is compared with that
	// resolution.
	if delta := startedAt.UTC().Sub(started.UTC()); delta > time.Millisecond || delta < -time.Millisecond {
		t.Fatalf("the pending boundary started at %v, want the interval of the first plan %v", startedAt.UTC(), started.UTC())
	}
}

// TestOnlineTwoInstancesPlanOneInterruptionForOneOutage covers the race of
// the planned interruption.
//
// The instances plan the interruption behind one barrier, so they detect the
// same outage in the same moment. The plan is atomic, so exactly one boundary
// exists, and the recovery of that boundary opens one epoch, publishes one
// adjustment and refunds the clock once.
func TestOnlineTwoInstancesPlanOneInterruptionForOneOutage(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-atomic-interruption"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := *before.Clock.DeadlineAt

	second, err := online.Open(ctx, fixture.pool, moveEvaluator{}, online.WithHealthReporter(fixture.health))
	if err != nil {
		t.Fatalf("open the second instance: %v", err)
	}
	instances := []*online.Service{fixture.service, second}

	// The race is repeated, because the window between the check and the
	// insert is small.
	const rounds = 20
	for round := 0; round < rounds; round++ {
		if _, err = fixture.pool.Exec(ctx, `DELETE FROM online_suspension_boundaries`); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var group sync.WaitGroup
		failures := make(chan error, len(instances))
		for _, instance := range instances {
			group.Add(1)
			go func(s *online.Service) {
				defer group.Done()
				<-start
				failures <- s.SuspendForDependency(ctx, online.DependencyRules)
			}(instance)
		}
		close(start)
		group.Wait()
		close(failures)
		// A planner that failed must not make the count below look right.
		for failure := range failures {
			if failure != nil {
				t.Fatalf("the planner failed: %v", failure)
			}
		}
		var planned int
		if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE kind='planned'`).Scan(&planned); err != nil {
			t.Fatal(err)
		}
		if planned != 1 {
			t.Fatalf("round %d planned %d interruptions for one outage, want exactly 1", round, planned)
		}
	}

	// The recovery of the one boundary opens one epoch and refunds once.
	// The outage lasts two minutes, so the refund is visible.
	fixture.clock.Advance(2 * time.Minute)
	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if plan.AdjustedMatches != 1 {
		t.Fatalf("the recovery adjusted %d matches, want 1", plan.AdjustedMatches)
	}
	if plan.InterruptionMs != int64(2*time.Minute/time.Millisecond) {
		t.Fatalf("the interruption = %d ms, want the outage of two minutes", plan.InterruptionMs)
	}
	var epochs int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs`).Scan(&epochs); err != nil {
		t.Fatal(err)
	}
	if epochs != 1 {
		t.Fatalf("epochs opened = %d for one outage, want 1", epochs)
	}
	var events int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='recovery_adjustment'`, matchID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("the recovery events = %d for one outage, want 1", events)
	}
	var adjustments int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1`, matchID).Scan(&adjustments); err != nil {
		t.Fatal(err)
	}
	if adjustments != 1 {
		t.Fatalf("the adjustment rows = %d for one outage, want 1", adjustments)
	}
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Clock.DeadlineAt == nil {
		t.Fatal("the recovered match has no deadline")
	}
	moved := after.Clock.DeadlineAt.Sub(beforeDeadline)
	if moved != time.Duration(plan.InterruptionMs)*time.Millisecond {
		t.Fatalf("the clock of the unfinished match moved by %v, want the interruption %d ms", moved, plan.InterruptionMs)
	}
	if moved <= 0 {
		t.Fatalf("the clock of the unfinished match moved by %v, want the outage", moved)
	}

	// The replay of the recovery changes nothing.
	replay, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("the replay of the recovery: %v", err)
	}
	if replay.AdjustedMatches != 0 {
		t.Fatalf("the replay adjusted %d matches, want none", replay.AdjustedMatches)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1`, matchID).Scan(&adjustments); err != nil {
		t.Fatal(err)
	}
	if adjustments != 1 {
		t.Fatalf("the adjustment rows = %d after the replay, want 1", adjustments)
	}
	recovered, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Clock.DeadlineAt == nil || !recovered.Clock.DeadlineAt.Equal(*after.Clock.DeadlineAt) {
		t.Fatalf("the replay moved the clock from %v to %v", after.Clock.DeadlineAt, recovered.Clock.DeadlineAt)
	}
}
