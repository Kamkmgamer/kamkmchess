package privacy

import (
	"os"
	"sync"
)

// The operating system lock of the restore lifecycle.
//
// The lock is an exclusive, non blocking lock on a file that lives next to the
// marker directory of the lifecycle. It is held by the restore for the whole
// lifecycle, and the operating system releases it when the process dies. It is
// therefore the live ownership proof of the lifecycle:
//
//   - a restore that finds the lock held is refused: a restore is alive;
//   - a closer that does not hold the lock is refused: it cannot mutate the
//     marker directory of a lifecycle it does not own;
//   - the recovery may only take the lock when it is free, which proves that
//     the named restore is not alive any more.
//
// The lock is advisory: it orders the restores and the recovery of this
// repository, and it never guards a state that is not the lifecycle itself.

// fenceLock is a held operating system lock.
type fenceLock struct {
	file *os.File
	// restoreID is the restore that owns the lifecycle, if the lock was taken
	// by a restore.
	restoreID string
	once      sync.Once
}

// acquireFenceLock takes the exclusive lock of the lifecycle.
//
// It returns a nil lock and no error when the lock is held by another process:
// the caller then knows that a restore is alive. The lock file is created when
// it does not exist, so the operator only prepares the parent directory.
func acquireFenceLock(path string) (*fenceLock, error) {
	if path == "" {
		return nil, os.ErrInvalid
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	locked, err := lockFileExclusive(file)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !locked {
		_ = file.Close()
		return nil, nil
	}
	return &fenceLock{file: file}, nil
}

// release gives the lock back. Closing the file releases it on every
// supported platform.
func (l *fenceLock) release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		if l.file != nil {
			_ = unlockFileExclusive(l.file)
			_ = l.file.Close()
		}
	})
}
