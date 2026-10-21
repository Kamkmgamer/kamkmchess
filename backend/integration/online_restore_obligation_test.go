package integration

// The obligation of a durable evidence record, the request of a replayed
// subject removal and the command line tool of the recovery.
//
// The regressions below cover the corrections of the parent source review: the
// recovery keeps the obligation of the next import, the replay of a subject
// removal names the request that is really there, and the recovery of the
// command line tool needs the bundle only when there is no evidence.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
)

// TestPostgresTheRecoveryKeepsTheObligationOfTheNextImport covers the
// evidence of a recovered restore.
//
// The evidence of a restore is an obligation for the **next** import: the
// import of a restore replaces the schema of the database, so the removals the
// record names are gone afterwards and the restore that comes next has to
// replay them. The close of a restore keeps its own evidence for that reason,
// and so does the recovery of a crashed restore: a recovery that discharged
// the last obligation would let a later restore without the removal ledger
// sink import an older bundle and destroy the removals without a replay.
func TestPostgresTheRecoveryKeepsTheObligationOfTheNextImport(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-obligation-recovery-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The restore crashed after it applied the removals: the fence is open and
	// the gate of the restore waits.
	handle, err := removals.BeginFence("evidence-obligation-crashed", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-obligation-crashed"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The recovery of the crashed restore succeeds: the removals are applied.
	if err = removals.RecoverRestore(ctx, "evidence-obligation-crashed", live); err != nil {
		t.Fatalf("the recovery failed: %v", err)
	}
	// The obligation of the next import survives the recovery.
	pending, err := removals.PendingRemovalRequirements(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending.Matches) != 1 {
		t.Fatalf("the pending evidence holds %d removals after the recovery", len(pending.Matches))
	}
	// The restore without the removal ledger sink is refused, and the import
	// never runs: the import would destroy the removals that the evidence
	// names.
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	imports := 0
	if _, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-obligation-next",
	}); err == nil {
		t.Fatal("a restore without a removal ledger sink was accepted after the recovery")
	}
	if imports != 0 {
		t.Fatalf("the refused restore imported %d times", imports)
	}
	// The removals are still in the database: the refused import never ran.
	applied, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Matches) != 1 {
		t.Fatalf("the database holds %d match records after the refused restore", len(applied.Matches))
	}
}

// TestPostgresTheRecoveryRecreatesTheEvidenceOfTheLostDirectory covers the
// recovery that is given the evidence of a restore.
//
// The evidence directory was lost, so the operator restores the evidence of
// the restore from the protected backup and hands it to the recovery. The
// recovery has to preserve it: the obligation of the next import survives the
// recovery even when the directory was lost.
func TestPostgresTheRecoveryRecreatesTheEvidenceOfTheLostDirectory(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-lost-directory-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	state := evidenceCapture(t, fixture.pool, [2]string{matchID, "black"})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence("evidence-lost-directory-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-lost-directory-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The evidence directory was lost.
	evidenceFile := filepath.Join(directory, "restore-requirements", "evidence-lost-directory-restore.json")
	if err = os.Remove(evidenceFile); err != nil {
		t.Fatalf("remove the durable evidence: %v", err)
	}
	// The recovery that is given the ledger of the restore succeeds.
	if err = removals.RecoverRestore(ctx, "evidence-lost-directory-restore", live); err != nil {
		t.Fatalf("the recovery with the supplied ledger failed: %v", err)
	}
	// The evidence is back: the obligation of the next import survived.
	if _, err = os.Stat(evidenceFile); err != nil {
		t.Fatalf("the durable evidence of the recovered restore is gone: %v", err)
	}
	pending, err := removals.PendingRemovalRequirements(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending.Matches) != 1 {
		t.Fatalf("the pending evidence holds %d removals after the recovery", len(pending.Matches))
	}
	// And the restore without the removal ledger sink is refused.
	imports := 0
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	if _, err = backup.Restore(ctx, backup.RestoreRequest{
		Path:           bundle,
		Passphrase:     []byte("evidence-passphrase-0001"),
		Restorer:       evidenceRestorer{pool: fixture.pool, state: state, imports: &imports},
		Tombstones:     evidenceTombstones{},
		AdmissionFence: evidenceLedger{service: removals},
		RestoreID:      "evidence-lost-directory-next",
	}); err == nil {
		t.Fatal("a restore without a removal ledger sink was accepted after the recovery")
	}
	if imports != 0 {
		t.Fatalf("the refused restore imported %d times", imports)
	}
}

// TestPostgresTheSubjectReplayNamesTheRequestThatIsThere covers the request
// of a replayed subject removal.
//
// The replay of a subject removal looks the request of the subject up and
// creates one when the database has none. A concurrent writer can win that
// request between the lookup and the insert, and then the identifier the
// replay generated is the identifier of no request at all: the subject row may
// never name a request that is not there.
//
// The regression makes the concurrent writer win deterministically: a trigger
// takes the tuple of the subject and cancels the insert of the replay.
func TestPostgresTheSubjectReplayNamesTheRequestThatIsThere(t *testing.T) {
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
	subjects, err := removals.ListSubjectRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjects) != 1 {
		t.Fatalf("the subject ledger holds %d records", len(subjects))
	}
	// The import of a bundle replaced the schema: the request of the subject
	// is gone and the replay has to create one.
	if _, err = fixture.pool.Exec(ctx, `TRUNCATE online_removal_ledger,online_removal_subjects,online_removal_requests,online_account_deletions CASCADE`); err != nil {
		t.Fatal(err)
	}
	// The concurrent writer that wins the tuple of the subject.
	if _, err = fixture.pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION evidence_rival_request() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.removal_id = 'rm_rival_evidence' THEN
				RETURN NEW;
			END IF;
			INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,applied_at,live_delete_due_at,live_deleted_at,recovery_sanitize_due_at,recovery_sanitized_at,removed_match_count,anonymized_match_count)
			VALUES('rm_rival_evidence', NEW.subject_kind, NEW.subject_id, NEW.scope, NEW.status, NEW.requested_at, NEW.verified_at, NEW.applied_at, NEW.live_delete_due_at, NEW.live_deleted_at, NEW.recovery_sanitize_due_at, NEW.recovery_sanitized_at, NEW.removed_match_count, NEW.anonymized_match_count)
			ON CONFLICT (subject_kind, subject_id, scope) DO NOTHING;
			RETURN NULL;
		END
		$$;
		DROP TRIGGER IF EXISTS evidence_rival_request_trigger ON online_removal_requests;
		CREATE TRIGGER evidence_rival_request_trigger BEFORE INSERT ON online_removal_requests
		FOR EACH ROW EXECUTE FUNCTION evidence_rival_request();`); err != nil {
		t.Fatal(err)
	}
	// The replay of the subject record succeeds, and the subject row names
	// the request that is really there.
	if err = removals.ApplySubjectRemovalRecords(ctx, subjects); err != nil {
		t.Fatalf("the replay of the subject record failed: %v", err)
	}
	var removalID string
	if err = fixture.pool.QueryRow(ctx, `SELECT removal_id FROM online_removal_subjects WHERE subject_id=$1`, subjects[0].RecordID).Scan(&removalID); err != nil {
		t.Fatal(err)
	}
	if removalID != "rm_rival_evidence" {
		t.Fatalf("the subject record names the request %q, want the one that is there", removalID)
	}
	// The request of the subject is the one of the concurrent writer, and the
	// identifier the replay generated is not in the table.
	var requests int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_removal_requests`).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("the request table holds %d rows after the replay", requests)
	}
	// The sanitation of the subject ran.
	var username string
	if err = fixture.pool.QueryRow(ctx, `SELECT coalesce(username,'') FROM online_public_profiles WHERE account_id='user_a'`).Scan(&username); err != nil {
		t.Fatal(err)
	}
	if username != "" {
		t.Fatalf("the public name of the removed account is back: %q", username)
	}
}

// TestPostgresTheRecoverCommandUsesTheEvidenceWithoutTheBundle covers the
// command line tool of the recovery.
//
// The bundle of a restore is only read when there is no evidence of the
// restore, so a recovery that is given the evidence needs neither the bundle
// nor the passphrase. A bundle that is named but never read is not a reason to
// ask for the passphrase.
func TestPostgresTheRecoverCommandUsesTheEvidenceWithoutTheBundle(t *testing.T) {
	fixture, removals, directory := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-cli-recovery-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the opponent: %v", err)
	}
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence("evidence-cli-restore", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, "evidence-cli-restore"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The evidence of the restore, as the operator restored it from the
	// protected backup.
	evidenceFile := filepath.Join(t.TempDir(), "evidence-cli-restore.json")
	record := privacy.RemovalRequirement{
		RestoreID: "evidence-cli-restore",
		Digest:    hexOf(backup.RemovalLedgerDigest(live.Matches, live.Subjects)),
		Matches:   live.Matches,
		Subjects:  live.Subjects,
	}
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(evidenceFile, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	binary := evidenceCLI(t)
	dsn := evidenceDSN(t, fixture)
	// The recovery of the restore with the evidence alone: no bundle and no
	// passphrase.
	output, err := evidenceRunCLI(t, binary, dsn,
		"recover",
		"--evidence", evidenceFile,
		"--restore-id", "evidence-cli-restore",
		"--fence", directory,
		"--database-url-env", "EVIDENCE_CLI_DATABASE_URL",
		"--passphrase-env", "EVIDENCE_CLI_PASSPHRASE",
	)
	if err != nil {
		t.Fatalf("the recovery with the evidence failed: %v\n%s", err, output)
	}
	if !strings.Contains(output, "recovered the restore evidence-cli-restore") {
		t.Fatalf("the output of the recovery = %q", output)
	}
	// The fence of the crashed restore is closed and the service may serve.
	fenced, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if fenced {
		t.Fatal("the fence of the recovered restore is still open")
	}
	// A bundle that is named but never read is not a reason to ask for the
	// passphrase: the recovery of another restore succeeds with a stale bundle
	// and without one.
	second, secondEvidence := evidenceCrashedRestore(t, removals, "evidence-cli-restore-two")
	_ = second
	bundle := evidenceBundle(t, t.TempDir(), nil, nil)
	output, err = evidenceRunCLI(t, binary, dsn,
		"recover",
		"--evidence", secondEvidence,
		"--file", bundle,
		"--restore-id", "evidence-cli-restore-two",
		"--fence", directory,
		"--database-url-env", "EVIDENCE_CLI_DATABASE_URL",
		"--passphrase-env", "EVIDENCE_CLI_PASSPHRASE",
	)
	if err != nil {
		t.Fatalf("the recovery with the evidence and a bundle failed: %v\n%s", err, output)
	}
	// A recovery without an evidence and without a bundle is refused.
	output, err = evidenceRunCLI(t, binary, dsn,
		"recover",
		"--restore-id", "evidence-cli-restore",
		"--fence", directory,
		"--database-url-env", "EVIDENCE_CLI_DATABASE_URL",
	)
	if err == nil {
		t.Fatalf("a recovery without an evidence and without a bundle was accepted: %s", output)
	}
	if !strings.Contains(output, "--evidence") {
		t.Fatalf("the refusal of the recovery does not name the evidence: %q", output)
	}
}

// evidenceCrashedRestore leaves a restore behind that crashed after it applied
// its removals, and it returns the evidence of the restore as the operator
// restored it from the protected backup.
func evidenceCrashedRestore(t *testing.T, removals *privacy.Service, restoreID string) (string, string) {
	t.Helper()
	ctx := context.Background()
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := removals.BeginFence(restoreID, false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = handle.Bind(live); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	if _, err = removals.RecordRestore(ctx, restoreID); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	record := privacy.RemovalRequirement{
		RestoreID: restoreID,
		Digest:    hexOf(backup.RemovalLedgerDigest(live.Matches, live.Subjects)),
		Matches:   live.Matches,
		Subjects:  live.Subjects,
	}
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), restoreID+".json")
	if err = os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path, path
}

// evidenceCLI returns the command line tool of the backup.
//
// The binary is built when the environment does not name one, so the test
// drives the real tool and not a copy of it.
func evidenceCLI(t *testing.T) string {
	t.Helper()
	if binary := strings.TrimSpace(os.Getenv("KHABACKUP_BIN")); binary != "" {
		return binary
	}
	binary := filepath.Join(t.TempDir(), "khabackup.exe")
	command := exec.Command("go", "build", "-o", binary, "../backup/cmd/khabackup")
	command.Dir = "."
	if output, err := command.CombinedOutput(); err != nil {
		t.Skipf("the command line tool could not be built: %v\n%s", err, output)
	}
	return binary
}

// evidenceDSN returns the database url of the fixture, with the schema of the
// fixture in it.
func evidenceDSN(t *testing.T, fixture *onlineAuthFixture) string {
	t.Helper()
	schema := fixture.pool.Config().ConnConfig.RuntimeParams["search_path"]
	if schema == "" {
		t.Fatal("the fixture has no schema")
	}
	dsn := os.Getenv(databaseEnv)
	if strings.Contains(dsn, "?") {
		return dsn + "&search_path=" + schema
	}
	return dsn + "?search_path=" + schema
}

// evidenceRunCLI runs the command line tool against the database of the
// fixture.
//
// The passphrase environment variable is deliberately not set: the recovery
// must not need it when the evidence of the restore is there.
func evidenceRunCLI(t *testing.T, binary, dsn string, arguments ...string) (string, error) {
	t.Helper()
	command := exec.Command(binary, arguments...)
	command.Env = append(os.Environ(), "EVIDENCE_CLI_DATABASE_URL="+dsn)
	command.Env = removeEnv(command.Env, "EVIDENCE_CLI_PASSPHRASE")
	output, err := command.CombinedOutput()
	return string(output), err
}

// removeEnv removes a variable from an environment.
func removeEnv(environment []string, name string) []string {
	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		if strings.HasPrefix(entry, name+"=") {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

var _ = errors.Is
var _ = time.Now
