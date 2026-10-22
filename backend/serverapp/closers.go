package serverapp

// The closer set of a composition.
//
// The composition owns the private rules processes: the shared one and the
// one of the health probe. Every owned resource is released exactly once, in
// reverse order of ownership, on every exit of the composition. A failed start
// therefore leaves no rules worker process behind, and the release of a
// running server closes both of them.
type closerSet struct {
	closers []func()
}

// own takes the ownership of one resource.
func (c *closerSet) own(closer func()) {
	if closer == nil {
		return
	}
	c.closers = append(c.closers, closer)
}

// release closes every owned resource, newest first.
//
// The set is emptied, so a second release closes nothing again.
func (c *closerSet) release() {
	for index := len(c.closers) - 1; index >= 0; index-- {
		c.closers[index]()
	}
	c.closers = nil
}
