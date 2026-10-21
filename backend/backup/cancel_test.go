package backup

// The cleanup of a restore that is refused before its import.
//
// The regression below covers the cleanup of a restore whose cancellation
// fails: the ownership of the lifecycle has to be given back and the failure
// of the cleanup has to be reported with the failure of the restore.

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// failingCancelFence is a fence whose cancellation fails.
type failingCancelFence struct {
	fakeAdmissionFence
}

// BeginFence returns a handle whose cancellation fails.
func (f *failingCancelFence) BeginFence(restoreID string, takeover bool) (FenceHandle, error) {
	handle, err := f.fakeAdmissionFence.BeginFence(restoreID, takeover)
	if err != nil {
		return nil, err
	}
	return &failingCancelHandle{FenceHandle: handle}, nil
}

// failingCancelHandle is a handle whose cancellation fails.
type failingCancelHandle struct {
	FenceHandle
}

// Cancel fails: the marker of the lifecycle cannot be removed.
func (h *failingCancelHandle) Cancel() error {
	return errors.New("the marker of the lifecycle could not be removed")
}

// TestTheFailedCancellationReleasesTheOwnershipAndIsReported covers the
// cleanup of a restore that is refused before its import.
//
// The ownership of the lifecycle is given back whatever the outcome of the
// cleanup is: a caller that keeps it would hold the lifecycle for ever and the
// operator could not recover the restore. The failure of the cleanup is
// reported with the failure of the restore, and the failure of the restore is
// not hidden.
func TestTheFailedCancellationReleasesTheOwnershipAndIsReported(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "bundle.khabackup")
	if _, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-20",
		Passphrase: []byte(testPassphrase),
		CreatedAt:  time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC),
		Dumper:     &fakeDumper{sql: []byte("SELECT 1;")},
		Tombstones: &fakeLedger{},
	}); err != nil {
		t.Fatal(err)
	}
	// The restore is refused before its import: the removals that the
	// restores which did not finish still owe are pending, and the restore has
	// no removal ledger sink.
	fence := &failingCancelFence{}
	fence.owed = AppliedRemovalLedger{Matches: []RemovalRecord{removal("rm_owed", "ref-owed", "match-owed", "explicit_removal", time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC))}}
	_, err := Restore(context.Background(), RestoreRequest{
		Path:           path,
		Passphrase:     []byte(testPassphrase),
		Restorer:       &fakeRestorer{},
		Tombstones:     &fakeLedger{},
		AdmissionFence: fence,
		RestoreID:      "restore-cancel",
	})
	if err == nil {
		t.Fatal("the restore reported success")
	}
	// The failure of the restore is not hidden.
	if !errors.Is(err, ErrLedgerConflict) {
		t.Fatalf("the failure of the restore is gone: %v", err)
	}
	// The failure of the cleanup is reported.
	if !strings.Contains(err.Error(), "the marker of the lifecycle could not be removed") {
		t.Fatalf("the failure of the cleanup is not reported: %v", err)
	}
	// The ownership of the lifecycle was given back.
	if len(fence.released) == 0 {
		t.Fatalf("the ownership of the lifecycle was not released: %v", fence.released)
	}
}
