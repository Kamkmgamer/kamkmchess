package privacy

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// The durable restore fence.
//
// A restore replaces the schema of the target database. A fence that lives
// inside that schema is replaced with it, so a crash between the import and
// the replay of the removal ledger would leave the restored database with the
// old ledger: the newest removals would be absent, and no state inside the
// database could tell that they are missing.
//
// The fence therefore lives outside the replaced target, in a small file that
// the restore writes before it imports anything and that it removes only after
// the newest merged removal ledger was replayed and verified. The fence
// survives the schema replacement and a process crash, and the service refuses
// to serve while it is open.
//
// The fence is an admission record, never a payload: it holds the identifier
// of the restore, the digest of the removal ledger the restore has to apply,
// and the time the fence was written.

// Fence is the durable record of a restore that is in progress.
type Fence struct {
	// RestoreID identifies the restore.
	RestoreID string `json:"restoreId"`
	// ExpectedLedgerDigest is the digest of the newest merged removal ledger
	// the restore has to apply. A database that does not carry that ledger
	// afterwards was not restored from the expected state.
	ExpectedLedgerDigest string `json:"expectedLedgerDigest"`
	// RecordedAt is when the fence was written.
	RecordedAt time.Time `json:"recordedAt"`
}

// WriteFence opens the durable restore fence.
//
// The fence is written before the restore imports anything, so the restored
// data is never visible while the removal ledger of the restore was not
// applied. The write is atomic, so a reader never sees a half-written fence.
func (s *Service) WriteFence(restoreID string, expectedLedgerDigest []byte) error {
	path := s.options.FencePath
	if path == "" {
		return errors.New("privacy: no restore fence path is configured")
	}
	fence := Fence{
		RestoreID:            restoreID,
		ExpectedLedgerDigest: fmt.Sprintf("%x", expectedLedgerDigest),
		RecordedAt:           s.now(),
	}
	raw, err := json.Marshal(fence)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".restore-fence-*.partial")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write(raw); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	if err = os.Chmod(name, 0o600); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// ClearFence closes the durable restore fence.
//
// The fence is closed only after the removal ledger of the restore was
// replayed and verified. A restore that failed leaves the fence open, so the
// service keeps refusing to serve the restored data.
func (s *Service) ClearFence() error {
	path := s.options.FencePath
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// FenceOpen reports whether the durable restore fence is open.
//
// A fence that cannot be read is an open fence: the service fails closed.
func (s *Service) FenceOpen() (bool, error) {
	path := s.options.FencePath
	if path == "" {
		return false, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return true, err
	}
	var fence Fence
	if err = json.Unmarshal(raw, &fence); err != nil {
		// A fence that cannot be read is an open fence.
		return true, nil
	}
	return true, nil
}

// ReadFence reads the durable restore fence.
//
// A missing fence is reported as a missing fence, not as an error.
func (s *Service) ReadFence() (Fence, bool, error) {
	path := s.options.FencePath
	if path == "" {
		return Fence{}, false, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Fence{}, false, nil
		}
		return Fence{}, false, err
	}
	var fence Fence
	if err = json.Unmarshal(raw, &fence); err != nil {
		return Fence{}, false, fmt.Errorf("privacy: the restore fence is unreadable")
	}
	return fence, true, nil
}
