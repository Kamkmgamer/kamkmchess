package main

import (
	"context"
	"encoding/json"
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
	if runErr != nil {
		t.Fatalf("run %v: %v", arguments, runErr)
	}
	return output
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
