package mcpserver

import (
	"testing"
	"time"
)

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
