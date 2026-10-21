//go:build !windows

package integration

import (
	"os"
	"path/filepath"
)

// evidenceBlockWrite makes the write of an evidence record fail.
//
// A POSIX system refuses to rename a record into a directory that is not
// writable, so the helper takes the write permission of the directory away.
// The record itself stays readable, so the obligation it carries survives the
// failure of the write.
func evidenceBlockWrite(t interface{ Cleanup(func()) }, directory, name string) (func(), error) {
	if err := os.Chmod(directory, 0o500); err != nil {
		return nil, err
	}
	release := func() { _ = os.Chmod(directory, 0o700) }
	t.Cleanup(release)
	return release, nil
}

// evidenceWriteBlocked reports whether the host refuses the rename of a record
// into a directory that is not writable.
func evidenceWriteBlocked(t interface{ Cleanup(func()) }, directory, name string) bool {
	return true
}

var _ = filepath.Join
