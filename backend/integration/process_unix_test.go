//go:build !windows

package integration

import (
	"os"
	"syscall"
)

// processAlive reports whether a process with the identifier is still running.
//
// The signal zero asks the kernel about the process without touching it. A
// process that was killed and reaped is gone, so the answer is that it is not
// alive any more.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}
