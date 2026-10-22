//go:build !unix && !windows

package privacy

import (
	"errors"
	"os"
)

// The platforms without an advisory file lock and without the byte range lock
// of Windows.
//
// The ownership of the restore lifecycle is a cross process lock. A platform
// that has neither of them cannot guarantee that only one restore is in
// progress, so the tool refuses the lifecycle *before* it mutates anything:
// the restore is refused, and the service keeps serving the database it has.
//
// The deployment runs on Linux, where the lock is an advisory file lock, and
// on Windows, where it is the byte range lock of LockFileEx.

var errUnsupportedPlatform = errors.New("privacy: the restore fence is not supported on this platform")

// lockFileExclusive refuses the lifecycle on an unsupported platform.
func lockFileExclusive(file *os.File) (bool, error) {
	return false, errUnsupportedPlatform
}

// unlockFileExclusive refuses the lifecycle on an unsupported platform.
func unlockFileExclusive(file *os.File) error {
	return errUnsupportedPlatform
}
