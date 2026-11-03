package agentboards

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/ratelimit"
)

// Reader reads a board by name.
type Reader interface {
	Read(ctx context.Context, board string) (Board, error)
}

// Recorder stores a browser-reported game result.
type Recorder interface {
	RecordClient(ctx context.Context, report Report) error
}

// Handler serves GET /v1/public/agent-boards?board=verified|community|browser.
// The answer is cached for a short while, so the public read never loads the
// database per visitor.
func Handler(reader Reader, ttl time.Duration) http.Handler {
	var (
		mu    sync.Mutex
		cache = map[string]struct {
			board Board
			at    time.Time
		}{}
	)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		board := r.URL.Query().Get("board")
		switch board {
		case BoardVerified, BoardBrowser:
		default:
			board = BoardCommunity
		}
		mu.Lock()
		entry, ok := cache[board]
		mu.Unlock()
		if !ok || time.Since(entry.at) > ttl {
			read, err := reader.Read(r.Context(), board)
			if err != nil {
				http.Error(w, "the board is unavailable", http.StatusServiceUnavailable)
				return
			}
			entry.board, entry.at = read, time.Now()
			mu.Lock()
			cache[board] = entry
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=30")
		_ = json.NewEncoder(w).Encode(entry.board)
	})
}

// reportBody is the wire shape of one browser-reported game.
type reportBody struct {
	ClientGameID    string `json:"clientGameId"`
	ModelName       string `json:"modelName"`
	ReasoningEffort string `json:"reasoningEffort"`
	EngineThinkMs   int    `json:"engineThinkMs"`
	Result          string `json:"result"`
	MoveCount       int    `json:"moveCount"`
}

// ReportHandler serves POST /v1/public/agent-games: one finished browser
// game a visitor's device reports for the browser board. Reports are rate
// limited per address, read through the same proxy trust as the game
// starts, and stored idempotently by client game id.
func ReportHandler(recorder Recorder, limit int, window time.Duration, trustProxy bool) http.Handler {
	reports := ratelimit.New(limit, window, time.Now)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !reports.Allow(ratelimit.ClientAddress(r, trustProxy)) {
			writeError(w, http.StatusTooManyRequests, "too_many_reports")
			return
		}
		var body reportBody
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		report, err := Report{
			ClientGameID:    body.ClientGameID,
			ModelName:       body.ModelName,
			ReasoningEffort: body.ReasoningEffort,
			EngineThinkMs:   body.EngineThinkMs,
			Result:          body.Result,
			MoveCount:       body.MoveCount,
		}.validated()
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		if err := recorder.RecordClient(r.Context(), report); err != nil {
			writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
