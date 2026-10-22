//go:build unix

package privacy

import "os"

// syncDirectory makes the entries of a directory persistent.
//
// The name of the lock directory and the name of the owner marker have to
// survive a crash of the host, or the fence could be lost and the service
// would serve a database whose removals were never replayed.
func syncDirectory(path string) error {
	if path == "" {
		return nil
	}
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
