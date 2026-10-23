package agentboards

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// Reader reads a board.
type Reader interface {
	Read(ctx context.Context, verified bool) (Board, error)
}

// Handler serves GET /v1/public/agent-boards?board=community|verified. The
// answer is cached for a short while, so the public read never loads the
// database per visitor.
func Handler(reader Reader, ttl time.Duration) http.Handler {
	var (
		mu    sync.Mutex
		cache = map[bool]struct {
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
		verified := r.URL.Query().Get("board") == "verified"
		mu.Lock()
		entry, ok := cache[verified]
		mu.Unlock()
		if !ok || time.Since(entry.at) > ttl {
			board, err := reader.Read(r.Context(), verified)
			if err != nil {
				http.Error(w, "the board is unavailable", http.StatusServiceUnavailable)
				return
			}
			entry.board, entry.at = board, time.Now()
			mu.Lock()
			cache[verified] = entry
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=30")
		_ = json.NewEncoder(w).Encode(entry.board)
	})
}
