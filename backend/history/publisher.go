package history

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// DefaultPublishInterval is how often the publisher looks for the matches that
// completed and are not published yet.
const DefaultPublishInterval = 2 * time.Second

// DefaultPublishBatch bounds one publishing pass.
const DefaultPublishBatch = 50

// PublishConfig configures the publishing loop.
type PublishConfig struct {
	// Interval is how often the loop runs one pass.
	Interval time.Duration
	// Batch bounds the number of matches one pass publishes.
	Batch int
	// OnError receives the failure of a pass. It never stops the loop: a match
	// that could not be published stays pending and a later pass retries it.
	OnError func(error)
}

// StartPublisher starts the trusted publishing loop.
//
// The loop publishes the replay and the profile results of the matches that
// completed. It is a server capability: it never fabricates a participant
// identity, it never writes match state, and no HTTP route can trigger it.
//
// The loop runs until the returned stop function is called or the context is
// cancelled. The stop function waits for the loop to finish, so the caller can
// close its database pool without a background pass still using it.
func StartPublisher(ctx context.Context, publisher *Service, config PublishConfig) func() {
	if publisher == nil {
		return func() {}
	}
	interval := config.Interval
	if interval <= 0 {
		interval = DefaultPublishInterval
	}
	batch := config.Batch
	if batch <= 0 {
		batch = DefaultPublishBatch
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
				publishPass(runCtx, publisher, batch, config.OnError)
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

// publishPass runs one bounded publishing pass.
func publishPass(ctx context.Context, publisher *Service, batch int, onError func(error)) {
	if _, err := publisher.ProjectPending(ctx, batch); err != nil {
		if onError != nil {
			onError(err)
			return
		}
		slog.Default().Error("online history publication failed", "error", err)
	}
}
