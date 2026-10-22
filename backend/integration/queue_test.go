package integration

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The queue tests drive the service with a deterministic clock, so every
// deadline, lease and cutoff is exact instead of approximate.

// queueClock is the deterministic clock of one queue test. It is named for the queue so it never collides with another integration fixture.
type queueClock struct {
	mu  sync.Mutex
	now time.Time
}

func newQueueClock() *queueClock {
	return &queueClock{now: time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)}
}

func (c *queueClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *queueClock) Advance(duration time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(duration)
}

// recordingCredentials records the issued engine credentials.
//
// It is the recording fixture of the queue tests. The credential path of the
// production composition is covered by the real allocator regression below.
//
// The fixture keeps the invariant of the real issuer: an ordinary request
// never rotates a live credential of a seat, and only an explicit rotation
// supersedes it.
type recordingCredentials struct {
	mu      sync.Mutex
	issued  []onlineauth.EngineSeatRequest
	secrets []string
	live    map[string]bool
}

func (c *recordingCredentials) IssueEngineSeatCredential(_ context.Context, request onlineauth.EngineSeatRequest) (onlineauth.EngineSeatCredentialOutcome, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.live == nil {
		c.live = map[string]bool{}
	}
	key := request.MatchID + "/" + string(request.Seat)
	if c.live[key] && !request.Rotate {
		// A routine issue keeps the live credential of the seat.
		return onlineauth.EngineSeatCredentialOutcome{Issued: false}, nil
	}
	c.issued = append(c.issued, request)
	secret := "kmgc1_testsecret" + fmt.Sprintf("%043d", len(c.issued))
	c.secrets = append(c.secrets, secret)
	c.live[key] = true
	return onlineauth.EngineSeatCredentialOutcome{Issued: true, Credential: onlineauth.IssuedSeatCredential{
		CredentialID: "kg-test-" + fmt.Sprintf("%08d", len(c.issued)),
		GuestID:      request.GuestID,
		MatchID:      request.MatchID,
		Seat:         request.Seat,
		Origin:       request.Origin,
		Secret:       secret,
		IssuedAt:     time.Unix(1_900_000_000, 0).UTC(),
		ExpiresAt:    time.Unix(1_900_003_600, 0).UTC(),
	}}, nil
}

// namedLabels names the owners of the test with a stable public label.
type namedLabels struct{}

func (namedLabels) PublicLabel(_ context.Context, accountID string) (string, error) {
	return "Player " + accountID, nil
}

// queueHarness is one queue under test.
type queueHarness struct {
	t           *testing.T
	pool        *pgxpool.Pool
	service     *queue.Service
	online      *online.Service
	clock       *queueClock
	credentials *recordingCredentials
	// application is the application name of the pool of the queue service.
	// It names the backends of this test, so the observation of a lock wait
	// can never be satisfied by the decision of another process.
	application string
}

// queuePoolCounter names the pools of the queue service of one process.
//
// The name is unique per pool, so the observation of a lock wait belongs to
// exactly one decision of exactly one test.
var queuePoolCounter atomic.Int64

// queueServicePool opens the pool of the queue service of one test.
//
// The pool carries the schema of the fixture and its own application name.
// The application name identifies the backend of a decision of this test in
// pg_stat_activity, so the wait of another process can never satisfy the
// observation of a lock wait.
func queueServicePool(t *testing.T, fixture *pgxpool.Pool) (*pgxpool.Pool, string) {
	t.Helper()
	var schema string
	if err := fixture.QueryRow(context.Background(), `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	dsn := os.Getenv(databaseEnv)
	if dsn == "" {
		t.Skipf("PostgreSQL integration unavailable: set %s", databaseEnv)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	application := fmt.Sprintf("kamkmchess-queue-test-%s-%d", randomSchemaSuffix(), queuePoolCounter.Add(1))
	cfg.ConnConfig.RuntimeParams["application_name"] = application
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, application
}

func newQueueHarness(t *testing.T) *queueHarness {
	t.Helper()
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	// The queue service runs on its own pool, so the backends of its
	// decisions are named and a test observes only its own decisions.
	servicePool, application := queueServicePool(t, pool)
	onlineService, err := online.Open(context.Background(), servicePool, moveEvaluator{})
	if err != nil {
		t.Fatal(err)
	}
	clock := newQueueClock()
	credentials := &recordingCredentials{}
	service, err := queue.Open(context.Background(), servicePool, queue.Options{
		Now: clock.Now,
		// The shared writer is the production allocator of the queue. The
		// regression therefore exercises the real acceptance path.
		Allocator:   onlineService,
		Labels:      namedLabels{},
		Credentials: credentials,
		Random:      func() float64 { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	return &queueHarness{t: t, pool: pool, service: service, online: onlineService, clock: clock, credentials: credentials, application: application}
}

func account(id string) online.ParticipantRef {
	return online.ParticipantRef{Kind: online.ParticipantAccount, ID: id}
}

func agentControl(label string) online.SeatControl {
	return online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label}
}

func humanControl() online.SeatControl {
	return online.SeatControl{Kind: online.ControlHuman}
}

// standardClock is the clock of the queue tests.
func standardClock() online.TimeControl {
	return online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
}

// holdBucketLock holds the time-control bucket lock of one clock in an open
// transaction.
//
// The queue takes the same lock before it decides anything, so a decision
// that starts while the lock is held waits for it. The test can then move
// the deterministic clock while the decision waits, which is the only honest
// way to show that the decision samples its time after the locks.
func (h *queueHarness) holdBucketLock(ctx context.Context, clock online.TimeControl) (pgx.Tx, error) {
	h.t.Helper()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("kamkmchess:queue:%d:%d", clock.StartingTimeMs, clock.IncrementMs)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// waitForBucketLockWaiter waits until a transaction of the fixture waits for
// the bucket lock of one clock.
//
// The observation is the lock itself: the decision of the queue has reached
// the bucket lock and waits for it. Only then may the test move the clock,
// so the decision provably waits for a lock it could not skip.
//
// The observation is bound to the backends of this test: the waiter has to
// be a backend of the pool of the queue service of this test. The decision
// of another process never satisfies the observation.
func (h *queueHarness) waitForBucketLockWaiter(ctx context.Context, clock online.TimeControl) {
	h.t.Helper()
	key := fmt.Sprintf("kamkmchess:queue:%d:%d", clock.StartingTimeMs, clock.IncrementMs)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		err := h.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks l
			JOIN pg_stat_activity a ON a.pid=l.pid
			WHERE l.locktype='advisory' AND NOT l.granted AND l.objsubid=1
			  AND a.application_name=$2
			  AND l.classid::bigint=((hashtextextended($1,0) >> 32) & 4294967295)
			  AND l.objid::bigint=(hashtextextended($1,0) & 4294967295)`, key, h.application).Scan(&waiting)
		if err == nil && waiting > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatal("the decision did not wait for the bucket lock")
}

// holdAccountScopeLock holds the account scope lock of one account in an
// open transaction.
//
// The queue takes the same lock before it consumes a candidate, so a decision
// that selected that candidate waits for it. The test can then move the
// deterministic clock while the decision waits, which is the only honest way
// to show that the decision samples its time after the locks.
func (h *queueHarness) holdAccountScopeLock(ctx context.Context, accountID string) (pgx.Tx, error) {
	h.t.Helper()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err = locks.LockAccountScope(ctx, tx, locks.AccountScope("account", accountID)); err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// waitForAccountScopeWaiter waits until a transaction of the fixture waits
// for the account scope lock of one account.
//
// The observation is the lock itself: the decision of the queue has reached
// the scope lock and waits for it. Only then may the test move the clock, so
// the decision provably waits for a lock it could not skip.
//
// The observation is bound to the backends of this test: the waiter has to
// be a backend of the pool of the queue service of this test. The decision
// of another process never satisfies the observation.
func (h *queueHarness) waitForAccountScopeWaiter(ctx context.Context, accountID string) {
	h.t.Helper()
	key := "kamkmchess.account." + locks.AccountScope("account", accountID)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		err := h.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks l
			JOIN pg_stat_activity a ON a.pid=l.pid
			WHERE l.locktype='advisory' AND NOT l.granted AND l.objsubid=1
			  AND a.application_name=$2
			  AND l.classid::bigint=((hashtext($1)::bigint >> 32) & 4294967295)
			  AND l.objid::bigint=(hashtext($1)::bigint & 4294967295)`, key, h.application).Scan(&waiting)
		if err == nil && waiting > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatal("the decision did not wait for the account scope lock")
}

// entryState reads the internal state of an entry from the database.
func (h *queueHarness) entryState(ctx context.Context, entryID string) (string, bool) {
	h.t.Helper()
	var state string
	var keepSearching bool
	if err := h.pool.QueryRow(ctx, `SELECT internal_state, keep_searching FROM online_queue_entries WHERE entry_id=$1`, entryID).Scan(&state, &keepSearching); err != nil {
		h.t.Fatalf("read the internal state of the entry: %v", err)
	}
	return state, keepSearching
}

// createEntry creates one explicit entry and fails the test when the service
// refuses it.
func (h *queueHarness) createEntry(owner string, control online.SeatControl, clock online.TimeControl, clientRequestID string) online.QueueEntry {
	h.t.Helper()
	entry, _, err := h.service.CreateEntry(context.Background(), account(owner), queue.CreateEntryRequest{
		Control:         control,
		TimeControl:     clock,
		ClientRequestID: clientRequestID,
	})
	if err != nil {
		h.t.Fatalf("create entry for %s: %v", owner, err)
	}
	return entry
}

// QUE-01: only an account enters the queue, and one entry produces one game.
func TestQueueRefusesGuestsAndConsumesAnEntryOnce(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	guest := online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest-1"}
	if _, _, err := h.service.CreateEntry(ctx, guest, queue.CreateEntryRequest{Control: agentControl("GPT-4o"), TimeControl: standardClock()}); !errors.Is(err, queue.ErrInvalidRequest) {
		t.Fatalf("guest entry error=%v, want ErrInvalidRequest", err)
	}
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	other := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("match: %v", err)
	}
	if assignment.MatchID == "" || assignment.OpponentLabel != "Player user_b" {
		t.Fatalf("unexpected assignment: %+v", assignment)
	}
	if assignment.Control.Kind != online.ControlAgent || assignment.Control.ModelLabel == nil || *assignment.Control.ModelLabel != "Custom model" {
		t.Fatalf("unexpected opponent control: %+v", assignment.Control)
	}
	// The same call again returns the same game. One entry produces one game.
	again, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("repeat match: %v", err)
	}
	if again.MatchID != assignment.MatchID || again.Seat != assignment.Seat {
		t.Fatalf("repeat match produced another game: %+v vs %+v", again, assignment)
	}
	// The opponent is consumed as well.
	stored, err := h.service.Entry(ctx, account("user_b"), other.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != online.QueueAssigned || stored.AssignedMatchID == nil || *stored.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the opponent entry was not assigned: %+v", stored)
	}
	// No game was created a second time.
	if _, err = h.online.GetMatch(ctx, assignment.MatchID); err != nil {
		t.Fatalf("read the assigned match: %v", err)
	}
}

// The match identifiers of two allocations never collide, even when two
// owners use the same client intent identifier. The intent is an owner
// scoped value and it never becomes the idempotency key of a match.
func TestQueueMatchIdentifiersNeverCollideAcrossOwners(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	first := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "intent-0001")
	h.clock.Advance(time.Millisecond)
	second := h.createEntry("user_b", agentControl("Claude"), standardClock(), "intent-0001")
	h.clock.Advance(time.Millisecond)
	third := h.createEntry("user_c", agentControl("Gemini"), standardClock(), "intent-0002")
	h.clock.Advance(time.Millisecond)
	fourth := h.createEntry("user_d", agentControl("Llama"), standardClock(), "intent-0002")
	if first.EntryID == second.EntryID || third.EntryID == fourth.EntryID {
		t.Fatal("two owners share one entry")
	}
	firstAssignment, err := h.service.Match(ctx, account("user_c"), third.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("first match: %v", err)
	}
	secondAssignment, err := h.service.Match(ctx, account("user_d"), fourth.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("second match: %v", err)
	}
	if firstAssignment.MatchID == secondAssignment.MatchID {
		t.Fatalf("two allocations share the match %s", firstAssignment.MatchID)
	}
	// The retry of one allocation names the same game.
	retry, err := h.service.Match(ctx, account("user_c"), third.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if retry.MatchID != firstAssignment.MatchID {
		t.Fatalf("the retry named another game: %s vs %s", retry.MatchID, firstAssignment.MatchID)
	}
}

// QUE-02: the compatibility rule of the service.
func TestQueueMatchesOnlyDifferentOwnersWithAnAgentSeat(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	human := h.createEntry("user_human", humanControl(), standardClock(), "")
	// The second human entry becomes ready a moment later, so the oldest
	// ready entry is the one that answers.
	h.clock.Advance(time.Millisecond)
	secondHuman := h.createEntry("user_human2", humanControl(), standardClock(), "")
	if _, err := h.service.Match(ctx, account("user_human"), human.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNoCandidate) {
		t.Fatalf("human/human match error=%v, want ErrNoCandidate", err)
	}
	if _, err := h.service.Match(ctx, account("user_human2"), secondHuman.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNoCandidate) {
		t.Fatalf("human/human match error=%v, want ErrNoCandidate", err)
	}
	// A human entry matches an agent entry.
	agent := h.createEntry("user_agent", agentControl("GPT-4o"), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_agent"), agent.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("human/agent match: %v", err)
	}
	if assignment.OpponentLabel != "Player user_human" {
		t.Fatalf("unexpected opponent label: %+v", assignment)
	}
	// The same owner is never paired with itself. The two entries use their
	// own clock, so no other entry of the queue is compatible with them.
	ownClock := online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 3_000}
	own := h.createEntry("user_own", agentControl("GPT-4o"), ownClock, "")
	h.createEntry("user_own", agentControl("Claude"), ownClock, "")
	if _, err := h.service.Match(ctx, account("user_own"), own.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNoCandidate) {
		t.Fatalf("same owner match error=%v, want ErrNoCandidate", err)
	}
	// A different clock is never paired.
	other := h.createEntry("user_other", agentControl("GPT-4o"), online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 1_000}, "")
	if _, err := h.service.Match(ctx, account("user_other"), other.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNoCandidate) {
		t.Fatalf("different clock match error=%v, want ErrNoCandidate", err)
	}
	// The refused attempts changed nothing.
	stored, err := h.service.Entry(ctx, account("user_own"), own.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != online.QueueWaiting {
		t.Fatalf("a refused match changed the entry: %+v", stored)
	}
}

// QUE-03: one owner may hold any number of entries and games.
func TestQueueOwnerHoldsUnlimitedConcurrentEntries(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	for index := 0; index < 3; index++ {
		h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), fmt.Sprintf("intent-%08d", index))
	}
	created := 0
	for index := 0; index < 3; index++ {
		entry, ok, err := h.service.CreateEntry(ctx, account("user_a"), queue.CreateEntryRequest{
			Control:         agentControl("GPT-4o"),
			TimeControl:     standardClock(),
			ClientRequestID: fmt.Sprintf("intent-%08d", index),
		})
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			created++
		}
		if entry.EntryID == "" {
			t.Fatal("an entry has no identity")
		}
	}
	if created != 0 {
		t.Fatalf("the replay of the intents created %d extra entries", created)
	}
}

// QUE-04: a second tab with the same intent creates no second entry.
func TestQueueCreationIsIdempotentPerOwner(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	first, created, err := h.service.CreateEntry(ctx, account("user_a"), queue.CreateEntryRequest{
		Control:         agentControl("GPT-4o"),
		TimeControl:     standardClock(),
		ClientRequestID: "intent-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("the first intent did not create an entry")
	}
	second, created, err := h.service.CreateEntry(ctx, account("user_a"), queue.CreateEntryRequest{
		Control:         agentControl("GPT-4o"),
		TimeControl:     standardClock(),
		ClientRequestID: "intent-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("the replay of an intent created a second entry")
	}
	if second.EntryID != first.EntryID {
		t.Fatalf("the replay produced another entry: %s vs %s", second.EntryID, first.EntryID)
	}
	// The same intent with another request is a conflict: the settings of an
	// entry are fixed.
	if _, _, err = h.service.CreateEntry(ctx, account("user_a"), queue.CreateEntryRequest{
		Control:         agentControl("Claude"),
		TimeControl:     standardClock(),
		ClientRequestID: "intent-0001",
	}); !errors.Is(err, queue.ErrConflict) {
		t.Fatalf("the reused intent error=%v, want ErrConflict", err)
	}
	// Another owner may use the same intent value.
	other, created, err := h.service.CreateEntry(ctx, account("user_b"), queue.CreateEntryRequest{
		Control:         agentControl("GPT-4o"),
		TimeControl:     standardClock(),
		ClientRequestID: "intent-0001",
	})
	if err != nil || !created {
		t.Fatalf("another owner could not use the same intent: %v", err)
	}
	if other.EntryID == first.EntryID {
		t.Fatal("two owners share one entry")
	}
}

// QUE-05: the search window starts at the authoritative ready acceptance.
func TestQueueWindowStartsAtTheReadyAcceptance(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	before := h.clock.Now()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	after := h.clock.Now()
	if entry.ReadyAt == nil || entry.CutoffAt == nil {
		t.Fatalf("the entry has no window: %+v", entry)
	}
	if entry.ReadyAt.Before(before) || entry.ReadyAt.After(after) {
		t.Fatalf("the ready time %s is not the acceptance time", entry.ReadyAt)
	}
	if !entry.CutoffAt.Equal(entry.ReadyAt.Add(10 * time.Second)) {
		t.Fatalf("the cutoff %s is not the ten second window after %s", entry.CutoffAt, entry.ReadyAt)
	}
	// A readiness check that takes longer does not move the window: the
	// window starts at the acceptance, not during the checks.
	h.clock.Advance(4 * time.Second)
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.CutoffAt == nil || !stored.CutoffAt.Equal(*entry.CutoffAt) {
		t.Fatalf("the window moved: %v vs %v", stored.CutoffAt, entry.CutoffAt)
	}
}

// QUE-07: an unresponsive entry expires and needs an explicit rejoin.
func TestQueueUnresponsiveEntryExpiresAndNeedsAnExplicitRejoin(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The owner stops answering. The lease runs out.
	h.clock.Advance(queue.DefaultReadinessTTL + time.Second)
	sweep, err := h.service.ExpireWaiting(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Expired != 1 {
		t.Fatalf("expired entries=%d, want 1", sweep.Expired)
	}
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != online.QueueWaiting || stored.ReadyAt != nil || stored.CutoffAt != nil {
		t.Fatalf("the expired entry is not reported as expired: %+v", stored)
	}
	// The expired entry is out of the eligibility.
	other := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	if _, err = h.service.Match(ctx, account("user_b"), other.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNoCandidate) {
		t.Fatalf("an expired entry was offered as a candidate: %v", err)
	}
	// The explicit rejoin starts a fresh window.
	rejoined, err := h.service.Ready(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	if rejoined.ReadyAt == nil || rejoined.CutoffAt == nil {
		t.Fatalf("the rejoin did not arm a window: %+v", rejoined)
	}
	if !rejoined.CutoffAt.Equal(rejoined.ReadyAt.Add(10 * time.Second)) {
		t.Fatalf("the rejoin did not start a fresh window: %+v", rejoined)
	}
	// The rearmed entry is eligible again.
	assignment, err := h.service.Match(ctx, account("user_b"), other.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("the rearmed entry was not eligible: %v", err)
	}
	if assignment.MatchID == "" {
		t.Fatal("the rearmed entry produced no game")
	}
}

// QUE-07: a responsive background owner stays eligible while it heartbeats.
func TestQueueResponsiveBackgroundEntryStaysEligible(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The owner keeps reporting in while the search runs.
	for step := 0; step < 3; step++ {
		h.clock.Advance(queue.DefaultReadinessTTL / 2)
		if _, err := h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err != nil {
			t.Fatalf("heartbeat %d: %v", step, err)
		}
	}
	sweep, err := h.service.ExpireWaiting(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Expired != 0 {
		t.Fatalf("a responsive entry expired: %d entries", sweep.Expired)
	}
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ReadyAt == nil || stored.Status != online.QueueWaiting {
		t.Fatalf("the responsive entry left the eligibility: %+v", stored)
	}
	// The entry is still a candidate for a fresh opponent.
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_b"), candidate.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("the responsive entry was not a candidate: %v", err)
	}
	if assignment.MatchID == "" {
		t.Fatal("the responsive entry produced no game")
	}
}

// QUE-08: the settings of a waiting entry stay fixed.
func TestQueueSelectionStaysFixedAndOtherEntriesSurvive(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	other := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The settings of an entry are fixed. A change of selection is a
	// cancellation and a new entry, never an edit.
	cancelled, err := h.service.Cancel(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != online.QueueCancelled {
		t.Fatalf("the entry was not cancelled: %+v", cancelled)
	}
	fresh := h.createEntry("user_a", agentControl("Claude"), standardClock(), "")
	if fresh.CutoffAt == nil || !fresh.CutoffAt.After(cancelled.UpdatedAt.Add(9*time.Second)) {
		t.Fatalf("the new entry did not start a fresh window: %+v", fresh)
	}
	// The other entry of the same owner is unaffected.
	survivor, err := h.service.Entry(ctx, account("user_a"), other.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if survivor.Status != online.QueueWaiting || survivor.CutoffAt == nil {
		t.Fatalf("the other entry changed: %+v", survivor)
	}
}

// QUE-09: a candidate that is ready exactly at the cutoff wins over the
// engine, and a later candidate does not.
func TestQueueCutoffEqualityWinsAndLaterCandidatesDoNot(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	cutoff := *entry.CutoffAt
	// A candidate that becomes ready exactly at the cutoff.
	h.clock.Advance(10 * time.Second)
	exact := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	if exact.ReadyAt == nil || !exact.ReadyAt.Equal(cutoff) {
		t.Fatalf("the candidate is not ready at the cutoff: %s vs %s", exact.ReadyAt, cutoff)
	}
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatalf("fallback at the cutoff: %v", err)
	}
	if assignment.Control.Kind != online.ControlAgent {
		t.Fatalf("the engine took the seat at the cutoff: %+v", assignment)
	}
	if assignment.OpponentLabel != "Player user_b" {
		t.Fatalf("unexpected opponent: %+v", assignment)
	}
	// A candidate that becomes ready after the cutoff never replaces a
	// committed opponent.
	h.clock.Advance(time.Millisecond)
	late := h.createEntry("user_c", agentControl("Gemini"), standardClock(), "")
	if late.ReadyAt == nil || !late.ReadyAt.After(cutoff) {
		t.Fatalf("the late candidate is not after the cutoff: %s", late.ReadyAt)
	}
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID == nil || *stored.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the committed opponent changed: %+v", stored)
	}
}

// QUE-10: two competing matchmakers produce exactly one game.
func TestQueueCompetingMatchersProduceOneGame(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	first := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	second := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	third := h.createEntry("user_c", agentControl("Gemini"), standardClock(), "")
	results := make(chan queue.Assignment, 3)
	errs := make(chan error, 3)
	var wg sync.WaitGroup
	for _, entry := range []string{first.EntryID, second.EntryID, third.EntryID} {
		owner := "user_a"
		if entry == second.EntryID {
			owner = "user_b"
		}
		if entry == third.EntryID {
			owner = "user_c"
		}
		wg.Add(1)
		go func(entryID, owner string) {
			defer wg.Done()
			assignment, err := h.service.Match(ctx, account(owner), entryID, queue.Operation{})
			results <- assignment
			errs <- err
		}(entry, owner)
	}
	wg.Wait()
	close(results)
	close(errs)
	matches := map[string]bool{}
	for err := range errs {
		if err != nil && !errors.Is(err, queue.ErrNoCandidate) {
			t.Fatalf("competing match: %v", err)
		}
	}
	for assignment := range results {
		if assignment.MatchID != "" {
			matches[assignment.MatchID] = true
		}
	}
	if len(matches) != 1 {
		t.Fatalf("the competing matchmakers produced %d games: %v", len(matches), matches)
	}
	// Exactly two entries are assigned and one still waits.
	assigned := 0
	waiting := 0
	for _, pair := range []struct {
		owner string
		id    string
	}{{"user_a", first.EntryID}, {"user_b", second.EntryID}, {"user_c", third.EntryID}} {
		stored, err := h.service.Entry(ctx, account(pair.owner), pair.id)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status == online.QueueAssigned {
			assigned++
		} else {
			waiting++
		}
	}
	if assigned != 2 || waiting != 1 {
		t.Fatalf("assigned=%d waiting=%d, want 2 and 1", assigned, waiting)
	}
}

// QUE-10: a cancellation and an assignment race to one outcome.
func TestQueueCancelAndAssignmentRaceHasOneOutcome(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	other := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = h.service.Match(ctx, account("user_b"), other.EntryID, queue.Operation{})
	}()
	go func() {
		defer wg.Done()
		_, _ = h.service.Cancel(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	}()
	wg.Wait()
	first, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.service.Entry(ctx, account("user_b"), other.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	switch first.Status {
	case online.QueueCancelled:
		if second.Status == online.QueueAssigned {
			t.Fatal("the cancelled entry was also assigned")
		}
	case online.QueueAssigned:
		if second.Status != online.QueueAssigned {
			t.Fatal("the assigned entry has no opponent")
		}
		if first.AssignedMatchID == nil || second.AssignedMatchID == nil || *first.AssignedMatchID != *second.AssignedMatchID {
			t.Fatalf("the pair does not share one game: %v %v", first.AssignedMatchID, second.AssignedMatchID)
		}
	default:
		t.Fatalf("unexpected state: %+v", first)
	}
}

// QUE-13: a late candidate and a late engine readiness never replace a
// committed opponent.
func TestQueueCommittedOpponentIsNeverReplaced(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The browser engine may only take the seat when the search window of
	// the entry has ended.
	h.clock.Advance(10 * time.Second)
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatalf("fallback: %v", err)
	}
	if assignment.Control.Kind != online.ControlEngine {
		t.Fatalf("the fallback did not use the engine: %+v", assignment)
	}
	if assignment.GuestCredential == nil || assignment.GuestCredential.Token == "" {
		t.Fatal("the fallback carried no engine credential")
	}
	// The engine seat is its own participant. The owner never owns it.
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID == nil || *stored.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the fallback did not assign the entry: %+v", stored)
	}
	// A late candidate cannot replace the engine.
	late := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	if _, err = h.service.Match(ctx, account("user_b"), late.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNoCandidate) {
		t.Fatalf("a late candidate was paired: %v", err)
	}
	after, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if after.AssignedMatchID == nil || *after.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the committed opponent changed: %+v", after)
	}
}

// F-10: the browser engine is its own participant. The requesting account
// never owns the opponent seat, and the credential is scoped to that one
// seat of that one match.
func TestQueueFallbackEngineSeatIsASeparateParticipant(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The engine takes the seat at the cutoff of the entry, never before it.
	h.clock.Advance(10 * time.Second)
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatalf("fallback: %v", err)
	}
	if assignment.GuestCredential == nil {
		t.Fatal("the fallback carried no engine credential")
	}
	match, err := h.online.GetMatch(ctx, assignment.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	var engineSeat, ownerSeat *online.MatchSeat
	for index := range match.Seats {
		switch match.Seats[index].Control.Kind {
		case online.ControlEngine:
			engineSeat = &match.Seats[index]
		default:
			ownerSeat = &match.Seats[index]
		}
	}
	if engineSeat == nil || ownerSeat == nil {
		t.Fatalf("the fallback match has no engine seat: %+v", match.Seats)
	}
	if engineSeat.Participant.Kind != online.ParticipantGuest {
		t.Fatalf("the engine seat is not a guest participant: %+v", engineSeat.Participant)
	}
	if engineSeat.Participant.ID == ownerSeat.Participant.ID {
		t.Fatal("the engine seat belongs to the requesting account")
	}
	if ownerSeat.Participant.ID != "user_a" || ownerSeat.Participant.Kind != online.ParticipantAccount {
		t.Fatalf("the owner does not own its own seat: %+v", ownerSeat.Participant)
	}
	if engineSeat.PublicLabel != queue.DefaultEngineLabel {
		t.Fatalf("the engine seat is not identified as the engine: %q", engineSeat.PublicLabel)
	}
	// The credential is scoped to the engine seat of that match only.
	if len(h.credentials.issued) != 1 {
		t.Fatalf("issued credentials=%d, want 1", len(h.credentials.issued))
	}
	issued := h.credentials.issued[0]
	if issued.MatchID != assignment.MatchID {
		t.Fatalf("the credential names another match: %s", issued.MatchID)
	}
	if issued.Seat != engineSeat.Seat {
		t.Fatalf("the credential names another seat: %s", issued.Seat)
	}
	if issued.GuestID != engineSeat.Participant.ID {
		t.Fatalf("the credential names another participant: %s", issued.GuestID)
	}
	if issued.Origin != "https://app.example" {
		t.Fatalf("the credential is scoped to another origin: %q", issued.Origin)
	}
	if assignment.GuestCredential.Seat != engineSeat.Seat || assignment.GuestCredential.MatchID != assignment.MatchID {
		t.Fatalf("the answer carries another credential: %+v", assignment.GuestCredential)
	}
}

// QUE-14: the standard position and random colors.
func TestQueueUsesTheStandardPositionAndRandomColors(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatal(err)
	}
	match, err := h.online.GetMatch(ctx, assignment.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.StartingFEN != queue.StandardStartingPosition {
		t.Fatalf("the queue used another position: %s", match.StartingFEN)
	}
	if match.TimeControl != standardClock() {
		t.Fatalf("the queue used another clock: %+v", match.TimeControl)
	}
	if len(match.Seats) != 2 {
		t.Fatalf("the match has %d seats", len(match.Seats))
	}
	white, black := match.Seats[0], match.Seats[1]
	if white.Seat != online.SeatWhite || black.Seat != online.SeatBlack {
		t.Fatalf("unexpected seats: %+v", match.Seats)
	}
	if white.Participant.ID == black.Participant.ID {
		t.Fatal("both seats belong to one participant")
	}
}

// ARC-10: a delayed worker resolves the original cutoff.
func TestQueueDelayedWorkerResolvesTheOriginalCutoff(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	cutoff := *entry.CutoffAt
	// A candidate that was ready before the original cutoff.
	h.clock.Advance(5 * time.Second)
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	if candidate.ReadyAt == nil || candidate.ReadyAt.After(cutoff) {
		t.Fatalf("the candidate was not ready before the cutoff: %s", candidate.ReadyAt)
	}
	// The timer is late: the worker runs two seconds after the original
	// cutoff.
	h.clock.Advance(7 * time.Second)
	// A candidate that became ready after the original cutoff.
	late := h.createEntry("user_c", agentControl("Gemini"), standardClock(), "")
	if late.ReadyAt == nil || !late.ReadyAt.After(cutoff) {
		t.Fatalf("the late candidate is not after the cutoff: %s", late.ReadyAt)
	}
	sweep, err := h.service.ResolveDueCutoffs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Matched != 1 {
		t.Fatalf("matched=%d, want 1", sweep.Matched)
	}
	assigned, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if assigned.AssignedMatchID == nil {
		t.Fatalf("the delayed worker did not assign the entry: %+v", assigned)
	}
	partner, err := h.service.Entry(ctx, account("user_b"), candidate.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if partner.AssignedMatchID == nil || *partner.AssignedMatchID != *assigned.AssignedMatchID {
		t.Fatalf("the delayed worker paired another entry: %+v", partner)
	}
	// The post cutoff candidate was not consumed.
	waiting, err := h.service.Entry(ctx, account("user_c"), late.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if waiting.Status != online.QueueWaiting || waiting.AssignedMatchID != nil {
		t.Fatalf("a post cutoff candidate was matched: %+v", waiting)
	}
}

// ARC-10: a late worker without a candidate never matches a post cutoff
// candidate.
func TestQueueLateWorkerDoesNotMatchPostCutoffCandidates(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	cutoff := *entry.CutoffAt
	h.clock.Advance(11 * time.Second)
	late := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	if late.ReadyAt == nil || !late.ReadyAt.After(cutoff) {
		t.Fatalf("the candidate is not after the cutoff: %s", late.ReadyAt)
	}
	h.clock.Advance(time.Second)
	sweep, err := h.service.ResolveDueCutoffs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Matched != 0 || sweep.Pending != 1 {
		t.Fatalf("the sweep matched=%d pending=%d, want 0 and 1", sweep.Matched, sweep.Pending)
	}
	waiting, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if waiting.AssignedMatchID != nil {
		t.Fatalf("the entry was assigned without a candidate: %+v", waiting)
	}
	// The entry waits for the engine fallback of the browser.
	fallback, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatalf("fallback: %v", err)
	}
	if fallback.Control.Kind != online.ControlEngine {
		t.Fatalf("the fallback did not use the engine: %+v", fallback)
	}
}

// The keep searching action removes the automatic cutoff.
func TestQueueKeepSearchingRemovesTheAutomaticCutoff(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	kept, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatal(err)
	}
	if kept.CutoffAt != nil {
		t.Fatalf("the entry kept its cutoff: %+v", kept)
	}
	// The sweep never resolves a cutoff that does not exist. The owner
	// keeps reporting in while the search runs.
	for step := 0; step < 3; step++ {
		h.clock.Advance(4 * time.Second)
		if _, err = h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err != nil {
			t.Fatalf("heartbeat %d: %v", step, err)
		}
	}
	sweep, err := h.service.ResolveDueCutoffs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Matched != 0 || sweep.Pending != 0 {
		t.Fatalf("the sweep resolved a kept search: %+v", sweep)
	}
	// A candidate that arrives later still matches the entry.
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_b"), candidate.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("the kept search did not match: %v", err)
	}
	if assignment.MatchID == "" {
		t.Fatal("the kept search produced no game")
	}
}

// A repeated operation returns the stored answer and never performs the
// operation twice.
func TestQueueOperationIdentifierIsExactlyOnce(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	operation := queue.Operation{ID: "operation-0001"}
	first, err := h.service.Cancel(ctx, account("user_a"), entry.EntryID, operation)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != online.QueueCancelled {
		t.Fatalf("the entry was not cancelled: %+v", first)
	}
	second, err := h.service.Cancel(ctx, account("user_a"), entry.EntryID, operation)
	if err != nil {
		t.Fatal(err)
	}
	if second.Version != first.Version || second.Status != first.Status {
		t.Fatalf("the repeated operation changed the answer: %+v vs %+v", second, first)
	}
}

// An entry of another owner is not found.
func TestQueueEntryOfAnotherOwnerIsNotFound(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	if _, err := h.service.Entry(ctx, account("user_b"), entry.EntryID); !errors.Is(err, queue.ErrNotFound) {
		t.Fatalf("foreign entry error=%v, want ErrNotFound", err)
	}
	if _, err := h.service.Cancel(ctx, account("user_b"), entry.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNotFound) {
		t.Fatalf("foreign cancel error=%v, want ErrNotFound", err)
	}
}

// A committed allocation is final. The sweep never resolves it again and the
// entries keep their one game.
func TestQueueCommittedAllocationIsNeverResolvedAgain(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	other := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatal(err)
	}
	// The sweep resolves nothing: the allocation is committed.
	sweep, err := h.service.Sweep(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Matched != 0 || sweep.Failed != 0 {
		t.Fatalf("the sweep resolved a committed allocation: %+v", sweep)
	}
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID == nil || *stored.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the assignment changed: %+v", stored)
	}
	partner, err := h.service.Entry(ctx, account("user_b"), other.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if partner.AssignedMatchID == nil || *partner.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the partner changed: %+v", partner)
	}
}

// The regressions of the independent queue review, round 4. Every one of them
// runs against the real PostgreSQL fixture and the real shared writer.
//
// They cover the three findings of the review:
//
//   - a kept search that follows a reached cutoff is a live search again,
//   - the browser engine never takes a seat before the deadline of the entry,
//   - the decision samples its time after the locks it waits for.

// QUE-13 and ARC-10: an entry whose cutoff was reached and that waits for the
// engine fallback is matchable again after the owner keeps searching.
//
// The kept search removes the cutoff and returns the entry to the
// eligibility, so a candidate that arrives later matches it.
func TestQueueKeptSearchAfterTheCutoffMatchesAgain(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The cutoff passes without a candidate.
	h.clock.Advance(10 * time.Second)
	sweep, err := h.service.ResolveDueCutoffs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Pending != 1 {
		t.Fatalf("the sweep did not record the pending fallback: %+v", sweep)
	}
	state, keepSearching := h.entryState(ctx, entry.EntryID)
	if state != "fallback" || keepSearching {
		t.Fatalf("the entry did not wait for the engine fallback: state=%q keep_searching=%v", state, keepSearching)
	}
	// The owner keeps searching. The cutoff is removed and the entry is a
	// live candidate again.
	kept, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("keep searching: %v", err)
	}
	if kept.CutoffAt != nil {
		t.Fatalf("the kept search kept its cutoff: %+v", kept)
	}
	state, keepSearching = h.entryState(ctx, entry.EntryID)
	if state != "waiting" || !keepSearching {
		t.Fatalf("the kept search is not a live search: state=%q keep_searching=%v", state, keepSearching)
	}
	// A candidate that arrives later matches the kept search.
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_b"), candidate.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("the kept search was not matchable: %v", err)
	}
	if assignment.MatchID == "" {
		t.Fatal("the kept search produced no game")
	}
	if assignment.OpponentLabel != "Player user_a" {
		t.Fatalf("the kept search matched another owner: %+v", assignment)
	}
}

// A repeated kept search is one operation. The second call changes nothing
// and the answer of the first call is the answer of the second one.
func TestQueueKeepSearchingIsIdempotent(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	first, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("keep searching: %v", err)
	}
	second, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("the repeated keep searching failed: %v", err)
	}
	if second.Version != first.Version {
		t.Fatalf("the repeated keep searching changed the entry: %+v vs %+v", second, first)
	}
	if second.CutoffAt != nil {
		t.Fatalf("the repeated keep searching armed a cutoff: %+v", second)
	}
	state, keepSearching := h.entryState(ctx, entry.EntryID)
	if state != "waiting" || !keepSearching {
		t.Fatalf("the repeated keep searching changed the state: state=%q keep_searching=%v", state, keepSearching)
	}
	// The operation identifier answers the same entry again.
	operation := queue.Operation{ID: "operation-0001"}
	third, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, operation)
	if err != nil {
		t.Fatalf("the kept search with an operation failed: %v", err)
	}
	fourth, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, operation)
	if err != nil {
		t.Fatalf("the repeated kept search with an operation failed: %v", err)
	}
	if third.Version != fourth.Version || third.CutoffAt != nil || fourth.CutoffAt != nil {
		t.Fatalf("the repeated operation changed the answer: %+v vs %+v", third, fourth)
	}
}

// A kept search is never overwritten by the reconciliation loop.
//
// The loop records the pending engine fallback in the transaction of its own
// decision, under the bucket lock. A kept search that won the interval
// therefore stays a kept search, and a later pass of the loop never touches
// it.
func TestQueueSweepNeverOverwritesAKeptSearch(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The cutoff passes without a candidate.
	h.clock.Advance(10 * time.Second)
	if _, err := h.service.ResolveDueCutoffs(ctx, 10); err != nil {
		t.Fatal(err)
	}
	// The owner keeps searching while the loop runs again.
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{})
		errs <- err
	}()
	go func() {
		defer wg.Done()
		_, err := h.service.ResolveDueCutoffs(ctx, 10)
		errs <- err
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("the race produced an error: %v", err)
		}
	}
	// The kept search wins the interval, whatever the order of the two
	// writes was. The loop never overwrites it.
	state, keepSearching := h.entryState(ctx, entry.EntryID)
	if state != "waiting" || !keepSearching {
		t.Fatalf("the loop overwrote the kept search: state=%q keep_searching=%v", state, keepSearching)
	}
	// The entry is a live search. A later pass of the loop never resolves
	// it and a candidate still matches it.
	sweep, err := h.service.ResolveDueCutoffs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Pending != 0 || sweep.Matched != 0 {
		t.Fatalf("the loop resolved a kept search: %+v", sweep)
	}
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	if _, err = h.service.Match(ctx, account("user_b"), candidate.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("the kept search was not matchable: %v", err)
	}
}

// QUE-05 and KHA-76: the browser engine never takes the seat of an entry
// before the deadline of that entry.
//
// The deadline selects the opponent. An engine that is committed while the
// search window still runs would take the seat of an opponent the owner was
// still promised a chance to find.
func TestQueueFallbackIsRefusedBeforeTheCutoff(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	if _, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"}); !errors.Is(err, queue.ErrConflict) {
		t.Fatalf("the engine took the seat before the cutoff: %v", err)
	}
	// The refused engine never produced a game and never issued a
	// credential.
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID != nil {
		t.Fatalf("the refused engine produced a game: %+v", stored)
	}
	if len(h.credentials.issued) != 0 {
		t.Fatalf("the refused engine issued %d credentials", len(h.credentials.issued))
	}
	// At the cutoff the engine takes the seat. The equality of the deadline
	// is the boundary of the rule.
	h.clock.Advance(10 * time.Second)
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatalf("the fallback at the cutoff failed: %v", err)
	}
	if assignment.Control.Kind != online.ControlEngine {
		t.Fatalf("the engine did not take the seat at the cutoff: %+v", assignment)
	}
}

// A candidate that is ready before the deadline still wins over the engine,
// even when the owner asks for the fallback early.
//
// The refusal of the early engine never removes the pairing of two owners.
func TestQueueEarlyFallbackStillPairsACandidate(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	h.clock.Advance(time.Second)
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatalf("the early fallback did not pair the candidate: %v", err)
	}
	if assignment.Control.Kind != online.ControlAgent {
		t.Fatalf("the early fallback took the engine seat: %+v", assignment)
	}
	if assignment.OpponentLabel != "Player user_b" {
		t.Fatalf("the early fallback paired another owner: %+v", assignment)
	}
	// The candidate of the pairing is consumed as well.
	stored, err := h.service.Entry(ctx, account("user_b"), candidate.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID == nil || *stored.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the candidate was not consumed: %+v", stored)
	}
}

// A kept search never revives a dead readiness lease.
//
// The lease of the owner is the signal that the owner is still there. An
// entry whose lease died needs the explicit rejoin, and a kept search never
// arms a fresh window.
func TestQueueKeepSearchingNeverRevivesADeadLease(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The owner stops reporting in. The lease runs out.
	h.clock.Advance(queue.DefaultReadinessTTL + time.Second)
	if _, err := h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrConflict) {
		t.Fatalf("the kept search revived a dead lease: %v", err)
	}
	state, keepSearching := h.entryState(ctx, entry.EntryID)
	if keepSearching || state != "waiting" {
		t.Fatalf("the refused kept search changed the entry: state=%q keep_searching=%v", state, keepSearching)
	}
	// The explicit rejoin of the expired entry arms a fresh window, and the
	// kept search works on the rearmed entry.
	if _, err := h.service.ExpireWaiting(ctx, 10); err != nil {
		t.Fatal(err)
	}
	rejoined, err := h.service.Ready(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	if rejoined.CutoffAt == nil {
		t.Fatalf("the rejoin did not arm a fresh window: %+v", rejoined)
	}
	if _, err = h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("the kept search of the rearmed entry failed: %v", err)
	}
}

// A kept search never revives an entry that waits for the engine fallback
// with a dead lease.
//
// The entry stays what it is: an entry that waits for the browser engine.
// Only the explicit rejoin arms a fresh window for it.
func TestQueueKeepSearchingNeverRevivesADeadFallbackLease(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The cutoff passes without a candidate and the entry waits for the
	// engine fallback.
	h.clock.Advance(10 * time.Second)
	sweep, err := h.service.ResolveDueCutoffs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Pending != 1 {
		t.Fatalf("the sweep did not record the pending fallback: %+v", sweep)
	}
	// The owner stops reporting in. The lease of the entry runs out.
	h.clock.Advance(queue.DefaultReadinessTTL + time.Second)
	if _, err = h.service.KeepSearching(ctx, account("user_a"), entry.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrConflict) {
		t.Fatalf("the kept search revived a dead lease: %v", err)
	}
	state, keepSearching := h.entryState(ctx, entry.EntryID)
	if keepSearching || state != "fallback" {
		t.Fatalf("the refused kept search changed the entry: state=%q keep_searching=%v", state, keepSearching)
	}
}

// The decision samples its time after the locks it waits for.
//
// A readiness lease that dies while the decision waits for the bucket lock is
// a dead lease. The entry of a silent owner never consumes a live candidate
// and never produces a game nobody will play.
func TestQueueLockWaitPastTheLeaseRefusesTheAllocation(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	// The candidate of the pair keeps reporting in, so its lease is live
	// when the decision runs.
	h.clock.Advance(10 * time.Second)
	if _, err := h.service.Heartbeat(ctx, account("user_b"), candidate.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	// The decision of the pair waits for the bucket lock.
	lock, err := h.holdBucketLock(ctx, standardClock())
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation
	// never leaves the decision waiting forever.
	defer lock.Rollback(ctx)
	results := make(chan error, 1)
	go func() {
		_, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{})
		results <- err
	}()
	// The decision waits for the bucket lock. Only then may the clock move.
	h.waitForBucketLockWaiter(ctx, standardClock())
	// The owner of the entry stops reporting in while the decision waits.
	h.clock.Advance(queue.DefaultReadinessTTL + time.Second)
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-results:
		if !errors.Is(err, queue.ErrConflict) {
			t.Fatalf("the expired entry produced a decision: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("the decision did not finish")
	}
	// The candidate was not consumed and no game exists.
	stored, err := h.service.Entry(ctx, account("user_b"), candidate.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID != nil || stored.Status != online.QueueWaiting {
		t.Fatalf("the candidate was consumed by an expired owner: %+v", stored)
	}
	owner, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if owner.AssignedMatchID != nil {
		t.Fatalf("the expired entry produced a game: %+v", owner)
	}
}

// The decision samples its time after the locks it waits for.
//
// A cutoff that passes while the decision waits for the bucket lock is a
// passed cutoff. The engine may then take the seat, because the deadline the
// owner was promised has been reached.
func TestQueueLockWaitPastTheCutoffAllowsTheEngine(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The decision starts while the window of the entry still runs.
	h.clock.Advance(9 * time.Second)
	lock, err := h.holdBucketLock(ctx, standardClock())
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation
	// never leaves the decision waiting forever.
	defer lock.Rollback(ctx)
	results := make(chan queue.Assignment, 1)
	errs := make(chan error, 1)
	go func() {
		assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
		results <- assignment
		errs <- err
	}()
	// The cutoff passes while the decision waits for the bucket lock.
	h.waitForBucketLockWaiter(ctx, standardClock())
	h.clock.Advance(3 * time.Second)
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var assignment queue.Assignment
	select {
	case err = <-errs:
		if err != nil {
			t.Fatalf("the decision refused the reached cutoff: %v", err)
		}
		assignment = <-results
	case <-time.After(60 * time.Second):
		t.Fatal("the decision did not finish")
	}
	if assignment.Control.Kind != online.ControlEngine {
		t.Fatalf("the engine did not take the seat after the reached cutoff: %+v", assignment)
	}
}

// The decision samples its time after the locks it waits for.
//
// A candidate that was ready by the original cutoff still wins over the
// engine, even when the decision of the entry runs after the cutoff.
func TestQueueLockWaitPastTheCutoffKeepsTheCandidate(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The candidate is ready before the cutoff of the entry.
	h.clock.Advance(time.Second)
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	// The decision starts while the window of the entry still runs.
	h.clock.Advance(8 * time.Second)
	lock, err := h.holdBucketLock(ctx, standardClock())
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation
	// never leaves the decision waiting forever.
	defer lock.Rollback(ctx)
	results := make(chan queue.Assignment, 1)
	errs := make(chan error, 1)
	go func() {
		assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
		results <- assignment
		errs <- err
	}()
	// The cutoff passes while the decision waits for the bucket lock.
	h.waitForBucketLockWaiter(ctx, standardClock())
	h.clock.Advance(3 * time.Second)
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var assignment queue.Assignment
	select {
	case err = <-errs:
		if err != nil {
			t.Fatalf("the decision failed: %v", err)
		}
		assignment = <-results
	case <-time.After(60 * time.Second):
		t.Fatal("the decision did not finish")
	}
	if assignment.Control.Kind != online.ControlAgent {
		t.Fatalf("the engine took the seat although a candidate was ready by the cutoff: %+v", assignment)
	}
	if assignment.OpponentLabel != "Player user_b" {
		t.Fatalf("the decision paired another owner: %+v", assignment)
	}
	// The candidate is consumed by the pairing.
	stored, err := h.service.Entry(ctx, account("user_b"), candidate.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID == nil || *stored.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the candidate was not consumed: %+v", stored)
	}
}

// The final candidate check uses the decision time.
//
// A candidate whose readiness lease dies while the decision waits is not
// consumed, even when it was ready by the cutoff of the entry.
//
// The decision waits for the bucket lock here, and the scan of the candidates
// runs after that lock. The candidate whose lease dies is therefore never
// selected at all. The final candidate check of a candidate that was selected
// and then dropped is covered by the account scope wait below.
func TestQueueLockWaitPastTheCandidateLeaseConsumesNoCandidate(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The candidate of the pair is ready long before the cutoff.
	h.clock.Advance(time.Second)
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	// The owner of the entry keeps reporting in, so its own lease is live
	// when the decision runs.
	h.clock.Advance(8 * time.Second)
	if _, err := h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	// The decision starts while the window of the entry still runs.
	lock, err := h.holdBucketLock(ctx, standardClock())
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation
	// never leaves the decision waiting forever.
	defer lock.Rollback(ctx)
	results := make(chan queue.Assignment, 1)
	errs := make(chan error, 1)
	go func() {
		assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
		results <- assignment
		errs <- err
	}()
	// The cutoff passes and the lease of the candidate dies while the
	// decision waits. The lease of the owner of the entry is still live.
	h.waitForBucketLockWaiter(ctx, standardClock())
	h.clock.Advance(11 * time.Second)
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var assignment queue.Assignment
	select {
	case err = <-errs:
		if err != nil {
			t.Fatalf("the decision failed: %v", err)
		}
		assignment = <-results
	case <-time.After(60 * time.Second):
		t.Fatal("the decision did not finish")
	}
	if assignment.Control.Kind != online.ControlEngine {
		t.Fatalf("a candidate with a dead lease took the seat: %+v", assignment)
	}
	// The candidate with the dead lease was not consumed.
	stored, err := h.service.Entry(ctx, account("user_b"), candidate.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID != nil {
		t.Fatalf("the candidate with the dead lease was consumed: %+v", stored)
	}
}

// The browser engine never takes the seat while another candidate is still
// eligible.
//
// The candidate of the first scan is dropped when its readiness lease dies
// while the decision waits for the account scope lock of its owner. A later
// candidate that was ready by the original cutoff is still eligible, so it
// wins over the engine: the seat of that candidate is never given to the
// engine because the lease of the first candidate died.
//
// The decision refuses the allocation instead of taking the seat of the
// later candidate, because the account scope of that candidate is not held by
// the decision and a scope lock that is taken after a row lock would break
// the lock order of the queue. The refusal is a retryable conflict, so the
// caller repeats the fallback; the repeat starts the decision again with the
// scope set of the later candidate.
func TestQueueDroppedCandidateNeverHandsTheSeatToTheEngine(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The first candidate is ready before the second one, so the scan of the
	// decision selects the first one.
	h.clock.Advance(time.Millisecond)
	first := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	h.clock.Advance(time.Millisecond)
	second := h.createEntry("user_c", agentControl("Gemini"), standardClock(), "")
	// The cutoff of the entry passes. The owner of the entry and the owner
	// of the second candidate keep reporting in, so their leases are live
	// when the decision runs.
	h.clock.Advance(10 * time.Second)
	if _, err := h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("heartbeat of the owner: %v", err)
	}
	if _, err := h.service.Heartbeat(ctx, account("user_c"), second.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("heartbeat of the second candidate: %v", err)
	}
	// The account scope lock of the first candidate is held, so the
	// decision waits for it after it selected the candidate.
	lock, err := h.holdAccountScopeLock(ctx, "user_b")
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation
	// never leaves the decision waiting forever.
	defer lock.Rollback(ctx)
	errs := make(chan error, 1)
	go func() {
		_, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
		errs <- err
	}()
	h.waitForAccountScopeWaiter(ctx, "user_b")
	// The lease of the first candidate dies while the decision waits. The
	// lease of the owner of the entry and the lease of the second
	// candidate are still live.
	h.clock.Advance(6 * time.Second)
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-errs:
		// The refusal is a retryable conflict and not a missing candidate:
		// a candidate exists, and the caller has to repeat the fallback
		// instead of believing that the queue is empty.
		if !errors.Is(err, queue.ErrConflict) {
			t.Fatalf("the dropped candidate did not refuse the allocation with a conflict: %v", err)
		}
		if errors.Is(err, queue.ErrNoCandidate) {
			t.Fatalf("the dropped candidate answered with a missing candidate: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("the decision did not finish")
	}
	// The engine took no seat, and no candidate was consumed.
	if len(h.credentials.issued) != 0 {
		t.Fatalf("the dropped candidate issued %d engine credentials", len(h.credentials.issued))
	}
	owner, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if owner.AssignedMatchID != nil {
		t.Fatalf("the dropped candidate produced a game: %+v", owner)
	}
	dropped, err := h.service.Entry(ctx, account("user_b"), first.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if dropped.AssignedMatchID != nil {
		t.Fatalf("the dropped candidate was consumed: %+v", dropped)
	}
	later, err := h.service.Entry(ctx, account("user_c"), second.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if later.AssignedMatchID != nil {
		t.Fatalf("the second candidate was consumed by the refused decision: %+v", later)
	}
	// The retry of the caller starts the decision with the scope set of the
	// second candidate, and the second candidate wins over the engine.
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatalf("the retry of the fallback failed: %v", err)
	}
	if assignment.Control.Kind != online.ControlAgent {
		t.Fatalf("the engine took the seat although a candidate was still eligible: %+v", assignment)
	}
	if assignment.OpponentLabel != "Player user_c" {
		t.Fatalf("the decision paired another owner: %+v", assignment)
	}
	later, err = h.service.Entry(ctx, account("user_c"), second.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if later.AssignedMatchID == nil || *later.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the second candidate was not consumed by the pairing: %+v", later)
	}
	// The dropped candidate is still waiting and was never consumed.
	dropped, err = h.service.Entry(ctx, account("user_b"), first.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if dropped.AssignedMatchID != nil {
		t.Fatalf("the dropped candidate was consumed: %+v", dropped)
	}
}

// A candidate that became ready after the original cutoff never wins over
// the engine, even when the decision of the entry runs late.
func TestQueueLateCandidateNeverWinsTheOriginalCutoff(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	cutoff := *entry.CutoffAt
	// The cutoff passes and a candidate becomes ready after it.
	h.clock.Advance(11 * time.Second)
	late := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	if late.ReadyAt == nil || !late.ReadyAt.After(cutoff) {
		t.Fatalf("the candidate is not after the cutoff: %s", late.ReadyAt)
	}
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatalf("fallback: %v", err)
	}
	if assignment.Control.Kind != online.ControlEngine {
		t.Fatalf("a candidate after the cutoff won the engine seat: %+v", assignment)
	}
	stored, err := h.service.Entry(ctx, account("user_b"), late.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID != nil {
		t.Fatalf("the late candidate was consumed: %+v", stored)
	}
}
