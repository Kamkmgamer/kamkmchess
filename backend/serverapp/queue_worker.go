package serverapp

import (
	"context"
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
}

// StartQueueReconciler starts the queue reconciliation loop.
//
// The loop expires the entries whose owner stopped responding, resolves the
// cutoffs that passed against their original deadline and finishes the
// reservations whose match is missing. It is bound to the server context and
// to the release function, so no sweep can run against a closed pool.
//
// The loop never commits the browser engine fallback. That needs a ready
// engine in the owner's browser, so the loop only records that the cutoff
// was reached.
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
				_, _ = service.Sweep(sweepCtx, batch)
			}
		}
	}()
	return cancel
}
