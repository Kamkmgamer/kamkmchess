package integration

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
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
type recordingCredentials struct {
	mu      sync.Mutex
	issued  []onlineauth.EngineSeatRequest
	secrets []string
	live    bool
}

func (c *recordingCredentials) IssueEngineSeatCredential(_ context.Context, request onlineauth.EngineSeatRequest) (onlineauth.IssuedSeatCredential, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.issued = append(c.issued, request)
	secret := "kmgc1_testsecret" + fmt.Sprintf("%043d", len(c.issued))
	c.secrets = append(c.secrets, secret)
	c.live = true
	return onlineauth.IssuedSeatCredential{
		CredentialID: "kg-test-" + fmt.Sprintf("%08d", len(c.issued)),
		GuestID:      request.GuestID,
		MatchID:      request.MatchID,
		Seat:         request.Seat,
		Origin:       request.Origin,
		Secret:       secret,
		IssuedAt:     time.Unix(1_900_000_000, 0).UTC(),
		ExpiresAt:    time.Unix(1_900_003_600, 0).UTC(),
	}, nil
}

func (c *recordingCredentials) HasEngineSeatCredential(context.Context, string, online.Seat) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.live, nil
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
}

func newQueueHarness(t *testing.T) *queueHarness {
	t.Helper()
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	onlineService, err := online.Open(context.Background(), pool, moveEvaluator{})
	if err != nil {
		t.Fatal(err)
	}
	clock := newQueueClock()
	credentials := &recordingCredentials{}
	service, err := queue.Open(context.Background(), pool, queue.Options{
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
	return &queueHarness{t: t, pool: pool, service: service, online: onlineService, clock: clock, credentials: credentials}
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

func standardClock() online.TimeControl {
	return online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}
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
