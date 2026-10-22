//go:build windows

package integration

import (
	"os"
	"path/filepath"
	"syscall"
)

// evidenceHoldRemoval makes the removal of an evidence record fail.
//
// Windows refuses to remove a file that another process holds open without the
// delete share, so the helper opens the record with that share and keeps the
// handle until the caller releases it. The evidence of a restore is read
// exactly as before, so only the removal fails.
func evidenceHoldRemoval(t interface{ Cleanup(func()) }, directory, name string) (func(), error) {
	path := filepath.Join(directory, name)
	pointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(pointer, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	release := func() { _ = syscall.CloseHandle(handle) }
	t.Cleanup(release)
	// The premise of the regression: the removal of the record has to be
	// refused.
	if err = os.Remove(path); err == nil {
		return nil, errHostDoesNotRefuseRemoval
	}
	return release, nil
}
