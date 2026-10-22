//go:build windows

package integration

import "syscall"

// processQueryLimitedInformation is the access right that reads the exit code
// of a process without stopping it.
const processQueryLimitedInformation = 0x1000

// processAlive reports whether a process with the identifier is still running.
//
// The exit code of the process tells the answer: a process that is still
// running has the "still active" exit code, and a process that was terminated
// carries its own exit code instead.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)
	var code uint32
	if err := syscall.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}
