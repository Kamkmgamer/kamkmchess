//go:build windows

package privacy

// syncDirectory makes the entries of a directory persistent.
//
// Windows does not support flushing a directory handle: FlushFileBuffers
// fails with ERROR_INVALID_HANDLE on a directory, and the standard library
// offers no way around it. The owner marker itself is flushed with
// file.Sync, so its content is persistent, and the name of the lock directory
// is made persistent by the file system when the marker inside it is written.
// The limit is stated here and in the contract: on Windows the tool cannot
// force the metadata of the parent directory to disk, so the durability of the
// fence against a power loss of the host is the guarantee of the file system
// and not a guarantee of the tool.
func syncDirectory(path string) error {
	return nil
}
