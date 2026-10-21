package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
)

// The HTTP surface of the queue, end to end: the real queue service, the
// real database, the real shared writer and the real route handlers.

// queueHTTPPrincipal is the account identity of one caller.
type queueHTTPPrincipal struct {
	token   string
	subject string
	origin  string
	kind    online.ParticipantKind
	matchID string
	seat    online.Seat
	guestID string
	authErr error
}

// queueHTTPAuthenticator resolves the caller of a queue request.
//
// The account path uses a fixture token: producing a genuine Clerk session
// token would need a live JWKS endpoint. The guest path is the real
// credential path of the authorization service.
type queueHTTPAuthenticator struct {
	principals map[string]queueHTTPPrincipal
}

func (a *queueHTTPAuthenticator) AuthenticateAccount(_ context.Context, token, origin string) (onlineauth.Principal, error) {
	stored, ok := a.principals[token]
	if !ok || stored.kind != online.ParticipantAccount {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	if stored.origin != origin {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	return onlineauth.NewAccountPrincipal(stored.subject, "session-"+stored.subject, origin, time.Unix(1_900_000_000, 0)), nil
}

func (a *queueHTTPAuthenticator) AuthenticateGuest(_ context.Context, secret, origin string) (onlineauth.Principal, error) {
	stored, ok := a.principals[secret]
	if !ok || stored.kind != online.ParticipantGuest {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	if stored.origin != origin {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	return onlineauth.Principal{
		Kind:         online.ParticipantGuest,
		Subject:      stored.guestID,
		Participant:  online.ParticipantRef{Kind: online.ParticipantGuest, ID: stored.guestID},
		CredentialID: "credential-" + stored.guestID,
		MatchID:      stored.matchID,
		Seat:         stored.seat,
		Origin:       origin,
		ExpiresAt:    time.Unix(1_900_003_600, 0),
	}, nil
}

// queueHTTPRequest sends one request to the queue handler.
func queueHTTPRequest(t *testing.T, handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
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

// TestQueueHTTPRoutesRunAgainstTheRealQueue drives the published routes
// against the real queue, the real database and the real shared writer.
func TestQueueHTTPRoutesRunAgainstTheRealQueue(t *testing.T) {
	h := newQueueHarness(t)
	authenticator := &queueHTTPAuthenticator{principals: map[string]queueHTTPPrincipal{
		"token-a": {token: "token-a", subject: "user_a", origin: "https://app.example", kind: online.ParticipantAccount},
		"token-b": {token: "token-b", subject: "user_b", origin: "https://app.example", kind: online.ParticipantAccount},
	}}
	handler := httpapi.NewQueue(h.service, authenticator, httpapi.OnlineOptions{AllowedOrigins: []string{"https://app.example"}})

	// The creation of an entry.
	created := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries", "token-a",
		`{"schemaVersion":2,"control":{"kind":"agent","modelLabel":"GPT-4o"},"timeControl":{"startingTimeMs":300000,"incrementMs":2000},"clientRequestId":"intent-0001"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var entry map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	entryID, _ := entry["entryId"].(string)
	if entryID == "" {
		t.Fatalf("the answer carries no entry: %s", created.Body.String())
	}
	if entry["owner"].(map[string]any)["id"] != "user_a" {
		t.Fatalf("the answer carries another owner: %s", created.Body.String())
	}

	// A guest credential never enters the queue.
	guest := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries", "token-guest",
		`{"schemaVersion":2,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":2000}}`)
	if guest.Code != http.StatusUnauthorized {
		t.Fatalf("the guest create status=%d body=%s", guest.Code, guest.Body.String())
	}

	// The second owner creates a compatible entry.
	second := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries", "token-b",
		`{"schemaVersion":2,"control":{"kind":"agent","modelLabel":"Claude"},"timeControl":{"startingTimeMs":300000,"incrementMs":2000}}`)
	if second.Code != http.StatusCreated {
		t.Fatalf("the second create status=%d body=%s", second.Code, second.Body.String())
	}
	var secondEntry map[string]any
	if err := json.Unmarshal(second.Body.Bytes(), &secondEntry); err != nil {
		t.Fatal(err)
	}
	secondID, _ := secondEntry["entryId"].(string)

	// The match route pairs the two entries.
	matched := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/"+entryID+"/match", "token-a", `{"schemaVersion":2}`)
	if matched.Code != http.StatusOK {
		t.Fatalf("the match status=%d body=%s", matched.Code, matched.Body.String())
	}
	var assignment map[string]any
	if err := json.Unmarshal(matched.Body.Bytes(), &assignment); err != nil {
		t.Fatal(err)
	}
	matchID, _ := assignment["matchId"].(string)
	if matchID == "" {
		t.Fatalf("the assignment carries no match: %s", matched.Body.String())
	}
	if assignment["seat"] != "white" && assignment["seat"] != "black" {
		t.Fatalf("the assignment carries no seat: %s", matched.Body.String())
	}

	// The other owner reads the same game.
	read := queueHTTPRequest(t, handler, http.MethodGet, "/v1/online/queue/entries/"+secondID, "token-b", "")
	if read.Code != http.StatusOK {
		t.Fatalf("the read status=%d body=%s", read.Code, read.Body.String())
	}
	var stored map[string]any
	if err := json.Unmarshal(read.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	if stored["status"] != "assigned" || stored["assignedMatchId"] != matchID {
		t.Fatalf("the opponent entry is not assigned: %s", read.Body.String())
	}

	// A foreign entry is not found.
	foreign := queueHTTPRequest(t, handler, http.MethodGet, "/v1/online/queue/entries/"+entryID, "token-b", "")
	if foreign.Code != http.StatusNotFound {
		t.Fatalf("the foreign read status=%d body=%s", foreign.Code, foreign.Body.String())
	}
}

// TestQueueHTTPFallbackCarriesTheEngineCredential drives the fallback route
// against the real queue and the real credential path.
func TestQueueHTTPFallbackCarriesTheEngineCredential(t *testing.T) {
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
	authenticator := &queueHTTPAuthenticator{principals: map[string]queueHTTPPrincipal{
		"token-a": {token: "token-a", subject: "user_a", origin: "https://app.example", kind: online.ParticipantAccount},
	}}
	handler := httpapi.NewQueue(service, authenticator, httpapi.OnlineOptions{AllowedOrigins: []string{"https://app.example"}})
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
	fallback := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/"+entryID+"/fallback", "token-a",
		`{"schemaVersion":2,"operationId":"operation-0001"}`)
	if fallback.Code != http.StatusOK {
		t.Fatalf("the fallback status=%d body=%s", fallback.Code, fallback.Body.String())
	}
	var assignment map[string]any
	if err := json.Unmarshal(fallback.Body.Bytes(), &assignment); err != nil {
		t.Fatal(err)
	}
	credential, ok := assignment["guestCredential"].(map[string]any)
	if !ok {
		t.Fatalf("the fallback carried no engine credential: %s", fallback.Body.String())
	}
	token, _ := credential["token"].(string)
	if token == "" {
		t.Fatalf("the engine credential carries no secret: %s", fallback.Body.String())
	}
	matchID, _ := assignment["matchId"].(string)
	// The routine retry answers the same assignment and rotates nothing.
	retry := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/"+entryID+"/fallback", "token-a",
		`{"schemaVersion":2,"operationId":"operation-0001"}`)
	if retry.Code != http.StatusOK {
		t.Fatalf("the retry status=%d body=%s", retry.Code, retry.Body.String())
	}
	var stored map[string]any
	if err := json.Unmarshal(retry.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	if stored["matchId"] != matchID {
		t.Fatalf("the retry named another game: %s", retry.Body.String())
	}
	if _, ok := stored["guestCredential"]; ok {
		t.Fatalf("the retry carried a secret: %s", retry.Body.String())
	}
	// The explicit recovery rotates the credential.
	recovery := queueHTTPRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/"+entryID+"/fallback", "token-a",
		`{"schemaVersion":2,"operationId":"operation-0002","credentialRecovery":true}`)
	if recovery.Code != http.StatusOK {
		t.Fatalf("the recovery status=%d body=%s", recovery.Code, recovery.Body.String())
	}
	var recovered map[string]any
	if err := json.Unmarshal(recovery.Body.Bytes(), &recovered); err != nil {
		t.Fatal(err)
	}
	newCredential, ok := recovered["guestCredential"].(map[string]any)
	if !ok {
		t.Fatalf("the recovery carried no engine credential: %s", recovery.Body.String())
	}
	newToken, _ := newCredential["token"].(string)
	if newToken == "" || newToken == token {
		t.Fatalf("the recovery did not rotate the credential: %s", recovery.Body.String())
	}
}
