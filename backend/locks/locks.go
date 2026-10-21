// Package locks holds the shared transaction locks of the online service.
//
// The account scope lock orders the flows that act on the same participant:
// the trusted allocation of a seat, the removal of the participant, and the
// creation of a public profile. They take the same lock, so an allocation and
// a removal of one participant are ordered instead of racing.
//
// The lock is a PostgreSQL transaction advisory lock, so it is released when
// the transaction ends. The key is derived from the scope string, so every
// flow that uses this package locks the same scope with the same lock.
//
// The lock order of the shared seams is fixed:
//
//	account scope locks (ascending) -> gate lock -> match row locks
//
// A flow that takes more than one of them takes them in that order, so the
// online writer, the trusted allocator and the privacy flow never deadlock
// against each other.
package locks

import (
	"context"
	"hash/fnv"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// The lock scopes of the online service.
const (
	// LockAccount is the scope of an account participant.
	LockAccount = "account"
	// LockMatch is the scope of one match.
	LockMatch = "match"
)

// advisoryKey derives a stable 64-bit advisory lock key.
//
// The key is derived in the service and sent as a literal, so every caller of
// a scope takes exactly the same lock and the lock statement stays
// observable for the race fixtures.
func advisoryKey(parts ...string) int64 {
	hash := fnv.New64a()
	for _, part := range parts {
		_, _ = hash.Write([]byte(part))
		_, _ = hash.Write([]byte{0})
	}
	return int64(hash.Sum64() & 0x7fffffffffffffff)
}

// AccountKey is the advisory lock key of one account scope.
//
// The scope is the shared scope string, so the online writer, the
// authorization service, the privacy service, the profile service and the
// private store take exactly the same lock.
func AccountKey(scope string) int64 {
	return advisoryKey(LockAccount, scope)
}

// MatchKey is the advisory lock key of one match scope.
func MatchKey(matchID string) int64 {
	return advisoryKey(LockMatch, matchID)
}

// AccountScope is the account scope key of one participant.
//
// The kind is part of the key, so an account and a guest with the same
// identifier never share a scope.
func AccountScope(kind, id string) string {
	return kind + ":" + id
}

// LockAccountScope takes the account scope lock of one participant.
//
// The scope lock is taken before the gate lock and before the match row
// locks, and the scopes of one transaction are taken in ascending order, so
// two flows that lock the same scopes cannot deadlock.
func LockAccountScope(ctx context.Context, tx pgx.Tx, scope string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, AccountKey(scope))
	return err
}

// LockAccountScopes takes the account scope locks of several participants in
// ascending order.
//
// The order is the deadlock rule: two transactions that lock the same scopes
// take them in the same order, so they never wait for each other.
func LockAccountScopes(ctx context.Context, tx pgx.Tx, scopes []string) error {
	ordered := make([]string, 0, len(scopes))
	seen := map[string]bool{}
	for _, scope := range scopes {
		if scope == "" || seen[scope] {
			continue
		}
		seen[scope] = true
		ordered = append(ordered, scope)
	}
	sort.Strings(ordered)
	for _, scope := range ordered {
		if err := LockAccountScope(ctx, tx, scope); err != nil {
			return err
		}
	}
	return nil
}

// matchScopePrefix separates the match scope locks from every other advisory
// lock of the service.
const matchScopePrefix = "kamkmchess.match."

// LockMatchScope takes the match scope lock of one match.
//
// The scope lock orders the trusted allocation of a match against another
// allocation of the same match. A match that does not exist yet has no row
// to lock, so the scope lock is what makes two allocations of the same
// match id wait for each other instead of racing for the insert.
func LockMatchScope(ctx context.Context, tx pgx.Tx, matchID string) error {
	if matchID == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, matchScopePrefix+matchID)
	return err
}

// Querier is the write surface a lock needs.
type Querier interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// LockAccountScopeQ takes the account scope lock when the caller is inside a
// transaction.
//
// Outside a real transaction the call is a no-op, because a pooled statement
// cannot hold a lock that orders it against a concurrent removal.
func LockAccountScopeQ(ctx context.Context, q Querier, scope string) error {
	tx, ok := q.(pgx.Tx)
	if !ok {
		return nil
	}
	return LockAccountScope(ctx, tx, scope)
}
