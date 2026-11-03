package ratelimit

import (
	"fmt"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimiterSlidesItsWindow(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := New(2, time.Hour, func() time.Time { return now })
	if !limiter.Allow("a") || !limiter.Allow("a") || limiter.Allow("a") {
		t.Fatal("the third start in the hour was allowed")
	}
	if !limiter.Allow("b") {
		t.Fatal("another address was limited")
	}
	now = now.Add(time.Hour)
	if !limiter.Allow("a") {
		t.Fatal("the window did not slide")
	}
}

func TestClientAddressIgnoresClientSuppliedForwardedEntries(t *testing.T) {
	limiter := New(20, time.Hour, time.Now)
	for i := range 21 {
		r := httptest.NewRequest("POST", "/", nil)
		r.RemoteAddr = "127.0.0.1:51000"
		r.Header.Add("X-Forwarded-For", fmt.Sprintf("10.0.0.%d", i))
		r.Header.Add("X-Forwarded-For", fmt.Sprintf("10.1.0.%d, 203.0.113.7", i))
		address := ClientAddress(r, true)
		if address != "203.0.113.7" {
			t.Fatalf("clientAddress = %q, want the proxy-appended entry", address)
		}
		if allowed := limiter.Allow(address); allowed != (i < 20) {
			t.Fatalf("start %d allowed = %v", i+1, allowed)
		}
	}

	r := httptest.NewRequest("POST", "/", nil)
	r.RemoteAddr = "127.0.0.1:51000"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := ClientAddress(r, false); got != "127.0.0.1" {
		t.Fatalf("untrusted clientAddress = %q", got)
	}
	if got := ClientAddress(r, true); got != "203.0.113.9" {
		t.Fatalf("single-entry clientAddress = %q", got)
	}
	r.Header.Set("X-Forwarded-For", "203.0.113.9, ")
	if got := ClientAddress(r, true); got != "127.0.0.1" {
		t.Fatalf("empty last entry clientAddress = %q", got)
	}
}
