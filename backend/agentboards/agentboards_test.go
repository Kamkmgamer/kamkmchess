package agentboards

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLevelBucketsTheThinkTime(t *testing.T) {
	for thinkMs, want := range map[int]string{100: "casual", 499: "casual", 500: "club", 1000: "club", 3000: "strong", 10000: "strong"} {
		if got := Level(thinkMs); got != want {
			t.Errorf("Level(%d) = %q, want %q", thinkMs, got, want)
		}
	}
}

func TestReportValidationKeepsTheTableSafe(t *testing.T) {
	valid := Report{ClientGameID: "game-1", ModelName: "Claude Haiku", ReasoningEffort: "high", EngineThinkMs: 1000, Result: "win", MoveCount: 34}
	if _, err := valid.validated(); err != nil {
		t.Fatalf("a valid report was rejected: %v", err)
	}
	for name, report := range map[string]Report{
		"empty client game id": {ModelName: "m", EngineThinkMs: 1000, Result: "win", MoveCount: 1},
		"long client game id":  {ClientGameID: strings.Repeat("a", 81), ModelName: "m", EngineThinkMs: 1000, Result: "win", MoveCount: 1},
		"empty model name":     {ClientGameID: "g", EngineThinkMs: 1000, Result: "win", MoveCount: 1},
		"only an @":            {ClientGameID: "g", ModelName: "@", EngineThinkMs: 1000, Result: "win", MoveCount: 1},
		"only a url":           {ClientGameID: "g", ModelName: "://", EngineThinkMs: 1000, Result: "win", MoveCount: 1},
		"unknown effort":       {ClientGameID: "g", ModelName: "m", ReasoningEffort: "ultra", EngineThinkMs: 1000, Result: "win", MoveCount: 1},
		"slow think time":      {ClientGameID: "g", ModelName: "m", EngineThinkMs: 10_001, Result: "win", MoveCount: 1},
		"fast think time":      {ClientGameID: "g", ModelName: "m", EngineThinkMs: 99, Result: "win", MoveCount: 1},
		"unknown result":       {ClientGameID: "g", ModelName: "m", EngineThinkMs: 1000, Result: "maybe", MoveCount: 1},
		"negative move count":  {ClientGameID: "g", ModelName: "m", EngineThinkMs: 1000, Result: "win", MoveCount: -1},
		"too many moves":       {ClientGameID: "g", ModelName: "m", EngineThinkMs: 1000, Result: "win", MoveCount: 1001},
	} {
		if _, err := report.validated(); !errors.Is(err, ErrInvalidReport) {
			t.Errorf("%s was not rejected: %v", name, err)
		}
	}
	// A name the table would not take is cleaned, never stored as itself.
	cleaned, err := (Report{ClientGameID: "g", ModelName: "a@b://c", EngineThinkMs: 1000, Result: "win", MoveCount: 1}).validated()
	if err != nil || cleaned.ModelName != "ab c" {
		t.Errorf("a name with @ and a url was not cleaned: %+v, %v", cleaned, err)
	}
	stored, err := (Report{ClientGameID: " g ", ModelName: "  claude\n\thaiku  ", ReasoningEffort: " HIGH ", EngineThinkMs: 1000, Result: "win", MoveCount: 34}).validated()
	if err != nil {
		t.Fatalf("a normalizing report was rejected: %v", err)
	}
	if stored.ClientGameID != "g" || stored.ModelName != "claude haiku" || stored.ReasoningEffort != "high" {
		t.Errorf("the report was not normalized: %+v", stored)
	}
	// An unknown effort stays empty, so it ranks with the never-reported games.
	quiet, err := (Report{ClientGameID: "g", ModelName: "m", EngineThinkMs: 1000, Result: "draw", MoveCount: 0}).validated()
	if err != nil || quiet.ReasoningEffort != "" {
		t.Errorf("a report without effort changed it: %+v, %v", quiet, err)
	}
}

type countingReader struct{ reads map[string]int }

func (r *countingReader) Read(_ context.Context, board string) (Board, error) {
	r.reads[board]++
	return Board{Board: board, Rows: []Row{}}, nil
}

func TestHandlerCachesEachBoardAndServesOnlyGet(t *testing.T) {
	reader := &countingReader{reads: map[string]int{}}
	handler := Handler(reader, time.Minute)
	get := func(query string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/public/agent-boards"+query, nil))
		return recorder
	}
	for range 3 {
		if code := get("?board=verified").Code; code != http.StatusOK {
			t.Fatalf("verified board answered %d", code)
		}
	}
	if body := get("?board=anything").Body.String(); !strings.Contains(body, `"board":"community"`) {
		t.Fatalf("an unknown board is not the community board: %s", body)
	}
	if body := get("?board=browser").Body.String(); !strings.Contains(body, `"board":"browser"`) {
		t.Fatalf("the browser board did not answer as itself: %s", body)
	}
	if reader.reads["verified"] != 1 || reader.reads["community"] != 1 || reader.reads["browser"] != 1 {
		t.Fatalf("the boards were read %v times, want once each", reader.reads)
	}
	post := httptest.NewRecorder()
	handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/v1/public/agent-boards", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST answered %d", post.Code)
	}
}

type recordingRecorder struct {
	reports []Report
	err     error
}

func (r *recordingRecorder) RecordClient(_ context.Context, report Report) error {
	r.reports = append(r.reports, report)
	return r.err
}

func TestReportHandlerStoresOneWellFormedReport(t *testing.T) {
	recorder := &recordingRecorder{}
	handler := ReportHandler(recorder, 100, time.Hour, false)
	post := func(body string) *httptest.ResponseRecorder {
		recorder2 := httptest.NewRecorder()
		handler.ServeHTTP(recorder2, httptest.NewRequest(http.MethodPost, "/v1/public/agent-games", strings.NewReader(body)))
		return recorder2
	}
	if code := post(`{"clientGameId":"game-1","modelName":"GPT-5","reasoningEffort":"high","engineThinkMs":1000,"result":"win","moveCount":41}`).Code; code != http.StatusOK {
		t.Fatalf("a well formed report answered %d", code)
	}
	if len(recorder.reports) != 1 || recorder.reports[0].ModelName != "GPT-5" || recorder.reports[0].ReasoningEffort != "high" || recorder.reports[0].Result != "win" {
		t.Fatalf("the report did not reach the store: %+v", recorder.reports)
	}
	for name, body := range map[string]string{
		"not json":           "nope",
		"unknown result":     `{"clientGameId":"g","modelName":"m","engineThinkMs":1000,"result":"maybe","moveCount":1}`,
		"missing game id":    `{"modelName":"m","engineThinkMs":1000,"result":"win","moveCount":1}`,
		"unknown effort":     `{"clientGameId":"g","modelName":"m","reasoningEffort":"ultra","engineThinkMs":1000,"result":"win","moveCount":1}`,
		"out of range think": `{"clientGameId":"g","modelName":"m","engineThinkMs":99,"result":"win","moveCount":1}`,
		"negative moves":     `{"clientGameId":"g","modelName":"m","engineThinkMs":1000,"result":"win","moveCount":-1}`,
		"empty model name":   `{"clientGameId":"g","engineThinkMs":1000,"result":"win","moveCount":1}`,
	} {
		if code := post(body).Code; code != http.StatusBadRequest {
			t.Errorf("%s answered %d, want 400", name, code)
		}
	}
	if len(recorder.reports) != 1 {
		t.Fatalf("rejected reports reached the store: %+v", recorder.reports)
	}
	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/v1/public/agent-games", nil))
	if get.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET answered %d", get.Code)
	}
}

func TestReportHandlerLimitsEachAddress(t *testing.T) {
	recorder := &recordingRecorder{}
	handler := ReportHandler(recorder, 1, time.Hour, false)
	body := `{"clientGameId":"game-1","modelName":"m","engineThinkMs":1000,"result":"loss","moveCount":9}`
	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodPost, "/v1/public/agent-games", strings.NewReader(body)))
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, httptest.NewRequest(http.MethodPost, "/v1/public/agent-games", strings.NewReader(body)))
	if first.Code != http.StatusOK || second.Code != http.StatusTooManyRequests {
		t.Fatalf("the limiter answered %d then %d", first.Code, second.Code)
	}
	// A different address is its own budget.
	third := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/public/agent-games", strings.NewReader(body))
	request.RemoteAddr = "203.0.113.9:4444"
	handler.ServeHTTP(third, request)
	if third.Code != http.StatusOK {
		t.Fatalf("another address answered %d", third.Code)
	}
	// Behind a trusted proxy the forwarded entry names the caller, so
	// visitors do not share the proxy's own budget.
	proxied := ReportHandler(recorder, 1, time.Hour, true)
	forward := func(last string) *httptest.ResponseRecorder {
		recorder2 := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/v1/public/agent-games", strings.NewReader(body))
		request.Header.Set("X-Forwarded-For", last)
		proxied.ServeHTTP(recorder2, request)
		return recorder2
	}
	if code := forward("198.51.100.7").Code; code != http.StatusOK {
		t.Fatalf("the first forwarded report answered %d", code)
	}
	if code := forward("198.51.100.7").Code; code != http.StatusTooManyRequests {
		t.Fatalf("the repeated forwarded report answered %d", code)
	}
	if code := forward("198.51.100.8").Code; code != http.StatusOK {
		t.Fatalf("another forwarded address answered %d", code)
	}
}

func TestReportHandlerTellsAStorageFailureFromABadReport(t *testing.T) {
	recorder := &recordingRecorder{err: errors.New("database down")}
	handler := ReportHandler(recorder, 10, time.Hour, false)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/public/agent-games", strings.NewReader(`{"clientGameId":"g","modelName":"m","engineThinkMs":1000,"result":"win","moveCount":1}`)))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("a storage failure answered %d", response.Code)
	}
}
