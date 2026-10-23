// Package onlineswitch holds the runtime switches of the online surfaces.
//
// The environment gives each surface its default. The site owner can override
// a default from the site; the override is stored in online_runtime_switches
// and wins until it is changed again. Every API process reads the stored
// overrides at most once per refresh interval, so a change reaches all of them
// within that interval without a redeploy.
package onlineswitch

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// State is whether each online surface is open.
type State struct {
	Friends bool `json:"friends"`
	Queue   bool `json:"queue"`
}

// Store is the runtime switch state of one process.
type Store struct {
	db       *pgxpool.Pool
	defaults State
	refresh  time.Duration

	mu     sync.Mutex
	state  State
	readAt time.Time
}

// RefreshInterval is how long a process trusts its last read of the overrides.
const RefreshInterval = 5 * time.Second

// Open reads the overrides once and returns the store. A nil pool keeps the
// defaults forever, which is what a service without a database does.
func Open(ctx context.Context, db *pgxpool.Pool, defaults State) (*Store, error) {
	s := &Store{db: db, defaults: defaults, refresh: RefreshInterval, state: defaults}
	if db == nil {
		return s, nil
	}
	state, err := s.read(ctx)
	if err != nil {
		return nil, err
	}
	s.state, s.readAt = state, time.Now()
	return s, nil
}

// Defaults is the configured state, before any override.
func (s *Store) Defaults() State { return s.defaults }

// State is the current state. When a refresh fails the last known state is
// kept, so a database blip never flips a surface.
func (s *Store) State(ctx context.Context) State {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil || time.Since(s.readAt) < s.refresh {
		return s.state
	}
	if state, err := s.read(ctx); err == nil {
		s.state = state
	}
	s.readAt = time.Now()
	return s.state
}

// FriendsEnabled is the friend surface gate.
func (s *Store) FriendsEnabled() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return s.State(ctx).Friends
}

// QueueEnabled reports whether the public queue is open.
func (s *Store) QueueEnabled() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return s.State(ctx).Queue
}

// ErrNoDatabase is returned by Set on a store without a database.
var ErrNoDatabase = errors.New("onlineswitch: no database")

// Set stores the owner's choice for both surfaces and returns the new state.
func (s *Store) Set(ctx context.Context, next State, by string) (State, error) {
	if s.db == nil {
		return State{}, ErrNoDatabase
	}
	_, err := s.db.Exec(ctx, `
INSERT INTO online_runtime_switches (surface, enabled, updated_by)
VALUES ('friends', $1, $3), ('queue', $2, $3)
ON CONFLICT (surface) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		next.Friends, next.Queue, by)
	if err != nil {
		return State{}, err
	}
	s.mu.Lock()
	s.state, s.readAt = next, time.Now()
	s.mu.Unlock()
	return next, nil
}

func (s *Store) read(ctx context.Context) (State, error) {
	state := s.defaults
	rows, err := s.db.Query(ctx, `SELECT surface, enabled FROM online_runtime_switches`)
	if err != nil {
		return State{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var surface string
		var enabled bool
		if err := rows.Scan(&surface, &enabled); err != nil {
			return State{}, err
		}
		switch surface {
		case "friends":
			state.Friends = enabled
		case "queue":
			state.Queue = enabled
		}
	}
	return state, rows.Err()
}
