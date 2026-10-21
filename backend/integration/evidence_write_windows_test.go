//go:build windows

package integration

import (
	"os"
	"path/filepath"
)

// evidenceBlockWrite makes the write of an evidence record fail.
//
// Windows refuses to rename a record over a file that is read only, so the
// helper makes the record read only. The record itself stays readable, so the
// obligation it carries survives the failure of the write.
func evidenceBlockWrite(t interface{ Cleanup(func()) }, directory, name string) (func(), error) {
	path := filepath.Join(directory, name)
	if err := os.Chmod(path, 0o400); err != nil {
		return nil, err
	}
	release := func() { _ = os.Chmod(path, 0o600) }
	t.Cleanup(release)
	return release, nil
}
