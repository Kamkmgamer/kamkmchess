package online

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The health boundary fails closed.
//
// A service that cannot confirm its own health never hands out a win, and a
// shared health state that cannot be read is an unavailable service rather
// than a healthy one.

// TestHealthStateFailsClosedOnAnUnreadableSharedState covers the fail closed
// rule of the health boundary.
//
// The shared state is the durable health every instance of the service sees.
// A read that fails is an unavailable service, never a healthy one.
func TestHealthStateFailsClosedOnAnUnreadableSharedState(t *testing.T) {
	// A pool that is closed cannot answer the shared state read.
	pool, err := pgxpool.New(context.Background(), "postgres://127.0.0.1:1/does-not-exist?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	reporter := NewHealthReporter(pool)
	service := &Service{health: reporter}
	if err = reporter.ReportDependency(context.Background(), DependencyRules, HealthHealthy, "the rules process answered"); err != nil {
		// The durable write cannot succeed either, which is the point.
		t.Logf("the durable report failed as expected: %v", err)
	}
	state := service.healthState(context.Background(), nil)
	if state == HealthHealthy {
		t.Fatal("a health state that cannot be read must not be healthy")
	}
}

// TestHealthStateIsUnavailableWhileADependencyIsDown covers the dependency
// rule of the health boundary.
//
// A degraded or unavailable dependency is not a healthy service, so the
// abandonment claim disappears while it lasts.
func TestHealthStateIsUnavailableWhileADependencyIsDown(t *testing.T) {
	reporter := NewHealthReporter(nil)
	service := &Service{health: reporter}
	if err := reporter.ReportDependency(context.Background(), DependencyRules, HealthHealthy, "the rules process answered"); err != nil {
		t.Fatal(err)
	}
	if state := service.healthState(context.Background(), nil); state != HealthHealthy {
		t.Fatalf("the health state = %q, want %q", state, HealthHealthy)
	}
	if err := reporter.ReportDependency(context.Background(), DependencyRules, HealthDegraded, "the rules process did not answer"); err != nil {
		t.Fatal(err)
	}
	if state := service.healthState(context.Background(), nil); state != HealthDegraded {
		t.Fatalf("the health state = %q, want %q", state, HealthDegraded)
	}
	if err := reporter.ReportDependency(context.Background(), DependencyRules, HealthUnavailable, "the rules process is down"); err != nil {
		t.Fatal(err)
	}
	if state := service.healthState(context.Background(), nil); state != HealthUnavailable {
		t.Fatalf("the health state = %q, want %q", state, HealthUnavailable)
	}
}

// TestHealthLivenessIsOnlyRefreshedWhileTheServiceIsHealthy covers the
// liveness record of an interruption.
//
// The liveness record is what locates an unexpected interruption, so a
// service that is not healthy must not refresh it.
func TestHealthLivenessIsOnlyRefreshedWhileTheServiceIsHealthy(t *testing.T) {
	reporter := NewHealthReporter(nil)
	if err := reporter.ReportDependency(context.Background(), DependencyRules, HealthHealthy, "the rules process answered"); err != nil {
		t.Fatal(err)
	}
	if !reporter.OverallHealthy() {
		t.Fatal("a healthy dependency must report a healthy service")
	}
	if err := reporter.ReportDependency(context.Background(), DependencyRules, HealthDegraded, "the rules process did not answer"); err != nil {
		t.Fatal(err)
	}
	if reporter.OverallHealthy() {
		t.Fatal("a degraded dependency must not report a healthy service")
	}
}

// TestRecoveryRefundNeverChargesTheInterruptionToAPlayer covers the refund
// arithmetic of the recovery once more, with the boundary the owner
// approved: the service outage is never charged to a player.
func TestRecoveryRefundNeverChargesTheInterruptionToAPlayer(t *testing.T) {
	start := time.Now().UTC()
	// The clock ran out while the service was down.
	activeSince := start.Add(-time.Minute)
	deadline := start.Add(10 * time.Second)
	refund, ok := recoveryOverlap(&deadline, &activeSince, nil, nil, start.Add(-time.Hour), start, start.Add(2*time.Minute))
	if !ok {
		t.Fatal("the charged window was not found")
	}
	if refund != 2*time.Minute {
		t.Fatalf("refund = %v, want the whole interruption", refund)
	}
}
