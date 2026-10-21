package integration

// The lifecycle of a restore around the import, and the recovery of a
// crashed restore.
//
// The regressions below cover the findings of the privacy review round 15: a
// restore that is refused before its import keeps the serving state of the
// service, the recovery makes the obligation of the next import durable before
// it releases the gate that proves it, the public proof release is bound to the
// restore that the marker names, and the evidence an operator hands to the
// recovery is always validated.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// TestPostgresTheRefusedRestoreKeepsTheServingState covers a restore that is
// refused before its import.
//
// The refusal happens after the restore took the lifecycle, because the fence
// owns the durable evidence of the removals and only the fence can say
// whether any are owed. A restore that is refused has changed nothing, so the
// marker of the lifecycle that this attempt created is removed and the
// service keeps the state it had.
func TestPostgresTheRefusedRestoreKeepsTheServingState(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-refused-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	// A restore that applied a removal leaves its evidence behind: the
	// obligation of the next import.
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	if _, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-refused-applied",
	}); err != nil {
		t.Fatalf("the restore with the removal sink failed: %v", err)
	}
	// The service serves before the refused restore.
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the service does not serve before the refused restore")
	}
	// The restore without the removal ledger sink is refused: it cannot
	// replay the removals that are owed.
	imports := 0
	if _, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-refused-restore",
	}); err == nil {
		t.Fatal("a restore without a removal ledger sink was accepted while removals were owed")
	}
	if imports != 0 {
		t.Fatalf("the refused restore imported %d times", imports)
	}
	// The marker of the lifecycle is gone, so the service serves again: the
	// refused restore changed nothing.
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if fenced {
		t.Fatal("the refused restore left the marker of the lifecycle behind")
	}
	allowed, err = removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the service does not serve after a restore that was refused before its import")
	}
	// The obligation of the next import is retained.
	pending, err := removals.PendingRemovalRequirements(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending.Matches) != 1 {
		t.Fatalf("the pending evidence holds %d removals after the refusal", len(pending.Matches))
	}
}

// TestPostgresTheRefusedTakeOverKeepsTheMarkerOfTheCrashedRestore covers a
// take-over that is refused before its import.
//
// The marker of a crashed restore is the history of that restore. A take-over
// that is refused has changed nothing, but the marker stays: the operator
// resolves the crashed restore.
func TestPostgresTheRefusedTakeOverKeepsTheMarkerOfTheCrashedRestore(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-takeover-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	// The restore crashes: the marker of the crashed restore stays.
	if _, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, fail: true},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-takeover-crashed",
	}); err == nil {
		t.Fatal("the crashing restore reported success")
	}
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !fenced {
		t.Fatal("the marker of the crashed restore is gone")
	}
	// The take-over without the removal ledger sink is refused, and the marker
	// of the crashed restore stays.
	imports := 0
	if _, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-takeover-refused",
		Takeover:       true,
	}); err == nil {
		t.Fatal("a take-over without a removal ledger sink was accepted while removals were owed")
	}
	if imports != 0 {
		t.Fatalf("the refused take-over imported %d times", imports)
	}
	fenced, err = removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !fenced {
		t.Fatal("the refused take-over removed the marker of the crashed restore")
	}
}

// TestPostgresTheFailedImportKeepsTheFenceClosed covers a restore whose
// import fails.
//
// The import may have changed the database, so the marker of the lifecycle
// stays and the service stays closed until the restore is resolved.
func TestPostgresTheFailedImportKeepsTheFenceClosed(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	if _, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, fail: true},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-failed-import",
	}); err == nil {
		t.Fatal("the restore with the failed import reported success")
	}
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !fenced {
		t.Fatal("the failed import left the service serving")
	}
}

// TestPostgresTheRecoveryMakesTheObligationDurableBeforeTheRelease covers the
// order of the recovery.
//
// The release of a gate is final, so the durable proof that the removals were
// owed has to be on the disk before the release. A recovery whose write of the
// evidence fails leaves the gate pending and the marker of the lifecycle in
// place: the service stays closed and the obligation survives.
func TestPostgresTheRecoveryMakesTheObligationDurableBeforeTheRelease(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-durable-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence("evidence-durable-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-durable-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The write of the evidence fails, and the record that is there stays
	// readable: the obligation it carries survives the failure.
	evidenceDirectory := filepath.Join(directory, "restore-requirements")
	if _, err = evidenceBlockWrite(t, evidenceDirectory, "evidence-durable-restore.json"); err != nil {
		t.Skipf("the write of the evidence cannot be refused on this host: %v", err)
	}
	// The recovery fails, and it released nothing.
	if err = removals.RecoverRestore(ctx, "evidence-durable-restore", live); err == nil {
		t.Fatal("the recovery reported success although the evidence could not be written")
	}
	var serving bool
	if err = fixture.pool.QueryRow(ctx, `SELECT serving_allowed FROM online_restore_gates WHERE restore_id='evidence-durable-restore'`).Scan(&serving); err != nil {
		t.Fatal(err)
	}
	if serving {
		t.Fatal("the gate of the restore was released although the evidence could not be written")
	}
	// The marker of the lifecycle is still there, so the service is closed.
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !fenced {
		t.Fatal("the failed recovery removed the marker of the lifecycle")
	}
	// The next restore without the removal ledger sink does not import
	// anything: the obligation of the next import is still there.
	imports := 0
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	if _, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-durable-next",
		Takeover:       true,
	}); err == nil {
		t.Fatal("a restore without a removal ledger sink was accepted although the obligation survived")
	}
	if imports != 0 {
		t.Fatalf("the refused restore imported %d times", imports)
	}
}

// TestPostgresThePublicProofReleaseIsBoundToTheRestore covers the public
// proof release.
//
// The release is not a protocol of its own: it is the recovery of the restore
// that the marker of the lifecycle names, with the candidate as its ledger. A
// candidate that is not the ledger the marker names proves nothing, and a
// marker that is not there is nothing to recover.
func TestPostgresThePublicProofReleaseIsBoundToTheRestore(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-bound-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// There is no marker of the lifecycle: there is nothing to recover.
	if _, err = removals.ReleaseRestoreGateWithProof(ctx, live); err == nil {
		t.Fatal("the proof release accepted a restore that has no marker")
	}
	handle, err := removals.BeginFence("evidence-bound-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-bound-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// A candidate that is not the ledger the marker names proves nothing.
	other := live
	other.Matches = append(append([]backup.RemovalRecord{}, live.Matches...), backup.RemovalRecord{
		RemovalID: "rm_evidence_bound_other", SubjectKind: "account", SubjectID: privacy.SubjectReference("user_a"), MatchID: "evidence-bound-other-match", Scope: "explicit_removal", RemovedAt: time.Now().UTC(),
	})
	if _, err = removals.ReleaseRestoreGateWithProof(ctx, other); err == nil {
		t.Fatal("the proof release accepted a ledger that the marker does not name")
	}
	var pending int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed=false`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("the refused proof release released %d gates", 1-pending)
	}
	// The candidate that is the ledger the marker names recovers the restore.
	released, err := removals.ReleaseRestoreGateWithProof(ctx, live)
	if err != nil {
		t.Fatalf("the proof release failed: %v", err)
	}
	if released < 1 {
		t.Fatalf("the proof release reported %d released gates", released)
	}
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if fenced {
		t.Fatal("the proof release left the marker of the lifecycle behind")
	}
}

// TestPostgresTheRecoverCommandRefusesAConflictingEvidence covers the evidence
// an operator hands to the recovery.
//
// The file is always opened and validated: a file that names another restore
// or that conflicts with the record of the evidence directory is refused
// instead of being ignored.
func TestPostgresTheRecoverCommandRefusesAConflictingEvidence(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-cli-conflict-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence("evidence-cli-conflict", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-cli-conflict"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The evidence of another restore: the recovery refuses it.
	foreign := privacy.RemovalRequirement{
		RestoreID: "evidence-cli-other",
		Digest:    hexOf(backup.RemovalLedgerDigest(live.Matches, live.Subjects)),
		Matches:   live.Matches,
		Subjects:  live.Subjects,
	}
	foreignFile := filepath.Join(t.TempDir(), "foreign.json")
	raw, err := json.Marshal(foreign)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(foreignFile, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	binary := evidenceCLI(t)
	dsn := evidenceDSN(t, fixture)
	output, err := evidenceRunCLI(t, binary, dsn,
		"recover",
		"--evidence", foreignFile,
		"--restore-id", "evidence-cli-conflict",
		"--fence", directory,
		"--database-url-env", "EVIDENCE_CLI_DATABASE_URL",
		"--passphrase-env", "EVIDENCE_CLI_PASSPHRASE",
	)
	if err == nil {
		t.Fatalf("the recovery accepted the evidence of another restore: %s", output)
	}
	if !strings.Contains(output, "evidence-cli-other") {
		t.Fatalf("the refusal of the recovery does not name the restore of the evidence: %q", output)
	}
	// The gate of the restore is untouched and the marker of the lifecycle is
	// still there.
	var serving bool
	if err = fixture.pool.QueryRow(ctx, `SELECT serving_allowed FROM online_restore_gates WHERE restore_id='evidence-cli-conflict'`).Scan(&serving); err != nil {
		t.Fatal(err)
	}
	if serving {
		t.Fatal("the refused recovery released the gate of the restore")
	}
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !fenced {
		t.Fatal("the refused recovery removed the marker of the lifecycle")
	}
	// A file that does not match its own digest is refused as well.
	altered := filepath.Join(t.TempDir(), "altered.json")
	if err = os.WriteFile(altered, []byte(`{"restoreId":"evidence-cli-conflict","digest":"0000000000000000000000000000000000000000000000000000000000000000","matches":[],"subjects":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err = evidenceRunCLI(t, binary, dsn,
		"recover",
		"--evidence", altered,
		"--restore-id", "evidence-cli-conflict",
		"--fence", directory,
		"--database-url-env", "EVIDENCE_CLI_DATABASE_URL",
		"--passphrase-env", "EVIDENCE_CLI_PASSPHRASE",
	)
	if err == nil {
		t.Fatalf("the recovery accepted an evidence file that does not match its digest: %s", output)
	}
}

// TestPostgresTheRestoreWithoutASinkRunsWithoutAnObligation covers the
// tooling of the private single-owner backup.
//
// A restore that has a fence and no removal ledger sink is refused while an
// evidence record of a removal is pending. A database that never carried a
// removal has no such record, so the restore runs: the tooling of the private
// single-owner backup works on a database without online removals.
func TestPostgresTheRestoreWithoutASinkRunsWithoutAnObligation(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	imports := 0
	if _, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-no-obligation",
	}); err != nil {
		t.Fatalf("the restore without a removal ledger sink was refused although no removal is owed: %v", err)
	}
	if imports != 1 {
		t.Fatalf("the restore imported %d times", imports)
	}
	// The fence of the restore is closed and the service serves.
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
		t.Fatal("the service does not serve after a restore without an obligation")
	}
}

// TestPostgresTheRefusedTakeOverKeepsTheCrashedRestoreRecoverable covers the
// history of a crashed restore.
//
// A take-over replaces the owner marker of the lifecycle, and a take-over that
// is refused before its import has to restore it exactly: the recovery of the
// crashed restore has to work with the ledger it owed, and a full restore has
// to be able to proceed afterwards.
func TestPostgresTheRefusedTakeOverKeepsTheCrashedRestoreRecoverable(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-history-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The restore that crashed: it bound the ledger it had to apply and its
	// marker stayed behind.
	crashed, err := removals.BeginFence("evidence-history-crashed", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = crashed.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	crashed.Release()
	marker := filepath.Join(directory, "restore-fence", "owner")
	before, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read the owner marker: %v", err)
	}
	// The take-over is refused before its import: it has no removal ledger
	// sink and removals are owed.
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	imports := 0
	if _, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-history-takeover",
		Takeover:       true,
	}); err == nil {
		t.Fatal("the take-over without a removal ledger sink was accepted while removals were owed")
	}
	if imports != 0 {
		t.Fatalf("the refused take-over imported %d times", imports)
	}
	// The owner marker of the crashed restore is exactly the one it left.
	after, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read the owner marker: %v", err)
	}
	if string(before) != string(after) {
		t.Fatalf("the refused take-over changed the crashed restore: before %s, after %s", before, after)
	}
	// The recovery of the crashed restore still works with the ledger it owed.
	if err = removals.RecoverRestore(ctx, "evidence-history-crashed", live); err != nil {
		t.Fatalf("the recovery of the crashed restore failed: %v", err)
	}
	// A full restore can proceed afterwards.
	if _, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state},
		Tombstones:     evidenceTombstones{},
		Removals:       evidenceLedger{service: removals},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-history-next",
	}); err != nil {
		t.Fatalf("the restore after the recovery failed: %v", err)
	}
}
