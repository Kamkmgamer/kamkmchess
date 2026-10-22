//go:build !windows

package integration

import (
	"errors"
	"os"
	"path/filepath"
)

// errHostDoesNotRefuseWrite reports that the host does not refuse the write
// of an evidence record, so a regression that needs the refusal cannot prove
// anything here.
var errHostDoesNotRefuseWrite = errors.New("the host does not refuse the write of the evidence")

// evidenceBlockWrite makes the write of an evidence record fail.
//
// A POSIX system refuses to write a record into a directory that is not
// writable, so the helper takes the write permission of the directory away.
// The record itself stays readable, so the obligation it carries survives the
// failure of the write.
//
// The helper proves that the host really refuses the write: it writes a
// record the way the service writes one, a temporary file in the directory
// that is written, flushed and then renamed over its name, and it reports
// that the host does not refuse the write when that write succeeds. A host
// that lets the write through, a container that runs as root and ignores the
// permission of the directory for example, cannot prove the premise of the
// regression, so the helper reports that and the regression skips itself.
//
// The probe writes a record of its own name, so the evidence that is already
// there is never the record the probe replaces.
func evidenceBlockWrite(t interface{ Cleanup(func()) }, directory, _ string) (func(), error) {
	if err := os.Chmod(directory, 0o500); err != nil {
		return nil, err
	}
	release := func() { _ = os.Chmod(directory, 0o700) }
	t.Cleanup(release)
	// The premise of the regression: the write of a record into the
	// directory has to be refused.
	if err := probeEvidenceWrite(directory); err == nil {
		// The host let the write through, so it cannot prove here that the
		// write of the evidence fails. The record the probe wrote is removed
		// again, so the directory carries the evidence alone.
		_ = os.Remove(filepath.Join(directory, ".evidence-write-probe"))
		return nil, errHostDoesNotRefuseWrite
	}
	return release, nil
}

// probeEvidenceWrite writes a record into the directory the way the service
// writes the durable evidence of a restore: a temporary file in the directory
// that is written, flushed and then renamed over its name.
//
// The probe returns the error of the write, so the caller can tell a refused
// write from a write that went through.
func probeEvidenceWrite(directory string) error {
	temporary, err := os.CreateTemp(directory, ".evidence-write-probe-*.partial")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write([]byte("probe")); err != nil {
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
	return os.Rename(name, filepath.Join(directory, ".evidence-write-probe"))
}
