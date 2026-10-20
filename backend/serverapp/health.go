package serverapp

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
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
	if err := prober.ProbeRules(ctx); err != nil {
		if onError != nil {
			onError(err)
		}
	}
}

// reportHealth records a health observation of one dependency.
func reportHealth(ctx context.Context, reporter *online.HealthReporter, dependency string, state online.HealthState, detail string) {
	if err := reporter.ReportDependency(ctx, dependency, state, detail); err != nil {
		slog.Default().Error("online health report failed", "error", err)
	}
}
