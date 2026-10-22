package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
	"github.com/jackc/pgx/v5"
)

// The decision time of the queue is sampled after the locks the decision
// waits for.
//
// The three regressions below drive the three places where the queue used to
// sample its time before it took the locks it waits for:
//
//   - the creation of an entry sampled the ready time, the cutoff and the
//     readiness lease before it took the bucket lock and the account scope
//     lock, so an entry that waited for them began with a shortened search
//     window and a shortened lease;
//   - the sweep of the unresponsive entries selected the due entries with one
//     time and expired them with the selection, so a lease that a heartbeat
//     renewed while the sweep waited for the bucket lock was overwritten by a
//     stale decision;
//   - the cancellation of an expired entry tried to write a state the
//     database refuses, so the route answered a database failure.
//
// Every regression runs against the real PostgreSQL fixture, the real
// migrations and the real shared writer.

// The creation of an entry receives the full window and the full lease from
// the instant it commits.
//
// The creation waits for the bucket lock of its time control. The window and
// the lease of the entry start at the ready acceptance, and the ready
// acceptance is the committed creation of the entry, so the entry receives
// the whole window and the whole lease even when it waited for the lock of
// its bucket.
func TestQueueCreationReceivesTheFullWindowAfterTheBucketLock(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	// The bucket lock of the time control is held, so the creation of the
	// entry waits for it.
	lock, err := h.holdBucketLock(ctx, standardClock())
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation never
	// leaves the creation waiting forever.
	defer lock.Rollback(ctx)
	created := make(chan online.QueueEntry, 1)
	failures := make(chan error, 1)
	go func() {
		entry, _, err := h.service.CreateEntry(ctx, account("user_a"), queue.CreateEntryRequest{
			Control:     agentControl("GPT-4o"),
			TimeControl: standardClock(),
		})
		if err != nil {
			failures <- err
			return
		}
		created <- entry
	}()
	// The creation waits for the bucket lock of its time control.
	h.waitForBucketLockWaiter(ctx, standardClock())
	// Part of the window and of the lease passes while the creation waits.
	h.clock.Advance(5 * time.Second)
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var entry online.QueueEntry
	select {
	case entry = <-created:
	case err = <-failures:
		t.Fatalf("the creation of the entry failed: %v", err)
	case <-time.After(60 * time.Second):
		t.Fatal("the creation of the entry did not finish")
	}
	// The ready time is the instant the creation committed, not the instant
	// the call started.
	committed := h.clock.Now()
	if entry.ReadyAt == nil {
		t.Fatal("the entry carries no ready time")
	}
	if !entry.ReadyAt.Equal(committed) {
		t.Fatalf("the ready time is %s, want the committed creation %s", entry.ReadyAt, committed)
	}
	// The window is the full window from the ready acceptance.
	if entry.CutoffAt == nil {
		t.Fatal("the entry carries no cutoff")
	}
	if window := entry.CutoffAt.Sub(*entry.ReadyAt); window != queue.DefaultSearchWindow {
		t.Fatalf("the window of the entry is %s, want %s", window, queue.DefaultSearchWindow)
	}
	// The lease is the full lease from the ready acceptance, so the entry is
	// never expired when it is created.
	var expiresAt, createdAt, updatedAt time.Time
	if err = h.pool.QueryRow(ctx, `SELECT expires_at, created_at, updated_at FROM online_queue_entries WHERE entry_id=$1`, entry.EntryID).Scan(&expiresAt, &createdAt, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if lease := expiresAt.Sub(*entry.ReadyAt); lease != queue.DefaultReadinessTTL {
		t.Fatalf("the lease of the entry is %s, want %s", lease, queue.DefaultReadinessTTL)
	}
	if !expiresAt.After(committed) {
		t.Fatalf("the entry is already expired when it is created: %s", expiresAt)
	}
	// Every timestamp of the row comes from the same instant.
	if !createdAt.Equal(committed) || !updatedAt.Equal(committed) {
		t.Fatalf("the timestamps of the entry disagree: created=%s updated=%s want %s", createdAt, updatedAt, committed)
	}
	state, _ := h.entryState(ctx, entry.EntryID)
	if state != "waiting" {
		t.Fatalf("the created entry is in an unexpected state: %s", state)
	}
}

// The sweep never expires an entry whose lease was renewed while it waited.
//
// The heartbeat of the owner decides while the lease of the entry is still
// alive and renews it. The renewal is not committed yet when the sweep
// selects the entry, so the sweep selects an entry whose lease looks due.
// The sweep waits for the bucket lock of the time control, the heartbeat
// commits and releases it, and the sweep observes the renewed lease.
//
// The entry stays eligible, and the sweep reports no expiry it did not
// perform.
func TestQueueSweepDoesNotExpireAnEntryRenewedWhileItWaited(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The heartbeat of the owner decides while the lease of the entry is
	// still alive.
	h.clock.Advance(10 * time.Second)
	// The receipt of the heartbeat is written by the service in the
	// transaction of the heartbeat itself. The test writes it first and keeps
	// it uncommitted, so the heartbeat is still in flight after it renewed
	// the lease: it waits for the receipt of its operation.
	receipt, err := h.holdOperationReceipt(ctx, entry.EntryID, "renew-0001")
	if err != nil {
		t.Fatal(err)
	}
	// The receipt is released when the test ends, so a failed observation
	// never leaves the heartbeat waiting forever.
	defer receipt.Rollback(ctx)
	heartbeats := make(chan error, 1)
	go func() {
		_, err := h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{ID: "renew-0001"})
		heartbeats <- err
	}()
	// The heartbeat waits for the receipt of its operation, so it decided
	// already: it sampled its time and it renewed the lease. The bucket lock
	// of the time control is free, so the wait is the one of the receipt.
	h.waitForServiceLockWaiter(ctx)
	// The lease of the entry dies and the sweep selects the entry, because
	// the renewal of the heartbeat is not committed yet.
	h.clock.Advance(6 * time.Second)
	sweeps := make(chan queue.SweepResult, 1)
	sweepFailures := make(chan error, 1)
	go func() {
		result, err := h.service.ExpireWaiting(ctx, 10)
		if err != nil {
			sweepFailures <- err
			return
		}
		sweeps <- result
	}()
	// The sweep waits for the bucket lock of the time control, which the
	// heartbeat of the owner holds.
	h.waitForBucketLockWaiter(ctx, standardClock())
	// The heartbeat commits, the receipt of its operation is skipped and the
	// bucket lock is released.
	if err = receipt.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-heartbeats:
		if err != nil {
			t.Fatalf("the heartbeat of the owner failed: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("the heartbeat of the owner did not finish")
	}
	var sweep queue.SweepResult
	select {
	case sweep = <-sweeps:
	case err = <-sweepFailures:
		t.Fatalf("the sweep failed: %v", err)
	case <-time.After(60 * time.Second):
		t.Fatal("the sweep did not finish")
	}
	// The sweep reports no expiry it did not perform.
	if sweep.Expired != 0 {
		t.Fatalf("the sweep expired %d entries although the lease was renewed", sweep.Expired)
	}
	if sweep.Failed != 0 {
		t.Fatalf("the sweep failed on %d entries", sweep.Failed)
	}
	// The entry is still waiting.
	state, _ := h.entryState(ctx, entry.EntryID)
	if state != "waiting" {
		t.Fatalf("the renewed entry is in an unexpected state: %s", state)
	}
	// The entry is still eligible: another owner pairs with it.
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_b"), candidate.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("the pairing of the renewed entry failed: %v", err)
	}
	if assignment.OpponentLabel != "Player user_a" {
		t.Fatalf("the pairing did not use the renewed entry: %+v", assignment)
	}
}

// The cancellation of an expired entry is a refusal and never a database
// failure.
//
// The expiry of an entry is cleared only by an explicit rejoin, and the
// database refuses every other transition out of the expiry. The service
// therefore refuses the cancellation of an expired entry with the same
// conflict the heartbeat and the kept search of an expired entry answer.
func TestQueueCancelOfAnExpiredEntryIsARefusal(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The owner stops responding and the entry expires.
	h.clock.Advance(20 * time.Second)
	sweep, err := h.service.ExpireWaiting(ctx, 10)
	if err != nil {
		t.Fatalf("expire the entry: %v", err)
	}
	if sweep.Expired != 1 {
		t.Fatalf("expired entries=%d, want 1", sweep.Expired)
	}
	state, _ := h.entryState(ctx, entry.EntryID)
	if state != "expired" {
		t.Fatalf("the entry is in an unexpected state: %s", state)
	}
	// The cancellation of the expired entry is refused, and the refusal is
	// the conflict of the service and not a failure of the database.
	_, err = h.service.Cancel(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if !errors.Is(err, queue.ErrConflict) {
		t.Fatalf("the cancellation of an expired entry failed: %v", err)
	}
	// The refusal changed nothing: the entry is still expired.
	state, _ = h.entryState(ctx, entry.EntryID)
	if state != "expired" {
		t.Fatalf("the refused cancellation changed the entry: %s", state)
	}
	// Only the explicit rejoin revives the entry, and it starts a fresh
	// window.
	rejoined, err := h.service.Ready(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("the rejoin of the expired entry failed: %v", err)
	}
	if rejoined.ReadyAt == nil || rejoined.CutoffAt == nil {
		t.Fatalf("the rejoin did not arm a fresh window: %+v", rejoined)
	}
	if window := rejoined.CutoffAt.Sub(*rejoined.ReadyAt); window != queue.DefaultSearchWindow {
		t.Fatalf("the window of the rejoined entry is %s, want %s", window, queue.DefaultSearchWindow)
	}
}

// The route of the cancellation answers a conflict for an expired entry.
//
// The browser reads a conflict and not a server failure, so it can reconcile
// the entry instead of believing that the service is unavailable.
func TestQueueHTTPCancelOfAnExpiredEntryAnswersAConflict(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	authenticator := &queueHTTPAuthenticator{principals: map[string]queueHTTPPrincipal{
		"token-a": {token: "token-a", subject: "user_a", origin: "https://app.example", kind: online.ParticipantAccount},
	}}
	handler := httpapi.NewQueue(h.service, authenticator, httpapi.QueueOptions{AllowedOrigins: []string{"https://app.example"}})
	created := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries", "token-a",
		`{"schemaVersion":2,"control":{"kind":"agent","modelLabel":"GPT-4o"},"timeControl":{"startingTimeMs":300000,"incrementMs":2000}}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var entry map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	entryID, _ := entry["entryId"].(string)
	// The owner stops responding and the entry expires.
	h.clock.Advance(20 * time.Second)
	if _, err := h.service.ExpireWaiting(ctx, 10); err != nil {
		t.Fatalf("expire the entry: %v", err)
	}
	// The cancellation of the expired entry is a conflict and never a
	// temporary failure of the service.
	cancelled := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/"+entryID+"/cancel", "token-a", `{"schemaVersion":2}`)
	if cancelled.Code != http.StatusConflict {
		t.Fatalf("the cancellation status=%d body=%s, want 409", cancelled.Code, cancelled.Body.String())
	}
	// The entry is still expired: the answer reports a waiting entry without
	// a ready time, which is the shape the browser reads as expired.
	read := queueHTTPRequest(t, handler, http.MethodGet, "/v1/online/queue/entries/"+entryID, "token-a", "")
	if read.Code != http.StatusOK {
		t.Fatalf("the read status=%d body=%s", read.Code, read.Body.String())
	}
	var stored map[string]any
	if err := json.Unmarshal(read.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	if stored["status"] != "waiting" || stored["readyAt"] != nil {
		t.Fatalf("the entry is not reported as expired: %s", read.Body.String())
	}
}

// holdOperationReceipt writes the receipt of one queue operation and keeps it
// uncommitted.
//
// The service writes the receipt of an operation in the transaction of the
// operation itself. An uncommitted receipt therefore keeps the operation of
// the service in flight after it wrote its state, so a regression can observe
// the state change and the commit of the operation separately.
func (h *queueHarness) holdOperationReceipt(ctx context.Context, entryID, operationID string) (pgx.Tx, error) {
	h.t.Helper()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_operation_receipts(scope_kind,scope_id,operation_id,request_hash,result_json,version,control_epoch,accepted_at)
		VALUES('queue',$1,$2,$3,$4,1,1,clock_timestamp())`, entryID, operationID, make([]byte, 32), []byte("{}")); err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// waitForServiceLockWaiter waits until a backend of the queue service waits
// for a lock.
//
// The observation is the wait itself: the operation of the service reached a
// lock it cannot take yet. The scenario that uses it keeps the bucket lock of
// the time control free, so the wait is the one of the operation that waits
// for the receipt of its answer.
func (h *queueHarness) waitForServiceLockWaiter(ctx context.Context) {
	h.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		err := h.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`, h.application).Scan(&waiting)
		if err == nil && waiting > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatal("the service did not wait for a lock")
}
