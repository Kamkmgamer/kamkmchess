package mcpserver

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMoveWaitClampsTheRequestedReplyWait(t *testing.T) {
	const bound = 25 * time.Second
	for name, test := range map[string]struct {
		requested any
		want      time.Duration
	}{
		"absent":   {nil, bound},         // agent runners keep the full wait
		"zero":     {float64(0), 0},      // the human's page reconciles through its own poll
		"over":     {float64(99), bound}, // never longer than the bound
		"negative": {float64(-3), 0},     // a negative wait cannot wait at all
		"partial":  {1.5, 1500 * time.Millisecond},
	} {
		if got := moveWait(test.requested, bound); got != test.want {
			t.Fatalf("moveWait(%s) = %s, want %s", name, got, test.want)
		}
	}
}

func TestToolResultTextCompactsBoardResults(t *testing.T) {
	result := map[string]any{
		"result":  "accepted",
		"message": "Played e2e4.",
		"board": map[string]any{
			"status": "opponent-turn",
			"fen":    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
			"input":  map[string]any{"moves": "e4 e5"},
		},
	}
	wrapper := toolResult(result, nil)
	content := wrapper["content"].([]map[string]any)
	text, ok := content[0]["text"].(string)
	if !ok {
		t.Fatal("tool result text was not a string")
	}
	if strings.Contains(text, "e4 e5") || strings.Contains(text, "current-match-input") {
		t.Fatalf("board history leaked into the text fallback: %s", text)
	}
	if wrapper["structuredContent"] == nil {
		t.Fatal("structured board content was dropped")
	}
}

func TestCleanNameKeepsSelfReportedNamesPublishable(t *testing.T) {
	for in, want := range map[string]string{
		"  Claude   Opus 5.5 ":  "Claude Opus 5.5",
		"me@example.com":        "meexample.com",
		"see https://x.example": "see https x.example",
		"bidi‮evil\x07":         "bidievil",
		"a very long model name that goes on and on forever": "a very long model name that goes on and",
	} {
		if got := cleanName(in); got != want {
			t.Errorf("cleanName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRateLimiterSlidesItsWindow(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newRateLimiter(2, time.Hour, func() time.Time { return now })
	if !limiter.allow("a") || !limiter.allow("a") || limiter.allow("a") {
		t.Fatal("the third start in the hour was allowed")
	}
	if !limiter.allow("b") {
		t.Fatal("another address was limited")
	}
	now = now.Add(time.Hour)
	if !limiter.allow("a") {
		t.Fatal("the window did not slide")
	}
}

func TestClientAddressIgnoresClientSuppliedForwardedEntries(t *testing.T) {
	limiter := newRateLimiter(20, time.Hour, time.Now)
	for i := range 21 {
		r := httptest.NewRequest("POST", "/v1/mcp", nil)
		r.RemoteAddr = "127.0.0.1:51000"
		r.Header.Add("X-Forwarded-For", fmt.Sprintf("10.0.0.%d", i))
		r.Header.Add("X-Forwarded-For", fmt.Sprintf("10.1.0.%d, 203.0.113.7", i))
		address := clientAddress(r, true)
		if address != "203.0.113.7" {
			t.Fatalf("clientAddress = %q, want the proxy-appended entry", address)
		}
		if allowed := limiter.allow(address); allowed != (i < 20) {
			t.Fatalf("start %d allowed = %v", i+1, allowed)
		}
	}

	r := httptest.NewRequest("POST", "/v1/mcp", nil)
	r.RemoteAddr = "127.0.0.1:51000"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := clientAddress(r, false); got != "127.0.0.1" {
		t.Fatalf("untrusted clientAddress = %q", got)
	}
	if got := clientAddress(r, true); got != "203.0.113.9" {
		t.Fatalf("single-entry clientAddress = %q", got)
	}
	r.Header.Set("X-Forwarded-For", "203.0.113.9, ")
	if got := clientAddress(r, true); got != "127.0.0.1" {
		t.Fatalf("empty last entry clientAddress = %q", got)
	}
}

func TestSessionsExpireAndAreBounded(t *testing.T) {
	now := time.Unix(0, 0)
	store := newSessionStore(1, time.Minute, func() time.Time { return now })
	id, err := store.create()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.create(); err == nil {
		t.Fatal("the store grew past its bound")
	}
	if _, ok := store.get(id); !ok {
		t.Fatal("a fresh session was missing")
	}
	now = now.Add(2 * time.Minute)
	if _, ok := store.get(id); ok {
		t.Fatal("an idle session survived")
	}
	if _, err = store.create(); err != nil {
		t.Fatal("an expired session kept its slot")
	}
}
