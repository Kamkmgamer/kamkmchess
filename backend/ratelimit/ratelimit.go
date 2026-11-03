// Package ratelimit names the caller of an anonymous endpoint and allows a
// number of requests per caller in a sliding window. It serves the rate
// limits of the MCP endpoint and the public agent boards.
package ratelimit

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// ClientAddress names the caller for the rate limits. The hosting proxy
// appends the address it saw to X-Forwarded-For and keeps whatever the
// client sent, so only the last entry is trustworthy.
func ClientAddress(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if values := r.Header.Values("X-Forwarded-For"); len(values) > 0 {
			last := values[len(values)-1]
			if i := strings.LastIndex(last, ","); i >= 0 {
				last = last[i+1:]
			}
			if last = strings.TrimSpace(last); last != "" {
				return last
			}
		}
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return host
}

// Limiter allows a number of requests per client address in a sliding window.
type Limiter struct {
	mu       sync.Mutex
	limit    int
	window   time.Duration
	now      func() time.Time
	attempts map[string][]time.Time
}

// New returns a limiter that allows limit requests per window. It calls now
// for every request, so tests can slide the window.
func New(limit int, window time.Duration, now func() time.Time) *Limiter {
	return &Limiter{limit: limit, window: window, now: now, attempts: map[string][]time.Time{}}
}

// Allow records one request of the address and reports whether it stays
// within the limit.
func (l *Limiter) Allow(address string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	kept := l.attempts[address][:0]
	for _, at := range l.attempts[address] {
		if now.Sub(at) < l.window {
			kept = append(kept, at)
		}
	}
	if len(kept) >= l.limit {
		l.attempts[address] = kept
		return false
	}
	l.attempts[address] = append(kept, now)
	// Forget quiet addresses, so the map never grows without bound.
	if len(l.attempts) > 10_000 {
		for key, times := range l.attempts {
			if len(times) == 0 || now.Sub(times[len(times)-1]) >= l.window {
				delete(l.attempts, key)
			}
		}
	}
	return true
}
