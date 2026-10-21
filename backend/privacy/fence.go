package privacy

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
)

// The durable restore fence.
//
// A restore replaces the schema of the target database. A fence that lives
// inside that schema is replaced with it, so a crash between the import and
// the replay of the removal ledger would leave the restored database with the
// old ledger: the newest removals would be absent, and no state inside the
// database could tell that they are missing.
//
// The fence therefore lives outside the restored database. The configured path
// is the *parent* directory that the operator prepares; the lifecycle owns a
// marker directory inside it:
//
//	<parent>/restore-fence/         the marker directory
//	<parent>/restore-fence/owner    the owner marker of the lifecycle
//	<parent>/restore-fence.lock     the operating system lock of the lifecycle
//
// The lock file carries an operating system lock that the restore holds for
// the whole lifecycle, from the admission of the restore until the fence is
// closed. It is the live ownership proof: it is held only by a running
// restore, and the operating system releases it when that process dies. A
// restore that finds the lock held is refused, a closer that does not own the
// lifecycle is refused, and the recovery of a crashed restore may only run
// when the lock is free, which proves that the named restore is not alive.
//
// The marker directory is the crash persistent, fail closed part: it exists
// while a restore is in progress and while a crashed restore waits for an
// operator, and it is never removed before a new marker replaced it. The
// service refuses to serve while it exists.
//
// The fence is an admission record, never a payload: the owner marker holds
// the identifier of the restore, the digest of the removal ledger the restore
// has to apply, a random ownership token and the time the fence was written.
//
// The permissions of the parent directory are the operator's decision: the
// restore tool has to create the marker and the durable evidence of the
// removal ledger, and the service has to be able to *stat* the marker
// directory, so the service account needs traverse permission on the parent
// directory and nothing more. The service never reads the owner marker and
// never reads the durable evidence: the marker directory is the whole of what
// it observes.

const (
	// fenceLockName is the name of the marker directory of the restore
	// lifecycle inside the configured parent directory.
	fenceLockName = "restore-fence"
	// fenceLockFileName is the name of the file that carries the operating
	// system lock of the lifecycle. It is a sibling of the marker directory,
	// so it survives the removal of the directory.
	fenceLockFileName = "restore-fence.lock"
	// fenceOwnerName is the owner marker inside the marker directory.
	fenceOwnerName = "owner"
)

// ErrFenceConflict is returned when the fence belongs to another restore.
var ErrFenceConflict = errors.New("privacy: the restore fence belongs to another restore")

// ErrFenceLive is returned when a restore holds the fence of the lifecycle.
var ErrFenceLive = errors.New("privacy: a restore is in progress")

// restoreIDPattern is the shape of a restore identifier.
//
// The identifier becomes a file name, so it may not carry a path separator
// and it may not be empty.
var restoreIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$`)

// Fence is the durable record of a restore that is in progress.
type Fence struct {
	// RestoreID identifies the restore.
	RestoreID string `json:"restoreId"`
	// ExpectedLedgerDigest is the digest of the removal ledger the restore has
	// to apply. A database that does not carry that ledger afterwards was not
	// restored from the expected state.
	//
	// The digest names the durable evidence of the ledger, which lives next
	// to the marker of the lifecycle and survives the import of the restore.
	ExpectedLedgerDigest string `json:"expectedLedgerDigest"`
	// OwnershipToken proves that the caller of the close is the restore that
	// opened the fence. It is a random value and it never leaves the process.
	OwnershipToken string `json:"ownershipToken"`
	// RecordedAt is when the fence was written.
	RecordedAt time.Time `json:"recordedAt"`
}

// FenceHandle is the ownership of the restore lifecycle.
//
// The handle holds the operating system lock of the lifecycle, so the
// ownership is exclusive across processes for the whole lifecycle of the
// restore: from the admission of the restore until the fence is closed. The
// handle is the only thing that may finish or release the lifecycle, and the
// close of the fence uses the handle instead of taking the lock again.
//
// A restore that crashes never finishes its handle. The operating system
// releases the lock when the process dies, and the marker of the lifecycle
// survives, so the service stays closed until an operator resolves the
// restore.
type FenceHandle struct {
	service   *Service
	lock      *fenceLock
	restoreID string
	token     string
	finished  bool
}

// Token is the ownership token of the lifecycle.
func (h *FenceHandle) Token() string {
	if h == nil {
		return ""
	}
	return h.token
}

// Bind records the removal ledger the restore has to apply in the marker of
// the lifecycle.
//
// The marker is replaced atomically inside the marker directory, so the
// marker of the lifecycle never disappears and the service stays closed.
//
// The removal ledger itself is written as durable evidence next to the marker
// of the lifecycle, before the marker names it. The evidence is the complete
// ledger the restore has to apply, including the removals that only the live
// database carried: the import of the restore destroys them, so a digest
// alone could never be rebuilt afterwards. The marker names the digest of the
// evidence, and the evidence is written and flushed before the import starts.
func (h *FenceHandle) Bind(required backup.AppliedRemovalLedger) error {
	if h == nil || h.service == nil {
		return errors.New("privacy: there is no restore fence to bind")
	}
	if h.finished {
		return errors.New("privacy: the restore fence is already closed")
	}
	existing, open, err := readFenceMarker(h.service.fenceDirectory())
	if err != nil {
		return err
	}
	if !open {
		return errors.New("privacy: the restore fence is not there")
	}
	if existing.RestoreID != h.restoreID || existing.OwnershipToken != h.token {
		return errors.New("privacy: the caller does not own the restore fence")
	}
	record := RemovalRequirement{
		RestoreID:  h.restoreID,
		Digest:     requirementDigest(required),
		Matches:    required.Matches,
		Subjects:   required.Subjects,
		RecordedAt: h.service.now(),
	}
	// The evidence is on the disk before the marker names it: a marker never
	// names a removal ledger whose evidence is missing.
	if err = h.service.writeRequirement(record); err != nil {
		return err
	}
	fence := Fence{
		RestoreID:            h.restoreID,
		ExpectedLedgerDigest: record.Digest,
		OwnershipToken:       h.token,
		RecordedAt:           existing.RecordedAt,
	}
	raw, err := json.Marshal(fence)
	if err != nil {
		return err
	}
	return h.service.writeOwnerMarker(h.service.fenceDirectory(), raw)
}

// Finish closes the fence of the lifecycle.
//
// The close verifies the owner marker of the lifecycle - the identifier, the
// ownership token and the digest of the removal ledger - and it verifies that
// the removal ledger the marker names is applied in the database. A marker
// that names no removal ledger was never bound, so there is nothing to
// verify and the close refuses it.
//
// A marker directory without an owner marker is an unknown state: the service
// decides with the marker directory, so the close may not report a closed
// fence while the directory is still there.
//
// The durable evidence that the database holds is discharged **while the
// ownership of the lifecycle is still held** and before the marker of the
// lifecycle is removed. A restore that takes the lifecycle after this close
// binds its own evidence, and the discharge of this close must not delete it:
// the removals of that restore would be lost with it. A close that cannot
// discharge the evidence fails with the marker of the lifecycle in place, so
// the service stays closed and the restore has to be run again.
//
// The marker is removed under the lock the handle holds, so no other restore
// can take the lifecycle in the middle of the close.
func (h *FenceHandle) Finish(applied backup.AppliedRemovalLedger) error {
	if h == nil || h.service == nil {
		return errors.New("privacy: there is no restore fence to close")
	}
	if h.finished {
		return errors.New("privacy: the restore fence is already closed")
	}
	directory := h.service.fenceDirectory()
	if _, err := os.Stat(directory); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// The fence is already closed. The close is idempotent.
			h.finished = true
			h.lock.release()
			return nil
		}
		return err
	}
	existing, open, err := readFenceMarker(directory)
	if err != nil {
		return err
	}
	if !open {
		// The marker directory is there, but its owner marker is not. The
		// state is unknown, and the service still refuses to serve because of
		// the marker directory: the close may not report a closed fence.
		return errors.New("privacy: the restore fence has no owner marker; the close of the fence is refused")
	}
	if existing.RestoreID != h.restoreID {
		return fmt.Errorf("privacy: the open fence belongs to the restore %q", existing.RestoreID)
	}
	if existing.OwnershipToken != h.token {
		return errors.New("privacy: the caller does not own the restore fence")
	}
	// A marker that names no removal ledger was never bound, so there is
	// nothing to compare with. A bound marker is closed only for the ledger it
	// names.
	if existing.ExpectedLedgerDigest == "" {
		return errors.New("privacy: the restore fence names no removal ledger; the close of the fence is refused")
	}
	required, found, err := h.service.readRequirement(existing.ExpectedLedgerDigest)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("privacy: the durable evidence of the removal ledger of the restore is missing")
	}
	if !backup.RemovalLedgerContains(applied, required.Ledger()) {
		return errors.New("privacy: the applied removal ledger is not the ledger of the restore")
	}
	// The evidence that the database holds is discharged while the ownership
	// of the lifecycle is still held, so a restore that takes the lifecycle
	// after this close cannot have its own evidence deleted by it. The
	// evidence of this restore is kept: it is discharged by the next restore,
	// which holds the very same removals.
	if err = h.service.dischargeRequirements(applied, h.restoreID); err != nil {
		return err
	}
	if err = h.service.removeFenceDirectory(); err != nil {
		return err
	}
	h.finished = true
	h.lock.release()
	return nil
}

// Release gives the ownership of the lifecycle back without closing the
// fence.
//
// The marker of the lifecycle survives, so the service stays closed. It is
// the path of a restore that could not finish: the operator resolves the
// restore with the recovery or with a take-over.
func (h *FenceHandle) Release() {
	if h == nil || h.finished {
		return
	}
	h.finished = true
	h.lock.release()
}

// BeginFence takes the ownership of the restore lifecycle.
//
// The ownership is the operating system lock of the lifecycle, and it is held
// until the handle is finished or released. A restore that finds the lock
// held is refused: a restore is alive, even when it has the same identifier.
//
// The marker directory of the lifecycle is the crash persistent, fail closed
// part. It is created when it does not exist. When a crashed restore left its
// marker behind, only a take-over may continue the lifecycle, and the take
// over replaces the owner marker *inside* the existing marker directory: the
// marker never disappears, so the service stays closed while the take-over
// runs, and a failure of the take-over leaves the marker of the crashed
// restore in place.
func (s *Service) BeginFence(restoreID string, takeover bool) (*FenceHandle, error) {
	restoreID = strings.TrimSpace(restoreID)
	if !restoreIDPattern.MatchString(restoreID) {
		return nil, errors.New("privacy: the restore identifier is not usable as a fence name")
	}
	parent := s.fenceParent()
	if parent == "" {
		return nil, errors.New("privacy: no restore fence path is configured")
	}
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, err
	}
	// The operating system lock is the live ownership proof of the lifecycle.
	lock, err := acquireFenceLock(s.fenceLockPath())
	if err != nil {
		return nil, err
	}
	if lock == nil {
		return nil, ErrFenceLive
	}
	release := true
	defer func() {
		if release {
			lock.release()
		}
	}()
	token, err := newOwnershipToken()
	if err != nil {
		return nil, err
	}
	// The digest of the removal ledger the restore has to apply is bound
	// after the ledgers were read, with Bind.
	fence := Fence{
		RestoreID:      restoreID,
		OwnershipToken: token,
		RecordedAt:     s.now(),
	}
	raw, err := json.Marshal(fence)
	if err != nil {
		return nil, err
	}
	directory := s.fenceDirectory()
	_, statErr := os.Stat(directory)
	switch {
	case statErr == nil:
		// The marker of a crashed restore is there. Only a take-over may
		// continue the lifecycle.
		if !takeover {
			return nil, errors.New("privacy: the fence of a crashed restore is still there; recover it or run the restore with the take-over")
		}
		if err = s.writeOwnerMarker(directory, raw); err != nil {
			return nil, err
		}
	case errors.Is(statErr, os.ErrNotExist):
		if err = s.createMarkerDirectory(directory, raw); err != nil {
			return nil, err
		}
	default:
		return nil, statErr
	}
	release = false
	return &FenceHandle{service: s, lock: lock, restoreID: restoreID, token: token}, nil
}

// createMarkerDirectory creates the marker directory of the lifecycle and
// writes its owner marker.
//
// The order of the writes is the order of the durability: the owner marker is
// flushed before the directory that holds it, and the directory is flushed in
// the parent that holds it. A crash of the host between the two steps leaves
// a marker without an owner file, which is still an open fence: the service
// fails closed.
func (s *Service) createMarkerDirectory(directory string, raw []byte) error {
	if err := os.Mkdir(directory, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return errors.New("privacy: the fence of a crashed restore is still there; recover it or run the restore with the take-over")
		}
		return err
	}
	if err := s.writeOwnerMarker(directory, raw); err != nil {
		return err
	}
	// The name of the marker directory has to be persistent in its parent.
	return syncDirectory(s.fenceParent())
}

// writeOwnerMarker writes the owner marker of the lifecycle.
//
// The marker is written to a temporary file in the marker directory, flushed,
// and then renamed over the owner marker. The rename is atomic, so the marker
// of the lifecycle never disappears: a take-over that fails leaves the marker
// of the crashed restore in place and the service stays closed.
func (s *Service) writeOwnerMarker(directory string, raw []byte) error {
	temporary, err := os.CreateTemp(directory, ".owner-*.partial")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write(raw); err != nil {
		_ = temporary.Close()
		return err
	}
	if err = temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	if err = os.Chmod(name, 0o600); err != nil {
		return err
	}
	if err = os.Rename(name, filepath.Join(directory, fenceOwnerName)); err != nil {
		return err
	}
	// The name of the owner marker has to be persistent in its directory.
	return syncDirectory(directory)
}

// FenceOpen reports whether a durable restore fence is open.
//
// The fence fails closed: every state that is not "no lifecycle at all" is an
// open fence. A marker directory that cannot be read, a marker directory
// without an owner marker and a fence file of an older layout are all open
// fences, so the service refuses to serve instead of serving a database whose
// removals were never replayed.
func (s *Service) FenceOpen() (bool, error) {
	parent := s.fenceParent()
	if parent == "" {
		return false, nil
	}
	info, err := os.Stat(parent)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return true, err
	}
	if !info.IsDir() {
		// A fence of the older layout is a file at the configured path. It is
		// not a parent directory of a marker directory, so the lifecycle
		// cannot be over: the service fails closed.
		return true, nil
	}
	if _, err = os.Stat(s.fenceDirectory()); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return true, err
	}
	return true, nil
}

// ReadFence reads the durable restore fence.
//
// A missing fence is reported as a missing fence, not as an error. The fence
// of another restore is reported as a conflict, so a caller never mistakes
// the fence of another restore for a fence that is not there.
func (s *Service) ReadFence(restoreID string) (Fence, bool, error) {
	if s.fenceParent() == "" {
		return Fence{}, false, nil
	}
	fence, open, err := readFenceMarker(s.fenceDirectory())
	if err != nil {
		return Fence{}, false, err
	}
	if !open {
		return Fence{}, false, nil
	}
	if restoreID != "" && fence.RestoreID != restoreID {
		return Fence{}, false, ErrFenceConflict
	}
	return fence, true, nil
}

// removeFenceDirectory removes the marker and the marker directory of the
// lifecycle.
//
// The caller has to hold the operating system lock of the lifecycle, so the
// removal is exclusive and a restore that took over in the meantime keeps
// its own marker.
func (s *Service) removeFenceDirectory() error {
	directory := s.fenceDirectory()
	if err := os.Remove(filepath.Join(directory, fenceOwnerName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(s.fenceParent())
}

// fenceParent is the configured parent directory of the fence.
func (s *Service) fenceParent() string {
	return strings.TrimSpace(s.options.FencePath)
}

// fenceDirectory is the marker directory of the lifecycle.
func (s *Service) fenceDirectory() string {
	return filepath.Join(s.fenceParent(), fenceLockName)
}

// fenceLockPath is the file that carries the operating system lock.
func (s *Service) fenceLockPath() string {
	return filepath.Join(s.fenceParent(), fenceLockFileName)
}

// readFenceMarker reads the owner marker of the marker directory.
func readFenceMarker(directory string) (Fence, bool, error) {
	raw, err := os.ReadFile(filepath.Join(directory, fenceOwnerName))
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

// fenceMarkerState is the state of the marker of the lifecycle.
//
// The states are told apart, because a marker directory without a readable
// owner marker is not the same as no marker at all: the first is an unknown
// state of a lifecycle that existed, and the second is the absence of one.
type fenceMarkerState int

const (
	// fenceMarkerAbsent means there is no marker directory at all.
	fenceMarkerAbsent fenceMarkerState = iota
	// fenceMarkerOwned means the marker directory carries a readable owner
	// marker.
	fenceMarkerOwned
	// fenceMarkerUnreadable means the marker directory exists but its owner
	// marker cannot be read.
	fenceMarkerUnreadable
)

// fenceMarkerState reads the state of the marker of the lifecycle.
//
// The state fails closed: a marker directory that cannot be read at all is an
// unknown state, not the absence of a lifecycle.
func (s *Service) fenceMarkerState() (fenceMarkerState, Fence, error) {
	directory := s.fenceDirectory()
	if _, err := os.Stat(directory); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fenceMarkerAbsent, Fence{}, nil
		}
		return fenceMarkerUnreadable, Fence{}, err
	}
	fence, open, err := readFenceMarker(directory)
	if err != nil {
		return fenceMarkerUnreadable, Fence{}, err
	}
	if !open {
		return fenceMarkerUnreadable, Fence{}, nil
	}
	return fenceMarkerOwned, fence, nil
}

// newOwnershipToken returns the proof that the caller of a close owns the
// fence.
func newOwnershipToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("privacy: secure random source unavailable")
	}
	return hex.EncodeToString(raw), nil
}
