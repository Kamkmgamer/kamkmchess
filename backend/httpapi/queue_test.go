package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
)

// stubQueueService is the queue the HTTP layer talks to.
type stubQueueService struct {
	entry      online.QueueEntry
	assignment queue.Assignment
	err        error
	created    bool
	actor      online.ParticipantRef
	entryID    string
	operation  queue.Operation
	origin     string
	recovery   bool
	calls      []string
}

func (s *stubQueueService) CreateEntry(_ context.Context, actor online.ParticipantRef, request queue.CreateEntryRequest) (online.QueueEntry, bool, error) {
	s.actor = actor
	s.calls = append(s.calls, "create")
	s.entry = online.QueueEntry{
		SchemaVersion: online.ContractsSchemaVersion,
		EntryID:       "qe_entry0001",
		Owner:         actor,
		Control:       request.Control,
		TimeControl:   request.TimeControl,
		Status:        online.QueueWaiting,
		Version:       1,
		CreatedAt:     time.Unix(1_900_000_000, 0).UTC(),
		UpdatedAt:     time.Unix(1_900_000_000, 0).UTC(),
	}
	return s.entry, s.created, s.err
}

func (s *stubQueueService) Entry(_ context.Context, actor online.ParticipantRef, entryID string) (online.QueueEntry, error) {
	s.actor = actor
	s.entryID = entryID
	s.calls = append(s.calls, "entry")
	return s.entry, s.err
}

func (s *stubQueueService) Ready(_ context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error) {
	s.actor = actor
	s.entryID = entryID
	s.operation = operation
	s.calls = append(s.calls, "ready")
	return s.entry, s.err
}

func (s *stubQueueService) Cancel(_ context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error) {
	s.actor = actor
	s.entryID = entryID
	s.operation = operation
	s.calls = append(s.calls, "cancel")
	return s.entry, s.err
}

func (s *stubQueueService) KeepSearching(_ context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error) {
	s.actor = actor
	s.entryID = entryID
	s.operation = operation
	s.calls = append(s.calls, "keep-searching")
	return s.entry, s.err
}

func (s *stubQueueService) Heartbeat(_ context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (online.QueueEntry, error) {
	s.actor = actor
	s.entryID = entryID
	s.operation = operation
	s.calls = append(s.calls, "heartbeat")
	return s.entry, s.err
}

func (s *stubQueueService) Match(_ context.Context, actor online.ParticipantRef, entryID string, operation queue.Operation) (queue.Assignment, error) {
	s.actor = actor
	s.entryID = entryID
	s.operation = operation
	s.calls = append(s.calls, "match")
	return s.assignment, s.err
}

func (s *stubQueueService) Fallback(_ context.Context, actor online.ParticipantRef, entryID string, request queue.FallbackRequest) (queue.Assignment, error) {
	s.actor = actor
	s.entryID = entryID
	s.operation = request.Operation
	s.origin = request.Origin
	s.recovery = request.CredentialRecovery
	s.calls = append(s.calls, "fallback")
	return s.assignment, s.err
}

func newQueueHandler(service QueueService) http.Handler {
	authenticator := &stubAuthenticator{account: map[string]onlineauth.Principal{
		"token-account": accountParticipant("user_a"),
	}, guest: map[string]onlineauth.Principal{
		"token-guest": guestParticipant("guest-1", "match-1", online.SeatWhite),
	}}
	return NewQueue(service, authenticator, QueueOptions{AllowedOrigins: []string{testOrigin}})
}

func queueRequest(t *testing.T, handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Origin", testOrigin)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

// The feature answer carries exactly the two rollout switches and the
// remote MCP state.
func TestOnlineFeaturesAnswerCarriesExactlyTheSwitches(t *testing.T) {
	closed := httptest.NewRecorder()
	NewFeatures(OnlineFeatures{}).ServeHTTP(closed, httptest.NewRequest(http.MethodGet, "/v1/online/features", nil))
	if closed.Code != http.StatusOK {
		t.Fatalf("features status=%d body=%s", closed.Code, closed.Body.String())
	}
	var answer map[string]any
	if err := json.Unmarshal(closed.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if len(answer) != 3 {
		t.Fatalf("the feature answer has %d fields: %s", len(answer), closed.Body.String())
	}
	if answer["friends"] != false || answer["queue"] != false || answer["mcp"] != false {
		t.Fatalf("a closed surface is not closed: %s", closed.Body.String())
	}
	open := httptest.NewRecorder()
	NewFeatures(OnlineFeatures{Friends: true, Queue: true, MCP: true}).ServeHTTP(open, httptest.NewRequest(http.MethodGet, "/v1/online/features", nil))
	if err := json.Unmarshal(open.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer["friends"] != true || answer["queue"] != true || answer["mcp"] != true {
		t.Fatalf("an open surface is not open: %s", open.Body.String())
	}
}

// The public queue needs an account session.
func TestOnlineQueueRefusesGuestsAndUnauthenticatedCallers(t *testing.T) {
	service := &stubQueueService{created: true}
	handler := newQueueHandler(service)
	body := `{"schemaVersion":2,"control":{"kind":"agent","modelLabel":"GPT-4o"},"timeControl":{"startingTimeMs":300000,"incrementMs":2000}}`
	for _, testCase := range []struct {
		name  string
		token string
		want  int
	}{
		{"no credential", "", http.StatusUnauthorized},
		{"guest credential", "token-guest", http.StatusUnauthorized},
		{"account", "token-account", http.StatusCreated},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries", testCase.token, body)
			if w.Code != testCase.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, testCase.want, w.Body.String())
			}
		})
	}
}

// A mutation needs an explicit origin.
func TestOnlineQueueMutationNeedsAnOrigin(t *testing.T) {
	service := &stubQueueService{created: true}
	handler := newQueueHandler(service)
	req := httptest.NewRequest(http.MethodPost, "/v1/online/queue/entries", strings.NewReader(`{"schemaVersion":2,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":0}}`))
	req.Header.Set("Authorization", "Bearer token-account")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status=%d want=403 body=%s", w.Code, w.Body.String())
	}
}

// The entry answer is the allowlisted entry and nothing else.
func TestOnlineQueueEntryAnswerIsAllowlisted(t *testing.T) {
	service := &stubQueueService{created: true}
	handler := newQueueHandler(service)
	body := `{"schemaVersion":2,"control":{"kind":"agent","modelLabel":"GPT-4o"},"timeControl":{"startingTimeMs":300000,"incrementMs":2000},"clientRequestId":"intent-0001"}`
	w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries", "token-account", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var answer map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"schemaVersion", "entryId", "owner", "control", "timeControl", "status", "version", "readyAt", "cutoffAt", "assignedMatchId", "createdAt", "updatedAt"} {
		if _, ok := answer[field]; !ok {
			t.Fatalf("the entry answer misses %q: %s", field, w.Body.String())
		}
	}
	if len(answer) != 12 {
		t.Fatalf("the entry answer has %d fields: %s", len(answer), w.Body.String())
	}
	if service.actor.ID != "user_a" {
		t.Fatalf("the service saw another actor: %+v", service.actor)
	}
}

// A replay of the same intent answers the same entry and creates no second
// game.
func TestOnlineQueueCreationReplayAnswersTheSameEntry(t *testing.T) {
	service := &stubQueueService{created: false}
	handler := newQueueHandler(service)
	body := `{"schemaVersion":2,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":0},"clientRequestId":"intent-0001"}`
	w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries", "token-account", body)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

// The match route answers 404 when no candidate exists.
func TestOnlineQueueMatchWithoutCandidateAnswersNotFound(t *testing.T) {
	service := &stubQueueService{err: queue.ErrNoCandidate}
	handler := newQueueHandler(service)
	w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/qe_entry0001/match", "token-account", `{"schemaVersion":2}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

// The assignment answer names the match, the seat and the opponent, and it
// carries the engine credential of a fallback.
func TestOnlineQueueAssignmentAnswerCarriesTheEngineCredential(t *testing.T) {
	service := &stubQueueService{assignment: queue.Assignment{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       "m_match0001",
		Seat:          online.SeatBlack,
		OpponentLabel: "Stockfish 19 Lite",
		Control:       online.SeatControl{Kind: online.ControlEngine, ModelLabel: stringPointer("Stockfish 19 Lite")},
		GuestCredential: &queue.GuestCredential{
			GuestID:   "engine_0001",
			MatchID:   "m_match0001",
			Seat:      online.SeatWhite,
			Token:     "kmgc1_secret",
			ExpiresAt: time.Unix(1_900_003_600, 0).UTC(),
		},
	}}
	handler := newQueueHandler(service)
	w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/qe_entry0001/fallback", "token-account", `{"schemaVersion":2,"operationId":"operation-0001"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var answer map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"schemaVersion", "matchId", "seat", "opponentLabel", "control", "guestCredential"} {
		if _, ok := answer[field]; !ok {
			t.Fatalf("the assignment answer misses %q: %s", field, w.Body.String())
		}
	}
	if len(answer) != 6 {
		t.Fatalf("the assignment answer has %d fields: %s", len(answer), w.Body.String())
	}
	if service.operation.ID != "operation-0001" {
		t.Fatalf("the operation identifier was not passed on: %+v", service.operation)
	}
	if service.origin != testOrigin {
		t.Fatalf("the origin was not passed on: %q", service.origin)
	}
}

// The fallback route reads the optional credential recovery of the request.
func TestOnlineQueueFallbackReadsTheCredentialRecovery(t *testing.T) {
	service := &stubQueueService{assignment: queue.Assignment{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       "m_match0001",
		Seat:          online.SeatWhite,
		OpponentLabel: "Stockfish 19 Lite",
		Control:       online.SeatControl{Kind: online.ControlEngine, ModelLabel: stringPointer("Stockfish 19 Lite (browser)")},
	}}
	handler := newQueueHandler(service)
	w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/qe_entry0001/fallback", "token-account",
		`{"schemaVersion":2,"operationId":"operation-0002","credentialRecovery":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !service.recovery {
		t.Fatal("the route did not read the credential recovery")
	}
	if service.operation.ID != "operation-0002" {
		t.Fatalf("the route did not read the operation identifier: %+v", service.operation)
	}
}

// The entry routes never answer with another owner's reference.
func TestOnlineQueueForeignEntryIsNotFound(t *testing.T) {
	service := &stubQueueService{err: queue.ErrNotFound}
	handler := newQueueHandler(service)
	w := queueRequest(t, handler, http.MethodGet, "/v1/online/queue/entries/qe_entry0001", "token-account", "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

// An invalid request is refused before the service is called.
func TestOnlineQueueRefusesAnInvalidRequest(t *testing.T) {
	service := &stubQueueService{created: true}
	handler := newQueueHandler(service)
	for _, body := range []string{
		`{"schemaVersion":1,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":0}}`,
		`{"schemaVersion":2,"control":{"kind":"engine","modelLabel":"Stockfish"},"timeControl":{"startingTimeMs":300000,"incrementMs":0}}`,
		`{"schemaVersion":2,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":0},"unknown":true}`,
	} {
		w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries", "token-account", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d want=400", body, w.Code)
		}
	}
}

// A conflict is a conflict and never a silent success.
func TestOnlineQueueConflictIsAConflict(t *testing.T) {
	service := &stubQueueService{err: queue.ErrConflict}
	handler := newQueueHandler(service)
	w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/qe_entry0001/cancel", "token-account", `{"schemaVersion":2}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

// A failure of the queue is a temporary failure.
func TestOnlineQueueUnavailableIsTemporary(t *testing.T) {
	service := &stubQueueService{err: errors.New("the database is gone")}
	handler := newQueueHandler(service)
	w := queueRequest(t, handler, http.MethodPost, "/v1/online/queue/entries/qe_entry0001/ready", "token-account", `{"schemaVersion":2}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func stringPointer(value string) *string {
	return &value
}
