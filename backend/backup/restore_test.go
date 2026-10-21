package backup

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRestoreLoadsTheExportThenReappliesTheLedger(t *testing.T) {
	directory := t.TempDir()
	older := filepath.Join(directory, "weekly-2026-W42.kha")
	sql := "CREATE TABLE games (game_id text PRIMARY KEY);\n"
	mustCreate(t, older, "weekly-2026-W42", []Tombstone{tombstone("game-a", day(1), 2, 1)}, sql)

	// A newer daily copy recorded one more deletion after the weekly copy.
	newer := []Tombstone{tombstone("game-b", day(6), 4, 2)}
	restorer := &fakeRestorer{}
	sink := &fakeLedger{entries: []Tombstone{tombstone("game-a", day(1), 2, 1)}}
	result, err := Restore(context.Background(), RestoreRequest{AdmissionFence: &fakeAdmissionFence{}, RestoreID: "restore-one",
		Path:         older,
		Passphrase:   []byte(testPassphrase),
		Restorer:     restorer,
		Tombstones:   sink,
		NewerLedgers: [][]Tombstone{newer},
	})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restorer.calls != 1 || string(restorer.sql) != sql {
		t.Fatalf("logical export was not restored byte for byte: %q", restorer.sql)
	}
	if sink.appliedCalls != 1 || len(sink.applied) != 2 {
		t.Fatalf("the merged ledger was not reapplied: %+v", sink.applied)
	}
	if result.TombstonesApplied != 2 || result.TombstonesKept != 1 {
		t.Fatalf("unexpected restore result: %+v", result)
	}
	if result.RecoveryCounts[RecoveryApply] != 1 {
		t.Fatalf("the newer deletion was not reported as applied: %+v", result.RecoveryCounts)
	}
}

func TestRestoreRefusesToTouchTheDatabaseWhenAuthenticationFails(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "daily-2026-10-18.kha")
	mustCreate(t, path, "daily-2026-10-18", nil, "SELECT 1;")
	restorer := &fakeRestorer{}
	sink := &fakeLedger{}
	if _, err := Restore(context.Background(), RestoreRequest{AdmissionFence: &fakeAdmissionFence{}, RestoreID: "restore-one",
		Path:       path,
		Passphrase: []byte("not the real passphrase"),
		Restorer:   restorer,
		Tombstones: sink,
	}); !errors.Is(err, ErrPassphrase) {
		t.Fatalf("a failed authentication did not stop the restore: %v", err)
	}
	if restorer.calls != 0 || sink.appliedCalls != 0 {
		t.Fatal("restore wrote to the database before authenticating the bundle")
	}
}

func TestRestoreDoesNotApplyTombstonesWhenTheLoadFails(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "daily-2026-10-18.kha")
	mustCreate(t, path, "daily-2026-10-18", []Tombstone{tombstone("game-a", day(2), 2, 1)}, "SELECT 1;")
	sentinel := errors.New("pg_restore aborted")
	restorer := &fakeRestorer{err: sentinel}
	sink := &fakeLedger{}
	if _, err := Restore(context.Background(), RestoreRequest{AdmissionFence: &fakeAdmissionFence{}, RestoreID: "restore-one",
		Path:       path,
		Passphrase: []byte(testPassphrase),
		Restorer:   restorer,
		Tombstones: sink,
	}); !errors.Is(err, sentinel) {
		t.Fatalf("restore failure not propagated: %v", err)
	}
	if sink.appliedCalls != 0 {
		t.Fatal("deletion recovery ran after a failed load")
	}
}

func TestPlanRestoreWritesNothing(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "daily-2026-10-18.kha")
	mustCreate(t, path, "daily-2026-10-18", []Tombstone{tombstone("game-a", day(2), 2, 1)}, "SELECT 1;\n")
	sink := &fakeLedger{}
	plan, err := PlanRestore(context.Background(), path, []byte(testPassphrase), sink, nil)
	if err != nil {
		t.Fatal(err)
	}
	if plan.SQLBytes != int64(len("SELECT 1;\n")) {
		t.Fatalf("plan reported %d SQL bytes", plan.SQLBytes)
	}
	if sink.appliedCalls != 0 {
		t.Fatal("PlanRestore applied tombstones")
	}
	if plan.RecoveryCounts[RecoveryApply] != 1 {
		t.Fatalf("the plan did not flag the deletion to reapply: %+v", plan)
	}
	if plan.Manifest.Label != "daily-2026-10-18" || plan.Manifest.TombstoneCount != 1 {
		t.Fatalf("plan lost the manifest: %+v", plan.Manifest)
	}
}

func TestCollectLedgersMergesTheWholeRotation(t *testing.T) {
	directory := t.TempDir()
	weekly := filepath.Join(directory, "weekly-2026-W42.kha")
	daily := filepath.Join(directory, "daily-2026-10-18.kha")
	mustCreate(t, weekly, "weekly-2026-W42", []Tombstone{tombstone("game-a", day(1), 2, 1)}, "SELECT 1;")
	mustCreate(t, daily, "daily-2026-10-18", []Tombstone{tombstone("game-a", day(9), 5, 2), tombstone("game-z", day(8), 3, 1)}, "SELECT 2;")

	merged, err := CollectLedgers([]string{weekly, daily}, []byte(testPassphrase))
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(merged) != 2 || !merged[0].DeletedAt.Equal(day(9)) {
		t.Fatalf("rotation ledgers were not merged by deletion time: %+v", merged)
	}
	if _, err = CollectLedgers([]string{weekly}, []byte("wrong passphrase here")); !errors.Is(err, ErrPassphrase) {
		t.Fatalf("CollectLedgers accepted the wrong passphrase: %v", err)
	}
}

func TestRestoreRecordsItsLineage(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "weekly-2026-W42.kha")
	mustCreate(t, source, "weekly-2026-W42", nil, "SELECT 1;")
	lineage := filepath.Join(directory, "daily-2026-10-19.kha")
	manifest, err := Create(context.Background(), CreateRequest{
		Path:         lineage,
		Label:        "daily-2026-10-19",
		Passphrase:   []byte(testPassphrase),
		CreatedAt:    day(19),
		RestoredFrom: "weekly-2026-W42",
		Dumper:       &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones:   &fakeLedger{},
	})
	if err != nil {
		t.Fatal(err)
	}
	verified, err := Verify(lineage, []byte(testPassphrase))
	if err != nil {
		t.Fatal(err)
	}
	if manifest.RestoredFrom != "weekly-2026-W42" || verified.Manifest.RestoredFrom != "weekly-2026-W42" {
		t.Fatalf("restore lineage was not preserved: %+v", verified.Manifest)
	}
	if verified.Manifest.CreatedAt.Location() != time.UTC {
		t.Fatalf("manifest time is not UTC: %v", verified.Manifest.CreatedAt)
	}
	if strings.TrimSpace(string(verified.Payload.SQL)) != "SELECT 1;" {
		t.Fatalf("unexpected export: %q", verified.Payload.SQL)
	}
}
