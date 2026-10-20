package backup

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// fakeRemovalLedger is the online removal ledger of a database.
type fakeRemovalLedger struct {
	entries      []RemovalRecord
	applied      []RemovalRecord
	appliedCalls int
	listErr      error
	applyErr     error
}

func (l *fakeRemovalLedger) ListRemovalRecords(context.Context) ([]RemovalRecord, error) {
	if l.listErr != nil {
		return nil, l.listErr
	}
	return append([]RemovalRecord(nil), l.entries...), nil
}

func (l *fakeRemovalLedger) ApplyRemovalRecords(_ context.Context, records []RemovalRecord) error {
	l.appliedCalls++
	if l.applyErr != nil {
		return l.applyErr
	}
	l.applied = append([]RemovalRecord(nil), records...)
	return nil
}

// removal is one removal record fixture.
func removal(removalID, subjectID, matchID, scope string, removedAt time.Time) RemovalRecord {
	return RemovalRecord{
		RemovalID:   removalID,
		SubjectKind: "account",
		SubjectID:   subjectID,
		MatchID:     matchID,
		Scope:       scope,
		RemovedAt:   removedAt,
	}
}

// TestMergeRemovalLedgersKeepsTheLaterRemoval covers the merge of two
// removal ledgers.
func TestMergeRemovalLedgersKeepsTheLaterRemoval(t *testing.T) {
	earlier := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	later := earlier.Add(time.Hour)
	merged, err := MergeRemovalLedgers([]RemovalRecord{removal("rm_one", "user_a", "match-one", "account_deletion", earlier)},
		[]RemovalRecord{removal("rm_two", "user_a", "match-one", "explicit_removal", later)})
	if err != nil {
		t.Fatal(err)
	}
	if len(merged) != 1 {
		t.Fatalf("the merged ledger = %+v", merged)
	}
	if merged[0].RemovedAt != later || merged[0].Scope != "explicit_removal" {
		t.Fatalf("the merged record = %+v", merged[0])
	}
	if _, err = MergeRemovalLedgers([]RemovalRecord{removal("rm_one", "user_a", "match-one", "account_deletion", earlier)},
		[]RemovalRecord{removal("rm_two", "user_b", "match-one", "account_deletion", later)}); err == nil {
		t.Fatal("a match with two removal subjects was accepted")
	}
}

// TestExportCarriesTheRemovalLedger covers the sealed bundle.
func TestExportCarriesTheRemovalLedger(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	removedAt := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	ledger := &fakeRemovalLedger{entries: []RemovalRecord{removal("rm_one", "user_a", "match-one", "explicit_removal", removedAt)}}
	manifest, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC),
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
		Removals:   ledger,
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.RemovalCount != 1 {
		t.Fatalf("the manifest removal count = %d", manifest.RemovalCount)
	}
	verified, err := Verify(path, []byte(testPassphrase))
	if err != nil {
		t.Fatal(err)
	}
	if len(verified.Payload.Removals) != 1 || verified.Payload.Removals[0].MatchID != "match-one" {
		t.Fatalf("the verified removals = %+v", verified.Payload.Removals)
	}
}

// TestRestoreReplaysTheRemovalLedger covers the restore of a bundle that
// carries removals.
func TestRestoreReplaysTheRemovalLedger(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	removedAt := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	manifest, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC),
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
		Removals:   &fakeRemovalLedger{entries: []RemovalRecord{removal("rm_one", "user_a", "match-one", "explicit_removal", removedAt)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = manifest
	restorer := &fakeRestorer{}
	sink := &fakeRemovalLedger{}
	result, err := Restore(context.Background(), RestoreRequest{
		Path:       path,
		Passphrase: []byte(testPassphrase),
		Restorer:   restorer,
		Tombstones: &fakeLedger{},
		Removals:   sink,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.RemovalsApplied != 1 {
		t.Fatalf("the applied removals = %d", result.RemovalsApplied)
	}
	if len(sink.applied) != 1 || sink.applied[0].MatchID != "match-one" {
		t.Fatalf("the replayed removals = %+v", sink.applied)
	}
}

// TestRestoreReportsTheRemovalsItCannotApply covers a restore without a
// removal sink.
//
// The restored database must not serve traffic before the removals are
// applied, so the restore reports them.
func TestRestoreReportsTheRemovalsItCannotApply(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	removedAt := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	if _, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC),
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
		Removals:   &fakeRemovalLedger{entries: []RemovalRecord{removal("rm_one", "user_a", "match-one", "explicit_removal", removedAt)}},
	}); err != nil {
		t.Fatal(err)
	}
	result, err := Restore(context.Background(), RestoreRequest{
		Path:       path,
		Passphrase: []byte(testPassphrase),
		Restorer:   &fakeRestorer{},
		Tombstones: &fakeLedger{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.RemovalsApplied != 0 {
		t.Fatalf("the applied removals = %d", result.RemovalsApplied)
	}
	if len(result.RemovalsPending) != 1 {
		t.Fatalf("the pending removals = %+v", result.RemovalsPending)
	}
}

// TestRestoreReplaysTheNewerRemovalLedgers covers the restore of an older
// bundle with a newer removal ledger.
func TestRestoreReplaysTheNewerRemovalLedgers(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	older := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	newer := older.Add(48 * time.Hour)
	if _, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-18",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  older,
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
		Removals:   &fakeRemovalLedger{},
	}); err != nil {
		t.Fatal(err)
	}
	sink := &fakeRemovalLedger{}
	result, err := Restore(context.Background(), RestoreRequest{
		Path:       path,
		Passphrase: []byte(testPassphrase),
		Restorer:   &fakeRestorer{},
		Tombstones: &fakeLedger{},
		Removals:   sink,
		NewerRemovalLedgers: [][]RemovalRecord{{
			removal("rm_new", "user_a", "match-one", "explicit_removal", newer),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.RemovalsApplied != 1 {
		t.Fatalf("the applied removals = %d", result.RemovalsApplied)
	}
	if len(sink.applied) != 1 || sink.applied[0].MatchID != "match-one" {
		t.Fatalf("the replayed removals = %+v", sink.applied)
	}
}
