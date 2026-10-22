package integration

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
)

// The queue and the removal of an account share the account scope lock, so a
// removal and a queue write of one account are ordered instead of racing.
// The durable removal is re-read inside the transaction of every queue
// write, so an account that was authenticated before its removal cannot
// write queue state afterwards.

// removeAccount writes the durable removal of an account.
//
// The removal tables store the one-way reference of the subject, so the
// account identifier never reaches the database.
func removeAccount(t *testing.T, h *queueHarness, accountID string) {
	t.Helper()
	ctx := context.Background()
	now := time.Unix(1_900_000_000, 0).UTC()
	removalID := "rm_queue_removal_0001"
	if _, err := h.pool.Exec(ctx, `INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,applied_at,live_delete_due_at,recovery_sanitize_due_at,removed_match_count,anonymized_match_count)
		VALUES($1,'account',$2,'explicit_removal','applied',$3,$3,$3,$3,$3,0,0)`, removalID, subject.Reference(accountID), now); err != nil {
		t.Fatalf("write the removal request: %v", err)
	}
	if _, err := h.pool.Exec(ctx, `INSERT INTO online_account_deletions(deletion_id,account_id,requested_at,applied_at,removal_id)
		VALUES($1,$2,$3,$3,$4)`, "rd_queue_deletion_0001", subject.Reference(accountID), now, removalID); err != nil {
		t.Fatalf("write the account deletion: %v", err)
	}
}

// A removed account cannot create an entry, rearm one, heartbeat one or
// commit a fallback.
func TestQueueRemovedAccountCannotWriteQueueState(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	removeAccount(t, h, "user_a")

	if _, _, err := h.service.CreateEntry(ctx, account("user_a"), queue.CreateEntryRequest{
		Control:     agentControl("GPT-4o"),
		TimeControl: standardClock(),
	}); !errors.Is(err, queue.ErrAccountRemoved) {
		t.Fatalf("the removed account created an entry: %v", err)
	}
	if _, err := h.service.Ready(ctx, account("user_a"), entry.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrAccountRemoved) {
		t.Fatalf("the removed account rearmed its entry: %v", err)
	}
	if _, err := h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrAccountRemoved) {
		t.Fatalf("the removed account heartbeated its entry: %v", err)
	}
	if _, err := h.service.Cancel(ctx, account("user_a"), entry.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrAccountRemoved) {
		t.Fatalf("the removed account cancelled its entry: %v", err)
	}
	if _, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"}); !errors.Is(err, queue.ErrAccountRemoved) {
		t.Fatalf("the removed account committed a fallback: %v", err)
	}
	// The entry of the removed account was never assigned.
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID != nil {
		t.Fatalf("the removed account produced a game: %+v", stored)
	}
}

// A removed account is never paired as a candidate.
func TestQueueRemovedAccountIsNeverPaired(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	// The entry of the removed account exists from before the removal.
	entry := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	removeAccount(t, h, "user_b")
	other := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	if _, err := h.service.Match(ctx, account("user_a"), other.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNoCandidate) {
		t.Fatalf("the removed account was paired: %v", err)
	}
	stored, err := h.service.Entry(ctx, account("user_b"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID != nil {
		t.Fatalf("the removed account produced a game: %+v", stored)
	}
}

// The removal and the queue write of one account are ordered by the account
// scope lock. A write that arrives while the removal holds the lock waits
// for it and is refused once the removal committed.
func TestQueueRemovalOrdersTheQueueWrites(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	// The removal takes the account scope lock of the account and holds it.
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = locks.LockAccountScope(ctx, tx, locks.AccountScope("account", "user_a")); err != nil {
		t.Fatal(err)
	}
	// The queue write waits for the scope lock.
	created := make(chan error, 1)
	go func() {
		_, _, err := h.service.CreateEntry(ctx, account("user_a"), queue.CreateEntryRequest{
			Control:     agentControl("GPT-4o"),
			TimeControl: standardClock(),
		})
		created <- err
	}()
	select {
	case err = <-created:
		t.Fatalf("the queue write did not wait for the scope lock: %v", err)
	case <-time.After(500 * time.Millisecond):
	}
	// The removal commits while it holds the lock.
	now := time.Unix(1_900_000_000, 0).UTC()
	if _, err = tx.Exec(ctx, `INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,applied_at,live_delete_due_at,recovery_sanitize_due_at,removed_match_count,anonymized_match_count)
		VALUES($1,'account',$2,'explicit_removal','applied',$3,$3,$3,$3,$3,0,0)`, "rm_queue_removal_0002", subject.Reference("user_a"), now); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_account_deletions(deletion_id,account_id,requested_at,applied_at,removal_id)
		VALUES($1,$2,$3,$3,$4)`, "rd_queue_deletion_0002", subject.Reference("user_a"), now, "rm_queue_removal_0002"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// The write proceeds after the removal and is refused.
	select {
	case err = <-created:
		if !errors.Is(err, queue.ErrAccountRemoved) {
			t.Fatalf("the queue write was not refused: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the queue write never finished")
	}
	// The entry of the removed account was never written.
	var count int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM online_queue_entries WHERE owner_id=$1`, "user_a").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("the removed account wrote %d entries", count)
	}
}

// The sweep never resolves an entry of a removed account, and it does not
// report it as a failure.
func TestQueueSweepSkipsARemovedAccount(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	removeAccount(t, h, "user_a")
	h.clock.Advance(11 * time.Second)
	sweep, err := h.service.Sweep(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Failed != 0 {
		t.Fatalf("the sweep reported a failure for a removed account: %+v", sweep)
	}
	if sweep.Matched != 0 {
		t.Fatalf("the sweep matched a removed account: %+v", sweep)
	}
}

// The queue reports the removal of an account as an unauthorized request.
func TestQueueRemovedAccountAnswersUnauthorized(t *testing.T) {
	h := newQueueHarness(t)
	removeAccount(t, h, "user_a")
	_, _, err := h.service.CreateEntry(context.Background(), account("user_a"), queue.CreateEntryRequest{
		Control:     agentControl("GPT-4o"),
		TimeControl: standardClock(),
	})
	if !errors.Is(err, queue.ErrAccountRemoved) {
		t.Fatalf("the removed account was not refused: %v", err)
	}
	if fmt.Sprint(err) == "" {
		t.Fatal("the error carries no message")
	}
}
