package integration

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// TestPostgresTheFenceHasOneOwner covers the ownership of the durable restore
// fence.
//
// The ownership of the lifecycle is an operating system lock that the restore
// holds for the whole lifecycle. A second restore is refused, even when it
// names the same restore, so the ownership token of the lifecycle is never
// handed to a second caller.
func TestPostgresTheFenceHasOneOwner(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	directory := t.TempDir() + "/restore"
	first, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}
	second, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}
	handle, err := first.BeginFence("restore-one", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	defer handle.Release()
	// The same restore with the same identifier is refused.
	if _, err = second.BeginFence("restore-one", false); err == nil {
		t.Fatal("a second restore of the same identifier took the fence")
	}
	// A different restore is refused.
	if _, err = second.BeginFence("restore-two", false); err == nil {
		t.Fatal("a second restore took the fence")
	}
	// The fence is closed only by its owner.
	if err = handle.Bind(backup.AppliedRemovalLedger{}); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	if err = handle.Finish(backup.AppliedRemovalLedger{}); err != nil {
		t.Fatalf("close the fence: %v", err)
	}
}

// TestPostgresTwoRestoresCannotOwnTheFenceAtTheSameTime covers the
// exclusive ownership of the fence across two service instances.
func TestPostgresTwoRestoresCannotOwnTheFenceAtTheSameTime(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	directory := t.TempDir() + "/restore"
	first, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}
	second, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}

	var (
		group   sync.WaitGroup
		start   = make(chan struct{})
		handles = make([]*privacy.FenceHandle, 2)
		errors  = make([]error, 2)
	)
	group.Add(2)
	go func() {
		defer group.Done()
		<-start
		handles[0], errors[0] = first.BeginFence("restore-one", false)
	}()
	go func() {
		defer group.Done()
		<-start
		handles[1], errors[1] = second.BeginFence("restore-two", false)
	}()
	close(start)
	group.Wait()
	opened := 0
	for index, err := range errors {
		if err == nil {
			opened++
			defer handles[index].Release()
		}
	}
	if opened != 1 {
		t.Fatalf("%d restores own the fence: %v", opened, errors)
	}
}

// TestPostgresTheTakeoverNeverRemovesTheMarker covers the take-over of a
// crashed restore.
//
// The take-over replaces the owner marker inside the marker directory, so the
// marker never disappears: the service stays closed while the take-over runs
// and when the take-over fails.
func TestPostgresTheTakeoverNeverRemovesTheMarker(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	directory := t.TempDir() + "/restore"
	service, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}
	// A restore that crashed leaves its marker behind.
	handle, err := service.BeginFence("restore-crashed", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	// The handle is released without closing the fence: the restore crashed.
	handle.Release()
	open, err := service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the marker of the crashed restore is gone")
	}
	// A restore without the take-over is refused.
	if _, err = service.BeginFence("restore-next", false); err == nil {
		t.Fatal("a restore took the fence of a crashed restore")
	}
	open, err = service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the marker of the crashed restore is gone after a refused restore")
	}
	// The take-over replaces the marker inside the marker directory.
	taken, err := service.BeginFence("restore-next", true)
	if err != nil {
		t.Fatalf("the take-over failed: %v", err)
	}
	defer taken.Release()
	open, err = service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the marker is gone during the take-over")
	}
	marker, present, err := service.ReadFence("restore-next")
	if err != nil {
		t.Fatal(err)
	}
	if !present || marker.RestoreID != "restore-next" {
		t.Fatalf("the marker of the take-over = %+v (present %v)", marker, present)
	}
}

// TestPostgresTheRemovalLedgerDigestIsOrderIndependent covers the digest of
// the removal ledger.
func TestPostgresTheRemovalLedgerDigestIsOrderIndependent(t *testing.T) {
	at := time.Now().UTC()
	first := backup.RemovalRecord{RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at}
	second := backup.RemovalRecord{RemovalID: "rm_two", SubjectKind: "guest", SubjectID: "ref-two", MatchID: "match-two", Scope: "account_deletion", RemovedAt: at}
	subject := backup.SubjectRemovalRecord{RecordID: "rs_one", SubjectKind: "account", SubjectRef: "ref-three", Scope: "explicit_removal", RemovedAt: at}
	forward := backup.RemovalLedgerDigest([]backup.RemovalRecord{first, second}, []backup.SubjectRemovalRecord{subject})
	backward := backup.RemovalLedgerDigest([]backup.RemovalRecord{second, first}, []backup.SubjectRemovalRecord{subject})
	if !bytes.Equal(forward, backward) {
		t.Fatal("the digest of the removal ledger depends on the order of the records")
	}
	other := backup.RemovalLedgerDigest([]backup.RemovalRecord{first}, []backup.SubjectRemovalRecord{subject})
	if bytes.Equal(forward, other) {
		t.Fatal("the digest of the removal ledger does not change with the records")
	}
	// Two records of one key with a different scope have a defined order.
	third := backup.RemovalRecord{RemovalID: "rm_three", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "account_deletion", RemovedAt: at}
	forth := backup.RemovalRecord{RemovalID: "rm_four", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at}
	firstOrder := backup.RemovalLedgerDigest([]backup.RemovalRecord{third, forth}, nil)
	secondOrder := backup.RemovalLedgerDigest([]backup.RemovalRecord{forth, third}, nil)
	if !bytes.Equal(firstOrder, secondOrder) {
		t.Fatal("the digest of two records of one key depends on the order of the records")
	}
}

// TestPostgresTheMergeRefusesTwoIdentifiersOfOneRemoval covers the merge of
// two ledgers that hold two identifiers for the same removal.
func TestPostgresTheMergeRefusesTwoIdentifiersOfOneRemoval(t *testing.T) {
	at := time.Now().UTC()
	first := backup.RemovalRecord{RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at}
	second := backup.RemovalRecord{RemovalID: "rm_two", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at}
	if _, err := backup.MergeRemovalLedgers([]backup.RemovalRecord{first}, []backup.RemovalRecord{second}); err == nil {
		t.Fatal("the merge accepted two identifiers of one removal")
	}
}

// TestPostgresTheContainmentNeedsTheStrongerRemoval covers the strength of a
// removal.
func TestPostgresTheContainmentNeedsTheStrongerRemoval(t *testing.T) {
	at := time.Now().UTC()
	required := backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{{
		RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at,
	}}}
	weaker := backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{{
		RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "account_deletion", RemovedAt: at,
	}}}
	if backup.RemovalLedgerContains(weaker, required) {
		t.Fatal("an anonymization satisfied a required explicit removal")
	}
	stronger := backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{{
		RemovalID: "rm_one", SubjectKind: "account", SubjectID: "ref-one", MatchID: "match-one", Scope: "explicit_removal", RemovedAt: at,
	}}}
	if !backup.RemovalLedgerContains(stronger, required) {
		t.Fatal("the explicit removal did not satisfy the required removal")
	}
	// The subject level ledger compares the strength as well.
	requiredSubject := backup.AppliedRemovalLedger{Subjects: []backup.SubjectRemovalRecord{{
		RecordID: "rs_one", SubjectKind: "account", SubjectRef: "ref-one", Scope: "account_deletion", RemovedAt: at,
	}}}
	strongerSubject := backup.AppliedRemovalLedger{Subjects: []backup.SubjectRemovalRecord{{
		RecordID: "rs_two", SubjectKind: "account", SubjectRef: "ref-one", Scope: "explicit_removal", RemovedAt: at,
	}}}
	if !backup.RemovalLedgerContains(strongerSubject, requiredSubject) {
		t.Fatal("the explicit removal of a subject did not satisfy the required anonymization")
	}
}
