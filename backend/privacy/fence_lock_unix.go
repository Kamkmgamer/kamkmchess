//go:build unix

package privacy

import (
	"errors"
	"os"
	"syscall"
)

// lockFileExclusive takes the exclusive lock of the file without blocking.
//
// The lock belongs to the open file description, so a second lock of the same
// file in the same process is refused as well: two restores of one process
// cannot share the lifecycle either.
func lockFileExclusive(file *os.File) (bool, error) {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return false, nil
	}
	return false, err
}

// unlockFileExclusive gives the lock back.
func unlockFileExclusive(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}
