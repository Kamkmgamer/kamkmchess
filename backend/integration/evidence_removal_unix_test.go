//go:build !windows

package integration

import (
	"os"
	"path/filepath"
)

// evidenceHoldRemoval makes the removal of an evidence record fail.
//
// A POSIX system refuses to remove a file of a directory that is not
// writable, so the helper takes the write permission of the directory away
// until the caller releases it. The evidence of a restore is read exactly as
// before, so only the removal fails.
func evidenceHoldRemoval(t interface{ Cleanup(func()) }, directory, name string) (func(), error) {
	probe := filepath.Join(directory, ".evidence-removal-probe")
	if err := os.WriteFile(probe, []byte("probe"), 0o600); err != nil {
		return nil, err
	}
	if err := os.Chmod(directory, 0o500); err != nil {
		return nil, err
	}
	release := func() { _ = os.Chmod(directory, 0o700) }
	t.Cleanup(release)
	// The premise of the regression: the removal of a record of the directory
	// has to be refused.
	if err := os.Remove(probe); err == nil {
		return nil, errHostDoesNotRefuseRemoval
	}
	return release, nil
}
