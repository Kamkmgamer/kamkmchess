package privacy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5"
)

// ListRemovalRecords reads the removal ledger of the live database.
//
// The ledger is the durable record of every removal. A backup carries it, so
// a restore of an older bundle can replay the removals before the restored
// database serves traffic.
func (s *Service) ListRemovalRecords(ctx context.Context) ([]backup.RemovalRecord, error) {
	rows, err := s.db.Query(ctx, `
		SELECT removal_id,subject_kind,subject_id,match_id,scope,removed_at
		FROM online_removal_ledger
		ORDER BY match_id, removal_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]backup.RemovalRecord, 0)
	for rows.Next() {
		var record backup.RemovalRecord
		if err = rows.Scan(&record.RemovalID, &record.SubjectKind, &record.SubjectID, &record.MatchID, &record.Scope, &record.RemovedAt); err != nil {
			return nil, err
		}
		record.RemovedAt = record.RemovedAt.UTC()
		records = append(records, record)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

// ApplyRemovalRecords replays a removal ledger.
//
// The replay is what a restore of an older backup runs before the restored
// database serves traffic. It is idempotent: a removal that was already
// applied finds no seat of the subject any more and is skipped.
func (s *Service) ApplyRemovalRecords(ctx context.Context, records []backup.RemovalRecord) error {
	for _, record := range records {
		if err := s.applyRemovalRecord(ctx, record); err != nil {
			return err
		}
	}
	return nil
}

// applyRemovalRecord replays one removal.
func (s *Service) applyRemovalRecord(ctx context.Context, record backup.RemovalRecord) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var seat string
	err = tx.QueryRow(ctx, `SELECT seat FROM online_seats WHERE match_id=$1 AND owner_kind=$2 AND `+subject.SQLReference("owner_id")+` = $3`,
		record.MatchID, record.SubjectKind, record.SubjectID).Scan(&seat)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The removal was already applied: the seat no longer names the
			// subject.
			return tx.Commit(ctx)
		}
		return err
	}
	// The request row may be missing in a restored database that is older
	// than the request. The replay recreates it, so the ledger and the
	// request agree again.
	if _, err = tx.Exec(ctx, `
		INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,applied_at,live_delete_due_at,live_deleted_at,recovery_sanitize_due_at,removed_match_count)
		VALUES($1,$2,$3,$4,'applied',$5,$5,$5,$6,$5,$7,$8)
		ON CONFLICT (subject_kind, subject_id, scope) DO NOTHING`,
		record.RemovalID, record.SubjectKind, record.SubjectID, record.Scope, record.RemovedAt,
		record.RemovedAt.Add(s.options.LiveRemovalDelay), record.RemovedAt.Add(s.options.RecoverySanitizeDelay), 1); err != nil {
		return err
	}
	match := subjectMatch{MatchID: record.MatchID, Seat: online.Seat(seat)}
	// The match row lock orders the replay against the projection of that
	// match. The projection takes the same lock, so a restored database is
	// never projected with the rows the replay is about to remove.
	if _, err = tx.Exec(ctx, `SELECT match_id FROM online_matches WHERE match_id=$1 FOR UPDATE`, record.MatchID); err != nil {
		return err
	}
	if err = s.applyMatchRemoval(ctx, tx, record.RemovalID, record.SubjectKind, record.SubjectID, record.Scope, match); err != nil {
		return err
	}
	if record.Scope == ScopeExplicitRemoval {
		// The shared game leaves both histories again.
		if _, err = tx.Exec(ctx, `DELETE FROM online_profile_results WHERE match_id=$1`, record.MatchID); err != nil {
			return err
		}
	} else {
		// The opponent's history entry loses the deleted name again.
		if _, err = tx.Exec(ctx, `
			UPDATE online_profile_results
			SET opponent_label='Deleted player', opponent_profile_id=NULL
			WHERE match_id=$1 AND seat <> $2`, record.MatchID, string(match.Seat)); err != nil {
			return err
		}
	}
	if err = s.removePrivateOwnerData(ctx, tx, record.SubjectKind, record.SubjectID, record.Scope); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RemovalLedgerDigest is the digest of a removal ledger.
//
// The restore gate records the digest of the ledger that was applied, so an
// operator can prove that the newest ledger was replayed.
func RemovalLedgerDigest(records []backup.RemovalRecord) ([]byte, error) {
	digest := sha256.New()
	for _, record := range records {
		digest.Write([]byte(record.MatchID))
		digest.Write([]byte{0})
		digest.Write([]byte(record.RemovalID))
		digest.Write([]byte{0})
		digest.Write([]byte(record.Scope))
		digest.Write([]byte{0})
	}
	return digest.Sum(nil), nil
}

// RemovalLedgerDigestHex is the hexadecimal digest of a removal ledger.
func RemovalLedgerDigestHex(records []backup.RemovalRecord) (string, error) {
	digest, err := RemovalLedgerDigest(records)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest), nil
}

// RecordRestore records that a database was restored from a backup.
//
// The record is written after the restore, because the restore replaces the
// table that holds it. The gate stays closed until the removal ledger has
// been replayed and the replay has been verified.
func (s *Service) RecordRestore(ctx context.Context, restoreID string) (string, error) {
	restoreID = trimSpace(restoreID)
	if restoreID == "" {
		return "", ErrInvalidArgument
	}
	gateID, err := newIdentifier("rg_")
	if err != nil {
		return "", err
	}
	records, err := s.ListRemovalRecords(ctx)
	if err != nil {
		return "", err
	}
	digest, err := RemovalLedgerDigest(records)
	if err != nil {
		return "", err
	}
	if _, err = s.db.Exec(ctx, `
		INSERT INTO online_restore_gates(gate_id,restore_id,ledger_digest,recorded_at)
		VALUES($1,$2,$3,clock_timestamp())
		ON CONFLICT (restore_id) DO NOTHING`, gateID, restoreID, digest); err != nil {
		return "", err
	}
	return restoreID, nil
}

// ReleaseRestoreGate releases a restore gate after the removal ledger has
// been replayed.
//
// The release is final, and it is refused while the removal ledger is not
// applied. A gate is never opened for a database that still serves a removed
// game.
func (s *Service) ReleaseRestoreGate(ctx context.Context, restoreID string) error {
	restoreID = trimSpace(restoreID)
	if restoreID == "" {
		return ErrInvalidArgument
	}
	applied, err := s.LedgerApplied(ctx)
	if err != nil {
		return err
	}
	if !applied {
		return ErrLedgerNotApplied
	}
	tag, err := s.db.Exec(ctx, `UPDATE online_restore_gates SET serving_allowed=true, released_at=clock_timestamp() WHERE restore_id=$1 AND serving_allowed=false`, restoreID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// LedgerApplied reports whether every recorded removal is applied in the
// database.
//
// The check reads the applied state of the removals themselves, so it
// survives a restore: a restored database holds the rows of the removals it
// lost, and the check finds them. A service that starts on such a database
// refuses to serve, because the erased game would be public again.
//
// The check fails closed: an unreadable ledger is not an empty ledger.
func (s *Service) LedgerApplied(ctx context.Context) (bool, error) {
	var pending bool
	err := s.db.QueryRow(ctx, `
		SELECT
			EXISTS(
				SELECT 1 FROM online_removal_ledger l
				JOIN online_seats s ON s.match_id = l.match_id AND s.owner_id = l.subject_id
				WHERE s.owner_id <> 'anonymized')
			OR EXISTS(
				SELECT 1 FROM online_removal_ledger l
				JOIN online_public_replays r ON r.match_id = l.match_id
				WHERE l.scope = 'explicit_removal' AND r.revoked_at IS NULL)`).Scan(&pending)
	if err != nil {
		return false, err
	}
	return !pending, nil
}

// ServingAllowed reports whether the service may serve traffic.
//
// Two conditions have to hold: no restore gate is waiting for its removal
// ledger, and every recorded removal is applied in the database.
func (s *Service) ServingAllowed(ctx context.Context) (bool, error) {
	var pending bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM online_restore_gates WHERE serving_allowed = false)`).Scan(&pending); err != nil {
		return false, err
	}
	if pending {
		return false, nil
	}
	return s.LedgerApplied(ctx)
}

// PendingRecoverySanitizations lists the removals whose recovery copies are
// due to be sanitized.
//
// The recovery copies of a removal are sanitized within thirty days of the
// verification. The listing is the operator evidence of that schedule.
func (s *Service) PendingRecoverySanitizations(ctx context.Context, now time.Time) ([]backup.RemovalRecord, error) {
	rows, err := s.db.Query(ctx, `
		SELECT l.removal_id,l.subject_kind,l.subject_id,l.match_id,l.scope,l.removed_at
		FROM online_removal_ledger l
		JOIN online_removal_requests r ON r.removal_id = l.removal_id
		WHERE r.recovery_sanitized_at IS NULL AND r.recovery_sanitize_due_at <= $1
		ORDER BY l.match_id`, now.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]backup.RemovalRecord, 0)
	for rows.Next() {
		var record backup.RemovalRecord
		if err = rows.Scan(&record.RemovalID, &record.SubjectKind, &record.SubjectID, &record.MatchID, &record.Scope, &record.RemovedAt); err != nil {
			return nil, err
		}
		record.RemovedAt = record.RemovedAt.UTC()
		records = append(records, record)
	}
	return records, rows.Err()
}

// MarkRecoverySanitized records that the recovery copies of a removal were
// sanitized.
func (s *Service) MarkRecoverySanitized(ctx context.Context, removalID string) error {
	removalID = trimSpace(removalID)
	if removalID == "" {
		return ErrInvalidArgument
	}
	tag, err := s.db.Exec(ctx, `UPDATE online_removal_requests SET recovery_sanitized_at=clock_timestamp() WHERE removal_id=$1 AND recovery_sanitized_at IS NULL`, removalID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// trimSpace trims a value.
func trimSpace(value string) string {
	start := 0
	end := len(value)
	for start < end && (value[start] == ' ' || value[start] == '\t' || value[start] == '\n' || value[start] == '\r') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\t' || value[end-1] == '\n' || value[end-1] == '\r') {
		end--
	}
	return value[start:end]
}
