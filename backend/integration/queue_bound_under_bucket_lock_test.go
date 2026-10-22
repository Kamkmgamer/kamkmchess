package integration

import (
	"context"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
)

// The first scan of a decision uses the bound of the row that the decision
// reads under the bucket lock.
//
// The decision reads the initiator row before it opens the transaction, and
// it opens the transaction before it takes the bucket lock. A transition of
// the entry that commits in that interval moves the bound of the entry: an
// entry that keeps searching accepts a candidate that is ready now, while
// an entry with a cutoff accepts only a candidate that was ready by the
// original cutoff.
//
// Every queue write takes the bucket lock before it writes the row, so the
// row that the decision reads under the bucket lock is the authoritative
// one. The decision reads it there and the first scan uses its bound, so the
// pairing happens in this decision and not in a later poll of the browser.
//
// The regression drives the race with the locks of the service itself and
// with no production hook. The transition of the entry holds the bucket lock
// of the time control while it waits for the account scope lock of the
// owner, the decision waits for the bucket lock behind it, and the
// transition commits before the decision observes the bucket.
func TestQueueDecisionUsesTheBoundOfTheRowUnderTheBucketLock(t *testing.T) {
	t.Run("the kept search of the owner commits before the decision", func(t *testing.T) {
		h := newQueueHarness(t)
		ctx := context.Background()
		// The entry of the owner starts its window. The cutoff of the entry
		// passes before the candidate becomes ready, so the candidate is only
		// eligible when the entry keeps searching.
		entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
		h.clock.Advance(11 * time.Second)
		candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
		// The kept search of the owner is the transition of the entry.
		assignment := runBoundUnderBucketLockScenario(t, h, ctx, entry, func() error {
			_, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{})
			return err
		})
		// The candidate wins over the engine and over the cutoff that the
		// entry had before the kept search.
		if assignment.OpponentLabel != "Player user_b" {
			t.Fatalf("the decision paired another owner: %+v", assignment)
		}
		if assignment.Control.Kind != online.ControlAgent {
			t.Fatalf("the decision did not pair an agent seat: %+v", assignment)
		}
		// The candidate is consumed by the pairing.
		stored, err := h.service.Entry(ctx, account("user_b"), candidate.EntryID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.AssignedMatchID == nil || *stored.AssignedMatchID != assignment.MatchID {
			t.Fatalf("the candidate was not consumed by the pairing: %+v", stored)
		}
		// The kept search is the state the decision observed, and the pairing
		// consumed the entry without touching it.
		state, keepSearching := h.entryState(ctx, entry.EntryID)
		if state != "assigned" || !keepSearching {
			t.Fatalf("the decision did not observe the kept search: state=%s keep_searching=%t", state, keepSearching)
		}
	})

	t.Run("the re-armed entry commits before the decision", func(t *testing.T) {
		h := newQueueHarness(t)
		ctx := context.Background()
		entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
		// The owner stops responding and the entry expires. The explicit
		// rejoin is the transition of the entry.
		h.clock.Advance(20 * time.Second)
		if _, err := h.service.ExpireWaiting(ctx, 10); err != nil {
			t.Fatalf("expire the entry: %v", err)
		}
		// The candidate becomes ready after the original cutoff of the
		// expired entry, so it is only eligible when the entry is re-armed.
		candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
		assignment := runBoundUnderBucketLockScenario(t, h, ctx, entry, func() error {
			_, err := h.service.Ready(ctx, account("user_a"), entry.EntryID, queue.Operation{})
			return err
		})
		if assignment.OpponentLabel != "Player user_b" {
			t.Fatalf("the decision paired another owner: %+v", assignment)
		}
		if assignment.Control.Kind != online.ControlAgent {
			t.Fatalf("the decision did not pair an agent seat: %+v", assignment)
		}
		stored, err := h.service.Entry(ctx, account("user_b"), candidate.EntryID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.AssignedMatchID == nil || *stored.AssignedMatchID != assignment.MatchID {
			t.Fatalf("the candidate was not consumed by the pairing: %+v", stored)
		}
		state, keepSearching := h.entryState(ctx, entry.EntryID)
		if state != "assigned" || keepSearching {
			t.Fatalf("the re-armed entry is in an unexpected state: state=%s keep_searching=%t", state, keepSearching)
		}
	})
}

// runBoundUnderBucketLockScenario drives one transition of an entry against
// one decision.
//
// The transition of the entry waits for the account scope lock of the owner,
// so it holds the bucket lock of the time control while the decision waits
// for it. The decision therefore reads the row of the entry before the
// transition commits and observes the transition in the row it reads under
// the bucket lock.
//
// The transition runs on the service itself: the test only holds the account
// scope lock of the owner, exactly like the removal race of a candidate
// does.
func runBoundUnderBucketLockScenario(t *testing.T, h *queueHarness, ctx context.Context, entry online.QueueEntry, transition func() error) queue.Assignment {
	t.Helper()
	// The account scope lock of the owner is held, so the transition of the
	// entry waits for it after it took the bucket lock.
	scope, err := h.holdAccountScopeLock(ctx, "user_a")
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation never
	// leaves the transition or the decision waiting forever.
	defer scope.Rollback(ctx)
	transitionResult := make(chan error, 1)
	go func() {
		transitionResult <- transition()
	}()
	// The observation proves that the transition holds the bucket lock of the
	// time control: the lock order of the queue is the bucket lock, then the
	// account scope lock, then the row lock.
	h.waitForAccountScopeWaiter(ctx, "user_a")
	// The decision starts and waits for the bucket lock behind the
	// transition. Its first read of the entry is behind it as well, so it
	// reads the row of the entry before the transition commits.
	answers := make(chan queue.Assignment, 1)
	failures := make(chan error, 1)
	go func() {
		assignment, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{})
		if err != nil {
			failures <- err
			return
		}
		answers <- assignment
	}()
	h.waitForBucketLockWaiter(ctx, standardClock())
	// The transition commits: the decision observes it in the row it reads
	// under the bucket lock.
	if err = scope.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-transitionResult:
		if err != nil {
			t.Fatalf("the transition of the entry failed: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("the transition of the entry did not finish")
	}
	select {
	case assignment := <-answers:
		return assignment
	case err = <-failures:
		t.Fatalf("the decision did not pair the candidate of the bucket: %v", err)
	case <-time.After(60 * time.Second):
		t.Fatal("the decision did not finish")
	}
	return queue.Assignment{}
}
