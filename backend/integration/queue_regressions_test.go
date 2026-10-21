package integration

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The regressions of the independent queue review, round 3. Every one of them
// runs against the real PostgreSQL fixture and the real shared writer.

// Q-01: the completion of one allocation is serialized. Two owners of one
// pair, or the reconciliation loop and an owner, never write the same match
// and never answer a server error for a committed game.
func TestQueueCompetingOwnersNeverSeeAServerError(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	for round := 0; round < 5; round++ {
		firstOwner := fmt.Sprintf("user_a%d", round)
		secondOwner := fmt.Sprintf("user_b%d", round)
		first := h.createEntry(firstOwner, agentControl("GPT-4o"), standardClock(), "")
		second := h.createEntry(secondOwner, agentControl("Claude"), standardClock(), "")
		results := make(chan queue.Assignment, 2)
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for _, pair := range []struct{ owner, id string }{{firstOwner, first.EntryID}, {secondOwner, second.EntryID}} {
			wg.Add(1)
			go func(owner, id string) {
				defer wg.Done()
				assignment, err := h.service.Match(ctx, account(owner), id, queue.Operation{})
				results <- assignment
				errs <- err
			}(pair.owner, pair.id)
		}
		wg.Wait()
		close(results)
		close(errs)
		for err := range errs {
			if err != nil && !errors.Is(err, queue.ErrNoCandidate) {
				t.Fatalf("round %d: the competing owners saw an error: %v", round, err)
			}
		}
		matches := map[string]bool{}
		for assignment := range results {
			if assignment.MatchID != "" {
				matches[assignment.MatchID] = true
			}
		}
		if len(matches) != 1 {
			t.Fatalf("round %d: the pair produced %d games: %v", round, len(matches), matches)
		}
	}
}

// Q-01: the reconciliation loop and the owner race on the same allocation.
// The pair still produces exactly one game and neither side sees an error.
func TestQueueSweepAndOwnerRaceOnTheSameAllocation(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	for round := 0; round < 3; round++ {
		first := h.createEntry(fmt.Sprintf("user_c%d", round), agentControl("GPT-4o"), standardClock(), "")
		second := h.createEntry(fmt.Sprintf("user_d%d", round), agentControl("Claude"), standardClock(), "")
		// The cutoff of the first entry passes, so the reconciliation loop
		// resolves it while the owner asks for a match.
		h.clock.Advance(11 * time.Second)
		var wg sync.WaitGroup
		errs := make(chan error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, err := h.service.Sweep(ctx, 10)
			errs <- err
		}()
		go func() {
			defer wg.Done()
			_, err := h.service.Match(ctx, account(fmt.Sprintf("user_c%d", round)), first.EntryID, queue.Operation{})
			if err != nil && !errors.Is(err, queue.ErrNoCandidate) {
				errs <- err
				return
			}
			errs <- nil
		}()
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("round %d: the race produced an error: %v", round, err)
			}
		}
		firstEntry, err := h.service.Entry(ctx, account(fmt.Sprintf("user_c%d", round)), first.EntryID)
		if err != nil {
			t.Fatal(err)
		}
		secondEntry, err := h.service.Entry(ctx, account(fmt.Sprintf("user_d%d", round)), second.EntryID)
		if err != nil {
			t.Fatal(err)
		}
		if firstEntry.AssignedMatchID == nil || secondEntry.AssignedMatchID == nil {
			t.Fatalf("round %d: the pair produced no game: %+v %+v", round, firstEntry, secondEntry)
		}
		if *firstEntry.AssignedMatchID != *secondEntry.AssignedMatchID {
			t.Fatalf("round %d: the pair produced two games: %v %v", round, *firstEntry.AssignedMatchID, *secondEntry.AssignedMatchID)
		}
	}
}

// Q-02: a routine retry of the fallback never rotates the credential the
// browser already holds.
func TestQueueRepeatedFallbackKeepsTheEngineCredential(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	first, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatal(err)
	}
	if first.GuestCredential == nil || first.GuestCredential.Token == "" {
		t.Fatal("the first fallback carried no engine credential")
	}
	// The routine retry answers the same assignment and carries no secret.
	second, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatal(err)
	}
	if second.MatchID != first.MatchID {
		t.Fatalf("the retry named another game: %v vs %v", second.MatchID, first.MatchID)
	}
	if second.GuestCredential != nil {
		t.Fatal("the routine retry rotated the engine credential")
	}
	if len(h.credentials.issued) != 1 {
		t.Fatalf("issued credentials=%d, want 1", len(h.credentials.issued))
	}
}

// Q-02: an explicit recovery of an owner that lost the answer rotates the
// credential on purpose.
func TestQueueExplicitRecoveryRotatesTheEngineCredential(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	first, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatal(err)
	}
	if first.GuestCredential == nil {
		t.Fatal("the first fallback carried no engine credential")
	}
	recovered, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{
		Origin:             "https://app.example",
		CredentialRecovery: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if recovered.GuestCredential == nil || recovered.GuestCredential.Token == "" {
		t.Fatal("the recovery carried no engine credential")
	}
	if recovered.GuestCredential.Token == first.GuestCredential.Token {
		t.Fatal("the recovery reused the secret of the lost answer")
	}
	if recovered.MatchID != first.MatchID {
		t.Fatalf("the recovery named another game: %v vs %v", recovered.MatchID, first.MatchID)
	}
}

// Q-03: the durable receipt never stores the plaintext of a credential.
func TestQueueReceiptNeverStoresTheEngineSecret(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{
		Operation: queue.Operation{ID: "operation-0001"},
		Origin:    "https://app.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	if assignment.GuestCredential == nil {
		t.Fatal("the fallback carried no engine credential")
	}
	var stored []byte
	if err = h.pool.QueryRow(ctx, `SELECT result_json FROM online_operation_receipts WHERE scope_kind='queue' AND scope_id=$1 AND operation_id=$2`, entry.EntryID, "operation-0001").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), assignment.GuestCredential.Token) {
		t.Fatalf("the durable receipt stores the engine secret: %s", stored)
	}
	if strings.Contains(string(stored), "kmgc1_") {
		t.Fatalf("the durable receipt stores a credential: %s", stored)
	}
	// The stored answer is the assignment without the secret.
	retry, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{
		Operation: queue.Operation{ID: "operation-0001"},
		Origin:    "https://app.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	if retry.MatchID != assignment.MatchID {
		t.Fatalf("the retry named another game: %v vs %v", retry.MatchID, assignment.MatchID)
	}
	if retry.GuestCredential != nil {
		t.Fatal("the stored answer carries a secret")
	}
}

// Q-04: the raw requested label never crosses an owner boundary and never
// reaches a durable row.
func TestQueueRawRequestedLabelNeverCrossesTheOwnerBoundary(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	raw := "internal-tunnel-route-v2"
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	other := h.createEntry("user_b", agentControl(raw), standardClock(), "")
	assignment, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Control.ModelLabel == nil || *assignment.Control.ModelLabel == raw {
		t.Fatalf("the answer carries the raw requested label: %+v", assignment.Control)
	}
	if *assignment.Control.ModelLabel != "Custom model" {
		t.Fatalf("the answer carries an unexpected label: %+v", assignment.Control)
	}
	// The durable rows carry the canonical label too.
	var stored string
	if err = h.pool.QueryRow(ctx, `SELECT opponent_control_model_label FROM online_queue_allocations WHERE initiator_entry_id=$1`, entry.EntryID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == raw {
		t.Fatalf("the allocation row stores the raw requested label: %s", stored)
	}
	var entryLabel string
	if err = h.pool.QueryRow(ctx, `SELECT seat_control_model_label FROM online_queue_entries WHERE entry_id=$1`, other.EntryID).Scan(&entryLabel); err != nil {
		t.Fatal(err)
	}
	if entryLabel == raw {
		t.Fatalf("the entry row stores the raw requested label: %s", entryLabel)
	}
	// The canonical seat of the match carries the same resolved label.
	match, err := h.online.GetMatch(ctx, assignment.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	for _, seat := range match.Seats {
		if seat.Control.Kind != online.ControlAgent {
			continue
		}
		if seat.Control.ModelLabel == nil || *seat.Control.ModelLabel == raw {
			t.Fatalf("the canonical seat carries the raw requested label: %+v", seat.Control)
		}
	}
}

// Q-05: the engine label of the fallback is the canonical one.
func TestQueueFallbackUsesTheCanonicalEngineLabel(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	assignment, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatal(err)
	}
	if assignment.OpponentLabel != "Stockfish 19 Lite" {
		t.Fatalf("the answer names the engine %q", assignment.OpponentLabel)
	}
	if assignment.Control.Kind != online.ControlEngine {
		t.Fatalf("the answer does not declare an engine: %+v", assignment.Control)
	}
	if assignment.Control.ModelLabel == nil || *assignment.Control.ModelLabel != "Stockfish 19 Lite (browser)" {
		t.Fatalf("the answer carries an unexpected engine label: %+v", assignment.Control)
	}
	match, err := h.online.GetMatch(ctx, assignment.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	for _, seat := range match.Seats {
		if seat.Control.Kind != online.ControlEngine {
			continue
		}
		if seat.PublicLabel != "Stockfish 19 Lite" {
			t.Fatalf("the canonical engine seat is named %q", seat.PublicLabel)
		}
		if seat.Control.ModelLabel == nil || *seat.Control.ModelLabel != "Stockfish 19 Lite (browser)" {
			t.Fatalf("the canonical engine seat carries %+v", seat.Control)
		}
	}
}

// Q-06: the readiness lease of the initiator is enforced inside the
// decision. A silent owner never consumes a live candidate.
func TestQueueExpiredInitiatorNeverConsumesACandidate(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	candidate := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	// The initiator stops reporting in. Its lease dies.
	h.clock.Advance(queue.DefaultReadinessTTL + time.Second)
	if _, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err == nil {
		t.Fatal("an expired initiator produced a game")
	} else if !errors.Is(err, queue.ErrConflict) {
		t.Fatalf("the expired initiator error=%v, want ErrConflict", err)
	}
	// The candidate is untouched and still waits.
	stored, err := h.service.Entry(ctx, account("user_b"), candidate.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != online.QueueWaiting || stored.AssignedMatchID != nil {
		t.Fatalf("the candidate was consumed by an expired initiator: %+v", stored)
	}
}

// Q-06: a heartbeat that arrives after the lease died never revives the
// entry. Only the explicit rejoin does.
func TestQueueLateHeartbeatNeverRevivesADeadLease(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	h.clock.Advance(queue.DefaultReadinessTTL + time.Second)
	if _, err := h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err == nil {
		t.Fatal("a late heartbeat revived a dead lease")
	} else if !errors.Is(err, queue.ErrConflict) {
		t.Fatalf("the late heartbeat error=%v, want ErrConflict", err)
	}
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ReadyAt == nil {
		t.Fatalf("the late heartbeat revived the entry: %+v", stored)
	}
	// The explicit rejoin arms a fresh window.
	rejoined, err := h.service.Ready(ctx, account("user_a"), entry.EntryID, queue.Operation{})
	if err != nil {
		t.Fatal(err)
	}
	if rejoined.ReadyAt == nil || rejoined.CutoffAt == nil {
		t.Fatalf("the rejoin did not arm a fresh window: %+v", rejoined)
	}
}

// Q-07: an entry whose cutoff passed and whose browser never reported a
// ready engine expires like every other silent entry.
func TestQueueFallbackPendingEntryExpires(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The cutoff passes without a candidate.
	h.clock.Advance(11 * time.Second)
	sweep, err := h.service.ResolveDueCutoffs(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if sweep.Pending != 1 {
		t.Fatalf("the sweep did not record the pending fallback: %+v", sweep)
	}
	stored, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != online.QueueWaiting || stored.ReadyAt == nil {
		t.Fatalf("the pending fallback is not a waiting entry: %+v", stored)
	}
	// The owner never reports in again. The entry expires.
	h.clock.Advance(queue.DefaultReadinessTTL + time.Second)
	expired, err := h.service.ExpireWaiting(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if expired.Expired != 1 {
		t.Fatalf("expired entries=%d, want 1", expired.Expired)
	}
	stored, err = h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ReadyAt != nil {
		t.Fatalf("the pending fallback never expired: %+v", stored)
	}
}

// Q-10: the engine credential of the production composition is real, it is
// scoped to the engine seat and the queue refuses it.
func TestQueueRealEngineCredentialIsScopedAndRefusedByTheQueue(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if err := migrations.Apply(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	onlineService, err := online.Open(ctx, pool, moveEvaluator{})
	if err != nil {
		t.Fatal(err)
	}
	authorizer := newTestAuthorizer(t, pool)
	allocator := onlineauth.NewAllocator(authorizer)
	clock := newQueueClock()
	service, err := queue.Open(ctx, pool, queue.Options{
		Now:         clock.Now,
		Allocator:   onlineService,
		Labels:      namedLabels{},
		Credentials: allocator,
		Random:      func() float64 { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, _, err := service.CreateEntry(ctx, account("user_a"), queue.CreateEntryRequest{
		Control:     agentControl("GPT-4o"),
		TimeControl: standardClock(),
	})
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatal(err)
	}
	if assignment.GuestCredential == nil || assignment.GuestCredential.Token == "" {
		t.Fatal("the fallback carried no engine credential")
	}
	// The credential authenticates as the engine participant of that seat.
	principal, err := authorizer.AuthenticateGuest(ctx, assignment.GuestCredential.Token, "https://app.example")
	if err != nil {
		t.Fatalf("the engine credential does not authenticate: %v", err)
	}
	if principal.Kind != online.ParticipantGuest {
		t.Fatalf("the engine credential is not a guest credential: %+v", principal)
	}
	if principal.MatchID != assignment.MatchID || principal.Seat != assignment.GuestCredential.Seat {
		t.Fatalf("the engine credential names another seat: %+v", principal)
	}
	if principal.Participant.ID == "user_a" {
		t.Fatal("the engine credential belongs to the requesting account")
	}
	// Another origin is refused.
	if _, err = authorizer.AuthenticateGuest(ctx, assignment.GuestCredential.Token, "https://other.example"); err == nil {
		t.Fatal("the engine credential works from another origin")
	}
	// The durable row stores only the hash of the secret.
	var stored string
	if err = pool.QueryRow(ctx, `SELECT encode(secret_hash,'hex') FROM online_guest_seat_credentials WHERE match_id=$1 AND seat=$2`, assignment.MatchID, assignment.GuestCredential.Seat).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, assignment.GuestCredential.Token) {
		t.Fatal("the durable row stores the plaintext of the engine credential")
	}
}

// newTestAuthorizer opens the real authorization service against the fixture
// database. The Clerk verifier is a fixture: the queue never verifies a
// session itself.
func newTestAuthorizer(t *testing.T, pool *pgxpool.Pool) *onlineauth.Service {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := fmt.Sprintf(`{"keys":[{"kty":"RSA","kid":"test-key","use":"sig","alg":"RS256","n":"%s","e":"AQAB"}]}`, base64.RawURLEncoding.EncodeToString(priv.N.Bytes()))
	verifier, err := auth.NewVerifier(auth.Config{
		Issuer:            "https://clerk.example",
		JWKSURL:           "https://clerk.example/.well-known/jwks.json",
		AuthorizedParties: []string{"https://app.example"},
		AllowedOrigins:    []string{"https://app.example"},
		HTTPClient: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(jwks)), Header: make(http.Header)}, nil
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	authorizer, err := onlineauth.Open(context.Background(), pool, verifier, onlineauth.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return authorizer
}
