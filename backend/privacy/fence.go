package privacy

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

// OpenFence opens the durable restore fence of one restore.
//
// The fence is owned exclusively by the restore that opened it. The file is
// created exclusively, so two restores that start at the same time cannot take
// the same fence: the second one is refused instead of overwriting the fence
// of the first. The same restore with the same ledger is idempotent, and the
// same restore with a different ledger is refused.
//
// The digest is the digest of the removal ledger the restore has to apply, so
// the fence states what the restore owes.
func (s *Service) OpenFence(restoreID string, expectedDigest []byte) error {
	restoreID = strings.TrimSpace(restoreID)
	if restoreID == "" {
		return errors.New("privacy: the restore needs an identifier")
	}
	path := s.options.FencePath
	if path == "" {
		return errors.New("privacy: no restore fence path is configured")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	fence := Fence{
		RestoreID:            restoreID,
		ExpectedLedgerDigest: fmt.Sprintf("%x", expectedDigest),
		RecordedAt:           s.now(),
	}
	raw, err := json.Marshal(fence)
	if err != nil {
		return err
	}
	// The exclusive create is the ownership: only one restore can hold the
	// fence, and the holder is the one that created the file.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		existing, open, readErr := s.ReadFence()
		if readErr != nil {
			return readErr
		}
		if !open {
			return errors.New("privacy: the restore fence is unreadable")
		}
		if existing.RestoreID != restoreID {
			return fmt.Errorf("privacy: the restore %q is already in progress", existing.RestoreID)
		}
		if existing.ExpectedLedgerDigest != fence.ExpectedLedgerDigest {
			return errors.New("privacy: the open fence names another removal ledger")
		}
		return nil
	}
	defer file.Close()
	if _, err = file.Write(raw); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	return nil
}

// CloseFence closes the durable restore fence of one restore.
//
// The fence is closed only when the restore that opened it applied the ledger
// the fence names. A different restore, or a different ledger, is refused. The
// fence is moved aside before it is read, so a fence that another restore
// replaced in the meantime is put back instead of being removed.
func (s *Service) CloseFence(restoreID string, appliedDigest []byte) error {
	restoreID = strings.TrimSpace(restoreID)
	if restoreID == "" {
		return errors.New("privacy: the restore needs an identifier")
	}
	path := s.options.FencePath
	if path == "" {
		return errors.New("privacy: no restore fence path is configured")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("privacy: no restore fence is open")
		}
		return err
	}
	var fence Fence
	if err = json.Unmarshal(raw, &fence); err != nil {
		return errors.New("privacy: the restore fence is unreadable")
	}
	if fence.RestoreID != restoreID {
		return fmt.Errorf("privacy: the open fence belongs to the restore %q", fence.RestoreID)
	}
	if fence.ExpectedLedgerDigest != fmt.Sprintf("%x", appliedDigest) {
		return errors.New("privacy: the applied removal ledger is not the ledger of the restore")
	}
	if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
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
