package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The bounded pool case of the health boundary.
//
// The presence read and the abandonment claim run inside a transaction that
// holds a connection of the pool. The shared health read must use that
// connection: a pool that cannot hand out a second connection would wait for
// a connection that the transaction itself is holding, and the claim path
// would deadlock against itself.

// TestOnlineTheSharedHealthIsReadOnTheConnectionOfTheTransaction covers the
// bounded pool case of the claim path.
//
// The pool has one connection, so a read that asks the pool for a second one
// waits for ever: the transaction of the caller holds the only connection.
// The presence read and the claim must answer anyway, and they must see the
// durable health of the service.
//
// The checkpoints of the rules dependency prove that the shared state is read
// and that it is aggregated as before: the newest checkpoint of every
// dependency wins, and the worst dependency is the state of the service. The
// degraded service never offers the claim and never awards the win, and the
// healthy service restores the claim.
func TestOnlineTheSharedHealthIsReadOnTheConnectionOfTheTransaction(t *testing.T) {
	pool := testPoolWith(t, func(cfg *pgxpool.Config) { cfg.MaxConns = 1 })
	fixture := newPresenceFixtureOn(t, pool, moveEvaluator{})
	ctx := context.Background()
	const matchID = "match-health-bounded-pool"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)
	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	// The opponent is offline long enough for the claim to be available, so
	// the health of the service is the only thing that can refuse it.
	fixture.clock.Advance(online.PresenceLeaseTTL + online.AbandonmentGracePeriod)

	// Another instance of the service recorded a broken rules dependency, so
	// the shared state of the service is degraded.
	writeHealthCheckpoint(t, pool, "chk-rules-degraded-bounded", online.DependencyRules, online.HealthDegraded)

	// The presence read must answer on the connection of its transaction.
	view := readPresenceWithin(t, fixture.service, presenceAlice().ref, matchID, 15*time.Second)
	if view.ServiceState != online.HealthDegraded {
		t.Fatalf("service state = %q, want %q", view.ServiceState, online.HealthDegraded)
	}
	if view.Claim.Eligible {
		t.Fatal("a degraded service must never offer the claim")
	}
	if view.Claim.Reason != online.ClaimReasonServiceUnavailable {
		t.Fatalf("claim reason = %q, want %q", view.Claim.Reason, online.ClaimReasonServiceUnavailable)
	}

	// The claim must be refused, and it must be refused without waiting for a
	// second connection: a service outage never awards an abandonment win.
	_, err := claimWithin(t, fixture.service, presenceAlice().ref,
		claimCommand(matchID, "op-claim-bounded-pool-degraded", online.SeatWhite, version), 15*time.Second)
	if !errors.Is(err, online.ErrActionNotAllowed) {
		t.Fatalf("claim on a degraded service = %v, want %v", err, online.ErrActionNotAllowed)
	}

	// The newest checkpoint of the dependency wins, so a healthy instance that
	// answers again restores the shared state of the service.
	writeHealthCheckpoint(t, pool, "chk-rules-healthy-bounded", online.DependencyRules, online.HealthHealthy)

	view = readPresenceWithin(t, fixture.service, presenceAlice().ref, matchID, 15*time.Second)
	if view.ServiceState != online.HealthHealthy {
		t.Fatalf("service state after the recovery = %q, want %q", view.ServiceState, online.HealthHealthy)
	}
	if !view.Claim.Eligible {
		t.Fatalf("the claim must be available again, reason %q", view.Claim.Reason)
	}

	// The accepted claim proves that the mutation path answers on the bounded
	// pool as well.
	result, err := claimWithin(t, fixture.service, presenceAlice().ref,
		claimCommand(matchID, "op-claim-bounded-pool-healthy", online.SeatWhite, version), 15*time.Second)
	if err != nil {
		t.Fatalf("claim on a healthy service: %v", err)
	}
	if result.Receipt.Result == nil || result.Receipt.Result.Reason != online.ReasonAbandonment {
		t.Fatalf("claim result = %+v, want an abandonment win", result.Receipt.Result)
	}
}

// writeHealthCheckpoint writes one durable checkpoint of a dependency.
//
// The checkpoint is written directly, so the shared state of the service is
// the state of another instance and the local observation of this instance
// stays healthy.
func writeHealthCheckpoint(t *testing.T, pool *pgxpool.Pool, checkpointID string, dependency string, state online.HealthState) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at) VALUES($1,$2,$3,$4,clock_timestamp())`,
		checkpointID, dependency, string(state), "the rules process did not answer"); err != nil {
		t.Fatalf("write the durable checkpoint %s: %v", checkpointID, err)
	}
}

// readPresenceWithin reads the presence view and fails when it does not
// answer in time.
//
// The read runs in its own goroutine, because a read that waits for a
// connection of a saturated pool never answers: the test must fail on the
// wait instead of waiting for the deadline of the caller.
func readPresenceWithin(t *testing.T, service *online.Service, actor online.ParticipantRef, matchID string, budget time.Duration) online.PresenceView {
	t.Helper()
	type outcome struct {
		view online.PresenceView
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		view, err := service.GetPresence(context.Background(), actor, matchID)
		done <- outcome{view: view, err: err}
	}()
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("presence read: %v", got.err)
		}
		return got.view
	case <-time.After(budget):
		t.Fatalf("the presence read did not answer within %v on a pool with one connection", budget)
	}
	return online.PresenceView{}
}

// claimWithin claims the abandonment of a match and fails when it does not
// answer in time.
//
// The claim runs in its own goroutine, for the same reason as the presence
// read: a claim that waits for a connection of a saturated pool never
// answers.
func claimWithin(t *testing.T, service *online.Service, actor online.ParticipantRef, cmd online.ClaimCommand, budget time.Duration) (online.CommandResult, error) {
	t.Helper()
	type outcome struct {
		result online.CommandResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := service.ClaimAbandonment(context.Background(), actor, cmd)
		done <- outcome{result: result, err: err}
	}()
	select {
	case got := <-done:
		return got.result, got.err
	case <-time.After(budget):
		t.Fatalf("the claim did not answer within %v on a pool with one connection", budget)
	}
	return online.CommandResult{}, nil
}
