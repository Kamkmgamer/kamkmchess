package privacy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5"
)

// ListSubjectRemovalRecords reads the subject level removal ledger.
//
// The subject record is the record of a removed subject itself, whatever it
// played and whatever private data it held. It is the record that survives a
// restore of an older backup, where the deletion table of the account is
// absent.
func (s *Service) ListSubjectRemovalRecords(ctx context.Context) ([]backup.SubjectRemovalRecord, error) {
	rows, err := s.db.Query(ctx, `
		SELECT subject_id,subject_kind,subject_ref,scope,removed_at
		FROM online_removal_subjects
		ORDER BY subject_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]backup.SubjectRemovalRecord, 0)
	for rows.Next() {
		var record backup.SubjectRemovalRecord
		if err = rows.Scan(&record.RecordID, &record.SubjectKind, &record.SubjectRef, &record.Scope, &record.RemovedAt); err != nil {
			return nil, err
		}
		record.RemovedAt = record.RemovedAt.UTC()
		records = append(records, record)
	}
	return records, rows.Err()
}

// ApplySubjectRemovalRecords replays the subject level removal ledger.
//
// The replay is what a restore of an older backup runs: the subject is fenced
// again and its private data is removed again, even when the restored
// database has no deletion record of its own.
func (s *Service) ApplySubjectRemovalRecords(ctx context.Context, records []backup.SubjectRemovalRecord) error {
	for _, record := range records {
		if err := s.applySubjectRemoval(ctx, record); err != nil {
			return err
		}
	}
	return nil
}

// applySubjectRemoval replays one subject removal.
func (s *Service) applySubjectRemoval(ctx context.Context, record backup.SubjectRemovalRecord) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// The request row of the removal is recreated, so the ledger and the
	// request agree again. The removal identifier is derived from the subject
	// record identifier, so the replay is idempotent.
	removalID := "rm_" + strings.TrimPrefix(record.RecordID, "rs_")
	if _, err = tx.Exec(ctx, `
		INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,applied_at,live_delete_due_at,live_deleted_at,recovery_sanitize_due_at)
		VALUES($1,$2,$3,$4,'applied',$5,$5,$5,$6,$5,$7)
		ON CONFLICT (subject_kind, subject_id, scope) DO NOTHING`,
		removalID, record.SubjectKind, record.SubjectRef, record.Scope, record.RemovedAt,
		record.RemovedAt.Add(s.options.LiveRemovalDelay), record.RemovedAt.Add(s.options.RecoverySanitizeDelay)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO online_removal_subjects(subject_id,removal_id,subject_kind,subject_ref,scope,removed_at)
		VALUES($1,(SELECT removal_id FROM online_removal_requests WHERE subject_kind=$2 AND subject_id=$3 AND scope=$4),$2,$3,$4,$5)
		ON CONFLICT (subject_kind, subject_ref, scope) DO NOTHING`,
		record.RecordID, record.SubjectKind, record.SubjectRef, record.Scope, record.RemovedAt); err != nil {
		return err
	}
	// The whole sanitation of the subject runs again: the public identity, the
	// deletion record, the private data, the friend and the queue records and
	// the session fence. An account that only had private data is removed as
	// well, so a restore of an older backup cannot give its name back.
	owners, err := s.subjectOwnerIDs(ctx, s.db, record.SubjectRef)
	if err != nil {
		return err
	}
	for _, owner := range owners {
		if err = s.removePrivateOwnerData(ctx, tx, record.SubjectKind, record.SubjectRef, owner, record.Scope); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// The ledger is the durable record of every match bound removal. A backup
// carries it, so a restore of an older bundle can replay the removals before
// the restored database serves traffic. The subject level removals live in
// their own ledger, because a subject that played no match still has to stay
// removed.
// AppliedRemovalLedger returns the removal ledger that is applied in the
// database.
//
// The restore compares it with the ledger it had to apply, so a restore that
// applied a different ledger keeps the fence open and the gate closed.
func (s *Service) AppliedRemovalLedger(ctx context.Context) (backup.AppliedRemovalLedger, error) {
	records, err := s.ListRemovalRecords(ctx)
	if err != nil {
		return backup.AppliedRemovalLedger{}, err
	}
	subjects, err := s.ListSubjectRemovalRecords(ctx)
	if err != nil {
		return backup.AppliedRemovalLedger{}, err
	}
	return backup.AppliedRemovalLedger{Matches: records, Subjects: subjects}, nil
}

// AppliedLedgerDigest is the digest of the removal ledger that is applied in
// the database.
//
// The restore compares it with the digest of the ledger it had to apply, so a
// restore that applied a different ledger keeps the fence open and the gate
// closed.
func (s *Service) AppliedLedgerDigest(ctx context.Context) (string, error) {
	records, err := s.ListRemovalRecords(ctx)
	if err != nil {
		return "", err
	}
	subjects, err := s.ListSubjectRemovalRecords(ctx)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(backup.RemovalLedgerDigest(records, subjects)), nil
}

// RecoverRestore recovers a restore that crashed.
//
// The recovery is the supported path for every crash boundary of the restore
// lifecycle:
//
//   - the restore crashed before it recorded its gate: there is no gate to
//     release. The removal ledger of the database decides what happens. If the
//     ledger holds every removal the restore had to apply, the fence is
//     closed and the service serves the database. If it does not, the
//     database may have lost the newest removals, so a blocking gate is
//     recorded, the fence is closed and the restore has to be run again.
//   - the restore crashed after it recorded its gate and before it released
//     it: the gate is released here, because the removal ledger is applied.
//   - the restore crashed after it released its gate and before it closed the
//     fence: the gate is already open, and the fence of the crashed restore
//     is closed here.
//
// The recovery is identity bound and it never touches the fence of another
// restore. It also never touches the fence of a *live* restore: the operating
// system lock of the lifecycle is the live ownership proof, and the recovery
// may only take it when it is free.
//
// The immutable deletion protections are never weakened: the recovery only
// releases the admission of a database whose removals are applied.
func (s *Service) RecoverRestore(ctx context.Context, restoreID string, required backup.AppliedRemovalLedger) error {
	restoreID = strings.TrimSpace(restoreID)
	if !restoreIDPattern.MatchString(restoreID) {
		return ErrInvalidArgument
	}
	if s.fenceParent() == "" {
		return errors.New("privacy: no restore fence path is configured")
	}
	// The live ownership proof: the operating system lock of the lifecycle is
	// free only when no restore is alive. A restore that is still running is
	// never cleared by a recovery, not even when it has the same identifier.
	lock, err := acquireFenceLock(s.fenceLockPath())
	if err != nil {
		return err
	}
	if lock == nil {
		return ErrFenceLive
	}
	defer lock.release()
	// The state of the marker is read before anything else, and the three
	// states are told apart:
	//
	//   - there is no marker directory at all: there is no lifecycle to
	//     recover, so the recovery has nothing to prove and nothing to
	//     release. It refuses.
	//   - the marker directory exists without a readable owner marker: the
	//     lifecycle is in an unknown state. A restore that died between the
	//     creation of the directory and the writing of its owner marker, or
	//     between the removal of the owner marker and the removal of the
	//     directory, left that state behind. Nothing proves which removal
	//     ledger the lifecycle owed, so the recovery refuses: the marker
	//     stays, the service stays closed, and the restore has to be run again
	//     with the take-over, which re-imports the bundle and re-applies the
	//     removal ledger.
	//   - the marker directory exists with a readable owner marker: the
	//     recovery is identity bound and the containment of the removal
	//     ledger is checked against the ledger the marker names.
	state, fence, err := s.fenceMarkerState()
	if err != nil {
		return err
	}
	switch state {
	case fenceMarkerAbsent:
		return errors.New("privacy: there is no restore fence to recover")
	case fenceMarkerUnreadable:
		return errors.New("privacy: the restore fence has no readable owner marker; run the restore again with the take-over")
	}
	// The fence of another restore is never touched.
	if fence.RestoreID != restoreID {
		return ErrFenceConflict
	}
	// The recovery is identity bound: the fence of the restore names the
	// removal ledger the restore had to apply, and the ledger of the recovery
	// has to be that ledger. A fence that names no ledger belongs to a restore
	// that died before it read the ledgers, so the recovery cannot prove what
	// it owed: the restore has to be run again with the take-over.
	requiredDigest := fmt.Sprintf("%x", backup.RemovalLedgerDigest(required.Matches, required.Subjects))
	if fence.ExpectedLedgerDigest == "" {
		return errors.New("privacy: the fence of the crashed restore names no removal ledger; run the restore again with the take-over")
	}
	if fence.ExpectedLedgerDigest != requiredDigest {
		return errors.New("privacy: the open fence names another removal ledger")
	}
	// The applied removal ledger has to hold every removal the restore had to
	// apply. A database that lost a removal is not released.
	applied, err := s.AppliedRemovalLedger(ctx)
	if err != nil {
		return err
	}
	if !backup.RemovalLedgerContains(applied, required) {
		// The removals are not applied: the database must not serve. A
		// blocking gate is recorded, the fence is closed so that the restore
		// can be run again, and the service stays closed because of the gate.
		if err = s.recordBlockingGate(ctx, restoreID, required); err != nil {
			return err
		}
		if err = s.removeFenceDirectory(); err != nil {
			return err
		}
		return ErrLedgerNotApplied
	}
	// The removals are applied, so the gate of the restore may be released.
	var released bool
	err = s.db.QueryRow(ctx, `SELECT serving_allowed FROM online_restore_gates WHERE restore_id=$1`, restoreID).Scan(&released)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if !released {
		if _, err = s.db.Exec(ctx, `UPDATE online_restore_gates SET serving_allowed=true, released_at=clock_timestamp() WHERE restore_id=$1 AND serving_allowed=false`, restoreID); err != nil {
			return err
		}
	}
	// The fence of the crashed restore is closed, so a new restore can take
	// the lock.
	return s.removeFenceDirectory()
}

// recordBlockingGate records a restore gate that keeps the service closed.
//
// The gate is the durable proof that the database of a crashed restore may
// not serve traffic. It is released by the next restore that applied the
// removal ledger.
// recordBlockingGate records a restore gate that keeps the service closed.
//
// The gate of a restore is released once and never taken back: the guard of
// the table refuses to set a released gate to pending again. So the blocking
// gate of a recovery is named apart from the gate of the restore, and it is
// recorded under that name.
//
// The name is derived from the restore, so a retry of the recovery finds the
// gate it recorded before instead of recording a second one. When that gate
// was already released, a name of its own is used, so the blocking gate is
// always a pending gate.
func (s *Service) recordBlockingGate(ctx context.Context, restoreID string, required backup.AppliedRemovalLedger) error {
	digest := backup.RemovalLedgerDigest(required.Matches, required.Subjects)
	for attempt := 0; attempt < 8; attempt++ {
		gateID, err := newIdentifier("rg_")
		if err != nil {
			return err
		}
		name := blockingGateRestoreID(restoreID)
		if attempt > 0 {
			// The gate of this name was already released, so it cannot block
			// the service again. A name of its own is used.
			name = blockingGateRestoreID(restoreID, "-"+strings.TrimPrefix(gateID, "rg_"))
		}
		if _, err = s.db.Exec(ctx, `
			INSERT INTO online_restore_gates(gate_id,restore_id,ledger_digest,recorded_at)
			VALUES($1,$2,$3,clock_timestamp())
			ON CONFLICT (restore_id) DO NOTHING`, gateID, name, digest); err != nil {
			return err
		}
		var serving bool
		err = s.db.QueryRow(ctx, `SELECT serving_allowed FROM online_restore_gates WHERE restore_id=$1`, name).Scan(&serving)
		if err != nil {
			return err
		}
		if !serving {
			// The gate is pending, so the service stays closed.
			return nil
		}
	}
	return errors.New("privacy: the blocking gate of the recovery could not be recorded")
}

// blockingGateRestoreID is the name of the gate that blocks the service for a
// restore whose removal ledger was not applied.
//
// The name is derived from the restore and it is kept apart from the
// identifier of the restore itself, whose gate may already be released. The
// name stays inside the length the table allows, so the insert is never
// refused by its own check.
func blockingGateRestoreID(restoreID string, extra ...string) string {
	const suffix = "-blocked"
	name := restoreID + suffix
	for _, part := range extra {
		name = name + part
	}
	if len(name) > 128 {
		name = name[:128]
	}
	return name
}

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
	// The private single-owner data of every deleted account is removed
	// again: a restored database holds those rows again, and the removal
	// ledger replays the removal.
	return s.applyPrivateRemovals(ctx)
}

// applyRemovalRecord replays one removal.
func (s *Service) applyRemovalRecord(ctx context.Context, record backup.RemovalRecord) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var (
		seat    string
		ownerID string
	)
	err = tx.QueryRow(ctx, `SELECT seat,owner_id FROM online_seats WHERE match_id=$1 AND owner_kind=$2 AND `+subject.SQLReference("owner_id")+` = $3`,
		record.MatchID, record.SubjectKind, record.SubjectID).Scan(&seat, &ownerID)
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
	if err = s.removePrivateOwnerData(ctx, tx, record.SubjectKind, record.SubjectID, ownerID, record.Scope); err != nil {
		return err
	}
	// The account is fenced again: the restored database holds the sessions of
	// the account, so the fence is re-applied with the removal.
	if record.SubjectKind == string(online.ParticipantAccount) {
		if err = s.fenceAccount(ctx, tx, ownerID, revocationReason(record.Scope)); err != nil {
			return err
		}
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

// RemovalLedgerDigestOf is the digest of the whole removal ledger: the match
// bound records and the subject level records.
//
// The durable fence stores this digest, so a restore that applied a different
// ledger than the one the fence expected is visible.
func RemovalLedgerDigestOf(matches []backup.RemovalRecord, subjects []backup.SubjectRemovalRecord) ([]byte, error) {
	digest := sha256.New()
	for _, record := range matches {
		digest.Write([]byte(record.MatchID))
		digest.Write([]byte{0})
		digest.Write([]byte(record.RemovalID))
		digest.Write([]byte{0})
		digest.Write([]byte(record.Scope))
		digest.Write([]byte{0})
	}
	for _, record := range subjects {
		digest.Write([]byte("subject:"))
		digest.Write([]byte(record.SubjectKind))
		digest.Write([]byte{0})
		digest.Write([]byte(record.SubjectRef))
		digest.Write([]byte{0})
		digest.Write([]byte(record.Scope))
		digest.Write([]byte{0})
	}
	return digest.Sum(nil), nil
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
//
// The release covers every gate that waits for its release, not only the gate
// of this restore: a restore that succeeded supersedes the restore that
// crashed before it, and the blocking gate of that crashed restore is released
// with it.
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
	// The release covers every gate that waits for its release, not only the
	// gate of this restore: a restore that succeeded supersedes the restore
	// that crashed before it, and the blocking gate of that crashed restore is
	// released with it. The gate of a restore that is still running is never
	// touched, because the lifecycle allows one restore at a time.
	if _, err = s.db.Exec(ctx, `UPDATE online_restore_gates SET serving_allowed=true, released_at=clock_timestamp() WHERE serving_allowed=false`); err != nil {
		return err
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
// The seat of the subject is matched by the one-way reference of the subject,
// never by the raw identifier, and the kind of the participant is part of the
// match.
//
// The check fails closed: an unreadable ledger is not an empty ledger.
func (s *Service) LedgerApplied(ctx context.Context) (bool, error) {
	var pending bool
	err := s.db.QueryRow(ctx, `
		SELECT
			EXISTS(
				SELECT 1 FROM online_removal_ledger l
				JOIN online_seats s ON s.match_id = l.match_id
				WHERE `+subject.SQLReference("s.owner_id")+` = l.subject_id
				  AND s.owner_kind = l.subject_kind
				  AND s.owner_id <> 'anonymized')
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
// Three conditions have to hold: no durable restore fence is open, no restore
// gate is waiting for its removal ledger, and every recorded removal is
// applied in the database.
func (s *Service) ServingAllowed(ctx context.Context) (bool, error) {
	fenced, err := s.FenceOpen()
	if err != nil {
		return false, err
	}
	if fenced {
		return false, nil
	}
	var pending bool
	if err = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM online_restore_gates WHERE serving_allowed = false)`).Scan(&pending); err != nil {
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
