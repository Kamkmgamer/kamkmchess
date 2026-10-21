package integration

// The recovery of a crashed restore, the release of the gates it proves and
// the truth the operator is told.
//
// The regressions below cover the findings of the privacy review round 14:
// the release of a gate with a proof has to run under the ownership of the
// lifecycle and inside the recovery, the release has to be based on facts
// that cannot change while it runs, the release has to require the same
// global erasure the ordinary release requires, and the evidence an operator
// hands to the recovery has to be validated like every other evidence.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPostgresTheRecoveryOfALiveRestoreReleasesNothing covers the ownership
// of the lifecycle.
//
// The recovery may only act when no restore is alive: the operating system
// lock of the lifecycle is the live ownership proof. A recovery that acts
// anyway releases a gate for ever, because a released gate is never taken
// back.
func TestPostgresTheRecoveryOfALiveRestoreReleasesNothing(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-live-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The restore of the operator is alive: it holds the fence.
	alive, err := removals.BeginFence("evidence-live-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	defer alive.Release()
	if err = alive.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	if _, err = removals.RecordRestore(ctx, "evidence-live-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The recovery of a live restore is refused, and it releases nothing.
	if err = removals.RecoverRestore(ctx, "evidence-live-restore", live); !errors.Is(err, privacy.ErrFenceLive) {
		t.Fatalf("the recovery of a live restore returned %v, want ErrFenceLive", err)
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the recovery of a live restore released %d gates", 1-pending)
	}
}

// TestPostgresTheRecoveryOfAnotherRestoreReleasesNothing covers the identity
// of the recovery.
//
// The fence of another restore is never touched, and a recovery that names
// another restore releases nothing.
func TestPostgresTheRecoveryOfAnotherRestoreReleasesNothing(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-other-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence("evidence-other-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-other-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The recovery of another restore is refused, and it releases nothing.
	if err = removals.RecoverRestore(ctx, "evidence-someone-else", live); !errors.Is(err, privacy.ErrFenceConflict) {
		t.Fatalf("the recovery of another restore returned %v, want ErrFenceConflict", err)
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the recovery of another restore released %d gates", 1-pending)
	}
}

// TestPostgresTheRecoveryReleasesNothingWhileTheErasureIsMissing covers the
// global check of the release.
//
// The rows of the removal ledger are not the erasure of a removal: a seat
// that still names the removed subject, or a replay that is published again,
// keeps the service closed. The release of a gate needs the same global check
// as the ordinary release, so the recovery releases nothing while the
// erasure is missing.
func TestPostgresTheRecoveryReleasesNothingWhileTheErasureIsMissing(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-erasure-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	// The removal is recorded in the ledger, but the seat of the removed
	// subject still names it: the state of a database that carries the record
	// of the removal and not the erasure of it.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,live_delete_due_at,recovery_sanitize_due_at)
		VALUES('rm_evidence_erasure','account',$1,'explicit_removal','verified',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp()+interval '30 days')`,
		privacy.SubjectReference("user_b")); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_removal_ledger(ledger_id,removal_id,subject_kind,subject_id,match_id,scope,removed_at)
		VALUES('rl_evidence_erasure','rm_evidence_erasure','account',$1,$2,'explicit_removal',clock_timestamp())`,
		privacy.SubjectReference("user_b"), matchID); err != nil {
		t.Fatal(err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence("evidence-erasure-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-erasure-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}

	// The ordinary release refuses, and so does the recovery.
	if err = removals.ReleaseRestoreGate(ctx, "evidence-erasure-restore"); !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the ordinary release returned %v, want ErrLedgerNotApplied", err)
	}
	if err = removals.RecoverRestore(ctx, "evidence-erasure-restore", live); !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery returned %v, want ErrLedgerNotApplied", err)
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the recovery released %d gates although the erasure is missing", 1-pending)
	}
	// The service stays closed.
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic although the erasure is missing")
	}
}

// TestPostgresTheRecoveryReleasesNothingOnStaleContainmentFacts covers the
// facts of the release.
//
// The release of a gate is final, so it may not be based on facts that change
// while it runs. The recovery reads the removal ledger and the state of the
// erasures inside the transaction of the release, so an import that replaces
// the rows of the removal ledger waits for it instead of invalidating the
// facts between the read and the write.
func TestPostgresTheRecoveryReleasesNothingOnStaleContainmentFacts(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-stale-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence("evidence-stale-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-stale-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// A transaction holds the row of the gate, so the release of the recovery
	// waits for it.
	blocking, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = blocking.Exec(ctx, `SELECT restore_id FROM online_restore_gates WHERE restore_id='evidence-stale-restore' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	recovered := make(chan error, 1)
	go func() {
		recovered <- removals.RecoverRestore(ctx, "evidence-stale-restore", live)
	}()
	// The recovery reads the removal ledger and waits for the row of the
	// gate, so it holds the ledger of the database while it runs.
	time.Sleep(time.Second)
	// The import that replaces the removal ledger waits for the recovery: the
	// facts of the release cannot change while it runs.
	imported := make(chan error, 1)
	go func() {
		_, importErr := fixture.pool.Exec(ctx, `SET lock_timeout='2s'`)
		if importErr == nil {
			_, importErr = fixture.pool.Exec(ctx, `TRUNCATE online_removal_ledger,online_removal_subjects`)
		}
		imported <- importErr
	}()
	select {
	case importErr := <-imported:
		if importErr == nil {
			t.Fatal("the import replaced the removal ledger while the release was running")
		}
		t.Logf("the import was refused while the release was running: %v", importErr)
	case <-time.After(30 * time.Second):
		t.Fatal("the import did not finish")
	}
	// The release finishes on the facts it read.
	if _, err = blocking.Exec(ctx, `SELECT 1`); err != nil {
		t.Fatal(err)
	}
	if err = blocking.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-recovered:
		if err != nil {
			t.Fatalf("the recovery failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the recovery did not finish")
	}
	// The removals are still in the database: the import never replaced them.
	applied, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Matches) != 1 {
		t.Fatalf("the database holds %d match records after the release", len(applied.Matches))
	}
}

// TestPostgresTheSuppliedEvidenceIsValidated covers the evidence an operator
// hands to a recovery.
//
// The evidence is a file from outside the system, so it is validated like
// every other evidence: the identifier of the restore has to be a name and
// not a path, the records have to be the shape the merge accepts, and the
// content has to hash to the digest the record names.
func TestPostgresTheSuppliedEvidenceIsValidated(t *testing.T) {
	directory := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	// A record whose identifier is a path is refused.
	if _, err := privacy.ReadRemovalRequirement(write("path.json", `{"restoreId":"../../etc/passwd","digest":"00","matches":[],"subjects":[]}`)); err == nil {
		t.Fatal("the reader accepted an identifier that is not a name")
	}
	// A record whose records are malformed is refused.
	if _, err := privacy.ReadRemovalRequirement(write("malformed.json", `{"restoreId":"restore-evidence","digest":"00","matches":[{"removalId":"rm_one","subjectKind":"account","subjectId":"ref-one","matchId":"match-one","scope":"not-a-scope","removedAt":"2026-10-20T09:00:00Z"}],"subjects":[]}`)); err == nil {
		t.Fatal("the reader accepted a malformed record")
	}
	// A record whose content does not hash to its digest is refused.
	if _, err := privacy.ReadRemovalRequirement(write("altered.json", `{"restoreId":"restore-evidence","digest":"0000000000000000000000000000000000000000000000000000000000000000","matches":[],"subjects":[]}`)); err == nil {
		t.Fatal("the reader accepted a record that does not match its digest")
	}
	// A record of the older format is still readable: the format of the
	// evidence did not change.
	record := backup.SubjectRemovalRecord{RecordID: "rs_one", SubjectKind: "account", SubjectRef: "ref-one", Scope: "explicit_removal", RemovedAt: time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)}
	digest := backup.RemovalLedgerDigest(nil, []backup.SubjectRemovalRecord{record})
	content := `{"restoreId":"restore-evidence","digest":"` + hexOf(digest) + `","matches":[],"subjects":[{"recordId":"rs_one","subjectKind":"account","subjectRef":"ref-one","scope":"explicit_removal","removedAt":"2026-10-20T09:00:00Z"}]}`
	read, err := privacy.ReadRemovalRequirement(write("good.json", content))
	if err != nil {
		t.Fatalf("the reader refused a valid record: %v", err)
	}
	if read.RestoreID != "restore-evidence" || len(read.Subjects) != 1 {
		t.Fatalf("the record that was read = %+v", read)
	}
}

// hexOf renders a digest as hexadecimal.
func hexOf(raw []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(raw)*2)
	for _, value := range raw {
		out = append(out, digits[value>>4], digits[value&0x0f])
	}
	return string(out)
}

// TestPostgresTheRestoreWithoutASinkIsRefusedAfterASuccessfulRestore covers
// the obligation of a durable evidence record.
//
// The close of a restore keeps the evidence of the restore that holds the
// fence, and that evidence is an obligation for the **next** import: the
// import of a restore replaces the schema of the database, so the removals
// that the evidence names are gone afterwards, and the restore that comes
// next has to replay them. A restore that has a fence and no removal ledger
// sink cannot replay them, so it is refused while such an evidence record
// exists.
//
// The refusal is therefore not decided by what the database holds now: the
// database holds the removals of the last restore until the next import
// destroys them, and accepting the restore without the sink would let the
// import destroy them without a replay.
func TestPostgresTheRestoreWithoutASinkIsRefusedAfterASuccessfulRestore(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-obligation-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	// A restore with the removal sink applies the removal and keeps its
	// evidence.
	if _, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-obligation-restore",
	}); err != nil {
		t.Fatalf("the restore with the removal sink failed: %v", err)
	}
	// The evidence of the restore is pending: it is the obligation of the
	// next import.
	pending, err := removals.PendingRemovalRequirements(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending.Matches) != 1 {
		t.Fatalf("the pending evidence holds %d removals", len(pending.Matches))
	}
	// The restore without the removal sink is refused, and the import never
	// runs: the import would destroy the removals that the evidence names.
	imports := 0
	if _, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-obligation-refused",
		Takeover:       true,
	}); err == nil {
		t.Fatal("a restore without a removal ledger sink was accepted while an evidence record is pending")
	}
	if imports != 0 {
		t.Fatalf("the refused restore imported %d times", imports)
	}
	// The database still holds the removal: the refused import never ran.
	applied, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Matches) != 1 {
		t.Fatalf("the database holds %d match records after the refused restore", len(applied.Matches))
	}
	// The control: the same restore **with** the removal ledger sink is
	// accepted, because the sink replays the removals that the evidence
	// names. The refusal is about the restore that cannot replay them.
	if _, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-obligation-with-sink",
	}); err != nil {
		t.Fatalf("the restore with the removal ledger sink was refused: %v", err)
	}
}

// unused keeps the pool import honest when the file is edited.
var _ = (*pgxpool.Pool)(nil)

// TestPostgresTheProofReleaseRefusesALiveRestore covers the ownership of the
// public proof release.
//
// The release of a gate with a proof is a supported path of its own, so it
// takes the ownership of the lifecycle: it refuses to act while a restore is
// alive, and it releases nothing then.
func TestPostgresTheProofReleaseRefusesALiveRestore(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-proof-live-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence("evidence-proof-live-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	defer handle.Release()
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	if _, err = removals.RecordRestore(ctx, "evidence-proof-live-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The proof release refuses while the restore is alive, and it releases
	// nothing.
	if _, err = removals.ReleaseRestoreGateWithProof(ctx, live); !errors.Is(err, privacy.ErrFenceLive) {
		t.Fatalf("the proof release of a live restore returned %v, want ErrFenceLive", err)
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the proof release of a live restore released %d gates", 1-pending)
	}
}
