package privacy

// The lifecycle of a restore around its import.
//
// The regressions below cover the owner marker of a crashed restore and the
// cancellation of a take-over that is refused before its import.

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
)

// TestTheCancelledTakeoverPreservesTheCrashedRestore covers the owner marker
// of a crashed restore.
//
// A take-over replaces the owner marker of the lifecycle, and a take-over that
// is refused before its import has to restore it exactly: the identifier, the
// ownership token and the bound removal ledger of the crashed restore are what
// the operator needs to recover it, and the directory of the marker is never
// removed, so the service never sees a gap.
func TestTheCancelledTakeoverPreservesTheCrashedRestore(t *testing.T) {
	directory := t.TempDir()
	service := &Service{options: Options{FencePath: directory, Now: time.Now}}
	// The restore that crashed: it bound the removal ledger it had to apply
	// and its marker stayed behind.
	crashed, err := service.BeginFence("restore-crashed", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	if err = crashed.Bind(backup.AppliedRemovalLedger{}); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	crashed.Release()
	marker := filepath.Join(directory, "restore-fence", "owner")
	before, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read the owner marker: %v", err)
	}
	// The take-over is refused before its import.
	takeover, err := service.BeginFence("restore-takeover", true)
	if err != nil {
		t.Fatalf("take over the fence: %v", err)
	}
	if err = takeover.Cancel(); err != nil {
		t.Fatalf("cancel the take-over: %v", err)
	}
	after, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read the owner marker: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("the cancelled take-over changed the crashed restore: before %s, after %s", before, after)
	}
	// The directory of the marker is still there, so the service stays closed
	// and the crashed restore is still recoverable.
	if _, err = os.Stat(filepath.Join(directory, "restore-fence")); err != nil {
		t.Fatalf("the cancelled take-over removed the marker directory: %v", err)
	}
	// The crashed restore is still the owner of the lifecycle: the recovery
	// of it is not a conflict.
	restored, err := service.BeginFence("restore-crashed", true)
	if err != nil {
		t.Fatalf("the crashed restore is not recoverable: %v", err)
	}
	if err = restored.Cancel(); err != nil {
		t.Fatalf("cancel the take-over of the crashed restore: %v", err)
	}
}

// TestTheCancelledTakeoverOfAnUnreadableMarkerRestoresIt covers a marker
// that cannot be read.
//
// The unknown state of the lifecycle is restored faithfully: the bytes of the
// owner marker are put back, so the operator finds the same state they found
// before the take-over.
func TestTheCancelledTakeoverOfAnUnreadableMarkerRestoresIt(t *testing.T) {
	directory := t.TempDir()
	service := &Service{options: Options{FencePath: directory, Now: time.Now}}
	crashed, err := service.BeginFence("restore-crashed", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	crashed.Release()
	marker := filepath.Join(directory, "restore-fence", "owner")
	if err = os.WriteFile(marker, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write the owner marker: %v", err)
	}
	before, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read the owner marker: %v", err)
	}
	takeover, err := service.BeginFence("restore-takeover", true)
	if err != nil {
		t.Fatalf("take over the fence: %v", err)
	}
	if err = takeover.Cancel(); err != nil {
		t.Fatalf("cancel the take-over: %v", err)
	}
	after, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read the owner marker: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("the cancelled take-over changed the unknown state: before %s, after %s", before, after)
	}
}
