package onlineauth

import (
	"context"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// LockAccountScope takes the account advisory lock inside a transaction.
//
// The lock is the shared protocol between the participant command path, the
// revocation path, and the explicit account-link path. Taking it in a
// transaction orders a link against a session revocation instead of racing
// it.
//
// Outside a real transaction the call is a no-op, because a pooled statement
// cannot hold a lock that orders it against a concurrent revocation.
func LockAccountScope(ctx context.Context, q online.Querier, subject string) error {
	if subject == "" {
		return ErrUnauthenticated
	}
	return locks.LockAccountScopeQ(ctx, writeQuerier(q), locks.AccountScope(string(online.ParticipantAccount), subject))
}

// LockSeatScope takes the guest seat advisory lock inside a transaction.
//
// The lock is the shared protocol between the participant command path, the
// credential rotation path, the seat revocation path, and the explicit
// account-link path.
func LockSeatScope(ctx context.Context, q online.Querier, matchID string, seat online.Seat) error {
	if matchID == "" || (seat != online.SeatWhite && seat != online.SeatBlack) {
		return ErrUnauthenticated
	}
	return lockScope(ctx, q, seatLockKey(matchID, seat))
}

// writeQuerier adapts the authorization read surface to the write surface the
// shared locks package needs.
//
// A caller that is not inside a transaction cannot hold a lock, and the shared
// lock helper treats that case as a no-op.
func writeQuerier(q online.Querier) locks.Querier {
	writer, ok := q.(locks.Querier)
	if !ok {
		return nil
	}
	return writer
}
