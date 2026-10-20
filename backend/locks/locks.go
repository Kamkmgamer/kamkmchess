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
	"sort"

	"github.com/jackc/pgx/v5"
)

// accountScopePrefix separates the account scope locks from every other
// advisory lock of the service.
const accountScopePrefix = "kamkmchess.account."

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
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, accountScopePrefix+scope)
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
