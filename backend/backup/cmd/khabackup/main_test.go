package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
)

type fixtureDumper struct{ sql string }

func (f fixtureDumper) Describe(context.Context) (string, error) {
	return "pg_dump (PostgreSQL) 17.4 (offline fixture)", nil
}

func (f fixtureDumper) Dump(_ context.Context, w io.Writer) error {
	_, err := io.WriteString(w, f.sql)
	return err
}

type fixtureLedger struct{ entries []backup.Tombstone }

func (f fixtureLedger) ListTombstones(context.Context) ([]backup.Tombstone, error) {
	return f.entries, nil
}

// captureRun runs the CLI with stdout redirected and returns what it printed.
func captureRun(t *testing.T, arguments []string) string {
	t.Helper()
	output, err := captureRunResult(t, arguments)
	if err != nil {
		t.Fatalf("run %v: %v", arguments, err)
	}
	return output
}

// captureRunResult runs the CLI with stdout redirected and returns what it
// printed together with the error of the command.
//
// A command that fails closed still prints its report, so the report of a
// failure is part of what the operator sees.
func captureRunResult(t *testing.T, arguments []string) (string, error) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = writer
	done := make(chan string, 1)
	go func() {
		output, _ := io.ReadAll(reader)
		done <- string(output)
	}()
	runErr := run(context.Background(), arguments)
	os.Stdout = original
	writer.Close()
	output := <-done
	reader.Close()
	return output, runErr
}

// reportCount counts the entries of a list of a report.
//
// A list of a report that is empty is reported as a missing key or as a null,
// so the count never assumes a shape the report does not promise.
func reportCount(report map[string]any, key string) int {
	items, ok := report[key].([]any)
	if !ok {
		return 0
	}
	return len(items)
}

// pinClock fixes the clock of the tool, so the age of a bundle is decided by
// a fixed reference time and not by the moment the test happens to run.
func pinClock(t *testing.T, at time.Time) {
	t.Helper()
	original := nowUTC
	nowUTC = func() time.Time { return at }
	t.Cleanup(func() { nowUTC = original })
}

func sealBundle(t *testing.T, directory, label string, createdAt time.Time, entries []backup.Tombstone) string {
	t.Helper()
	path := filepath.Join(directory, label+".kha")
	if _, err := backup.Create(context.Background(), backup.CreateRequest{
		Path:       path,
		Label:      label,
		Passphrase: []byte(testOperatorPassphrase),
		CreatedAt:  createdAt,
		Dumper:     fixtureDumper{sql: "CREATE TABLE games (game_id text PRIMARY KEY);\n"},
		Tombstones: fixtureLedger{entries: entries},
	}); err != nil {
		t.Fatalf("seal %s: %v", label, err)
	}
	return path
}

const testOperatorPassphrase = "an operator passphrase"

func TestVerifyAndInspectCommandsOffline(t *testing.T) {
	t.Setenv("KHA_BACKUP_PASSPHRASE", testOperatorPassphrase)
	directory := t.TempDir()
	path := sealBundle(t, directory, "daily-2026-10-18", time.Date(2026, 10, 18, 6, 0, 0, 0, time.UTC), nil)

	verified := captureRun(t, []string{"verify", "--file", path, "--json"})
	var report map[string]any
	if err := json.Unmarshal([]byte(verified), &report); err != nil {
		t.Fatalf("verify --json did not print a report: %v\n%s", err, verified)
	}
	if report["verified"] != true || report["label"] != "daily-2026-10-18" {
		t.Fatalf("verify report is wrong: %v", report)
	}

	inspected := captureRun(t, []string{"inspect", "--file", path, "--json"})
	if !strings.Contains(inspected, "AES-256-GCM") || strings.Contains(inspected, testOperatorPassphrase) {
		t.Fatalf("inspect output is wrong or leaked the passphrase: %s", inspected)
	}
}

func TestVerifyCommandFailsClosedOnAWrongPassphrase(t *testing.T) {
	t.Setenv("KHA_BACKUP_PASSPHRASE", "not the operator passphrase")
	path := sealBundle(t, t.TempDir(), "daily-2026-10-18", time.Date(2026, 10, 18, 6, 0, 0, 0, time.UTC), nil)
	if err := run(context.Background(), []string{"verify", "--file", path, "--json"}); err == nil {
		t.Fatal("verify accepted the wrong passphrase")
	}
}

func TestRotatePlansBeforeItDeletes(t *testing.T) {
	directory := t.TempDir()
	reference := time.Now().UTC()
	for index := 1; index <= 10; index++ {
		sealBundle(t, directory, "daily-"+reference.AddDate(0, 0, -index).Format(time.DateOnly), reference.AddDate(0, 0, -index), nil)
	}
	for index := 1; index <= 5; index++ {
		at := reference.AddDate(0, 0, -7*index)
		sealBundle(t, directory, backup.WeeklyLabel(at), at, nil)
	}

	planned := captureRun(t, []string{"rotate", "--dir", directory, "--json"})
	var report map[string]any
	if err := json.Unmarshal([]byte(planned), &report); err != nil {
		t.Fatalf("rotate --json did not print a plan: %v\n%s", err, planned)
	}
	if report["applied"] != false {
		t.Fatalf("rotate planned to delete without --apply: %v", report)
	}
	if len(report["prune"].([]any)) != 4 {
		t.Fatalf("expected four prunable copies: %v", report["prune"])
	}
	if len(report["deleted"].([]any)) != 0 {
		t.Fatalf("rotate deleted files without --apply: %v", report["deleted"])
	}

	applied := captureRun(t, []string{"rotate", "--dir", directory, "--json", "--apply"})
	var appliedReport map[string]any
	if err := json.Unmarshal([]byte(applied), &appliedReport); err != nil {
		t.Fatalf("rotate --apply did not print a report: %v", err)
	}
	if appliedReport["applied"] != true || len(appliedReport["deleted"].([]any)) != 4 {
		t.Fatalf("rotate --apply did not prune exactly the planned copies: %v", appliedReport["deleted"])
	}
	remaining, err := filepath.Glob(filepath.Join(directory, "*.kha"))
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 11 {
		t.Fatalf("%d bundles remain, want the seven daily and four weekly copies", len(remaining))
	}
}

// The rotation retires a bundle that passed the maximum age of thirty days,
// and it keeps a bundle that is exactly thirty days old. The plan is printed
// without --apply, so nothing is deleted by this test.
func TestRotateRetiresOnlyTheBundleThatPassedTheMaximumAge(t *testing.T) {
	directory := t.TempDir()
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	pinClock(t, reference)
	exactly := sealBundle(t, directory, "daily-2026-10-02", reference.Add(-backup.MaxBundleAge), nil)
	tooOld := sealBundle(t, directory, "daily-2026-10-01", reference.Add(-backup.MaxBundleAge-time.Second), nil)

	planned, err := captureRunResult(t, []string{"rotate", "--dir", directory, "--json"})
	if err != nil {
		t.Fatalf("rotate failed: %v\n%s", err, planned)
	}
	var report map[string]any
	if err = json.Unmarshal([]byte(planned), &report); err != nil {
		t.Fatalf("rotate --json did not print a plan: %v\n%s", err, planned)
	}
	if report["maxAgeDays"] != float64(backup.MaxBundleAgeDays) {
		t.Fatalf("the report does not name the maximum age: %v", report)
	}
	if len(report["deleted"].([]any)) != 0 {
		t.Fatalf("the plan deleted files without --apply: %v", report["deleted"])
	}
	pruned := map[string]bool{}
	for _, item := range report["prune"].([]any) {
		pruned[item.(map[string]any)["path"].(string)] = true
	}
	if !pruned[tooOld] {
		t.Fatalf("the bundle that passed the maximum age has to be planned for retirement: %v", report["prune"])
	}
	if pruned[exactly] {
		t.Fatalf("the bundle that is exactly thirty days old is inside the maximum age: %v", report["prune"])
	}
	if _, err = os.Stat(exactly); err != nil {
		t.Fatalf("the plan deleted a bundle: %v", err)
	}
	if _, err = os.Stat(tooOld); err != nil {
		t.Fatalf("the plan deleted a bundle: %v", err)
	}
}

// A protected bundle is never deleted, and the rotation refuses to report a
// success while a protected bundle of the managed directory is older than the
// maximum age.
func TestRotateFailsClosedOnAProtectedOldBundle(t *testing.T) {
	directory := t.TempDir()
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	pinClock(t, reference)
	path := sealBundle(t, directory, "daily-2026-09-01", reference.AddDate(0, 0, -60), nil)

	planned, err := captureRunResult(t, []string{"rotate", "--dir", directory, "--protect", "daily-2026-09-01", "--json"})
	if err == nil {
		t.Fatalf("the rotation reported success with an unresolved retention: %s", planned)
	}
	if !errors.Is(err, backup.ErrRetentionUnresolved) {
		t.Fatalf("the rotation failed for the wrong reason: %v", err)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("the protected bundle was deleted: %v", statErr)
	}
	var report map[string]any
	if unmarshalErr := json.Unmarshal([]byte(planned), &report); unmarshalErr != nil {
		t.Fatalf("the failing rotation did not print a report: %v\n%s", unmarshalErr, planned)
	}
	unresolved := report["unresolved"].([]any)
	if len(unresolved) != 1 {
		t.Fatalf("the report does not name the unresolved bundle: %v", report["unresolved"])
	}
	if !strings.Contains(unresolved[0].(map[string]any)["reason"].(string), "protected") {
		t.Fatalf("the unresolved reason does not explain the obligation: %v", unresolved[0])
	}
}

// A bundle whose manifest cannot be read cannot be dated, so its age cannot
// be proven. It is never deleted, and the rotation fails closed on it.
func TestRotateFailsClosedOnAnUnreadableBundle(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "daily-2026-10-20.kha")
	if err := os.WriteFile(path, []byte("not an encrypted bundle"), 0o600); err != nil {
		t.Fatal(err)
	}

	planned, err := captureRunResult(t, []string{"rotate", "--dir", directory, "--json"})
	if err == nil {
		t.Fatalf("the rotation reported success with an unreadable bundle: %s", planned)
	}
	if !errors.Is(err, backup.ErrRetentionUnresolved) {
		t.Fatalf("the rotation failed for the wrong reason: %v", err)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("the unreadable bundle was deleted: %v", statErr)
	}
	var report map[string]any
	if unmarshalErr := json.Unmarshal([]byte(planned), &report); unmarshalErr != nil {
		t.Fatalf("the failing rotation did not print a report: %v\n%s", unmarshalErr, planned)
	}
	if len(report["unreadable"].([]any)) != 1 {
		t.Fatalf("the report does not name the unreadable bundle: %v", report["unreadable"])
	}
	if len(report["unresolved"].([]any)) != 1 {
		t.Fatalf("the report does not name the unresolved bundle: %v", report["unresolved"])
	}
}

// The durable evidence of a restore lives in its own directory of the managed
// directory. The rotation never descends into a subdirectory, so the evidence
// is never a candidate and never retired by the maximum age.
func TestRotateLeavesTheRestoreEvidenceDirectoryOutsideThePruning(t *testing.T) {
	directory := t.TempDir()
	evidence := filepath.Join(directory, "restore-evidence")
	if err := os.MkdirAll(evidence, 0o700); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(evidence, "daily-2020-01-01.kha")
	if err := os.WriteFile(inside, []byte("not an encrypted bundle"), 0o600); err != nil {
		t.Fatal(err)
	}

	planned, err := captureRunResult(t, []string{"rotate", "--dir", directory, "--json"})
	if err != nil {
		t.Fatalf("the evidence directory was taken into the rotation: %v\n%s", err, planned)
	}
	var report map[string]any
	if unmarshalErr := json.Unmarshal([]byte(planned), &report); unmarshalErr != nil {
		t.Fatalf("rotate --json did not print a plan: %v\n%s", unmarshalErr, planned)
	}
	if reportCount(report, "unreadable") != 0 || reportCount(report, "unresolved") != 0 {
		t.Fatalf("the evidence directory was read by the rotation: %v", report)
	}
	if _, statErr := os.Stat(inside); statErr != nil {
		t.Fatalf("the evidence was touched by the rotation: %v", statErr)
	}
}

func TestRestoreRefusesWithoutApply(t *testing.T) {
	t.Setenv("KHA_BACKUP_PASSPHRASE", testOperatorPassphrase)
	path := sealBundle(t, t.TempDir(), "daily-2026-10-18", time.Date(2026, 10, 18, 6, 0, 0, 0, time.UTC), nil)
	err := run(context.Background(), []string{"restore", "--file", path, "--database-url-env", "KHA_TEST_ABSENT_DATABASE_URL"})
	if err == nil || !strings.Contains(err.Error(), "not set") {
		t.Fatalf("restore without --apply should refuse before any connection: %v", err)
	}
}

func TestUnknownCommandAndHelp(t *testing.T) {
	if err := run(context.Background(), []string{"destroy"}); err == nil {
		t.Fatal("an unknown command was accepted")
	}
	if output := captureRun(t, []string{"help"}); !strings.Contains(output, "restore") {
		t.Fatalf("help output is missing the restore command: %s", output)
	}
}
