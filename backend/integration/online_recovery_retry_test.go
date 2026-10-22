package integration

import (
	"context"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The retry of a recovery that failed.
//
// A recovery that begins and fails must leave the service in a state that a
// retry can finish. The durable evidence of the interruption is the pending
// boundary of the interruption, and the epoch of the interruption stays
// unresolved until that boundary is applied.
//
// The liveness record is not that evidence. A healthy process refreshes it,
// so a retry that only looked at the liveness would derive no interruption
// at all, would mark only the memory of its own instance recovered and
// would leave the epoch of the failed recovery unresolved. The durable gate
// would then refuse every mutation for good.

// injectRecoveryFailure makes the canonical adjustment fail.
//
// The trigger refuses the write that publishes the adjustment of a match, so
// the recovery fails after it began and after its evidence is durable. The
// failure is removed again before the retry.
func injectRecoveryFailure(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE OR REPLACE FUNCTION kha41_injected_recovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'injected recovery failure';
END $$`); err != nil {
		t.Fatalf("create the injected failure: %v", err)
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER IF EXISTS kha41_injected_recovery_failure ON online_recovery_adjustments`); err != nil {
		t.Fatalf("drop the injected trigger: %v", err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER kha41_injected_recovery_failure BEFORE INSERT ON online_recovery_adjustments FOR EACH ROW EXECUTE FUNCTION kha41_injected_recovery_failure()`); err != nil {
		t.Fatalf("arm the injected failure: %v", err)
	}
}

// removeRecoveryFailure removes the injected failure again.
func removeRecoveryFailure(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `DROP TRIGGER IF EXISTS kha41_injected_recovery_failure ON online_recovery_adjustments`); err != nil {
		t.Fatalf("remove the injected failure: %v", err)
	}
}

// TestOnlineRecoveryRetryAfterAFailedRecoveryCompletesExactlyOnce covers the
// retry of a recovery that failed after it began.
//
// The recovery cannot publish the canonical adjustment, so the epoch of the
// interruption stays unresolved and the durable gate stays closed. The
// healthy process refreshes its liveness before the retry, so the retry
// cannot derive the interruption from the liveness record: the pending
// boundary is the evidence of the interruption. The retry finishes that one
// interruption, refunds the clock of the unfinished match exactly once and
// opens the gate again.
func TestOnlineRecoveryRetryAfterAFailedRecoveryCompletesExactlyOnce(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-recovery-retry"
	const finishedID = "match-recovery-retry-finished"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	createAgentMatch(t, fixture.service, finishedID, 20*60*1000)
	if _, err := fixture.service.Execute(ctx, presenceAlice().ref, resignOnlineCommand(finishedID, "op-resign-"+finishedID, online.SeatWhite, 1)); err != nil {
		t.Fatalf("resign the finished match: %v", err)
	}
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := before.Clock.DeadlineAt.UTC()
	finished, err := fixture.service.GetMatch(ctx, finishedID)
	if err != nil {
		t.Fatal(err)
	}

	// The service stopped being seen five minutes ago and comes back now.
	setLiveness(t, fixture.pool, fixture.clock.Now().Add(-5*time.Minute))
	fixture.clock.Advance(5 * time.Minute)

	// The recovery begins and fails: the canonical adjustment cannot be
	// published.
	injectRecoveryFailure(t, fixture.pool)
	if _, err = fixture.service.RecoverFromInterruption(ctx); err == nil {
		t.Fatal("the recovery must fail while the failure is injected")
	}
	removeRecoveryFailure(t, fixture.pool)

	// The gate stays closed. The epoch of the interruption is unresolved and
	// the boundary of the interruption is not applied.
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if state.Open {
		t.Fatal("the gate must stay closed while the recovery of the interruption is unfinished")
	}
	// The evidence of the interruption is durable, so a retry can finish it.
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE adjusted_at IS NULL`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("pending boundaries = %d after the failed recovery, want exactly 1", pending)
	}
	var unresolved int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs WHERE recovered_at IS NULL`).Scan(&unresolved); err != nil {
		t.Fatal(err)
	}
	if unresolved != 1 {
		t.Fatalf("unresolved epochs = %d after the failed recovery, want exactly 1", unresolved)
	}

	// The healthy process refreshes its liveness before the retry, so the
	// retry cannot derive the interruption from the liveness record.
	setLiveness(t, fixture.pool, fixture.clock.Now())

	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("retry the recovery: %v", err)
	}
	if plan.AdjustedMatches != 1 {
		t.Fatalf("the retry adjusted %d matches, want 1", plan.AdjustedMatches)
	}
	if plan.InterruptionMs != (5 * time.Minute).Milliseconds() {
		t.Fatalf("the interruption of the retry = %d ms, want the derived %d ms", plan.InterruptionMs, (5 * time.Minute).Milliseconds())
	}
	// The retry finishes the interrupted recovery. It opens no second epoch
	// and it adjusts no deadline twice.
	var epochs int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs`).Scan(&epochs); err != nil {
		t.Fatal(err)
	}
	if epochs != 1 {
		t.Fatalf("epochs opened = %d after the retry, want the epoch of the failed recovery only", epochs)
	}
	var adjustments int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1`, matchID).Scan(&adjustments); err != nil {
		t.Fatal(err)
	}
	if adjustments != 1 {
		t.Fatalf("the adjustment rows = %d after the retry, want exactly 1", adjustments)
	}
	var events int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='recovery_adjustment'`, matchID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("the recovery adjustment events = %d after the retry, want exactly 1", events)
	}

	// The clock of the unfinished match is refunded by the interruption that
	// was derived before the failure.
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if got := after.Clock.DeadlineAt.UTC().Sub(beforeDeadline); got != 5*time.Minute {
		t.Fatalf("the deadline moved by %v after the retry, want the interruption of 5m", got)
	}

	// The already final result stays final.
	afterFinished, err := fixture.service.GetMatch(ctx, finishedID)
	if err != nil {
		t.Fatal(err)
	}
	if afterFinished.Version != finished.Version {
		t.Fatalf("the finished match moved from version %d to %d", finished.Version, afterFinished.Version)
	}
	if afterFinished.Result == nil || afterFinished.Result.Kind != online.ResultWin || afterFinished.Result.Reason != online.ReasonResignation {
		t.Fatalf("the finished result changed: %+v", afterFinished.Result)
	}

	// The gate opens again, so the service accepts a resumed action.
	state, err = online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Open {
		t.Fatalf("the gate after the retry = %+v, want an open gate", state)
	}
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, moveOnlineCommand(matchID, "op-move-after-retry", online.SeatWhite, after.Version, "g1f3")); err != nil {
		t.Fatalf("the move after the retry: %v", err)
	}

	// A further retry changes nothing. The interruption is refunded once.
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
		t.Fatalf("the adjustment rows = %d after the replay, want exactly 1", adjustments)
	}
}

// TestOnlineRecoveryResolvesAnEpochWithoutABoundary covers the epoch that a
// failed recovery of an earlier version left behind.
//
// An epoch without a boundary is the shape that a recovery left behind when
// it committed its epoch and failed before it persisted the evidence of the
// interruption. The epoch is the only evidence of that interruption, and the
// conservative interval of an interruption that no boundary describes is
// empty: the clock of a match is not refunded for an interruption of an
// unknown length.
//
// The epoch is completed by the recovery, so the durable gate opens again
// instead of refusing every mutation for good.
func TestOnlineRecoveryResolvesAnEpochWithoutABoundary(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-recovery-orphan-epoch"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := before.Clock.DeadlineAt.UTC()

	// The epoch of a recovery that failed before it persisted its boundary.
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO online_service_epochs(epoch,started_at,note) VALUES(2,$1,'unexpected interruption')`, fixture.clock.Now().UTC()); err != nil {
		t.Fatalf("open the epoch without a boundary: %v", err)
	}
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if state.Open {
		t.Fatal("the gate must be closed while the epoch is unresolved")
	}

	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("recover the epoch without a boundary: %v", err)
	}
	if plan.AdjustedMatches != 0 {
		t.Fatalf("the recovery adjusted %d matches, want none for an unknown interruption", plan.AdjustedMatches)
	}
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if got := after.Clock.DeadlineAt.UTC().Sub(beforeDeadline); got != 0 {
		t.Fatalf("the deadline moved by %v, want no refund for an unknown interruption", got)
	}
	var unresolved int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs WHERE recovered_at IS NULL`).Scan(&unresolved); err != nil {
		t.Fatal(err)
	}
	if unresolved != 0 {
		t.Fatalf("unresolved epochs = %d after the recovery, want none", unresolved)
	}
	state, err = online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Open {
		t.Fatalf("the gate after the recovery = %+v, want an open gate", state)
	}
}
