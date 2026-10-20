package integration

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The presence, recovery and runner lease fixtures.
//
// The liveness lease and the continuous offline minute are boundaries of
// wall-clock time. The fixtures replace the authoritative clock of the writer
// with a movable one, so the boundaries are reached exactly and the tests
// stay fast. The database stays real: the production schema, the production
// constraints and the production transactions are exercised.

// fakeClock is a movable authoritative clock.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

// newFakeClock returns a clock that starts just after the database clock, so
// the movable time is never floored by an accepted timestamp.
func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Now().UTC().Add(2 * time.Second)}
}

// Now returns the current reading of the clock.
func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance moves the clock forward.
func (c *fakeClock) Advance(by time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(by)
}

// Source is the clock source of the writer.
func (c *fakeClock) Source() online.ClockSource {
	return func(context.Context, online.Querier) (time.Time, error) { return c.Now(), nil }
}

// presenceFixture is one online service with a movable clock and a durable
// health boundary.
type presenceFixture struct {
	service *online.Service
	pool    *pgxpool.Pool
	clock   *fakeClock
	health  *online.HealthReporter
}

// newPresenceFixture opens an online service against the real schema.
func newPresenceFixture(t *testing.T) presenceFixture {
	t.Helper()
	return newPresenceFixtureWith(t, moveEvaluator{})
}

// newPresenceFixtureWith opens an online service with a chosen rules
// evaluator.
func newPresenceFixtureWith(t *testing.T, evaluator online.Evaluator) presenceFixture {
	t.Helper()
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	clock := newFakeClock()
	health := online.NewHealthReporter(pool)
	service, err := online.Open(context.Background(), pool, evaluator,
		online.WithClockSource(clock.Source()),
		online.WithHealthReporter(health),
	)
	if err != nil {
		t.Fatal(err)
	}
	return presenceFixture{service: service, pool: pool, clock: clock, health: health}
}

// modelLabel returns a declared public model label.
func modelLabel(label string) *string { return &label }

// presenceAccount is one account participant of a fixture match.
type presenceAccount struct {
	ref  online.ParticipantRef
	seat online.Seat
}

// alice and bob are the two account participants of the fixtures.
func presenceAlice() presenceAccount {
	return presenceAccount{ref: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, seat: online.SeatWhite}
}

func presenceBob() presenceAccount {
	return presenceAccount{ref: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_b"}, seat: online.SeatBlack}
}

// createAgentMatch creates a match with two human controlled seats.
//
// The presence rules do not depend on the declared control, so the presence
// fixtures use human seats.
func createAgentMatch(t *testing.T, service *online.Service, matchID string, startingTimeMs int64) {
	t.Helper()
	command := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-create-" + matchID,
		ExpectedVersion: 0,
		Seat:            online.SeatWhite,
		ControlEpoch:    1,
		Action: online.Action{
			Kind: online.ActionCreateMatch,
			CreateMatch: &online.CreateMatchSetup{
				Variant:     "orthodox",
				StartingFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
				TimeControl: online.TimeControl{StartingTimeMs: startingTimeMs, IncrementMs: 0},
				Seats: online.CreateMatchSeats{
					White: online.CreateSeat{
						Participant: presenceAlice().ref,
						PublicLabel: "Alice",
						Control:     online.SeatControl{Kind: online.ControlHuman},
					},
					Black: online.CreateSeat{
						Participant: presenceBob().ref,
						PublicLabel: "Bob",
						Control:     online.SeatControl{Kind: online.ControlHuman},
					},
				},
			},
		},
	}
	if _, err := service.Execute(context.Background(), presenceAlice().ref, command); err != nil {
		t.Fatalf("create match %s: %v", matchID, err)
	}
}

// acceptMoves makes both sides move once, so the opening exchange is
// complete and the main clock runs.
func acceptMoves(t *testing.T, service *online.Service, matchID string) int64 {
	t.Helper()
	ctx := context.Background()
	white := moveOnlineCommand(matchID, "op-move-white-"+matchID, online.SeatWhite, 1, "e2e4")
	if _, err := service.Execute(ctx, presenceAlice().ref, white); err != nil {
		t.Fatalf("white move: %v", err)
	}
	black := moveOnlineCommand(matchID, "op-move-black-"+matchID, online.SeatBlack, 2, "e7e5")
	if _, err := service.Execute(ctx, presenceBob().ref, black); err != nil {
		t.Fatalf("black move: %v", err)
	}
	match, err := service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	return match.Version
}

// claimCommand builds the claim envelope of one seat.
func claimCommand(matchID, operationID string, seat online.Seat, version int64) online.ClaimCommand {
	return online.ClaimCommand{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat,
		ControlEpoch:    1,
	}
}

// TestOnlinePresenceConnectedOpponentNeverOffersClaim covers MAT-05.
//
// With twenty minutes on the clock a connected opponent may use the whole
// time. No abandonment claim appears merely because no move arrives, even
// after the entire clock ran down.
func TestOnlinePresenceConnectedOpponentNeverOffersClaim(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-stall"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)

	// The opponent keeps reporting in every five seconds while the clock
	// runs down.
	for step := 0; step < 240; step++ {
		fixture.clock.Advance(5 * time.Second)
		if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
			t.Fatalf("heartbeat: %v", err)
		}
		if _, err := fixture.service.Heartbeat(ctx, presenceAlice().ref, matchID, online.SeatWhite); err != nil {
			t.Fatalf("heartbeat: %v", err)
		}
		view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
		if err != nil {
			t.Fatal(err)
		}
		if view.Claim.Eligible {
			t.Fatalf("step %d: a connected opponent must never enable the claim", step)
		}
		if view.Claim.Reason != online.ClaimReasonOpponentConnected {
			t.Fatalf("step %d: claim reason = %q, want %q", step, view.Claim.Reason, online.ClaimReasonOpponentConnected)
		}
	}
}

// TestOnlinePresenceLeaseExpiryMarksTheSeatOffline covers the liveness lease.
//
// The lease of a heartbeat is fifteen seconds long. A suspended client stops
// reporting in, and its seat counts as offline from the moment the lease
// expires.
func TestOnlinePresenceLeaseExpiryMarksTheSeatOffline(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-lease"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)

	presence, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack)
	if err != nil {
		t.Fatal(err)
	}
	if presence.State != online.PresenceConnected {
		t.Fatalf("state after a heartbeat = %q, want %q", presence.State, online.PresenceConnected)
	}
	lease := presence.LeaseExpiresAt
	if lease == nil {
		t.Fatal("the presence record has no lease")
	}
	if got := lease.Sub(*presence.LastHeartbeatAt); got != online.PresenceLeaseTTL {
		t.Fatalf("lease length = %v, want %v", got, online.PresenceLeaseTTL)
	}
	fixture.clock.Advance(online.PresenceLeaseTTL - time.Second)
	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Claim.Reason != online.ClaimReasonOpponentConnected {
		t.Fatalf("claim reason before the lease expires = %q, want %q", view.Claim.Reason, online.ClaimReasonOpponentConnected)
	}
	fixture.clock.Advance(time.Second)
	view, err = fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Claim.Reason != online.ClaimReasonGracePeriod {
		t.Fatalf("claim reason after the lease expires = %q, want %q", view.Claim.Reason, online.ClaimReasonGracePeriod)
	}
}

// TestOnlinePresenceClaimBoundaryAtSixtySeconds covers MAT-06.
//
// The continuous offline minute is exact: one second short of it the claim is
// not available, and at it the claim is.
func TestOnlinePresenceClaimBoundaryAtSixtySeconds(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-boundary"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)

	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	// The lease expires fifteen seconds after the heartbeat, and the
	// continuous offline minute starts there.
	fixture.clock.Advance(online.PresenceLeaseTTL + online.AbandonmentGracePeriod - time.Second)
	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Claim.Eligible {
		t.Fatal("the claim must not be available one second short of the offline minute")
	}
	if view.Claim.Reason != online.ClaimReasonGracePeriod {
		t.Fatalf("claim reason = %q, want %q", view.Claim.Reason, online.ClaimReasonGracePeriod)
	}
	if view.Claim.GraceSecondsLeft != 1 {
		t.Fatalf("grace seconds left = %d, want 1", view.Claim.GraceSecondsLeft)
	}
	// The claim is refused while the minute has not elapsed.
	if _, err := fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-early", online.SeatWhite, version)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("claim before the minute = %v, want %v", err, online.ErrActionNotAllowed)
	}
	fixture.clock.Advance(time.Second)
	view, err = fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if !view.Claim.Eligible {
		t.Fatalf("the claim must be available after the offline minute, reason %q", view.Claim.Reason)
	}
	result, err := fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-on-time", online.SeatWhite, version))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if result.Receipt.Result == nil || result.Receipt.Result.Reason != online.ReasonAbandonment {
		t.Fatalf("claim result = %+v, want an abandonment win", result.Receipt.Result)
	}
	if result.Receipt.Result.Winner == nil || *result.Receipt.Result.Winner != online.SeatWhite {
		t.Fatalf("claim winner = %+v, want white", result.Receipt.Result)
	}
}

// TestOnlinePresenceKeepWaitingPreservesTheOption covers MAT-06.
//
// Waiting preserves the claim option and the normal clock behaviour. It never
// concedes a result.
func TestOnlinePresenceKeepWaitingPreservesTheOption(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-waiting"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)

	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	fixture.clock.Advance(online.PresenceLeaseTTL + online.AbandonmentGracePeriod)
	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if !view.Claim.Eligible {
		t.Fatalf("the claim must be available, reason %q", view.Claim.Reason)
	}
	kept, err := fixture.service.KeepWaiting(ctx, presenceAlice().ref, matchID, online.SeatWhite)
	if err != nil {
		t.Fatalf("keep waiting: %v", err)
	}
	if kept.KeepWaitingAt == nil {
		t.Fatal("the keep waiting choice was not recorded")
	}
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchActive {
		t.Fatalf("keep waiting changed the match status to %q", match.Status)
	}
	if match.Result != nil {
		t.Fatalf("keep waiting conceded a result: %+v", match.Result)
	}
	view, err = fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if !view.Claim.Eligible {
		t.Fatalf("keep waiting removed the claim option, reason %q", view.Claim.Reason)
	}
	// The clock kept running, so the claim is still available and it still
	// ends the match.
	if _, err := fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-after-waiting", online.SeatWhite, version)); err != nil {
		t.Fatalf("claim after waiting: %v", err)
	}
}

// TestOnlinePresenceReconnectClearsTheClaim covers MAT-07.
//
// A reconnect that is accepted first removes the claim eligibility, and a
// later disconnect starts a fresh minute.
func TestOnlinePresenceReconnectClearsTheClaim(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-reconnect"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)

	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	fixture.clock.Advance(online.PresenceLeaseTTL + online.AbandonmentGracePeriod)
	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if !view.Claim.Eligible {
		t.Fatalf("the claim must be available before the reconnect, reason %q", view.Claim.Reason)
	}
	// The opponent reconnects before the claim is made.
	if _, err = fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	view, err = fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Claim.Eligible {
		t.Fatal("the reconnect did not clear the claim eligibility")
	}
	if view.Claim.Reason != online.ClaimReasonOpponentConnected {
		t.Fatalf("claim reason after the reconnect = %q, want %q", view.Claim.Reason, online.ClaimReasonOpponentConnected)
	}
	if _, err = fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-after-reconnect", online.SeatWhite, version)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("the claim after the reconnect = %v, want %v", err, online.ErrActionNotAllowed)
	}
	// A later disconnect starts a fresh minute.
	fixture.clock.Advance(online.PresenceLeaseTTL + online.AbandonmentGracePeriod - time.Second)
	view, err = fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Claim.Eligible {
		t.Fatal("the fresh minute must not be complete one second early")
	}
	fixture.clock.Advance(time.Second)
	view, err = fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if !view.Claim.Eligible {
		t.Fatalf("the fresh minute did not complete, reason %q", view.Claim.Reason)
	}
}

// TestOnlinePresenceClaimFirstStaysFinal covers MAT-07.
//
// A claim that was accepted first stays final, and a later reconnect does not
// change it.
func TestOnlinePresenceClaimFirstStaysFinal(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-claim-first"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)

	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	fixture.clock.Advance(online.PresenceLeaseTTL + online.AbandonmentGracePeriod)
	result, err := fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-first", online.SeatWhite, version))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if result.Receipt.Result == nil || result.Receipt.Result.Reason != online.ReasonAbandonment {
		t.Fatalf("claim result = %+v, want an abandonment win", result.Receipt.Result)
	}
	// The opponent reconnects after the claim.
	if _, err = fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Status != online.MatchCompleted {
		t.Fatalf("the match status = %q, want %q", match.Status, online.MatchCompleted)
	}
	if match.Result == nil || match.Result.Reason != online.ReasonAbandonment {
		t.Fatalf("the result changed after the reconnect: %+v", match.Result)
	}
	// A second claim cannot change the final result.
	if _, err = fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-second", online.SeatWhite, version)); !errors.Is(err, online.ErrMatchEnded) {
		t.Fatalf("the second claim = %v, want %v", err, online.ErrMatchEnded)
	}
}

// TestOnlinePresenceServiceUnavailableSuppressesTheClaim covers the service
// health boundary.
//
// A service that is not healthy never offers the claim, so an outage cannot
// masquerade as an absent opponent.
func TestOnlinePresenceServiceUnavailableSuppressesTheClaim(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-outage"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)

	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	fixture.clock.Advance(online.PresenceLeaseTTL + online.AbandonmentGracePeriod)

	// The rules process is down. The health boundary is the signal, and no
	// move is submitted while it is down.
	if err := fixture.health.ReportDependency(ctx, online.DependencyRules, online.HealthUnavailable, "the rules process is down"); err != nil {
		t.Fatal(err)
	}
	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Claim.Eligible {
		t.Fatal("the claim must not be available while the service is unavailable")
	}
	if view.Claim.Reason != online.ClaimReasonServiceUnavailable {
		t.Fatalf("claim reason = %q, want %q", view.Claim.Reason, online.ClaimReasonServiceUnavailable)
	}
	if _, err = fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-outage", online.SeatWhite, version)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("the claim during the outage = %v, want %v", err, online.ErrActionNotAllowed)
	}
	// The service recovers and the claim returns.
	if err := fixture.health.ReportDependency(ctx, online.DependencyRules, online.HealthHealthy, "the rules process answered"); err != nil {
		t.Fatal(err)
	}
	view, err = fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if !view.Claim.Eligible {
		t.Fatalf("the claim must be available again, reason %q", view.Claim.Reason)
	}
}

// TestOnlinePresenceClaimCannotBypassTheOpeningAbort covers the opening
// rules.
//
// While the opening reply window is open the claim is never available, and
// the unanswered window aborts the match instead of handing out a win.
func TestOnlinePresenceClaimCannotBypassTheOpeningAbort(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-opening"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	// Only the first move is made, so the reply window is open.
	first := moveOnlineCommand(matchID, "op-move-white-"+matchID, online.SeatWhite, 1, "e2e4")
	if _, err := fixture.service.Execute(ctx, presenceAlice().ref, first); err != nil {
		t.Fatalf("white move: %v", err)
	}
	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	// The reply window is still open.
	fixture.clock.Advance(5 * time.Second)
	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Claim.Eligible {
		t.Fatal("the claim must not be available while the reply window is open")
	}
	if view.Claim.Reason != online.ClaimReasonOpeningReply {
		t.Fatalf("claim reason = %q, want %q", view.Claim.Reason, online.ClaimReasonOpeningReply)
	}
	if _, err = fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-opening", online.SeatWhite, 2)); !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("the claim during the reply window = %v, want %v", err, online.ErrActionNotAllowed)
	}
	// The unanswered reply window aborts the match unscored.
	fixture.clock.Advance(time.Duration(online.OpeningReplyWindowMs) * time.Millisecond)
	result, err := fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-opening-expired", online.SeatWhite, 2))
	if err != nil {
		t.Fatalf("claim after the reply window: %v", err)
	}
	if result.Receipt.Outcome != online.OutcomeOpeningExpired {
		t.Fatalf("the receipt outcome = %q, want %q", result.Receipt.Outcome, online.OutcomeOpeningExpired)
	}
	if result.Receipt.Result == nil || result.Receipt.Result.Kind != online.ResultAbort {
		t.Fatalf("the result = %+v, want an abort", result.Receipt.Result)
	}
}

// TestOnlinePresenceClaimIsSerializedWithTheClockExpiry covers the ordering
// of the terminal outcomes.
//
// A claim that arrives after the clock expired settles the timeout, exactly
// like a late move does. The claim never manufactures a win.
func TestOnlinePresenceClaimIsSerializedWithTheClockExpiry(t *testing.T) {
	fixture := newPresenceFixtureWith(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
	ctx := context.Background()
	const matchID = "match-presence-expiry"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)

	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatal(err)
	}
	// The clock of the side to move runs out before the offline minute
	// elapses.
	fixture.clock.Advance(20 * time.Minute)
	result, err := fixture.service.ClaimAbandonment(ctx, presenceAlice().ref, claimCommand(matchID, "op-claim-after-expiry", online.SeatWhite, version))
	if err != nil {
		t.Fatalf("claim after the expiry: %v", err)
	}
	if result.Receipt.Outcome != online.OutcomeDeadlineExpired {
		t.Fatalf("the receipt outcome = %q, want %q", result.Receipt.Outcome, online.OutcomeDeadlineExpired)
	}
	if result.Receipt.Result == nil || result.Receipt.Result.Reason != online.ReasonTimeout {
		t.Fatalf("the result = %+v, want a timeout", result.Receipt.Result)
	}
}
