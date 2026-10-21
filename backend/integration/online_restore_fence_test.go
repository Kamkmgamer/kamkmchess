package integration

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// TestPostgresTheRestoreFenceHasOneOwner covers the ownership of the durable
// restore fence.
//
// Two restores that start at the same time cannot both own the fence: the
// second one is refused instead of overwriting the fence of the first. The
// same restore with the same ledger is idempotent, and the same restore with
// another ledger is refused.
func TestPostgresTheRestoreFenceHasOneOwner(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	path := t.TempDir() + "/restore.fence"
	first, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: path})
	if err != nil {
		t.Fatal(err)
	}
	second, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: path})
	if err != nil {
		t.Fatal(err)
	}
	digest := []byte("digest-of-the-ledger")
	var (
		group  sync.WaitGroup
		start  = make(chan struct{})
		errors = make([]error, 2)
	)
	group.Add(2)
	go func() {
		defer group.Done()
		<-start
		errors[0] = first.OpenFence("restore-one", digest)
	}()
	go func() {
		defer group.Done()
		<-start
		errors[1] = second.OpenFence("restore-two", digest)
	}()
	close(start)
	group.Wait()
	opened := 0
	owner := ""
	for index, err := range errors {
		if err == nil {
			opened++
			if index == 0 {
				owner = "restore-one"
			} else {
				owner = "restore-two"
			}
		}
	}
	if opened != 1 {
		t.Fatalf("%d restores own the fence: %v", opened, errors)
	}
	other := "restore-one"
	if owner == "restore-one" {
		other = "restore-two"
	}
	// The same restore with the same ledger is idempotent.
	if err = first.OpenFence(owner, digest); err != nil {
		t.Fatalf("the owner could not take its own fence again: %v", err)
	}
	// The same restore with another ledger is refused.
	if err = first.OpenFence(owner, []byte("another-digest")); err == nil {
		t.Fatal("the fence accepted another removal ledger")
	}
	// A different restore is refused.
	if err = second.OpenFence(other, digest); err == nil {
		t.Fatal("a second restore took the fence")
	}
	// The fence is closed only by its owner.
	if err = second.CloseFence(other, digest); err == nil {
		t.Fatal("the fence was closed by another restore")
	}
}

// TestPostgresTheRestoreFenceSurvivesARestart covers the recovery of a
// crashed restore.
//
// The fence is on disk, so a service that starts after the crash sees it and
// refuses to serve.
func TestPostgresTheRestoreFenceSurvivesARestart(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	path := t.TempDir() + "/restore.fence"
	before, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: path})
	if err != nil {
		t.Fatal(err)
	}
	if err = before.OpenFence("restore-crashed", []byte("digest")); err != nil {
		t.Fatalf("open fence: %v", err)
	}
	// The process restarts: a new service reads the same fence.
	after, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: path})
	if err != nil {
		t.Fatal(err)
	}
	open, err := after.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the fence of the crashed restore is gone after the restart")
	}
	allowed, err := after.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic while the fence of a crashed restore is open")
	}
}

// TestPostgresTheRestoreIsRefusedBeforeTheImport covers the admission of a
// restore that cannot replay the removals.
//
// The refusal happens before the import, so the database is never touched.
func TestPostgresTheRestoreIsRefusedBeforeTheImport(t *testing.T) {
	directory := t.TempDir()
	path := directory + "/bundle.khabackup"
	removedAt := time.Now().UTC()
	removal := backup.RemovalRecord{RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: removedAt}
	if _, err := backup.Create(context.Background(), backup.CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte("correct horse battery staple"),
		CreatedAt:  removedAt,
		Dumper:     &countingDumper{},
		Tombstones: &countingLedger{},
		Removals:   &countingRemovalLedger{entries: []backup.RemovalRecord{removal}},
	}); err != nil {
		t.Fatal(err)
	}
	// A restore without the removal sink is refused before the import.
	restorer := &countingRestorer{}
	if _, err := backup.Restore(context.Background(), backup.RestoreRequest{
		Path:       path,
		Passphrase: []byte("correct horse battery staple"),
		Restorer:   restorer,
		Tombstones: &countingLedger{},
	}); err == nil {
		t.Fatal("a restore with removals and no removal sink was accepted")
	}
	if restorer.calls != 0 {
		t.Fatalf("the refused restore imported %d times", restorer.calls)
	}
	// A restore without the admission fence is refused before the import.
	restorer = &countingRestorer{}
	if _, err := backup.Restore(context.Background(), backup.RestoreRequest{
		Path:       path,
		Passphrase: []byte("correct horse battery staple"),
		Restorer:   restorer,
		Tombstones: &countingLedger{},
		Removals:   &countingRemovalLedger{},
		RestoreID:  "restore-one",
	}); err == nil {
		t.Fatal("a restore with removals and no admission fence was accepted")
	}
	if restorer.calls != 0 {
		t.Fatalf("the refused restore imported %d times", restorer.calls)
	}
	// A restore without a restore identifier is refused before the import.
	restorer = &countingRestorer{}
	if _, err := backup.Restore(context.Background(), backup.RestoreRequest{
		Path:       path,
		Passphrase: []byte("correct horse battery staple"),
		Restorer:   restorer,
		Tombstones: &countingLedger{},
		Removals:   &countingRemovalLedger{},
	}); err == nil {
		t.Fatal("a restore with removals and no restore identifier was accepted")
	}
	if restorer.calls != 0 {
		t.Fatalf("the refused restore imported %d times", restorer.calls)
	}
}

// countingDumper is a logical export of one statement.
type countingDumper struct{}

func (d *countingDumper) Describe(context.Context) (string, error) {
	return "pg_dump (PostgreSQL) 17.4", nil
}

func (d *countingDumper) Dump(_ context.Context, w io.Writer) error {
	_, err := w.Write([]byte("SELECT 1;"))
	return err
}

// countingRestorer counts the imports of a restore.
type countingRestorer struct {
	calls int
}

func (r *countingRestorer) Restore(_ context.Context, sql io.Reader) error {
	r.calls++
	_, err := io.ReadAll(sql)
	return err
}

// countingLedger is a deletion tombstone ledger.
type countingLedger struct{}

func (l *countingLedger) ListTombstones(context.Context) ([]backup.Tombstone, error) {
	return nil, nil
}

func (l *countingLedger) ApplyTombstones(context.Context, []backup.Tombstone) error {
	return nil
}

// countingRemovalLedger is an online removal ledger.
type countingRemovalLedger struct {
	entries []backup.RemovalRecord
}

func (l *countingRemovalLedger) ListRemovalRecords(context.Context) ([]backup.RemovalRecord, error) {
	return append([]backup.RemovalRecord(nil), l.entries...), nil
}

func (l *countingRemovalLedger) ListSubjectRemovalRecords(context.Context) ([]backup.SubjectRemovalRecord, error) {
	return nil, nil
}

func (l *countingRemovalLedger) ApplyRemovalRecords(context.Context, []backup.RemovalRecord) error {
	return nil
}

func (l *countingRemovalLedger) ApplySubjectRemovalRecords(context.Context, []backup.SubjectRemovalRecord) error {
	return nil
}

func (l *countingRemovalLedger) AppliedRemovalLedger(context.Context) (backup.AppliedRemovalLedger, error) {
	return backup.AppliedRemovalLedger{Matches: l.entries}, nil
}
