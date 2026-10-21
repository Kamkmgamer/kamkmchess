package integration

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
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
	broken atomic.Bool
}

func (e *outageEvaluator) ValidateSetup(ctx context.Context, input online.RulesInput) error {
	if e.broken.Load() {
		return errors.New("the rules process is down")
	}
	return e.moveEvaluator.ValidateSetup(ctx, input)
}

func (e *outageEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	if e.broken.Load() {
		return online.Candidate{}, errors.New("the rules process is down")
	}
	return e.moveEvaluator.Evaluate(ctx, input)
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
