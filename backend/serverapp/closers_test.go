package serverapp

import (
	"testing"
)

// TestCloserSetReleasesEveryOwnedResource covers the ownership of the
// private rules processes.
//
// The composition owns the shared rules client and the client of the health
// probe. Both are released on every exit, newest first, and a second release
// closes nothing again.
func TestCloserSetReleasesEveryOwnedResource(t *testing.T) {
	owned := &closerSet{}
	closed := []string{}
	owned.own(func() { closed = append(closed, "shared") })
	owned.own(nil)
	owned.own(func() { closed = append(closed, "probe") })
	owned.release()
	if len(closed) != 2 || closed[0] != "probe" || closed[1] != "shared" {
		t.Fatalf("the closed resources = %v, want the probe and then the shared client", closed)
	}
	owned.release()
	if len(closed) != 2 {
		t.Fatalf("the resources were closed twice: %v", closed)
	}
}
