//go:build !unix && !windows

package privacy

// syncDirectory refuses the lifecycle on an unsupported platform.
//
// The name of the marker directory has to be persistent, and a platform
// without a flush of a directory cannot promise it. The restore refuses the
// lifecycle before it mutates anything, so the service keeps serving the
// database it has.
func syncDirectory(path string) error {
	return errUnsupportedPlatform
}
