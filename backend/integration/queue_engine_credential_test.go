package integration

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The engine credential of a browser engine fallback is issued once.
//
// Two tabs of one owner are allowed traffic: both observe the same entry and
// both may commit the browser engine fallback of it. The routine fallback of
// the second tab must never revoke the secret the first tab already holds.
//
// The regressions below run against the real PostgreSQL fixture and the real
// credential path. The barrier of the issuer makes the concurrency honest:
// both callers are inside the issuer before either of them leaves it, so the
// second caller observes the state the first one committed.

// The concurrent routine fallbacks of one entry produce one credential, and
// the secret the first tab received keeps working.
func TestQueueConcurrentRoutineFallbackKeepsTheFirstEngineCredential(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
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
		Credentials: newBarrierIssuer(allocator, 2),
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
	// The engine takes the seat at the cutoff of the entry.
	clock.Advance(10 * time.Second)
	answers := make([]queue.Assignment, 2)
	failures := make([]error, 2)
	var wg sync.WaitGroup
	for index := 0; index < 2; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			answer, err := service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
			answers[index] = answer
			failures[index] = err
		}(index)
	}
	wg.Wait()
	for index, err := range failures {
		if err != nil {
			t.Fatalf("the concurrent fallback %d failed: %v", index, err)
		}
	}
	if answers[0].MatchID == "" || answers[0].MatchID != answers[1].MatchID {
		t.Fatalf("the two tabs produced different games: %q and %q", answers[0].MatchID, answers[1].MatchID)
	}
	// Exactly one tab receives a secret. The routine fallback of the second
	// tab never receives a second secret of the same seat.
	carried := 0
	secrets := map[string]int{}
	for index, answer := range answers {
		if answer.GuestCredential == nil {
			continue
		}
		carried++
		secrets[answer.GuestCredential.Token] = index
		if answer.GuestCredential.MatchID != answers[0].MatchID {
			t.Fatalf("the answer %d carries a credential of another match: %+v", index, answer.GuestCredential)
		}
	}
	// Every secret that was handed out is still valid. The routine fallback
	// of the second tab never superseded the secret of the first one.
	for secret, index := range secrets {
		if _, err = authorizer.AuthenticateGuest(ctx, secret, "https://app.example"); err != nil {
			t.Fatalf("the engine credential of the answer %d does not authenticate any more: %v", index, err)
		}
	}
	if carried != 1 {
		t.Fatalf("%d of the two routine fallbacks carried a secret, want exactly one", carried)
	}
	if len(secrets) != 1 {
		t.Fatalf("the two routine fallbacks carried %d different secrets, want one", len(secrets))
	}
	secret := ""
	for value := range secrets {
		secret = value
	}
	if secret == "" {
		t.Fatal("the fallback carried no engine credential")
	}
	// The secret of the first tab is still valid. The routine fallback of the
	// second tab never superseded it.
	principal, err := authorizer.AuthenticateGuest(ctx, secret, "https://app.example")
	if err != nil {
		t.Fatalf("the issued engine credential does not authenticate any more: %v", err)
	}
	if principal.MatchID != answers[0].MatchID {
		t.Fatalf("the engine credential names another match: %+v", principal)
	}
	if principal.Participant.ID == "user_a" {
		t.Fatal("the engine credential belongs to the requesting account")
	}
	// The seat carries exactly one credential, and it is the live one. A
	// second live secret of the same seat would break the first tab.
	total, live := credentialRows(t, pool, answers[0].MatchID)
	if total != 1 || live != 1 {
		t.Fatalf("the engine seat carries %d credentials, %d of them live; want one live credential", total, live)
	}
}

// The issuer is the authority of the invariant. Two concurrent routine
// issuances of one seat that has no credential yet mint exactly one
// credential, and a routine issuance of a seat that has a live credential
// mints nothing and revokes nothing.
func TestEngineSeatRoutineIssuanceNeverSupersedesALiveCredential(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
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
	// The recording issuer creates the match and the engine seat without a
	// credential, so the seat of the match has no credential yet.
	service, err := queue.Open(ctx, pool, queue.Options{
		Now:         clock.Now,
		Allocator:   onlineService,
		Labels:      namedLabels{},
		Credentials: &recordingCredentials{},
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
	clock.Advance(10 * time.Second)
	assignment, err := service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatal(err)
	}
	if assignment.MatchID == "" {
		t.Fatal("the fallback produced no game")
	}
	var (
		seat  string
		guest string
	)
	if err = pool.QueryRow(ctx, `SELECT seat,owner_id FROM online_seats WHERE match_id=$1 AND owner_kind='guest'`, assignment.MatchID).Scan(&seat, &guest); err != nil {
		t.Fatal(err)
	}
	// Two concurrent routine issuances of the same seat. The seat lock of
	// the issuer orders them, so exactly one of them mints a credential.
	outcomes := make([]onlineauth.EngineSeatCredentialOutcome, 2)
	failures := make([]error, 2)
	var wg sync.WaitGroup
	for index := 0; index < 2; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			outcome, err := allocator.IssueEngineSeatCredential(ctx, onlineauth.EngineSeatRequest{
				MatchID: assignment.MatchID,
				Seat:    online.Seat(seat),
				GuestID: guest,
				Origin:  "https://app.example",
			})
			outcomes[index] = outcome
			failures[index] = err
		}(index)
	}
	wg.Wait()
	minted := 0
	secret := ""
	for index, err := range failures {
		if err != nil {
			t.Fatalf("the routine issuance %d failed: %v", index, err)
		}
		if !outcomes[index].Issued {
			continue
		}
		minted++
		secret = outcomes[index].Credential.Secret
		// Every minted secret is still valid. A routine issuance never
		// supersedes the credential of the issuance that ran before it.
		if _, err = authorizer.AuthenticateGuest(ctx, secret, "https://app.example"); err != nil {
			t.Fatalf("the engine credential of the issuance %d does not authenticate any more: %v", index, err)
		}
	}
	if minted != 1 {
		t.Fatalf("%d of the two concurrent routine issuances minted a credential, want exactly one", minted)
	}
	if secret == "" {
		t.Fatal("the minted credential carried no secret")
	}
	// The minted credential is the live one of the seat.
	principal, err := authorizer.AuthenticateGuest(ctx, secret, "https://app.example")
	if err != nil {
		t.Fatalf("the minted engine credential does not authenticate: %v", err)
	}
	if principal.Seat != online.Seat(seat) {
		t.Fatalf("the engine credential names another seat: %+v", principal)
	}
	total, live := credentialRows(t, pool, assignment.MatchID)
	if total != 1 || live != 1 {
		t.Fatalf("the engine seat carries %d credentials, %d of them live; want one live credential", total, live)
	}
	// A routine issuance of a seat that has a live credential mints nothing
	// and revokes nothing. The secret the browser holds keeps working.
	repeated, err := allocator.IssueEngineSeatCredential(ctx, onlineauth.EngineSeatRequest{
		MatchID: assignment.MatchID,
		Seat:    online.Seat(seat),
		GuestID: guest,
		Origin:  "https://app.example",
	})
	if err != nil {
		t.Fatalf("the repeated routine issuance failed: %v", err)
	}
	if repeated.Issued {
		t.Fatal("a routine issuance minted a second credential of a live seat")
	}
	if repeated.Credential.Secret != "" || repeated.Credential.CredentialID != "" {
		t.Fatalf("a routine issuance that minted nothing carried a secret: %+v", repeated.Credential)
	}
	if _, err = authorizer.AuthenticateGuest(ctx, secret, "https://app.example"); err != nil {
		t.Fatalf("the routine issuance revoked the live credential: %v", err)
	}
	total, live = credentialRows(t, pool, assignment.MatchID)
	if total != 1 || live != 1 {
		t.Fatalf("the engine seat carries %d credentials, %d of them live; want one live credential", total, live)
	}
}

// The explicit recovery of an owner that lost the answer rotates the
// credential on purpose. The rotation supersedes the live credential, so the
// lost secret stops working and the new one is the only live secret of the
// seat.
func TestQueueExplicitRecoveryRotatesTheEngineCredential(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if err := migrations.Apply(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	onlineService, err := online.Open(ctx, pool, moveEvaluator{})
	if err != nil {
		t.Fatal(err)
	}
	authorizer := newTestAuthorizer(t, pool)
	clock := newQueueClock()
	service, err := queue.Open(ctx, pool, queue.Options{
		Now:         clock.Now,
		Allocator:   onlineService,
		Labels:      namedLabels{},
		Credentials: onlineauth.NewAllocator(authorizer),
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
	clock.Advance(10 * time.Second)
	first, err := service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{Origin: "https://app.example"})
	if err != nil {
		t.Fatal(err)
	}
	if first.GuestCredential == nil || first.GuestCredential.Token == "" {
		t.Fatal("the first fallback carried no engine credential")
	}
	firstSecret := first.GuestCredential.Token
	if _, err = authorizer.AuthenticateGuest(ctx, firstSecret, "https://app.example"); err != nil {
		t.Fatalf("the first engine credential does not authenticate: %v", err)
	}
	// The explicit recovery rotates the credential on purpose.
	recovered, err := service.Fallback(ctx, account("user_a"), entry.EntryID, queue.FallbackRequest{
		Origin:             "https://app.example",
		CredentialRecovery: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if recovered.GuestCredential == nil || recovered.GuestCredential.Token == "" {
		t.Fatal("the recovery carried no engine credential")
	}
	if recovered.MatchID != first.MatchID {
		t.Fatalf("the recovery named another game: %v vs %v", recovered.MatchID, first.MatchID)
	}
	if recovered.GuestCredential.Token == firstSecret {
		t.Fatal("the recovery reused the secret of the lost answer")
	}
	// The new secret is the live one of the seat.
	if _, err = authorizer.AuthenticateGuest(ctx, recovered.GuestCredential.Token, "https://app.example"); err != nil {
		t.Fatalf("the recovered engine credential does not authenticate: %v", err)
	}
	// The rotation superseded the lost secret on purpose.
	if _, err = authorizer.AuthenticateGuest(ctx, firstSecret, "https://app.example"); err == nil {
		t.Fatal("the rotation left the lost secret working")
	}
	total, live := credentialRows(t, pool, first.MatchID)
	if total != 2 || live != 1 {
		t.Fatalf("the engine seat carries %d credentials, %d of them live; want the rotated pair", total, live)
	}
}

// credentialRows counts the credentials of one match and the live ones of it.
func credentialRows(t *testing.T, pool *pgxpool.Pool, matchID string) (int, int) {
	t.Helper()
	var total, live int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*),count(*) FILTER (WHERE revoked_at IS NULL AND superseded_at IS NULL) FROM online_guest_seat_credentials WHERE match_id=$1`,
		matchID).Scan(&total, &live); err != nil {
		t.Fatalf("read the credentials of the match: %v", err)
	}
	return total, live
}

// barrierIssuer releases the issuances of one test at the same time.
//
// The barrier makes the concurrency of the test honest: both callers are
// inside the issuer before either of them leaves it, so the second caller
// observes the state the first one committed. A barrier of one issuer never
// blocks a caller that arrives later.
type barrierIssuer struct {
	inner  queue.CredentialIssuer
	target int

	mu      sync.Mutex
	arrived int
	gate    chan struct{}
	opened  bool
}

func newBarrierIssuer(inner queue.CredentialIssuer, target int) *barrierIssuer {
	return &barrierIssuer{inner: inner, target: target, gate: make(chan struct{})}
}

func (b *barrierIssuer) IssueEngineSeatCredential(ctx context.Context, request onlineauth.EngineSeatRequest) (onlineauth.EngineSeatCredentialOutcome, error) {
	b.mu.Lock()
	if !b.opened {
		b.arrived++
		if b.arrived >= b.target {
			b.opened = true
			close(b.gate)
		}
	}
	b.mu.Unlock()
	select {
	case <-b.gate:
	case <-ctx.Done():
		return onlineauth.EngineSeatCredentialOutcome{}, ctx.Err()
	case <-time.After(30 * time.Second):
		return onlineauth.EngineSeatCredentialOutcome{}, errors.New("the barrier of the issuer timed out")
	}
	return b.inner.IssueEngineSeatCredential(ctx, request)
}
