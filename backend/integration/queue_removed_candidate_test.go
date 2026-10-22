package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5/pgconn"
)

// The removed candidate never hands the seat of the entry to the engine.
//
// The decision selects the oldest compatible ready candidate and then waits
// for the account scope lock of its owner. The removal of that owner commits
// while the decision waits, so the durable removal is observed inside the
// transaction of the decision and the selected candidate is dropped.
//
// A dropped candidate is never consumed, and it never hands the seat of the
// entry to the browser engine while another candidate is still eligible. The
// decision scans again at the decision time, and the refusal of the fallback
// is a retryable conflict: the caller repeats the fallback and the waiting
// candidate wins over the engine.
//
// The removal of an account deletes its waiting entries, and a restored copy
// may carry an entry of a removed account without that sanitation. Both
// shapes are covered, because a removed account is never paired in either of
// them.
func TestQueueRemovedCandidateNeverHandsTheSeatToTheEngine(t *testing.T) {
	t.Run("the removal deletes the waiting entry", func(t *testing.T) {
		runRemovedCandidateScenario(t, true)
	})
	t.Run("the waiting entry survives the removal", func(t *testing.T) {
		runRemovedCandidateScenario(t, false)
	})
}

// runRemovedCandidateScenario drives one removal race against one decision.
//
// The removal of the selected candidate commits while the decision waits for
// the account scope lock of the owner of that candidate.
func runRemovedCandidateScenario(t *testing.T, deleteWaitingEntry bool) {
	t.Helper()
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	// The first candidate is ready before the second one, so the scan of the
	// decision selects the first one.
	h.clock.Advance(time.Millisecond)
	h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	h.clock.Advance(time.Millisecond)
	later := h.createEntry("user_c", agentControl("Gemini"), standardClock(), "")
	// The cutoff of the entry passes. The owner of the entry and the owner of
	// the later candidate keep reporting in, so their leases are live when
	// the decision runs.
	h.clock.Advance(10 * time.Second)
	if _, err := h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("heartbeat of the owner: %v", err)
	}
	if _, err := h.service.Heartbeat(ctx, account("user_c"), later.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("heartbeat of the later candidate: %v", err)
	}
	// The account scope lock of the selected candidate is held, so the
	// decision waits for it after it selected the candidate.
	lock, err := h.holdAccountScopeLock(ctx, "user_b")
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation never
	// leaves the decision waiting forever.
	defer lock.Rollback(ctx)
	errs := make(chan error, 1)
	go func() {
		_, err := h.service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
		errs <- err
	}()
	// The observation proves that the decision selected the candidate of the
	// removed account: the scope lock of that candidate is the one the
	// decision waits for.
	h.waitForAccountScopeWaiter(ctx, "user_b")
	// The removal of the selected candidate commits while the decision waits.
	// The removal takes the same account scope lock, so the removal and the
	// decision are ordered and the decision observes the removal.
	if err = removeAccountInTx(ctx, lock, "user_b", deleteWaitingEntry); err != nil {
		t.Fatalf("write the removal: %v", err)
	}
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-errs:
		// The refusal is a retryable conflict and not a missing candidate: a
		// candidate exists, and the caller has to repeat the fallback
		// instead of believing that the queue is empty.
		if !errors.Is(err, queue.ErrConflict) {
			t.Fatalf("the removed candidate did not refuse the allocation with a conflict: %v", err)
		}
		if errors.Is(err, queue.ErrNoCandidate) {
			t.Fatalf("the removed candidate answered with a missing candidate: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("the decision did not finish")
	}
	// The engine took no seat, and no credential was issued.
	if len(h.credentials.issued) != 0 {
		t.Fatalf("the removed candidate issued %d engine credentials", len(h.credentials.issued))
	}
	owner, err := h.service.Entry(ctx, account("user_a"), entry.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if owner.AssignedMatchID != nil {
		t.Fatalf("the removed candidate produced a game: %+v", owner)
	}
	if owner.Status != online.QueueWaiting {
		t.Fatalf("the refused decision changed the state of the entry: %+v", owner)
	}
	// The later candidate is still waiting and was never consumed.
	laterEntry, err := h.service.Entry(ctx, account("user_c"), later.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if laterEntry.AssignedMatchID != nil {
		t.Fatalf("the later candidate was consumed by the refused decision: %+v", laterEntry)
	}
	// The retry of the caller starts the decision with the scope set of the
	// later candidate, and the later candidate wins over the engine.
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
	laterEntry, err = h.service.Entry(ctx, account("user_c"), later.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if laterEntry.AssignedMatchID == nil || *laterEntry.AssignedMatchID != assignment.MatchID {
		t.Fatalf("the later candidate was not consumed by the pairing: %+v", laterEntry)
	}
}

// A removed account is never a candidate of the scan.
//
// The entry of the removed account survives the removal, and the scan of the
// candidates must not offer it: a removed account is never paired, so its
// entry never answers the scan and never sends the decision into a pairing
// that the shared writer refuses.
func TestQueueRemovedAccountIsNeverScannedAsACandidate(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	removed := h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	// The removal of the account is recorded, and its waiting entry survives
	// the removal.
	if err := removeAccountInTx(ctx, h.pool, "user_b", false); err != nil {
		t.Fatalf("write the removal: %v", err)
	}
	if _, err := h.service.Match(ctx, account("user_a"), entry.EntryID, queue.Operation{}); !errors.Is(err, queue.ErrNoCandidate) {
		t.Fatalf("the removed account was offered as a candidate: %v", err)
	}
	stored, err := h.service.Entry(ctx, account("user_b"), removed.EntryID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.AssignedMatchID != nil {
		t.Fatalf("the removed account produced a game: %+v", stored)
	}
}

// removedCandidateAuthenticator resolves the caller of a queue request.
//
// The account path uses a fixture token: producing a genuine Clerk session
// token would need a live JWKS endpoint.
type removedCandidateAuthenticator struct {
	accounts map[string]string
}

func (a *removedCandidateAuthenticator) AuthenticateAccount(_ context.Context, token, origin string) (onlineauth.Principal, error) {
	accountID, ok := a.accounts[token]
	if !ok || origin != "https://app.example" {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	return onlineauth.NewAccountPrincipal(accountID, "session-"+accountID, origin, time.Unix(1_900_000_000, 0)), nil
}

func (a *removedCandidateAuthenticator) AuthenticateGuest(_ context.Context, _ string, _ string) (onlineauth.Principal, error) {
	return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
}

// removedCandidateRequest sends one request to the queue handler.
func removedCandidateRequest(t *testing.T, handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Origin", "https://app.example")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

// TestQueueHTTPFallbackAnswersAConflictWhenTheCandidateIsRemoved drives the
// removal race over the published routes.
//
// The browser engine never takes the seat while another candidate is still
// eligible. The route answers a conflict and not an assignment with an engine
// credential, so the browser repeats the fallback instead of believing that
// the queue is empty, and the repeated fallback pairs the candidate that is
// still waiting.
func TestQueueHTTPFallbackAnswersAConflictWhenTheCandidateIsRemoved(t *testing.T) {
	h := newQueueHarness(t)
	ctx := context.Background()
	authenticator := &removedCandidateAuthenticator{accounts: map[string]string{
		"token-a": "user_a",
		"token-b": "user_b",
		"token-c": "user_c",
	}}
	handler := httpapi.NewQueue(h.service, authenticator, httpapi.QueueOptions{AllowedOrigins: []string{"https://app.example"}})
	// The entry of the owner, the candidate the scan selects and the
	// candidate that is still waiting behind it.
	entry := h.createEntry("user_a", agentControl("GPT-4o"), standardClock(), "")
	h.clock.Advance(time.Millisecond)
	h.createEntry("user_b", agentControl("Claude"), standardClock(), "")
	h.clock.Advance(time.Millisecond)
	second := h.createEntry("user_c", agentControl("Gemini"), standardClock(), "")
	// The cutoff of the entry passes. The owner of the entry and the owner of
	// the second candidate keep reporting in, so their leases are live when
	// the decision runs.
	h.clock.Advance(10 * time.Second)
	if _, err := h.service.Heartbeat(ctx, account("user_a"), entry.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("heartbeat of the owner: %v", err)
	}
	if _, err := h.service.Heartbeat(ctx, account("user_c"), second.EntryID, queue.Operation{}); err != nil {
		t.Fatalf("heartbeat of the second candidate: %v", err)
	}
	// The account scope lock of the selected candidate is held, so the
	// decision waits for it after it selected the candidate.
	lock, err := h.holdAccountScopeLock(ctx, "user_b")
	if err != nil {
		t.Fatal(err)
	}
	// The lock is released when the test ends, so a failed observation never
	// leaves the decision waiting forever.
	defer lock.Rollback(ctx)
	answers := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		answers <- removedCandidateRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/"+entry.EntryID+"/fallback", "token-a", `{"schemaVersion":2}`)
	}()
	h.waitForAccountScopeWaiter(ctx, "user_b")
	// The removal of the selected candidate commits while the decision waits.
	if err = removeAccountInTx(ctx, lock, "user_b", true); err != nil {
		t.Fatalf("write the removal: %v", err)
	}
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var refused *httptest.ResponseRecorder
	select {
	case refused = <-answers:
	case <-time.After(60 * time.Second):
		t.Fatal("the fallback did not finish")
	}
	if refused.Code != http.StatusConflict {
		t.Fatalf("the removed candidate answered status=%d body=%s, want 409", refused.Code, refused.Body.String())
	}
	// The refusal carries no game and no engine credential.
	if strings.Contains(refused.Body.String(), "guestCredential") || strings.Contains(refused.Body.String(), "Stockfish") {
		t.Fatalf("the refused fallback carries an engine: %s", refused.Body.String())
	}
	if len(h.credentials.issued) != 0 {
		t.Fatalf("the removed candidate issued %d engine credentials", len(h.credentials.issued))
	}
	// The repeated fallback starts the decision with the scope set of the
	// second candidate, and the second candidate wins over the engine.
	retry := removedCandidateRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/"+entry.EntryID+"/fallback", "token-a", `{"schemaVersion":2}`)
	if retry.Code != http.StatusOK {
		t.Fatalf("the repeated fallback status=%d body=%s", retry.Code, retry.Body.String())
	}
	var assignment map[string]any
	if err := json.Unmarshal(retry.Body.Bytes(), &assignment); err != nil {
		t.Fatal(err)
	}
	if assignment["opponentLabel"] != "Player user_c" {
		t.Fatalf("the repeated fallback paired another owner: %s", retry.Body.String())
	}
	if assignment["control"].(map[string]any)["kind"] != "agent" {
		t.Fatalf("the engine took the seat although a candidate was still eligible: %s", retry.Body.String())
	}
	if _, ok := assignment["guestCredential"]; ok {
		t.Fatalf("the repeated fallback issued an engine credential: %s", retry.Body.String())
	}
}

// removalWriter is the write surface of the removal of an account.
//
// A transaction and a pool are both write surfaces, and the removal is
// written in the one that the caller needs: the transaction that holds the
// account scope lock of the account, or the pool of the fixture.
type removalWriter interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// removeAccountInTx writes the durable removal of an account.
//
// The removal tables store the one-way reference of the subject, so the
// account identifier never reaches the database.
//
// The waiting entries of the account are deleted, exactly like the removal of
// the privacy service does. A removal that keeps the entry stands for a
// restored copy that carries the entry without the sanitation of the removal.
//
// The caller decides where the removal is written: the transaction that holds
// the account scope lock of the account orders the removal against a queue
// decision that selected the account as a candidate.
func removeAccountInTx(ctx context.Context, tx removalWriter, accountID string, deleteWaitingEntry bool) error {
	now := time.Unix(1_900_000_000, 0).UTC()
	removalID := "rm_queue_removed_candidate"
	if _, err := tx.Exec(ctx, `INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,applied_at,live_delete_due_at,recovery_sanitize_due_at,removed_match_count,anonymized_match_count)
		VALUES($1,'account',$2,'explicit_removal','applied',$3,$3,$3,$3,$3,0,0)`, removalID, subject.Reference(accountID), now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO online_account_deletions(deletion_id,account_id,requested_at,applied_at,removal_id)
		VALUES($1,$2,$3,$3,$4)`, "rd_queue_removed_candidate", subject.Reference(accountID), now, removalID); err != nil {
		return err
	}
	if !deleteWaitingEntry {
		return nil
	}
	// A waiting entry is deleted: it names nobody any more.
	_, err := tx.Exec(ctx, `DELETE FROM online_queue_entries WHERE owner_kind='account' AND owner_id=$1 AND status <> 'assigned'`, accountID)
	return err
}
