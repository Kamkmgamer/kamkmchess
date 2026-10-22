package integration

// The durable evidence of the removals a restore owes.
//
// The regressions below drive the real privacy service, the real backup
// restore lifecycle and a real PostgreSQL database.
//
// The import of a bundle is simulated: the native pg_restore lifecycle of the
// operations owns that, and the simulation models what the import does to the
// removal ledger of the live database. The import replaces the removal ledger
// of the live database with the removal ledger of the bundle, and it brings
// the seats of the bundle back, because the bundle was sealed before the
// removal. Everything else - the fence, the durable evidence, the gate, the
// replay of the removal ledger and the release of the gate - is the real code.

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
	"github.com/jackc/pgx/v5/pgxpool"
)

// evidenceDumper is a logical export that carries no schema change.
type evidenceDumper struct{}

func (evidenceDumper) Describe(context.Context) (string, error) {
	return "evidence logical export", nil
}

func (evidenceDumper) Dump(_ context.Context, w io.Writer) error {
	_, err := w.Write([]byte("-- evidence bundle\nSELECT 1;\n"))
	return err
}

// evidenceTombstones is a database without private deletion tombstones.
type evidenceTombstones struct{}

func (evidenceTombstones) ListTombstones(context.Context) ([]backup.Tombstone, error) {
	return nil, nil
}

func (evidenceTombstones) ApplyTombstones(context.Context, []backup.Tombstone) error {
	return nil
}

// evidenceLedger adapts the privacy service to the interfaces of the backup
// package. The command line tool does the same in its pgtools.go.
type evidenceLedger struct {
	service *privacy.Service
}

func (l evidenceLedger) ListRemovalRecords(ctx context.Context) ([]backup.RemovalRecord, error) {
	return l.service.ListRemovalRecords(ctx)
}

func (l evidenceLedger) ListSubjectRemovalRecords(ctx context.Context) ([]backup.SubjectRemovalRecord, error) {
	return l.service.ListSubjectRemovalRecords(ctx)
}

func (l evidenceLedger) ApplyRemovalRecords(ctx context.Context, records []backup.RemovalRecord) error {
	return l.service.ApplyRemovalRecords(ctx, records)
}

func (l evidenceLedger) ApplySubjectRemovalRecords(ctx context.Context, records []backup.SubjectRemovalRecord) error {
	return l.service.ApplySubjectRemovalRecords(ctx, records)
}

func (l evidenceLedger) AppliedRemovalLedger(ctx context.Context) (backup.AppliedRemovalLedger, error) {
	return l.service.AppliedRemovalLedger(ctx)
}

func (l evidenceLedger) PendingRemovalRequirements(ctx context.Context) (backup.AppliedRemovalLedger, error) {
	return l.service.PendingRemovalRequirements(ctx)
}

func (l evidenceLedger) RecordRestore(ctx context.Context, restoreID string) (string, error) {
	return l.service.RecordRestore(ctx, restoreID)
}

func (l evidenceLedger) ReleaseRestoreGate(ctx context.Context, restoreID string) error {
	return l.service.ReleaseRestoreGate(ctx, restoreID)
}

func (l evidenceLedger) BeginFence(restoreID string, takeover bool) (backup.FenceHandle, error) {
	handle, err := l.service.BeginFence(restoreID, takeover)
	if err != nil {
		return nil, err
	}
	return handle, nil
}

// evidenceBundle seals a bundle that carries the given removal ledgers.
func evidenceBundle(t *testing.T, directory string, matches []backup.RemovalRecord, subjects []backup.SubjectRemovalRecord) string {
	t.Helper()
	label := backup.DailyLabel(time.Now().UTC())
	path := filepath.Join(directory, label+".kha")
	if _, err := backup.Create(context.Background(), backup.CreateRequest{
		Path:       path,
		Label:      label,
		Passphrase: []byte("evidence-passphrase-0001"),
		CreatedAt:  time.Now().UTC(),
		Dumper:     evidenceDumper{},
		Tombstones: evidenceTombstones{},
		Removals:   evidenceSource{matches: matches, subjects: subjects},
	}); err != nil {
		t.Fatalf("seal the evidence bundle: %v", err)
	}
	return path
}

// evidenceSource is the removal ledger that a bundle carries.
type evidenceSource struct {
	matches  []backup.RemovalRecord
	subjects []backup.SubjectRemovalRecord
}

func (s evidenceSource) ListRemovalRecords(context.Context) ([]backup.RemovalRecord, error) {
	return s.matches, nil
}

func (s evidenceSource) ListSubjectRemovalRecords(context.Context) ([]backup.SubjectRemovalRecord, error) {
	return s.subjects, nil
}

// evidenceSeat is the seat of a participant before its removal.
type evidenceSeat struct {
	matchID     string
	seat        string
	ownerKind   string
	ownerID     string
	publicLabel string
	controlKind string
	modelLabel  *string
	epoch       int64
}

// evidenceState is the state of the live database that the import of a bundle
// replaces.
//
// The import brings the seats of the bundle back, because the bundle was
// sealed before the removal. The replay of the removal ledger anonymizes them
// again, so the replay of the ledger is observable.
type evidenceState struct {
	seats []evidenceSeat
}

// evidenceCapture reads the seats of the participants before their removal.
func evidenceCapture(t *testing.T, pool *pgxpool.Pool, seats ...[2]string) evidenceState {
	t.Helper()
	state := evidenceState{}
	for _, seat := range seats {
		var captured evidenceSeat
		captured.matchID = seat[0]
		captured.seat = seat[1]
		if err := pool.QueryRow(context.Background(), `
			SELECT owner_kind,owner_id,public_label,control_kind,model_label,control_epoch
			FROM online_seats WHERE match_id=$1 AND seat=$2`, captured.matchID, captured.seat).
			Scan(&captured.ownerKind, &captured.ownerID, &captured.publicLabel, &captured.controlKind, &captured.modelLabel, &captured.epoch); err != nil {
			t.Fatalf("read the seat %s/%s: %v", captured.matchID, captured.seat, err)
		}
		state.seats = append(state.seats, captured)
	}
	return state
}

// restore brings the seats of the bundle back.
func (s evidenceState) restore(ctx context.Context, pool *pgxpool.Pool) error {
	for _, seat := range s.seats {
		if _, err := pool.Exec(ctx, `DELETE FROM online_seats WHERE match_id=$1 AND seat=$2`, seat.matchID, seat.seat); err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO online_seats(match_id,seat,owner_kind,owner_id,public_label,control_kind,model_label,control_epoch)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
			seat.matchID, seat.seat, seat.ownerKind, seat.ownerID, seat.publicLabel, seat.controlKind, seat.modelLabel, seat.epoch); err != nil {
			return err
		}
	}
	return nil
}

// evidenceRestorer is the import of a bundle.
//
// The import replaces the removal ledger of the live database with the removal
// ledger of the bundle, and it fails when the restore crashes.
type evidenceRestorer struct {
	pool *pgxpool.Pool
	// state is the state of the live database that the import replaces.
	state evidenceState
	// matches and subjects are the removal ledgers that the bundle carries.
	matches  []backup.RemovalRecord
	subjects []backup.SubjectRemovalRecord
	// fail makes the import fail, which is the crash of the restore.
	fail bool
	// imports counts the imports that ran.
	imports *int
}

func (r evidenceRestorer) Restore(ctx context.Context, sql io.Reader) error {
	_, _ = io.Copy(io.Discard, sql)
	if r.imports != nil {
		*r.imports++
	}
	if r.pool == nil {
		if r.fail {
			return errors.New("the import of the bundle failed")
		}
		return nil
	}
	if err := r.state.restore(ctx, r.pool); err != nil {
		return err
	}
	if err := evidenceImport(ctx, r.pool, r.matches, r.subjects); err != nil {
		return err
	}
	if r.fail {
		return errors.New("the import of the bundle failed")
	}
	return nil
}

// evidenceImport replaces the removal ledger of the live database with the
// removal ledger of the bundle.
//
// The import of a restore replaces the schema of the target database, so the
// removals that only the live database carried are gone afterwards.
func evidenceImport(ctx context.Context, pool *pgxpool.Pool, matches []backup.RemovalRecord, subjects []backup.SubjectRemovalRecord) error {
	if _, err := pool.Exec(ctx, `TRUNCATE online_removal_ledger,online_removal_subjects,online_removal_requests,online_account_deletions CASCADE`); err != nil {
		return err
	}
	for _, record := range matches {
		if _, err := pool.Exec(ctx, `
			INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,applied_at,live_delete_due_at,live_deleted_at,recovery_sanitize_due_at,removed_match_count)
			VALUES($1,$2,$3,$4,'applied',$5,$5,$5,$6,$5,$7,1)
			ON CONFLICT DO NOTHING`,
			record.RemovalID, record.SubjectKind, record.SubjectID, record.Scope, record.RemovedAt,
			record.RemovedAt.Add(24*time.Hour), record.RemovedAt.Add(30*24*time.Hour)); err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO online_removal_ledger(ledger_id,removal_id,subject_kind,subject_id,match_id,scope,removed_at)
			VALUES($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT DO NOTHING`,
			"rl_"+strings.TrimPrefix(record.RemovalID, "rm_"), record.RemovalID, record.SubjectKind, record.SubjectID, record.MatchID, record.Scope, record.RemovedAt); err != nil {
			return err
		}
	}
	for _, record := range subjects {
		removalID := "rm_" + strings.TrimPrefix(record.RecordID, "rs_")
		if _, err := pool.Exec(ctx, `
			INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,applied_at,live_delete_due_at,live_deleted_at,recovery_sanitize_due_at)
			VALUES($1,$2,$3,$4,'applied',$5,$5,$5,$6,$5,$7)
			ON CONFLICT DO NOTHING`,
			removalID, record.SubjectKind, record.SubjectRef, record.Scope, record.RemovedAt,
			record.RemovedAt.Add(24*time.Hour), record.RemovedAt.Add(30*24*time.Hour)); err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO online_removal_subjects(subject_id,removal_id,subject_kind,subject_ref,scope,removed_at)
			VALUES($1,$2,$3,$4,$5,$6)
			ON CONFLICT DO NOTHING`,
			record.RecordID, removalID, record.SubjectKind, record.SubjectRef, record.Scope, record.RemovedAt); err != nil {
			return err
		}
	}
	return nil
}

// evidenceFixture opens the privacy service of a fixture with a durable fence.
func evidenceFixture(t *testing.T) (*onlineAuthFixture, *privacy.Service, string) {
	t.Helper()
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	directory := filepath.Join(t.TempDir(), "restore")
	service, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}
	return fixture, service, directory
}

// TestPostgresTheRecoveryOfACrashedRestoreNamesTheRemovalLedgerItBound
// covers the recovery of a restore that crashed.
//
// The restore binds the removal ledger it has to apply, and that ledger holds
// the removals that only the live database carried. The import of the restore
// destroys them, so nobody can rebuild the ledger from the bundle and the
// rotation copies afterwards.
//
// The durable evidence of the restore is the ledger itself, and it lives
// outside the restored database. The recovery of the crashed restore names
// that ledger, so the recovery reports that the removals are not applied
// instead of reporting that the fence names another ledger.
func TestPostgresTheRecoveryOfACrashedRestoreNamesTheRemovalLedgerItBound(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-recovery-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	// The opponent of the match asks for an explicit removal.
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(live.Matches) != 1 || len(live.Subjects) != 1 {
		t.Fatalf("the live ledger holds %d match records and %d subject records", len(live.Matches), len(live.Subjects))
	}
	// The bundle of the restore is an old one: it carries no removal at all.
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	restoreID := "evidence-recovery-restore"
	// The restore crashes during its import. The import destroys the removal
	// ledger of the live database.
	_, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, fail: true},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      restoreID,
	})
	if err == nil {
		t.Fatal("the crashing restore reported success")
	}
	// The marker of the crashed restore names the ledger the restore had to
	// apply, and that ledger holds the removal of the live database.
	fence, open, err := removals.ReadFence("")
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the crashed restore left no marker")
	}
	owedDigest := evidenceDigest(live)
	if fence.ExpectedLedgerDigest != owedDigest {
		t.Fatalf("the marker names %q, the live ledger digest is %q", fence.ExpectedLedgerDigest, owedDigest)
	}
	// The durable evidence of the restore is on the disk, and it is the exact
	// ledger the restore owed.
	required, found, err := removals.RestoreRequirement(restoreID)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("the durable evidence of the crashed restore is missing")
	}
	if evidenceDigest(required) != owedDigest {
		t.Fatalf("the durable evidence names %q, the live ledger digest is %q", evidenceDigest(required), owedDigest)
	}
	// The evidence is private: it is readable by its owner only. The
	// permission bits are a POSIX guarantee, and Windows has no such bits.
	evidenceFile := filepath.Join(directory, "restore-requirements", restoreID+".json")
	info, err := os.Stat(evidenceFile)
	if err != nil {
		t.Fatalf("the durable evidence is not on the disk: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("the durable evidence is readable by others: %v", info.Mode().Perm())
	}
	// The evidence never holds the identifier of a removed subject: it holds
	// the one-way reference of the subject, exactly like the ledger of the
	// database.
	raw, err := os.ReadFile(evidenceFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "user_b") {
		t.Fatal("the durable evidence holds the identifier of a removed subject")
	}
	// The recovery of the crashed restore names the ledger the restore bound.
	// The removals are not applied, because the import destroyed them, so the
	// recovery reports that the ledger is not applied.
	err = removals.RecoverRestore(ctx, restoreID, required)
	if !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery of the crashed restore returned %v, want ErrLedgerNotApplied", err)
	}
	if strings.Contains(err.Error(), "another removal ledger") {
		t.Fatalf("the recovery could not name the ledger the restore bound: %v", err)
	}
	// The fence is closed, so the restore can be run again, and the service
	// stays closed because of the gate of the lost removal.
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if fenced {
		t.Fatal("the fence of the crashed restore is still open")
	}
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic after a restore that lost a removal")
	}
}

// TestPostgresTheOwedRemovalsAreReplayedByTheNextRestore covers the removals
// that a crashed restore owed.
//
// The removals that only the live database carried are destroyed by the import
// of the restore. The durable evidence of the restore keeps them, and the next
// restore merges that evidence into the removal ledger it has to apply, so the
// removals are replayed and the service may serve again.
func TestPostgresTheOwedRemovalsAreReplayedByTheNextRestore(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-owed-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	restoreID := "evidence-owed-restore"
	_, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, fail: true},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      restoreID,
	})
	if err == nil {
		t.Fatal("the crashing restore reported success")
	}
	// The import destroyed the removal ledger of the live database.
	after, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Matches) != 0 || len(after.Subjects) != 0 {
		t.Fatalf("the import left %d match records and %d subject records", len(after.Matches), len(after.Subjects))
	}
	// The recovery of the crashed restore finds the removals lost and records
	// the gate that keeps the service closed.
	required, found, err := removals.RestoreRequirement(restoreID)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("the durable evidence of the crashed restore is missing")
	}
	if err = removals.RecoverRestore(ctx, restoreID, required); !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery of the crashed restore returned %v, want ErrLedgerNotApplied", err)
	}
	// The next restore takes over. It replays the removals the crashed restore
	// owed, because the durable evidence is merged into the removal ledger it
	// has to apply.
	nextID := "evidence-owed-next"
	result, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      nextID,
		Takeover:       true,
	})
	if err != nil {
		t.Fatalf("the next restore failed: %v", err)
	}
	if result.RemovalsApplied != 1 || result.SubjectRemovalsApplied != 1 {
		t.Fatalf("the next restore replayed %d removals and %d subject removals", result.RemovalsApplied, result.SubjectRemovalsApplied)
	}
	// The removal ledger of the database holds the owed removal again.
	applied, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !backup.RemovalLedgerContains(applied, live) {
		t.Fatalf("the applied ledger does not hold the owed removal: %+v", applied)
	}
	// The seat of the removed participant is anonymized again.
	var ownerID string
	if err = fixture.pool.QueryRow(ctx, `SELECT owner_id FROM online_seats WHERE match_id=$1 AND seat='black'`, matchID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if ownerID != "anonymized" {
		t.Fatalf("the seat of the removed participant names %q", ownerID)
	}
	// The gate of the lost removal is released, because the database holds the
	// removal it waited for, and the service serves again.
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("the database holds %d pending gates", pending)
	}
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the service does not serve after a restore that applied the owed removals")
	}
}

// TestPostgresTheSubjectRemovalOfAnAccountWithoutAMatchIsReplayed covers the
// removal of a subject that never played an online match.
//
// The subject level record is the only carrier of that removal, so the
// evidence of the restore has to hold it and the next restore has to replay
// it.
func TestPostgresTheSubjectRemovalOfAnAccountWithoutAMatchIsReplayed(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	// The account owns a public name and it never played an online match.
	resolver, err := profileServiceFor(t, fixture)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = resolver.EnsureProfileForAccount(ctx, "user_a"); err != nil {
		t.Fatal(err)
	}
	name := "namedplayer"
	if _, err = resolver.UpdateProfile(ctx, accountPrincipal("user_a", "session-user_a"), profile.Update{Username: &name}, authTestOrigin); err != nil {
		t.Fatalf("update the profile: %v", err)
	}
	if _, err = removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove the account: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(live.Matches) != 0 || len(live.Subjects) != 1 {
		t.Fatalf("the live ledger holds %d match records and %d subject records", len(live.Matches), len(live.Subjects))
	}
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	restoreID := "evidence-subject-restore"
	_, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, fail: true},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      restoreID,
	})
	if err == nil {
		t.Fatal("the crashing restore reported success")
	}
	// The subject record of the removal is gone: the import destroyed it.
	after, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Subjects) != 0 {
		t.Fatalf("the import left %d subject records", len(after.Subjects))
	}
	required, found, err := removals.RestoreRequirement(restoreID)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("the durable evidence of the crashed restore is missing")
	}
	if err = removals.RecoverRestore(ctx, restoreID, required); !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery of the crashed restore returned %v, want ErrLedgerNotApplied", err)
	}
	// The next restore replays the subject removal, so the account stays
	// removed.
	result, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-subject-next",
		Takeover:       true,
	})
	if err != nil {
		t.Fatalf("the next restore failed: %v", err)
	}
	if result.SubjectRemovalsApplied != 1 {
		t.Fatalf("the next restore replayed %d subject removals", result.SubjectRemovalsApplied)
	}
	applied, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !backup.RemovalLedgerContains(applied, live) {
		t.Fatalf("the applied ledger does not hold the owed subject removal: %+v", applied)
	}
	// The public name of the removed account is gone and its session is
	// fenced.
	var username string
	if err = fixture.pool.QueryRow(ctx, `SELECT coalesce(username,'') FROM online_public_profiles WHERE account_id='user_a'`).Scan(&username); err != nil {
		t.Fatal(err)
	}
	if username != "" {
		t.Fatalf("the public name of the removed account is back: %q", username)
	}
	var revoked int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_session_revocations WHERE subject_id='user_a'`).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked == 0 {
		t.Fatal("the removed account is not fenced")
	}
}

// TestPostgresTheRepeatedTakeoverKeepsTheOwedRemovals covers the take-over of
// a restore that crashed more than once.
//
// The durable evidence of a restore survives the crash of the restore and the
// take-over of the next one, so the removals that the first restore owed are
// still owed after the second crash and are replayed at the end.
func TestPostgresTheRepeatedTakeoverKeepsTheOwedRemovals(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-repeated-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	// The first restore crashes during its import.
	firstID := "evidence-repeated-first"
	_, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, fail: true},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      firstID,
	})
	if err == nil {
		t.Fatal("the crashing restore reported success")
	}
	// The second restore takes over and crashes as well.
	secondID := "evidence-repeated-second"
	_, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, fail: true},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      secondID,
		Takeover:       true,
	})
	if err == nil {
		t.Fatal("the second crashing restore reported success")
	}
	// The evidence of the first restore is still there: the removals it owed
	// are still owed.
	first, found, err := removals.RestoreRequirement(firstID)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("the durable evidence of the first restore is gone after the take-over")
	}
	if evidenceDigest(first) != evidenceDigest(live) {
		t.Fatalf("the durable evidence of the first restore names %q, the live ledger digest is %q", evidenceDigest(first), evidenceDigest(live))
	}
	// The third restore replays the removals that the first restore owed.
	result, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-repeated-third",
		Takeover:       true,
	})
	if err != nil {
		t.Fatalf("the third restore failed: %v", err)
	}
	if result.RemovalsApplied != 1 {
		t.Fatalf("the third restore replayed %d removals", result.RemovalsApplied)
	}
	applied, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !backup.RemovalLedgerContains(applied, live) {
		t.Fatalf("the applied ledger does not hold the owed removal: %+v", applied)
	}
}

// TestPostgresTheGateOfALostRemovalIsRetainedUntilItIsApplied covers the
// gate that a recovery records for a database that lost a removal.
//
// The gate is the durable proof that the database may not serve traffic. It is
// released only when the database holds the removal ledger the gate waits for,
// so a restore that did not apply the removal keeps the service closed.
func TestPostgresTheGateOfALostRemovalIsRetainedUntilItIsApplied(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	// The removal that the database cannot hold: it names a match that the
	// database does not have, so no replay can apply it.
	owed := backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{{
		RemovalID: "rm_evidence_lost", SubjectKind: "account", SubjectID: privacy.SubjectReference("user_a"), MatchID: "evidence-lost-match", Scope: "explicit_removal", RemovedAt: time.Now().UTC(),
	}}}
	restoreID := "evidence-lost-restore"
	handle, err := removals.BeginFence(restoreID, false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(owed); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	// The recovery of the crashed restore finds the removal lost, so it
	// records the gate that keeps the service closed.
	if err = removals.RecoverRestore(ctx, restoreID, owed); !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery of the crashed restore returned %v, want ErrLedgerNotApplied", err)
	}
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic while the gate of the lost removal waits")
	}
	// The next restore does not apply the removal, so the gate is retained
	// and the service stays closed.
	next, err := removals.BeginFence("evidence-lost-next", true)
	if err != nil {
		t.Fatalf("open the fence of the next restore: %v", err)
	}
	defer next.Release()
	if err = next.Bind(owed); err != nil {
		t.Fatalf("bind the fence of the next restore: %v", err)
	}
	if _, err = removals.RecordRestore(ctx, "evidence-lost-next"); err != nil {
		t.Fatal(err)
	}
	if err = removals.ReleaseRestoreGate(ctx, "evidence-lost-next"); err == nil {
		t.Log("the release of the gate of the next restore was refused")
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending == 0 {
		t.Fatal("the gate of the lost removal was released although the removal was not applied")
	}
	allowed, err = removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic while the gate of the lost removal waits")
	}
}

// TestPostgresTheSecondRestoreWithTheNewerLedgerAppliesTheOwedRemoval is the
// control of the gate above.
//
// The same second restore, with the newer rotation copy that carries the
// removal, applies the removal, so the gate is released and the service may
// serve.
func TestPostgresTheSecondRestoreWithTheNewerLedgerAppliesTheOwedRemoval(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-control-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The bundle carries the removal, and the newer rotation copy carries it
	// as well.
	bundle := evidenceBundle(t, t.TempDir(), live.Matches, live.Subjects)
	crashedID := "evidence-control-crashed"
	_, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:                       bundle,
		Passphrase:                 []byte("evidence-passphrase-0001"),
		Restorer:                   evidenceRestorer{pool: fixture.pool, state: state, fail: true},
		Tombstones:                 evidenceTombstones{},
		Removals:                   evidenceLedger{service: removals},
		AdmissionFence:             evidenceLedger{service: removals},
		RestoreID:                  crashedID,
		NewerRemovalLedgers:        [][]backup.RemovalRecord{live.Matches},
		NewerSubjectRemovalLedgers: [][]backup.SubjectRemovalRecord{live.Subjects},
	})
	if err == nil {
		t.Fatal("the crashing restore reported success")
	}
	required, found, err := removals.RestoreRequirement(crashedID)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("the durable evidence of the crashed restore is missing")
	}
	if err = removals.RecoverRestore(ctx, crashedID, required); !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery of the crashed restore returned %v, want ErrLedgerNotApplied", err)
	}
	// The second restore supplies the newer rotation copy. The removal is
	// applied, the gate is released and the service serves again.
	result, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:                       bundle,
		Passphrase:                 []byte("evidence-passphrase-0001"),
		Restorer:                   evidenceRestorer{pool: fixture.pool, state: state},
		Tombstones:                 evidenceTombstones{},
		Removals:                   evidenceLedger{service: removals},
		AdmissionFence:             evidenceLedger{service: removals},
		RestoreID:                  "evidence-control-second",
		Takeover:                   true,
		NewerRemovalLedgers:        [][]backup.RemovalRecord{live.Matches},
		NewerSubjectRemovalLedgers: [][]backup.SubjectRemovalRecord{live.Subjects},
	})
	if err != nil {
		t.Fatalf("the second restore failed: %v", err)
	}
	if result.RemovalsApplied != 1 {
		t.Fatalf("the second restore replayed %d removals", result.RemovalsApplied)
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("the database holds %d pending gates", pending)
	}
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the service does not serve after a restore that applied the removal")
	}
}

// TestPostgresTheRestoreWithoutARemovalServesAgain is the control of the
// regressions above.
//
// A restore without any removal closes its fence, releases its gate and lets
// the service serve again.
func TestPostgresTheRestoreWithoutARemovalServesAgain(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	result, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-control-empty",
	})
	if err != nil {
		t.Fatalf("the restore failed: %v", err)
	}
	if result.RemovalsApplied != 0 || result.SubjectRemovalsApplied != 0 {
		t.Fatalf("the restore replayed %d removals and %d subject removals", result.RemovalsApplied, result.SubjectRemovalsApplied)
	}
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if fenced {
		t.Fatal("the fence of the restore is still open")
	}
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the service does not serve after a restore without removals")
	}
}

// TestPostgresTheFinishOfAnUnboundFenceIsRefused covers the close of a fence
// whose marker names no removal ledger.
//
// The contract says that the fence is closed only for the removal ledger it
// names. A marker that names no ledger was never bound, so the close has
// nothing to verify and it refuses.
func TestPostgresTheFinishOfAnUnboundFenceIsRefused(t *testing.T) {
	_, removals, _ := evidenceFixture(t)
	handle, err := removals.BeginFence("evidence-unbound-restore", false)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Release()
	fence, open, err := removals.ReadFence("")
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the marker of the lifecycle is missing")
	}
	if fence.ExpectedLedgerDigest != "" {
		t.Fatalf("the marker names the ledger %q", fence.ExpectedLedgerDigest)
	}
	if err = handle.Finish(backup.AppliedRemovalLedger{}); err == nil {
		t.Fatal("the close of an unbound fence was accepted")
	}
	// The fence is still open, so the service stays closed.
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !fenced {
		t.Fatal("the refused close closed the fence")
	}
}

// TestPostgresTheFinishOfAFenceWithoutAnOwnerIsRefused covers the close of a
// fence whose marker directory has no owner marker.
//
// The service decides with the marker directory, so a close that reports a
// closed fence while the directory is still there tells the operator that the
// restore is done while the service refuses every request.
func TestPostgresTheFinishOfAFenceWithoutAnOwnerIsRefused(t *testing.T) {
	_, removals, directory := evidenceFixture(t)
	handle, err := removals.BeginFence("evidence-ownerless-restore", false)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Release()
	if err = handle.Bind(backup.AppliedRemovalLedger{}); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	// The owner marker of the lifecycle is gone, the marker directory is
	// still there. That is the state a crash between the two removals of the
	// close leaves behind.
	if err = os.Remove(filepath.Join(directory, "restore-fence", "owner")); err != nil {
		t.Fatal(err)
	}
	if err = handle.Finish(backup.AppliedRemovalLedger{}); err == nil {
		t.Fatal("the close of a fence without an owner marker reported success")
	}
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !fenced {
		t.Fatal("the marker directory without an owner marker is not an open fence")
	}
}

// TestPostgresTheBlockingGateOfALongRestoreIdentifierIsRecorded covers the
// name of the gate that a recovery records for a database that lost a
// removal.
//
// The name of the gate is derived from the restore identifier, and it has to
// stay inside the length the table allows. A restore identifier of the maximum
// length must not turn the name of the blocking gate into the name of the gate
// of the restore itself, because the insert of the blocking gate would then
// conflict with the row of the restore and the ledger the recovery owed would
// never be recorded.
func TestPostgresTheBlockingGateOfALongRestoreIdentifierIsRecorded(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	long := ""
	for len(long) < 128 {
		long += "restore"
	}
	long = long[:128]
	// The restore recorded its own gate, which is pending.
	if _, err := removals.RecordRestore(ctx, long); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	owed := backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{{
		RemovalID: "rm_evidence_long", SubjectKind: "account", SubjectID: privacy.SubjectReference("user_a"), MatchID: "evidence-long-match", Scope: "explicit_removal", RemovedAt: time.Now().UTC(),
	}}}
	handle, err := removals.BeginFence(long, false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(owed); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if err = removals.RecoverRestore(ctx, long, owed); !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery returned %v, want ErrLedgerNotApplied", err)
	}
	// The gate that records the owed ledger is there, and it is a gate of its
	// own: the name of the restore is not its name.
	var rows int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("the database holds %d restore gates, want the gate of the restore and the blocking gate", rows)
	}
	// The blocking gate waits for the removal ledger it names, and the
	// database does not hold that removal, so the gate is retained.
	if err = removals.ReleaseRestoreGate(ctx, "evidence-long-other"); err != nil {
		t.Logf("the release of the gates reported: %v", err)
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the database holds %d pending gates, want the one of the lost removal", pending)
	}
	// The service stays closed, because the blocking gate waits.
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic while the blocking gate waits")
	}
}

// errHostDoesNotRefuseRemoval reports that the host does not refuse the
// removal of an evidence record, so a regression that needs the refusal
// cannot prove anything here.
var errHostDoesNotRefuseRemoval = errors.New("the host does not refuse the removal of the evidence")

// TestPostgresTheCloseKeepsTheOwnershipWhileTheEvidenceIsDischarged covers
// the order of the close of the fence.
//
// The close discharges the durable evidence of the removals the database holds
// and then removes the marker of the lifecycle. The discharge runs while the
// ownership of the lifecycle is still held: a restore that takes the
// lifecycle after the close binds its own evidence, and the discharge of the
// close must not delete it.
//
// The regression makes the removal of the evidence fail, so the order of the
// close is observable: the close that cannot discharge the evidence keeps the
// marker of the lifecycle and the ownership of it, so the service stays closed
// and another restore is refused.
func TestPostgresTheCloseKeepsTheOwnershipWhileTheEvidenceIsDischarged(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	// A real removal, so the applied ledger of the close holds the removals
	// the durable evidence names.
	matchID := "evidence-close-match"
	historyService := historyServiceFor(t, fixture)
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// A restore that did not finish left its evidence behind. The close of the
	// next restore discharges it, because the database holds the removals it
	// names.
	crashed, err := removals.BeginFence("evidence-close-crashed", false)
	if err != nil {
		t.Fatalf("open the fence of the crashed restore: %v", err)
	}
	if err = crashed.Bind(live); err != nil {
		t.Fatalf("bind the fence of the crashed restore: %v", err)
	}
	crashed.Release()
	handle, err := removals.BeginFence("evidence-close-order", true)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	defer handle.Release()
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	// The close of the next restore cannot discharge that evidence. The
	// refusal is arranged after the bind of this restore, because the bind
	// writes its own evidence into the same directory and has to succeed:
	// the close is what has to fail, not the bind.
	evidenceDirectory := filepath.Join(directory, "restore-requirements")
	if _, err = evidenceHoldRemoval(t, evidenceDirectory, "evidence-close-crashed.json"); err != nil {
		t.Skipf("the removal of the evidence cannot be refused on this host: %v", err)
	}
	if err = handle.Finish(live); err == nil {
		t.Fatal("the close reported success although the evidence could not be discharged")
	}
	// The marker of the lifecycle is still there, so the service stays closed.
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !fenced {
		t.Fatal("the close removed the marker of the lifecycle although the evidence was not discharged")
	}
	// The ownership of the lifecycle is still held, so another restore cannot
	// bind its own evidence in the middle of the close.
	if _, err = removals.BeginFence("evidence-close-other", true); !errors.Is(err, privacy.ErrFenceLive) {
		t.Fatalf("the ownership of the lifecycle was released before the evidence was discharged: %v", err)
	}
}

// TestPostgresTheGateOfAMissingEvidenceIsRetained covers a gate whose durable
// evidence is gone.
//
// The gate names the removal ledger it waits for, and that ledger has durable
// evidence. A gate whose evidence is missing waits for removals that are
// still owed, so it is retained and the service stays closed: the release of
// a gate may never open the service for a database whose removal ledger rows
// are gone.
func TestPostgresTheGateOfAMissingEvidenceIsRetained(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	handle, err := removals.BeginFence("evidence-missing-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	defer handle.Release()
	required := backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{{
		RemovalID: "rm_evidence_missing", SubjectKind: "account", SubjectID: privacy.SubjectReference("user_a"), MatchID: "evidence-missing-match", Scope: "explicit_removal", RemovedAt: time.Now().UTC(),
	}}}
	if err = handle.Bind(required); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	if _, err = removals.RecordRestore(ctx, "evidence-missing-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The durable evidence of the restore is gone.
	evidenceFile := filepath.Join(directory, "restore-requirements", "evidence-missing-restore.json")
	if err = os.Remove(evidenceFile); err != nil {
		t.Fatalf("remove the durable evidence: %v", err)
	}
	// The release of the gate is refused: the database does not hold the
	// removal ledger the gate waits for, and the evidence that says what it
	// waits for is gone.
	if err = removals.ReleaseRestoreGate(ctx, "evidence-missing-restore"); err == nil {
		t.Fatal("the release of a gate whose evidence is missing was accepted")
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the database holds %d pending gates, want the one of the restore", pending)
	}
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic while a gate without evidence waits")
	}
}

// TestPostgresTheEvidenceOfTheNextRestoreSurvivesTheClose covers the close of
// a fence and the restore that follows it.
//
// The close of a fence discharges the evidence that the database holds. The
// restore that follows binds its own evidence, and the close of the previous
// restore must not delete it: the removals of that restore would be lost
// with it, and the recovery of its crash could not name them.
func TestPostgresTheEvidenceOfTheNextRestoreSurvivesTheClose(t *testing.T) {
	for attempt := 0; attempt < 10; attempt++ {
		fixture, removals, directory := evidenceFixture(t)
		ctx := context.Background()
		// The removal that the live database holds, so the applied ledger of
		// the close holds the evidence of the next restore.
		matchID := "evidence-survive-match"
		historyService := historyServiceFor(t, fixture)
		privacyCompletedMatch(t, fixture, historyService, matchID)
		if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
			t.Fatalf("remove the opponent: %v", err)
		}
		live, err := removals.AppliedRemovalLedger(ctx)
		if err != nil {
			t.Fatal(err)
		}
		// The first restore binds the evidence of the removals it has to
		// apply and closes its fence.
		first, err := removals.BeginFence("evidence-survive-first", false)
		if err != nil {
			t.Fatalf("open the fence of the first restore: %v", err)
		}
		if err = first.Bind(live); err != nil {
			t.Fatalf("bind the fence of the first restore: %v", err)
		}
		// The second restore binds its own evidence while the first one
		// closes. The lifecycle allows one restore at a time, so the second one
		// waits for the first one to release the ownership.
		bound := make(chan string, 1)
		go func() {
			for attempt := 0; attempt < 200; attempt++ {
				second, err := removals.BeginFence("evidence-survive-second", true)
				if err != nil {
					time.Sleep(2 * time.Millisecond)
					continue
				}
				if err = second.Bind(live); err != nil {
					bound <- ""
					return
				}
				bound <- "evidence-survive-second"
				second.Release()
				return
			}
			bound <- ""
		}()
		if err = first.Finish(live); err != nil {
			t.Fatalf("the close of the first restore failed: %v", err)
		}
		name := <-bound
		if name == "" {
			continue
		}
		// The evidence of the second restore is there.
		evidenceFile := filepath.Join(directory, "restore-requirements", name+".json")
		if _, err = os.Stat(evidenceFile); err != nil {
			t.Fatalf("the durable evidence of the second restore is gone: %v", err)
		}
		return
	}
	t.Fatal("the second restore never took the lifecycle")
}

// TestPostgresTheRestoreWithoutARemovalSinkIsRefusedWhileRemovalsAreOwed
// covers a restore that has a fence and no removal ledger sink.
//
// The removals that the restores which did not finish still owe are destroyed
// by the import of a restore, and their durable evidence lives with the
// fence. A restore without the sink cannot replay them, so it is refused
// before the import: the database is not touched and the evidence stays
// pending.
func TestPostgresTheRestoreWithoutARemovalSinkIsRefusedWhileRemovalsAreOwed(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-sink-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	// The restore crashes during its import: the evidence of the removals it
	// owed stays pending.
	if _, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, fail: true},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-sink-crashed",
	}); err == nil {
		t.Fatal("the crashing restore reported success")
	}
	pending, err := removals.PendingRemovalRequirements(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending.Matches) != 1 {
		t.Fatalf("the pending evidence holds %d removals", len(pending.Matches))
	}
	// The restore without the removal sink is refused, and the import never
	// runs.
	imports := 0
	_, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-sink-refused",
		Takeover:       true,
	})
	if err == nil {
		t.Fatal("a restore without a removal ledger sink was accepted while removals were owed")
	}
	if imports != 0 {
		t.Fatalf("the refused restore imported %d times", imports)
	}
	// The evidence is still pending: the refusal did not discharge it.
	pending, err = removals.PendingRemovalRequirements(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending.Matches) != 1 {
		t.Fatalf("the pending evidence holds %d removals after the refusal", len(pending.Matches))
	}
	// The control: the same restore with the removal sink replays the owed
	// removals, and the evidence of the crashed restore is discharged. The
	// evidence of the closing restore is kept on purpose: the next restore
	// discharges it.
	result, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-sink-control",
		Takeover:       true,
	})
	if err != nil {
		t.Fatalf("the restore with the removal sink failed: %v", err)
	}
	if result.RemovalsApplied != 1 {
		t.Fatalf("the restore with the removal sink replayed %d removals", result.RemovalsApplied)
	}
	if _, err = os.Stat(filepath.Join(directory, "restore-requirements", "evidence-sink-crashed.json")); err == nil {
		t.Fatal("the evidence of the crashed restore was not discharged")
	}
}

// TestPostgresTheGateOfAMissingEvidenceIsReleasedByAProof covers the
// supported recovery of a gate whose durable evidence is gone.
//
// The gate names the digest of the removal ledger it waits for, and that
// digest is one way: the only proof of the commitment is a removal ledger
// whose own digest is exactly the one the gate names. A supplied ledger that
// proves the commitment releases the gate when the database holds it, and a
// supplied ledger that proves nothing leaves the gate closed.
func TestPostgresTheGateOfAMissingEvidenceIsReleasedByTheRecovery(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-proof-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The restore bound the removal ledger it had to apply and recorded its
	// gate. The removal is applied in the database, so the gate waits for a
	// ledger the database holds.
	handle, err := removals.BeginFence("evidence-proof-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-proof-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The durable evidence of the restore is lost.
	if err = os.Remove(filepath.Join(directory, "restore-requirements", "evidence-proof-restore.json")); err != nil {
		t.Fatalf("remove the durable evidence: %v", err)
	}
	// The release of the gate needs the evidence, so it is refused: the gate
	// waits and the removals it waits for stay owed.
	if err = removals.ReleaseRestoreGate(ctx, "evidence-proof-restore"); err == nil {
		t.Fatal("the release of a gate whose evidence is missing was accepted")
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the database holds %d pending gates, want the one of the restore", pending)
	}
	// A supplied ledger that is not the ledger the gate waits for proves
	// nothing: the recovery refuses it and releases nothing.
	other := live
	other.Matches = append(append([]backup.RemovalRecord{}, live.Matches...), backup.RemovalRecord{
		RemovalID: "rm_evidence_proof_other", SubjectKind: "account", SubjectID: privacy.SubjectReference("user_a"), MatchID: "evidence-proof-other-match", Scope: "explicit_removal", RemovedAt: time.Now().UTC(),
	})
	if err = removals.RecoverRestore(ctx, "evidence-proof-restore", other); err == nil {
		t.Fatal("the recovery accepted a ledger that is not the one the restore owed")
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the refused recovery released %d gates", 1-pending)
	}
	// The supported recovery: the operator supplies the removal ledger the
	// gate waits for, its digest is exactly the one the gate names, and the
	// database holds it, so the recovery releases the gate and closes the
	// fence of the crashed restore.
	if err = removals.RecoverRestore(ctx, "evidence-proof-restore", live); err != nil {
		t.Fatalf("the recovery with the supplied ledger failed: %v", err)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("the database holds %d pending gates after the recovery", pending)
	}
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the service does not serve after the recovery released the gate")
	}
}

// evidenceDigest renders the digest of a removal ledger the way the marker of
// the fence and the durable evidence store it.
func evidenceDigest(ledger backup.AppliedRemovalLedger) string {
	return hexDigest(backup.RemovalLedgerDigest(ledger.Matches, ledger.Subjects))
}

// hexDigest renders a digest as hexadecimal.
func hexDigest(raw []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(raw)*2)
	for _, value := range raw {
		out = append(out, digits[value>>4], digits[value&0x0f])
	}
	return string(out)
}
