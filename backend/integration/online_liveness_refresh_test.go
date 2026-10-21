package integration

import (
	"context"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
)

// The durable liveness of a healthy service.
//
// The liveness record is the evidence that the service was alive. A healthy
// service refreshes it, so a restart of a healthy instance is not read as an
// interruption: no epoch is opened, no clock is refunded and the runner
// leases of the peers are not fenced.

// TestOnlineHealthyMonitorRefreshesTheDurableLiveness covers the liveness of
// a healthy service.
//
// The liveness of the fixture is moved past the TTL, as it would be after a
// quiet period without a state change. The monitor of a healthy service
// refreshes it, and the restart of the instance changes nothing.
func TestOnlineHealthyMonitorRefreshesTheDurableLiveness(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-liveness-refresh"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.DeadlineAt == nil {
		t.Fatal("the match has no armed clock")
	}
	beforeDeadline := *before.Clock.DeadlineAt

	// The monitor of a healthy service refreshes the liveness.
	stop := serverapp.StartHealthMonitor(ctx, fixture.pool, fixture.health, fixture.service, serverapp.HealthMonitorConfig{Interval: 50 * time.Millisecond})
	defer stop()
	// The first tick settles the durable health of the two dependencies.
	waitForLiveness(t, fixture, time.Now().Add(time.Second))
	// The liveness goes stale without a state change: the service is healthy
	// and nothing is reported, so only a periodic refresh moves the record.
	if _, err = fixture.pool.Exec(ctx, `UPDATE online_service_liveness SET last_seen_at=clock_timestamp()-interval '90 seconds' WHERE singleton`); err != nil {
		t.Fatalf("age the liveness: %v", err)
	}
	var stale time.Time
	if err = fixture.pool.QueryRow(ctx, `SELECT last_seen_at FROM online_service_liveness WHERE singleton`).Scan(&stale); err != nil {
		t.Fatalf("read the liveness: %v", err)
	}
	// The next tick refreshes it.
	waitForLiveness(t, fixture, stale)
	var refreshed time.Time
	if err = fixture.pool.QueryRow(ctx, `SELECT last_seen_at FROM online_service_liveness WHERE singleton`).Scan(&refreshed); err != nil {
		t.Fatalf("read the liveness: %v", err)
	}
	if !refreshed.After(stale) {
		t.Fatalf("the liveness of a healthy service stayed at %v: the monitor did not refresh it", stale)
	}
	if age := time.Since(refreshed); age > online.ServiceLivenessTTL {
		t.Fatalf("the liveness is %s old after the refresh, want at most the TTL %s", age, online.ServiceLivenessTTL)
	}

	// The runner lease of a peer survives the restart of a healthy instance.
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO online_runner_leases(lease_id,match_id,seat,control_epoch,generation,runner_id,status,acquired_at,expires_at,runner_epoch)
VALUES('lease-liveness-0001',$1,'black',1,2,'runner-liveness','active',clock_timestamp(),clock_timestamp()+interval '15 seconds',1)`, matchID); err != nil {
		t.Fatalf("write the runner lease: %v", err)
	}

	// The restart of the healthy instance changes nothing.
	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if plan.InterruptionMs != 0 || plan.AdjustedMatches != 0 {
		t.Fatalf("the recovery of a healthy service = %+v, want no interruption", plan)
	}
	var epochs int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs`).Scan(&epochs); err != nil {
		t.Fatal(err)
	}
	if epochs != 0 {
		t.Fatalf("epochs opened = %d after the restart of a healthy service, want none", epochs)
	}
	var adjustments int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1`, matchID).Scan(&adjustments); err != nil {
		t.Fatal(err)
	}
	if adjustments != 0 {
		t.Fatalf("the restart of a healthy service wrote %d adjustments, want none", adjustments)
	}
	var status string
	if err = fixture.pool.QueryRow(ctx, `SELECT status FROM online_runner_leases WHERE lease_id='lease-liveness-0001'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "active" {
		t.Fatalf("the runner lease of the peer = %q after the restart of a healthy service, want %q", status, "active")
	}
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Clock.DeadlineAt == nil || !after.Clock.DeadlineAt.Equal(beforeDeadline) {
		t.Fatalf("the clock of the unfinished match moved from %v to %v", beforeDeadline, after.Clock.DeadlineAt)
	}
}

// waitForLiveness waits until the durable liveness is newer than the given
// moment.
func waitForLiveness(t *testing.T, fixture presenceFixture, after time.Time) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var seen time.Time
		if err := fixture.pool.QueryRow(context.Background(), `SELECT last_seen_at FROM online_service_liveness WHERE singleton`).Scan(&seen); err == nil {
			if seen.After(after) {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the durable liveness was not newer than %v", after)
}
