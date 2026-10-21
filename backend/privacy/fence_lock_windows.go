//go:build windows

package privacy

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

// The Windows lock of the lifecycle.
//
// LockFileEx is the byte range lock of Windows. It is taken without blocking,
// it belongs to the file handle, and the operating system releases it when the
// handle is closed or when the process dies. The standard library does not
// export it, so the system call is bound directly.
var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx   = kernel32.NewProc("LockFileEx")
	procUnlockFileEx = kernel32.NewProc("UnlockFileEx")
)

const (
	lockfileFailImmediately = 0x00000001
	lockfileExclusiveLock   = 0x00000002
	// errorLockViolation is returned when another handle holds the lock.
	errorLockViolation = syscall.Errno(33)
	// errorSharingViolation is returned when the file cannot be locked.
	errorSharingViolation = syscall.Errno(32)
)

// lockFileExclusive takes the exclusive lock of the file without blocking.
//
// The lock belongs to the handle, so a second handle of the same file in the
// same process is refused as well: two restores of one process cannot share
// the lifecycle either.
func lockFileExclusive(file *os.File) (bool, error) {
	var overlapped syscall.Overlapped
	handle := syscall.Handle(file.Fd())
	result, _, err := procLockFileEx.Call(
		uintptr(handle),
		uintptr(lockfileExclusiveLock|lockfileFailImmediately),
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&overlapped)),
	)
	if result != 0 {
		return true, nil
	}
	if errno, ok := err.(syscall.Errno); ok {
		if errno == errorLockViolation || errno == errorSharingViolation {
			return false, nil
		}
		return false, errno
	}
	if err != nil && !errors.Is(err, syscall.Errno(0)) {
		return false, err
	}
	return false, errors.New("privacy: the restore fence could not be locked")
}

// unlockFileExclusive gives the lock back.
func unlockFileExclusive(file *os.File) error {
	var overlapped syscall.Overlapped
	handle := syscall.Handle(file.Fd())
	result, _, err := procUnlockFileEx.Call(
		uintptr(handle),
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&overlapped)),
	)
	if result != 0 {
		return nil
	}
	if errno, ok := err.(syscall.Errno); ok {
		return errno
	}
	return nil
}
