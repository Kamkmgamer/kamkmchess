package serverapp

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/queue"
)

// failingQueue is a queue whose sweep reports a failure.
type failingQueue struct {
	result queue.SweepResult
	err    error
}

func (q *failingQueue) Sweep(context.Context, int) (queue.SweepResult, error) {
	return q.result, q.err
}

// The reconciliation loop reports the result of a pass. A queue that fails
// every pass has to be visible from the outside.
func TestQueueReconcilerReportsTheSweepResult(t *testing.T) {
	var buffer bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buffer, nil)))
	defer slog.SetDefault(previous)

	sweepQueue(context.Background(), &failingQueue{result: queue.SweepResult{Failed: 2, Expired: 1}}, 10, nil)
	report := buffer.String()
	if !strings.Contains(report, "queue reconciliation") {
		t.Fatalf("the failed pass was not reported: %s", report)
	}
	if strings.Contains(report, "kmgc1_") || strings.Contains(report, "user_") {
		t.Fatalf("the report carries a secret or an identifier: %s", report)
	}
	var entry map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(report)), &entry); err != nil {
		t.Fatalf("the report is not a structured log line: %s", report)
	}
	if entry["failed"] != float64(2) {
		t.Fatalf("the report does not count the failures: %s", report)
	}
}

// A pass that fails reaches the error hook of the composition.
func TestQueueReconcilerReportsAFailedPass(t *testing.T) {
	var buffer bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buffer, nil)))
	defer slog.SetDefault(previous)

	reported := make(chan error, 1)
	sweepQueue(context.Background(), &failingQueue{err: context.DeadlineExceeded}, 10, func(err error) {
		reported <- err
	})
	select {
	case err := <-reported:
		if err == nil {
			t.Fatal("the hook received no error")
		}
	default:
		t.Fatal("the hook was not called")
	}
}

// The loop stops with the context and never runs against a closed pool.
func TestQueueReconcilerStopsWithTheContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	stop := StartQueueReconciler(ctx, nil, QueueSweepConfig{Interval: time.Millisecond})
	stop()
	cancel()
}
