package mcpserver

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// session is one connected agent. It holds at most one game.
type session struct {
	mu sync.Mutex
	// id is the MCP session id. It never doubles as a credential.
	id         string
	lastSeen   time.Time
	readyMatch string
	readySeat  online.Seat
	readyName  string

	principal   onlineauth.Principal
	matchID     string
	seat        online.Seat
	agentName   string
	resumeToken string
	// plan is the agent's last plan. It is handed back on its next turn,
	// the same way the page carries a model's plan.
	plan string
}

// Readiness metadata is owned by the store lock, independently of sess.mu.
func (st *sessionStore) markReady(sess *session) {
	st.mu.Lock()
	defer st.mu.Unlock()
	sess.readyMatch, sess.readySeat = sess.matchID, sess.seat
	sess.readyName = sess.agentName
}

func (st *sessionStore) seatName(matchID string, seat online.Seat) string {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, sess := range st.sessions {
		if sess.readyMatch == matchID && sess.readySeat == seat {
			return sess.readyName
		}
	}
	return ""
}

func (st *sessionStore) seatReady(matchID string, seat online.Seat) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.expireLocked()
	for _, sess := range st.sessions {
		if sess.readyMatch == matchID && sess.readySeat == seat {
			return true
		}
	}
	return false
}

func (sess *session) hasGame() bool { return sess.matchID != "" }

// attach makes a game the session's game. The caller holds sess.mu.
func (sess *session) attach(principal onlineauth.Principal, name, resumeToken string) {
	sess.principal = principal
	sess.matchID = principal.MatchID
	sess.seat = principal.Seat
	sess.agentName = name
	sess.resumeToken = resumeToken
	sess.plan = ""
}

// detach clears the session's game after a failed start cleanup. The caller
// holds sess.mu.
func (sess *session) detach() {
	sess.principal = onlineauth.Principal{}
	sess.matchID = ""
	sess.seat = ""
	sess.agentName = ""
	sess.resumeToken = ""
	sess.plan = ""
}

type sessionStore struct {
	mu       sync.Mutex
	sessions map[string]*session
	max      int
	idle     time.Duration
	now      func() time.Time
}

func newSessionStore(max int, idle time.Duration, now func() time.Time) *sessionStore {
	return &sessionStore{sessions: map[string]*session{}, max: max, idle: idle, now: now}
}

var errTooManySessions = errors.New("the server is busy: too many agents are connected, try again later")

func (st *sessionStore) create() (string, error) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	id := hex.EncodeToString(raw[:])
	st.mu.Lock()
	defer st.mu.Unlock()
	st.expireLocked()
	if len(st.sessions) >= st.max {
		return "", errTooManySessions
	}
	st.sessions[id] = &session{id: id, lastSeen: st.now()}
	return id, nil
}

func (st *sessionStore) get(id string) (*session, bool) {
	if id == "" {
		return nil, false
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	sess, ok := st.sessions[id]
	if !ok || st.now().Sub(sess.lastSeen) > st.idle {
		delete(st.sessions, id)
		return nil, false
	}
	sess.lastSeen = st.now()
	return sess, true
}

func (st *sessionStore) drop(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.sessions, id)
}

func (st *sessionStore) expireLocked() {
	for id, sess := range st.sessions {
		if st.now().Sub(sess.lastSeen) > st.idle {
			delete(st.sessions, id)
		}
	}
}

// rateLimiter allows a number of game starts per client address in a
// sliding window.
type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	now    func() time.Time
	starts map[string][]time.Time
}

func newRateLimiter(limit int, window time.Duration, now func() time.Time) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, now: now, starts: map[string][]time.Time{}}
}

func (l *rateLimiter) allow(address string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	kept := l.starts[address][:0]
	for _, at := range l.starts[address] {
		if now.Sub(at) < l.window {
			kept = append(kept, at)
		}
	}
	if len(kept) >= l.limit {
		l.starts[address] = kept
		return false
	}
	l.starts[address] = append(kept, now)
	// Forget quiet addresses, so the map never grows without bound.
	if len(l.starts) > 10_000 {
		for key, times := range l.starts {
			if len(times) == 0 || now.Sub(times[len(times)-1]) >= l.window {
				delete(l.starts, key)
			}
		}
	}
	return true
}
