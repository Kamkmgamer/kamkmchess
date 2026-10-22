package integration

import (
	"context"
	"errors"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The durable gate and the abandonment claim.
//
// A service that is recovering is not serving, so an absent opponent during
// the recovery is not an abandonment. The claim consumes the durable service
// health boundary, so a closed gate refuses it even while every dependency is
// healthy.
//
// The dependencies and the gate are two different facts: the health of the
// dependencies stays truthfully healthy while the gate is closed, and the
// presence view reports both of them. The claim reads the gate, so the
// client is never offered a win the service would refuse.

// TestOnlinePresenceClosedRecoveryGateRefusesTheClaim covers the durable
// gate of the claim.
//
// The opponent is offline for the whole continuous minute, so the claim is
// available while the service is serving. The service then opens the epoch of
// an interruption and never completes its recovery, which is the durable
// evidence that the service is not serving. The presence view must refuse the
// claim with the stable service reason, the health of the dependencies must
// stay truthfully healthy, and the claim command must stay refused.
func TestOnlinePresenceClosedRecoveryGateRefusesTheClaim(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-presence-closed-gate"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMoves(t, fixture.service, matchID)

	// Every dependency is healthy: the rules process answered and the shared
	// state is reachable.
	if err := fixture.health.ReportDependency(ctx, online.DependencyRules, online.HealthHealthy, "the rules process answered"); err != nil {
		t.Fatalf("report the rules dependency: %v", err)
	}
	if err := fixture.health.ReportDependency(ctx, online.DependencyDatabase, online.HealthHealthy, "the shared state is reachable"); err != nil {
		t.Fatalf("report the database dependency: %v", err)
	}

	// The opponent reports in and then stays silent for the whole continuous
	// offline minute, so the claim is available while the service is
	// serving.
	if _, err := fixture.service.Heartbeat(ctx, presenceBob().ref, matchID, online.SeatBlack); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	fixture.clock.Advance(online.PresenceLeaseTTL + online.AbandonmentGracePeriod)

	view, err := fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatalf("presence read: %v", err)
	}
	if !view.Claim.Eligible {
		t.Fatalf("the claim must be available while the service is serving, reason %q", view.Claim.Reason)
	}
	if view.ServiceState != online.HealthHealthy {
		t.Fatalf("service state = %q, want %q", view.ServiceState, online.HealthHealthy)
	}

	// The service is recovering: the epoch of the interruption opened and its
	// recovery never completed. This is the durable evidence that the service
	// is not serving.
	var epoch int64
	if err = fixture.pool.QueryRow(ctx, `SELECT COALESCE(MAX(epoch),0)+1 FROM online_service_epochs`).Scan(&epoch); err != nil {
		t.Fatalf("read the next service epoch: %v", err)
	}
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO online_service_epochs(epoch,started_at,note) VALUES($1,clock_timestamp(),'the interrupted service')`, epoch); err != nil {
		t.Fatalf("open the epoch of the interruption: %v", err)
	}
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatalf("read the durable gate: %v", err)
	}
	if state.Open {
		t.Fatalf("the gate of a recovering service = %+v, want a closed gate", state)
	}

	view, err = fixture.service.GetPresence(ctx, presenceAlice().ref, matchID)
	if err != nil {
		t.Fatalf("presence read during the recovery: %v", err)
	}
	if view.Claim.Eligible {
		t.Fatal("a recovering service must never offer the claim")
	}
	if view.Claim.Reason != online.ClaimReasonServiceUnavailable {
		t.Fatalf("claim reason = %q, want %q", view.Claim.Reason, online.ClaimReasonServiceUnavailable)
	}
	if view.ServiceState != online.HealthHealthy {
		t.Fatalf("service state during the recovery = %q, want %q", view.ServiceState, online.HealthHealthy)
	}
	if view.Recovered {
		t.Fatal("the presence view must report the recovering state")
	}

	// The claim command stays refused while the gate is closed, so the
	// correction never hands out a win the service does not serve.
	if _, err = fixture.service.ClaimAbandonment(ctx, presenceAlice().ref,
		claimCommand(matchID, "op-claim-closed-gate", online.SeatWhite, version)); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the claim during the recovery = %v, want %v", err, online.ErrUnavailable)
	}
}
