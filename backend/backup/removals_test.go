package backup

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// fakeRemovalLedger is the online removal ledger of a database.
type fakeRemovalLedger struct {
	entries        []RemovalRecord
	applied        []RemovalRecord
	appliedCalls   int
	subjects       []SubjectRemovalRecord
	subjectApplied []SubjectRemovalRecord
	listErr        error
	applyErr       error
}

func (l *fakeRemovalLedger) ListRemovalRecords(context.Context) ([]RemovalRecord, error) {
	if l.listErr != nil {
		return nil, l.listErr
	}
	return append([]RemovalRecord(nil), l.entries...), nil
}

func (l *fakeRemovalLedger) ListSubjectRemovalRecords(context.Context) ([]SubjectRemovalRecord, error) {
	if l.listErr != nil {
		return nil, l.listErr
	}
	return append([]SubjectRemovalRecord(nil), l.subjects...), nil
}

func (l *fakeRemovalLedger) ApplyRemovalRecords(_ context.Context, records []RemovalRecord) error {
	l.appliedCalls++
	if l.applyErr != nil {
		return l.applyErr
	}
	l.applied = append([]RemovalRecord(nil), records...)
	return nil
}

func (l *fakeRemovalLedger) ApplySubjectRemovalRecords(_ context.Context, records []SubjectRemovalRecord) error {
	if l.applyErr != nil {
		return l.applyErr
	}
	l.subjectApplied = append([]SubjectRemovalRecord(nil), records...)
	return nil
}

// TestMergeRemovalLedgersKeepsTwoSubjectsOfOneMatch covers the key of the
// removal ledger.
//
// Two participants of one match can both be removed, and the two removals are
// two different removals.
func TestMergeRemovalLedgersKeepsTwoSubjectsOfOneMatch(t *testing.T) {
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	first := RemovalRecord{RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at}
	second := RemovalRecord{RemovalID: "rm_two", SubjectKind: "account", SubjectID: "ref-two", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at}
	merged, err := MergeRemovalLedgers([]RemovalRecord{first}, []RemovalRecord{second})
	if err != nil {
		t.Fatalf("merge the removal ledgers: %v", err)
	}
	if len(merged) != 2 {
		t.Fatalf("the merged ledger holds %d records: %+v", len(merged), merged)
	}
	// The later removal of the same subject wins.
	later := second
	later.RemovedAt = at.Add(time.Hour)
	merged, err = MergeRemovalLedgers([]RemovalRecord{first, second}, []RemovalRecord{later})
	if err != nil {
		t.Fatal(err)
	}
	if len(merged) != 2 {
		t.Fatalf("the merged ledger holds %d records: %+v", len(merged), merged)
	}
}

// TestCollectRemovalLedgersReadsTheNewerBundles covers the operator flow.
//
// The newer rotation copies carry the online removal ledgers, and the operator
// flow has to replay them with the older bundle.
func TestCollectRemovalLedgersReadsTheNewerBundles(t *testing.T) {
	directory := t.TempDir()
	older := filepath.Join(directory, "older.khabackup")
	newer := filepath.Join(directory, "newer.khabackup")
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	removal := RemovalRecord{RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at}
	subject := SubjectRemovalRecord{RecordID: "rs_one", SubjectKind: "account", SubjectRef: "ref-one", Scope: "explicit_removal", RemovedAt: at}
	for path, payload := range map[string]ExportPayload{
		older: {Tool: "pg_dump (PostgreSQL) 17.4", SQL: []byte("SELECT 1;")},
		newer: {Tool: "pg_dump (PostgreSQL) 17.4", Removals: []RemovalRecord{removal}, SubjectRemovals: []SubjectRemovalRecord{subject}, SQL: []byte("SELECT 1;")},
	} {
		if _, err := Create(context.Background(), CreateRequest{
			Path:       path,
			Label:      "daily-2026-10-20",
			Passphrase: []byte(testPassphrase),
			CreatedAt:  at,
			Dumper:     &fakeDumper{sql: payload.SQL},
			Tombstones: &fakeLedger{},
			Removals:   &fakeRemovalLedger{entries: payload.Removals, subjects: payload.SubjectRemovals},
		}); err != nil {
			t.Fatalf("create %s: %v", path, err)
		}
	}
	removals, subjects, err := CollectRemovalLedgers([]string{newer}, []byte(testPassphrase))
	if err != nil {
		t.Fatalf("collect the removal ledgers: %v", err)
	}
	if len(removals) != 1 || removals[0].MatchID != "match-one" {
		t.Fatalf("the collected removal ledger = %+v", removals)
	}
	if len(subjects) != 1 || subjects[0].SubjectRef != "ref-one" {
		t.Fatalf("the collected subject ledger = %+v", subjects)
	}
}

// TestRestoreReplaysTheNewerRemovalLedgers covers the restore of an older
// bundle with the removal ledgers of the newer rotation copies.
//
// The removals of the newer bundle are applied, and the restore needs the
// admission fence.
func TestRestoreReplaysTheNewerRemovalLedgers(t *testing.T) {
	directory := t.TempDir()
	older := filepath.Join(directory, "older.khabackup")
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	removal := RemovalRecord{RemovalID: "rm_new", SubjectKind: "account", SubjectID: "ref-new", MatchID: "match-new", Scope: "explicit_removal", RemovedAt: at}
	subject := SubjectRemovalRecord{RecordID: "rs_new", SubjectKind: "account", SubjectRef: "ref-new", Scope: "explicit_removal", RemovedAt: at}
	if _, err := Create(context.Background(), CreateRequest{
		Path:       older,
		Label:      "daily-2026-10-18",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  at,
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
	}); err != nil {
		t.Fatal(err)
	}
	sink := &fakeRemovalLedger{}
	fence := &fakeAdmissionFence{}
	result, err := Restore(context.Background(), RestoreRequest{
		Path:                       older,
		Passphrase:                 []byte(testPassphrase),
		Restorer:                   &fakeRestorer{},
		Tombstones:                 &fakeLedger{},
		Removals:                   sink,
		AdmissionFence:             fence,
		RestoreID:                  "restore-one",
		NewerRemovalLedgers:        [][]RemovalRecord{{removal}},
		NewerSubjectRemovalLedgers: [][]SubjectRemovalRecord{{subject}},
	})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.RemovalsApplied != 1 || result.SubjectRemovalsApplied != 1 {
		t.Fatalf("the applied removals = %d and %d", result.RemovalsApplied, result.SubjectRemovalsApplied)
	}
	if len(sink.applied) != 1 || sink.applied[0].MatchID != "match-new" {
		t.Fatalf("the replayed removal ledger = %+v", sink.applied)
	}
	if len(sink.subjectApplied) != 1 || sink.subjectApplied[0].SubjectRef != "ref-new" {
		t.Fatalf("the replayed subject ledger = %+v", sink.subjectApplied)
	}
}

// TestRestoreWithoutAnAdmissionFenceIsRefused covers the safe library use.
//
// A restore that carries removals needs the durable admission control, because
// the removals are the records that keep a removed subject removed.
func TestRestoreWithoutAnAdmissionFenceIsRefused(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	removal := RemovalRecord{RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at}
	if _, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  at,
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
		Removals:   &fakeRemovalLedger{entries: []RemovalRecord{removal}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), RestoreRequest{
		Path:       path,
		Passphrase: []byte(testPassphrase),
		Restorer:   &fakeRestorer{},
		Tombstones: &fakeLedger{},
		Removals:   &fakeRemovalLedger{},
	}); err == nil {
		t.Fatal("a restore with removals was accepted without an admission fence")
	}
}

// fakeAdmissionFence records the fence calls of a restore.
type fakeAdmissionFence struct {
	opened  []string
	closed  []string
	openErr error
}

func (f *fakeAdmissionFence) OpenFence(restoreID string, digest []byte) error {
	if f.openErr != nil {
		return f.openErr
	}
	f.opened = append(f.opened, restoreID)
	return nil
}

func (f *fakeAdmissionFence) CloseFence(restoreID string, digest []byte) error {
	f.closed = append(f.closed, restoreID)
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
		[]RemovalRecord{removal("rm_two", "user_b", "match-one", "account_deletion", later)}); err != nil {
		t.Fatalf("two removal subjects of one match were refused: %v", err)
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
		Path:           path,
		Passphrase:     []byte(testPassphrase),
		Restorer:       restorer,
		Tombstones:     &fakeLedger{},
		Removals:       sink,
		AdmissionFence: &fakeAdmissionFence{},
		RestoreID:      "restore-one",
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

// TestRestoreReplaysTheNewerRemovalLedgersOfAnOlderBundle covers the restore
// of an older bundle with a newer removal ledger.
func TestRestoreReplaysTheNewerRemovalLedgersOfAnOlderBundle(t *testing.T) {
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
		Path:           path,
		Passphrase:     []byte(testPassphrase),
		Restorer:       &fakeRestorer{},
		Tombstones:     &fakeLedger{},
		Removals:       sink,
		AdmissionFence: &fakeAdmissionFence{},
		RestoreID:      "restore-one",
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
