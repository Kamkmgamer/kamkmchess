package serverapp

import (
	"context"
	"log/slog"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/queue"
)

// DefaultQueueSweepInterval is the default cadence of the queue
// reconciliation loop.
const DefaultQueueSweepInterval = time.Second

// DefaultQueueSweepBatch is the default number of entries one queue
// reconciliation pass resolves.
const DefaultQueueSweepBatch = 100

// QueueSweepConfig configures the queue reconciliation loop.
type QueueSweepConfig struct {
	// Interval is how often the loop runs.
	Interval time.Duration
	// Batch bounds one pass.
	Batch int
	// OnError receives the failure of a pass. It never stops the loop: an
	// entry that could not be resolved stays pending and a later pass
	// retries it.
	OnError func(error)
}

// StartQueueReconciler starts the queue reconciliation loop.
//
// The loop expires the entries whose owner stopped responding and resolves
// the cutoffs that passed against their original deadline. It is bound to the
// server context and to the release function, so no sweep can run against a
// closed pool.
//
// The loop never commits the browser engine fallback. That needs a ready
// engine in the owner's browser, so the loop only records that the cutoff
// was reached.
//
// A pass that fails is reported, never swallowed: a queue that fails every
// pass has to be visible from the outside. The report carries the counters of
// the pass and never a participant identifier, a credential or a private
// route.
func StartQueueReconciler(ctx context.Context, service *queue.Service, config QueueSweepConfig) func() {
	if service == nil {
		return func() {}
	}
	interval := config.Interval
	if interval <= 0 {
		interval = DefaultQueueSweepInterval
	}
	batch := config.Batch
	if batch <= 0 {
		batch = DefaultQueueSweepBatch
	}
	sweepCtx, cancel := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-sweepCtx.Done():
				return
			case <-ticker.C:
				sweepQueue(sweepCtx, service, batch, config.OnError)
			}
		}
	}()
	return cancel
}

// queueSweeper is the reconciliation surface of the queue.
//
// It is an interface so the loop can be exercised without a database.
type queueSweeper interface {
	// Sweep runs one bounded reconciliation pass.
	Sweep(ctx context.Context, limit int) (queue.SweepResult, error)
}

// sweepQueue runs one bounded reconciliation pass.
//
// The result of the pass is reported when it resolved something or when it
// failed something. A failure of the pass itself reaches the error hook or
// the default logger.
func sweepQueue(ctx context.Context, service queueSweeper, batch int, onError func(error)) {
	result, err := service.Sweep(ctx, batch)
	if err != nil {
		if onError != nil {
			onError(err)
			return
		}
		slog.Default().Error("queue reconciliation failed", "error", err)
		return
	}
	if result.Failed > 0 {
		slog.Default().Warn("queue reconciliation could not resolve entries",
			"failed", result.Failed,
			"expired", result.Expired,
			"matched", result.Matched,
			"pending", result.Pending,
		)
		return
	}
	if result.Expired > 0 || result.Matched > 0 || result.Pending > 0 {
		slog.Default().Info("queue reconciliation pass",
			"expired", result.Expired,
			"matched", result.Matched,
			"pending", result.Pending,
		)
	}
}
