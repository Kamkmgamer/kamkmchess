package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
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
	// owed are the removals that the restores which did not finish still
	// owe. They are the durable evidence of a crashed restore.
	owed         []RemovalRecord
	owedSubjects []SubjectRemovalRecord
	listErr      error
	applyErr     error
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

func (l *fakeRemovalLedger) AppliedRemovalLedger(context.Context) (AppliedRemovalLedger, error) {
	return AppliedRemovalLedger{Matches: l.applied, Subjects: l.subjectApplied}, nil
}

func (l *fakeRemovalLedger) PendingRemovalRequirements(context.Context) (AppliedRemovalLedger, error) {
	return AppliedRemovalLedger{Matches: l.owed, Subjects: l.owedSubjects}, nil
}

func (l *fakeRemovalLedger) RecordRestore(_ context.Context, restoreID string) (string, error) {
	return restoreID, nil
}

func (l *fakeRemovalLedger) ReleaseRestoreGate(context.Context, string) error {
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
		RestoreID:  "restore-one",
	}); err == nil {
		t.Fatal("a restore with removals was accepted without an admission fence")
	}
}

// TestRestoreWithoutRemovalsClosesItsFence covers the finalize of a restore
// that carries no removal.
//
// Every restore is fenced, because its import replaces the schema of the
// database. A restore without removals has no removal ledger to replay, so it
// has no gate to release, but its fence still has to be closed: a marker that
// stayed behind would keep the service closed forever.
func TestRestoreWithoutRemovalsClosesItsFence(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	if _, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  at,
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
	}); err != nil {
		t.Fatal(err)
	}
	fence := &fakeAdmissionFence{}
	if _, err := Restore(context.Background(), RestoreRequest{
		Path:           path,
		Passphrase:     []byte(testPassphrase),
		Restorer:       &fakeRestorer{},
		Tombstones:     &fakeLedger{},
		AdmissionFence: fence,
		RestoreID:      "restore-one",
	}); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if len(fence.opened) != 1 {
		t.Fatalf("the restore did not take the fence: %v", fence.opened)
	}
	if len(fence.closed) != 1 {
		t.Fatalf("the restore did not close its fence: %v", fence.closed)
	}
	if len(fence.released) != 0 {
		t.Fatalf("the closed fence was released as well: %v", fence.released)
	}
}

// TestRestoreThatFailsLeavesItsFenceOpen covers the failure of a restore.
//
// A restore that fails leaves its marker behind, so the service stays closed
// until an operator resolves the restore.
func TestRestoreThatFailsLeavesItsFenceOpen(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	if _, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  at,
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
	}); err != nil {
		t.Fatal(err)
	}
	fence := &fakeAdmissionFence{}
	if _, err := Restore(context.Background(), RestoreRequest{
		Path:           path,
		Passphrase:     []byte(testPassphrase),
		Restorer:       &failingRestorer{},
		Tombstones:     &fakeLedger{},
		AdmissionFence: fence,
		RestoreID:      "restore-one",
	}); err == nil {
		t.Fatal("a restore whose import failed reported success")
	}
	if len(fence.closed) != 0 {
		t.Fatalf("the failed restore closed its fence: %v", fence.closed)
	}
	if len(fence.released) != 1 {
		t.Fatalf("the failed restore did not release its ownership: %v", fence.released)
	}
}

// fakeAdmissionFence records the fence calls of a restore.
type fakeAdmissionFence struct {
	opened    []string
	closed    []string
	bound     []string
	released  []string
	cancelled []string
	openErr   error
	// owed are the removals the restores which did not finish still owe.
	owed AppliedRemovalLedger
}

func (f *fakeAdmissionFence) BeginFence(restoreID string, takeover bool) (FenceHandle, error) {
	if f.openErr != nil {
		return nil, f.openErr
	}
	f.opened = append(f.opened, restoreID)
	return &fakeFenceHandle{fence: f}, nil
}

// PendingRemovalRequirements returns the removals the fence still owes.
func (f *fakeAdmissionFence) PendingRemovalRequirements(context.Context) (AppliedRemovalLedger, error) {
	return f.owed, nil
}

// fakeFenceHandle is the ownership of the lifecycle of the fake fence.
type fakeFenceHandle struct {
	fence *fakeAdmissionFence
}

func (h *fakeFenceHandle) Bind(required AppliedRemovalLedger) error {
	h.fence.bound = append(h.fence.bound, fmt.Sprintf("%x", RemovalLedgerDigest(required.Matches, required.Subjects)))
	return nil
}

func (h *fakeFenceHandle) Finish(applied AppliedRemovalLedger) error {
	h.fence.closed = append(h.fence.closed, fmt.Sprintf("%x", RemovalLedgerDigest(applied.Matches, applied.Subjects)))
	return nil
}

func (h *fakeFenceHandle) Release() {
	h.fence.released = append(h.fence.released, "released")
}

func (h *fakeFenceHandle) Cancel() error {
	h.fence.cancelled = append(h.fence.cancelled, "cancelled")
	return nil
}

// failingRestorer is an import that fails.
type failingRestorer struct{}

func (r *failingRestorer) Restore(context.Context, io.Reader) error {
	return errors.New("the import failed")
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

// TestRemovalLedgerContainsUsesTheStrongestDuplicateMatchRow covers the
// containment of the applied removal ledger.
//
// The applied ledger of a restored database can hold two rows for the same
// match, kind and subject: the restored database brings its own row back and
// the replay writes the row of the removal it applied. The strongest of those
// rows is the one that counts, so the answer never depends on the order of
// the rows and never on the random identifier of a removal.
func TestRemovalLedgerContainsUsesTheStrongestDuplicateMatchRow(t *testing.T) {
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	weak := removal("rm_weak", "ref-one", "match-one", "account_deletion", at)
	strong := removal("rm_strong", "rm_strong_other", "match-one", "explicit_removal", at.Add(time.Hour))
	required := AppliedRemovalLedger{Matches: []RemovalRecord{strong}}
	// The weaker row comes last: the containment still holds, because the
	// explicit removal of the applied ledger is the strongest one.
	if !RemovalLedgerContains(AppliedRemovalLedger{Matches: []RemovalRecord{strong, weak}}, required) {
		t.Fatal("the applied ledger holds the required explicit removal")
	}
	// The other order gives the same answer.
	if !RemovalLedgerContains(AppliedRemovalLedger{Matches: []RemovalRecord{weak, strong}}, required) {
		t.Fatal("the containment of the applied ledger depends on the order of the rows")
	}
	// A weaker applied removal does not satisfy a required explicit removal,
	// whatever the order of the rows is.
	weaker := AppliedRemovalLedger{Matches: []RemovalRecord{weak}}
	if RemovalLedgerContains(weaker, required) {
		t.Fatal("an applied anonymization satisfied a required explicit removal")
	}
	// The same rule holds for the subject level half of the check.
	subject := SubjectRemovalRecord{RecordID: "rs_strong", SubjectKind: "account", SubjectRef: "ref-subject", Scope: "explicit_removal", RemovedAt: at}
	weakSubject := SubjectRemovalRecord{RecordID: "rs_weak", SubjectKind: "account", SubjectRef: "ref-subject", Scope: "account_deletion", RemovedAt: at}
	subjectRequired := AppliedRemovalLedger{Subjects: []SubjectRemovalRecord{subject}}
	if !RemovalLedgerContains(AppliedRemovalLedger{Subjects: []SubjectRemovalRecord{weakSubject, subject}}, subjectRequired) {
		t.Fatal("the applied ledger holds the required subject removal")
	}
	if RemovalLedgerContains(AppliedRemovalLedger{Subjects: []SubjectRemovalRecord{weakSubject}}, subjectRequired) {
		t.Fatal("an applied anonymization satisfied a required subject removal")
	}
}

// TestRestoreReplaysTheRemovalsTheCrashedRestoreOwed covers the removals
// that a crashed restore owed.
//
// The import of a restore destroys the removals that only the live database
// carried, so they are kept as durable evidence outside the database. The next
// restore merges that evidence into the removal ledger it has to apply, so the
// removals are replayed and they are not forgotten.
func TestRestoreReplaysTheRemovalsTheCrashedRestoreOwed(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	if _, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  at,
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
	}); err != nil {
		t.Fatal(err)
	}
	owed := removal("rm_owed", "ref-owed", "match-owed", "explicit_removal", at)
	owedSubject := SubjectRemovalRecord{RecordID: "rs_owed", SubjectKind: "account", SubjectRef: "ref-owed", Scope: "explicit_removal", RemovedAt: at}
	sink := &fakeRemovalLedger{owed: []RemovalRecord{owed}, owedSubjects: []SubjectRemovalRecord{owedSubject}}
	fence := &fakeAdmissionFence{}
	result, err := Restore(context.Background(), RestoreRequest{
		Path:           path,
		Passphrase:     []byte(testPassphrase),
		Restorer:       &fakeRestorer{},
		Tombstones:     &fakeLedger{},
		Removals:       sink,
		AdmissionFence: fence,
		RestoreID:      "restore-owed",
	})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.RemovalsApplied != 1 || result.SubjectRemovalsApplied != 1 {
		t.Fatalf("the restore replayed %d removals and %d subject removals", result.RemovalsApplied, result.SubjectRemovalsApplied)
	}
	if len(sink.applied) != 1 || sink.applied[0].RemovalID != "rm_owed" {
		t.Fatalf("the replayed removal ledger = %+v", sink.applied)
	}
	if len(sink.subjectApplied) != 1 || sink.subjectApplied[0].RecordID != "rs_owed" {
		t.Fatalf("the replayed subject ledger = %+v", sink.subjectApplied)
	}
	// The fence is bound with the complete ledger, the owed removals
	// included.
	if len(fence.bound) != 1 {
		t.Fatalf("the fence was bound %d times: %v", len(fence.bound), fence.bound)
	}
	bound := fmt.Sprintf("%x", RemovalLedgerDigest([]RemovalRecord{owed}, []SubjectRemovalRecord{owedSubject}))
	if fence.bound[0] != bound {
		t.Fatalf("the fence was bound with %q, the complete ledger is %q", fence.bound[0], bound)
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
	restorer := &fakeRestorer{}
	if _, err := Restore(context.Background(), RestoreRequest{AdmissionFence: &fakeAdmissionFence{}, RestoreID: "restore-one",
		Path:       path,
		Passphrase: []byte(testPassphrase),
		Restorer:   restorer,
		Tombstones: &fakeLedger{},
	}); err == nil {
		t.Fatal("a restore with removals and no removal sink was accepted")
	}
	if restorer.calls != 0 {
		t.Fatalf("the refused restore imported %d times", restorer.calls)
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
