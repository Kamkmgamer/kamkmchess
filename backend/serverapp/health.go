package serverapp

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The durable health monitor.
//
// The health boundary is what keeps a service outage from looking like an
// absent opponent. The monitor keeps the durable health in step with the
// dependencies the online service needs, so the claim option disappears while
// the service cannot serve and returns when it can.
//
// The monitor never writes a checkpoint for an unchanged state, so a healthy
// service does not grow a checkpoint row on every pass.

// DefaultHealthCheckInterval is how often the monitor checks the database.
const DefaultHealthCheckInterval = 5 * time.Second

// HealthMonitorConfig configures the health monitor.
type HealthMonitorConfig struct {
	// Interval is how often the monitor runs one check.
	Interval time.Duration
	// OnError receives the failure of a check. It never stops the monitor.
	OnError func(error)
}

// StartHealthMonitor starts the durable health monitor.
//
// The monitor runs until the returned stop function is called or the context
// is cancelled. The stop function waits for the loop to finish, so the
// caller can close the database pool without a background check still using
// it.
func StartHealthMonitor(ctx context.Context, pool *pgxpool.Pool, reporter *online.HealthReporter, prober *online.Service, config HealthMonitorConfig) func() {
	if pool == nil || reporter == nil {
		return func() {}
	}
	interval := config.Interval
	if interval <= 0 {
		interval = DefaultHealthCheckInterval
	}
	runCtx, cancel := context.WithCancel(ctx)
	var done sync.WaitGroup
	done.Add(1)
	go func() {
		defer done.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				checkHealth(runCtx, pool, reporter, prober, config.OnError)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			done.Wait()
		})
	}
}

// rulesCancellation reports whether an evaluation of the rules process was
// cancelled by its caller.
//
// A departing client is not a broken dependency. The rules client reports a
// cancelled request with its own error, so the classifier knows that error and
// the context errors.
func rulesCancellation(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	return errors.Is(err, rulesworker.ErrCanceled)
}

// rulesBusy reports whether the rules process was occupied by a running
// request.
//
// An occupied process is not a broken dependency, so the service keeps
// serving and no interruption is recorded.
func rulesBusy(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, online.ErrRulesBusy) {
		return true
	}
	return errors.Is(err, rulesworker.ErrBusy)
}

// rulesHealth is the seam of the durable health monitor.
//
// The service owns the calls that check and repair the rules dependency, and
// the monitor owns the decision of which call belongs to the moment. The
// seam keeps that decision testable without a database and without a worker.
type rulesHealth interface {
	// ProbeRules checks that the rules process answers.
	ProbeRules(ctx context.Context) error
	// RepairRules replaces the rules process and proves that it answers.
	RepairRules(ctx context.Context) error
	// PendingSuspension reports the open interruption of the service.
	PendingSuspension(ctx context.Context) (*online.RecoveryBoundary, error)
	// SuspendForDependency records the interruption of a dependency.
	SuspendForDependency(ctx context.Context, dependency string) error
	// RecoverFromInterruption publishes the recovered state.
	RecoverFromInterruption(ctx context.Context) (online.RecoveryPlan, error)
}

// checkHealth runs one health check.
//
// The check reports the database dependency and probes the rules dependency.
// The two are independent: a healthy database never proves that the rules
// process is healthy, and only a real probe of the rules process may clear a
// degraded rules state.
func checkHealth(ctx context.Context, pool *pgxpool.Pool, reporter *online.HealthReporter, prober *online.Service, onError func(error)) {
	if err := pool.Ping(ctx); err != nil {
		reportHealth(ctx, reporter, online.DependencyDatabase, online.HealthUnavailable, "the shared state is unavailable")
		if onError != nil {
			onError(err)
		}
	} else {
		current := reporter.Current()
		if current.Database.State != online.HealthHealthy {
			reportHealth(ctx, reporter, online.DependencyDatabase, online.HealthHealthy, "the shared state is reachable")
		}
	}
	if prober == nil {
		return
	}
	checkRulesHealth(ctx, prober, onError)
}

// checkRulesHealth checks or repairs the rules dependency.
//
// The gate decides which of the two calls belongs to the moment.
//
//   - A closed gate means the worker was found broken. The worker is gone
//     after such an outage, and a check never starts a worker, so the
//     recovery of a closed gate is a repair: the replacement is started and
//     proven. Without it the gate could never open again, because no
//     participant request can start the replacement while the gate refuses
//     the traffic.
//   - An open gate means the dependency is only checked. A check never
//     starts a worker either, so the cold start stays with the traffic.
//
// A failed repair is a failure of the check: the gate stays closed, the
// failure is reported, and the next tick repairs again. The interruption is
// never recovered on a failed repair, because the recovery would publish a
// dependency that was never proven.
func checkRulesHealth(ctx context.Context, prober rulesHealth, onError func(error)) {
	pending, err := prober.PendingSuspension(ctx)
	if err != nil {
		if onError != nil {
			onError(err)
		}
		return
	}
	if pending != nil {
		// The gate is closed: the worker is replaced and proven.
		if err := prober.RepairRules(ctx); err != nil {
			// A failed repair is retried on the next tick, and the
			// interruption stays open.
			if onError != nil {
				onError(err)
			}
			return
		}
		// The replacement answered, so the canonical state is published
		// before the gate opens again.
		if _, err := prober.RecoverFromInterruption(ctx); err != nil && onError != nil {
			onError(err)
		}
		return
	}
	// The gate is open: the dependency is only checked.
	if err := prober.ProbeRules(ctx); err != nil {
		if rulesBusy(err) || rulesCancellation(err) {
			// The rules process is occupied by a running request, or the
			// probe was cancelled by its caller. Neither is a broken
			// dependency, so the service keeps serving and no
			// interruption is recorded.
			if onError != nil {
				onError(err)
			}
			return
		}
		// The rules process is down. The interruption is recorded as a
		// durable boundary, so the gate closes and the clock of the
		// unfinished matches is refunded when the dependency comes back.
		// The service does not have to restart for the recovery.
		if suspendErr := prober.SuspendForDependency(ctx, online.DependencyRules); suspendErr != nil {
			if onError != nil {
				onError(suspendErr)
			}
		}
		if onError != nil {
			onError(err)
		}
		return
	}
	// The rules process answered and the gate is open, so there is no
	// interruption to recover.
}

// reportHealth records a health observation of one dependency.
func reportHealth(ctx context.Context, reporter *online.HealthReporter, dependency string, state online.HealthState, detail string) {
	if err := reporter.ReportDependency(ctx, dependency, state, detail); err != nil {
		slog.Default().Error("online health report failed", "error", err)
	}
}
