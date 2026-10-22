package online

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/jackc/pgx/v5"
)

// MatchErased reports whether the shared replay of a match was erased.
//
// Only an explicit removal erases a shared replay: the explicit removal of a
// participant and the per match removal of a public replay. An ordinary
// account deletion anonymizes the shared game and keeps it, so its projection
// stays allowed.
//
// The caller has to hold the match row lock, so the answer is the truth of
// the moment the caller holds the lock: a removal that was ordered before the
// caller is visible here, and a removal that is ordered after it revokes or
// anonymizes whatever the caller wrote. The check therefore never races a
// removal of the same match.
func MatchErased(ctx context.Context, q Querier, matchID string) (bool, error) {
	var erased bool
	err := q.QueryRow(ctx, `
		SELECT
			EXISTS(
				SELECT 1 FROM online_removal_ledger l
				JOIN online_removal_requests r ON r.removal_id = l.removal_id
				WHERE l.match_id = $1 AND l.scope = 'explicit_removal')
			OR EXISTS(
				SELECT 1 FROM online_deletion_markers m
				WHERE m.match_id = $1 AND m.marker_kind = 'replay_removal')`, matchID).Scan(&erased)
	if err != nil {
		return false, err
	}
	return erased, nil
}

// recordReplayRemoval appends the durable record of a per match removal of a
// public replay.
//
// The record is the fact that a restore of an older bundle replays before the
// restored database serves traffic. Without it, a bundle that was sealed
// before the removal would restore the public replay of the match and the
// removed content would be served again.
//
// The record names no subject: a per match removal keeps its participants, so
// the record carries no reference of a person.
func recordReplayRemoval(ctx context.Context, tx pgx.Tx, matchID, markerID, reason string, removedAt time.Time) error {
	ledgerID, err := newReplayRemovalID()
	if err != nil {
		return err
	}
	// The match is the key of the record: a match has one public replay, so a
	// second removal of the same match keeps the first record.
	_, err = tx.Exec(ctx, `
		INSERT INTO online_replay_removal_ledger(ledger_id,match_id,marker_id,reason,removed_at)
		VALUES($1,$2,$3,$4,$5)
		ON CONFLICT (match_id) DO NOTHING`,
		ledgerID, matchID, markerID, reason, removedAt.UTC())
	return err
}

// newReplayRemovalID mints an opaque identifier for one durable replay
// removal record.
func newReplayRemovalID() (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "rr_" + hex.EncodeToString(raw), nil
}
