package integration

import (
	"context"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgxpool"
)

// setLiveness writes the durable liveness record of the service.
//
// The record is the signal the recovery uses to locate an unexpected
// failure. A fixture moves it into the past to simulate a service that
// stopped being seen.
func setLiveness(t *testing.T, pool *pgxpool.Pool, at time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `INSERT INTO online_service_liveness(singleton,last_seen_at,updated_at) VALUES(true,$1,$1)
ON CONFLICT (singleton) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,updated_at=EXCLUDED.updated_at`, at.UTC())
	if err != nil {
		t.Fatalf("write liveness: %v", err)
	}
}

// clockDeadline reads the armed deadline of one match.
func clockDeadline(t *testing.T, service *online.Service, matchID string) time.Time {
	t.Helper()
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Clock.DeadlineAt == nil {
		t.Fatalf("match %s has no armed deadline", matchID)
	}
	return match.Clock.DeadlineAt.UTC()
}

// TestOnlineRecoveryHealthyJoinDoesNotOpenAnEpoch covers the healthy join.
//
// A second instance that joins a running service changes nothing: no epoch is
// opened, no deadline is shifted, and the work of its peers keeps its lease.
func TestOnlineRecoveryHealthyJoinDoesNotOpenAnEpoch(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-recovery-join"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before := clockDeadline(t, fixture.service, matchID)

	// The service is alive: it keeps refreshing its liveness record.
	setLiveness(t, fixture.pool, fixture.clock.Now())
	fixture.clock.Advance(time.Minute)
	setLiveness(t, fixture.pool, fixture.clock.Now())

	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if plan.InterruptionMs != 0 {
		t.Fatalf("interruption = %d ms, want 0", plan.InterruptionMs)
	}
	if plan.AdjustedMatches != 0 {
		t.Fatalf("adjusted matches = %d, want 0", plan.AdjustedMatches)
	}
	if plan.ServiceEpoch != 1 {
		t.Fatalf("service epoch = %d, want 1", plan.ServiceEpoch)
	}
	if after := clockDeadline(t, fixture.service, matchID); !after.Equal(before) {
		t.Fatalf("the deadline moved from %v to %v", before, after)
	}
	var epochs int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs`).Scan(&epochs); err != nil {
		t.Fatal(err)
	}
	if epochs != 0 {
		t.Fatalf("epochs opened = %d, want 0", epochs)
	}
}

// TestOnlineRecoveryAdjustsTheDeadlineOfAnUnfinishedMatch covers the
// canonical recovery adjustment.
//
// A clock that survived the interruption is still refunded for the time the
// service was down, and the adjustment is published as a versioned event.
func TestOnlineRecoveryAdjustsTheDeadlineOfAnUnfinishedMatch(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-recovery-adjust"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := match.Clock.DeadlineAt.UTC()
	beforeActive := match.Clock.ActiveSince.UTC()
	beforeVersion := match.Version

	// The service stopped being seen five minutes ago and comes back now.
	setLiveness(t, fixture.pool, fixture.clock.Now().Add(-5*time.Minute))
	fixture.clock.Advance(5 * time.Minute)

	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if plan.AdjustedMatches != 1 {
		t.Fatalf("adjusted matches = %d, want 1", plan.AdjustedMatches)
	}
	if plan.InterruptionMs != (5 * time.Minute).Milliseconds() {
		t.Fatalf("interruption = %d ms, want %d", plan.InterruptionMs, (5 * time.Minute).Milliseconds())
	}
	if plan.ServiceEpoch != 2 {
		t.Fatalf("service epoch = %d, want 2", plan.ServiceEpoch)
	}
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != beforeVersion+1 {
		t.Fatalf("version = %d, want %d", after.Version, beforeVersion+1)
	}
	if got := after.Clock.DeadlineAt.UTC().Sub(beforeDeadline); got != 5*time.Minute {
		t.Fatalf("the deadline moved by %v, want 5m", got)
	}
	if got := after.Clock.ActiveSince.UTC().Sub(beforeActive); got != 5*time.Minute {
		t.Fatalf("the active clock moved by %v, want 5m", got)
	}
	var events int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='recovery_adjustment'`, matchID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("recovery adjustment events = %d, want 1", events)
	}
	// The canonical state is published before a resumed action is accepted.
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, moveOnlineCommand(matchID, "op-move-after-recovery", online.SeatWhite, after.Version, "g1f3")); err != nil {
		t.Fatalf("move after the recovery: %v", err)
	}
}

// TestOnlineRecoveryReplaysABoundaryOnlyOnce covers the exactly-once rule.
//
// Replaying a boundary never shifts a deadline twice, and a second distinct
// interruption is a second boundary that adjusts once.
func TestOnlineRecoveryReplaysABoundaryOnlyOnce(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-recovery-replay"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)

	setLiveness(t, fixture.pool, fixture.clock.Now().Add(-5*time.Minute))
	fixture.clock.Advance(5 * time.Minute)
	first, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if first.AdjustedMatches != 1 {
		t.Fatalf("adjusted matches = %d, want 1", first.AdjustedMatches)
	}
	afterFirst := clockDeadline(t, fixture.service, matchID)

	// The same boundary is replayed.
	replay, err := fixture.service.ApplyRecoveryBoundary(ctx, first.BoundaryID)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replay.AlreadyAdjusted {
		t.Fatal("the replay of an applied boundary must report that it was already adjusted")
	}
	if replay.AdjustedMatches != 0 {
		t.Fatalf("the replay adjusted %d matches, want 0", replay.AdjustedMatches)
	}
	if after := clockDeadline(t, fixture.service, matchID); !after.Equal(afterFirst) {
		t.Fatalf("the replay moved the deadline from %v to %v", afterFirst, after)
	}

	// A second, distinct interruption adjusts once more.
	setLiveness(t, fixture.pool, fixture.clock.Now().Add(-2*time.Minute))
	fixture.clock.Advance(2 * time.Minute)
	second, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("second recovery: %v", err)
	}
	if second.BoundaryID == first.BoundaryID {
		t.Fatal("a second interruption must be a second boundary")
	}
	if second.AdjustedMatches != 1 {
		t.Fatalf("the second interruption adjusted %d matches, want 1", second.AdjustedMatches)
	}
	if got := clockDeadline(t, fixture.service, matchID).Sub(afterFirst); got != 2*time.Minute {
		t.Fatalf("the second interruption moved the deadline by %v, want 2m", got)
	}
	// The first boundary is still applied only once.
	again, err := fixture.service.ApplyRecoveryBoundary(ctx, first.BoundaryID)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !again.AlreadyAdjusted || again.AdjustedMatches != 0 {
		t.Fatalf("the replay of the first boundary = %+v, want an unchanged match", again)
	}
}

// TestOnlineRecoveryPreservesTerminalResults covers the immutable result.
//
// An already final result stays final, and the recovery never writes it.
func TestOnlineRecoveryPreservesTerminalResults(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const finishedID = "match-recovery-finished"
	const runningID = "match-recovery-running"
	createAgentMatch(t, fixture.service, finishedID, 20*60*1000)
	createAgentMatch(t, fixture.service, runningID, 20*60*1000)
	acceptMoves(t, fixture.service, runningID)
	resign := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         finishedID,
		OperationID:     "op-resign-" + finishedID,
		ExpectedVersion: 1,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionResign},
	}
	if _, err := fixture.service.Execute(ctx, presenceAlice().ref, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	before, err := fixture.service.GetMatch(ctx, finishedID)
	if err != nil {
		t.Fatal(err)
	}

	setLiveness(t, fixture.pool, fixture.clock.Now().Add(-3*time.Minute))
	fixture.clock.Advance(3 * time.Minute)
	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if plan.PreservedResults < 1 {
		t.Fatalf("preserved results = %d, want at least 1", plan.PreservedResults)
	}
	after, err := fixture.service.GetMatch(ctx, finishedID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version {
		t.Fatalf("the finished match moved from version %d to %d", before.Version, after.Version)
	}
	if after.Result == nil || after.Result.Kind != online.ResultWin || after.Result.Reason != online.ReasonResignation {
		t.Fatalf("the finished result changed: %+v", after.Result)
	}
}

// TestOnlineRecoveryRefundsAnOutageThatCrossedTheDeadline covers the
// approved no-charging rule.
//
// A clock that ran out while the service was down keeps the time it had
// left when the service went down, so the interruption is never charged to
// the player.
func TestOnlineRecoveryRefundsAnOutageThatCrossedTheDeadline(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-recovery-crossed"
	// The clock of the match is short, so it runs out during the outage.
	createAgentMatch(t, fixture.service, matchID, 20_000)
	acceptMoves(t, fixture.service, matchID)
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := match.Clock.DeadlineAt.UTC()
	beforeActive := match.Clock.ActiveSince.UTC()
	beforeBank := match.Clock.WhiteMs + match.Clock.BlackMs

	// The service went down five minutes ago and comes back now.
	setLiveness(t, fixture.pool, fixture.clock.Now().Add(-5*time.Minute))
	fixture.clock.Advance(5 * time.Minute)

	plan, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if plan.AdjustedMatches != 1 {
		t.Fatalf("adjusted matches = %d, want 1", plan.AdjustedMatches)
	}
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	// The deadline moved by the whole interruption, so it is past the
	// resume again.
	if got := after.Clock.DeadlineAt.UTC().Sub(beforeDeadline); got != 5*time.Minute {
		t.Fatalf("the deadline moved by %v, want 5m", got)
	}
	if got := after.Clock.ActiveSince.UTC().Sub(beforeActive); got != 5*time.Minute {
		t.Fatalf("the active clock moved by %v, want 5m", got)
	}
	// The time the player had left when the service went down is the time
	// the player has left now.
	afterBank := after.Clock.WhiteMs + after.Clock.BlackMs
	if afterBank != beforeBank {
		t.Fatalf("the bank changed from %d to %d, want the same remaining time", beforeBank, afterBank)
	}
	if !after.Clock.DeadlineAt.After(fixture.clock.Now()) {
		t.Fatalf("the deadline %v is still in the past of the resume %v", after.Clock.DeadlineAt, fixture.clock.Now())
	}
}

// TestOnlineRecoveryRefundsThePresenceLease covers the presence of the
// interruption.
//
// A service that was down cannot receive heartbeats, so the liveness lease
// of a connected seat is refunded too. A suspended service never manufactures
// an absent opponent.
func TestOnlineRecoveryRefundsThePresenceLease(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-recovery-presence"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	presence, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack)
	if err != nil {
		t.Fatal(err)
	}
	lease := presence.LeaseExpiresAt.UTC()

	setLiveness(t, fixture.pool, fixture.clock.Now().Add(-5*time.Minute))
	fixture.clock.Advance(5 * time.Minute)
	if _, err = fixture.service.RecoverFromInterruption(ctx); err != nil {
		t.Fatalf("recover: %v", err)
	}
	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	var black *online.SeatPresence
	for index := range view.Seats {
		if view.Seats[index].Seat == online.SeatBlack {
			black = &view.Seats[index]
		}
	}
	if black == nil {
		t.Fatal("the presence view has no black seat")
	}
	if black.State != online.PresenceConnected {
		t.Fatalf("the seat state = %q, want %q", black.State, online.PresenceConnected)
	}
	if got := black.LeaseExpiresAt.UTC().Sub(lease); got != 5*time.Minute {
		t.Fatalf("the presence lease moved by %v, want 5m", got)
	}
}
