# KHA-72 public profile browser check

From the repository root, run `pnpm dev --port 5183 --strictPort` and open
`http://127.0.0.1:5183/experiments/kha72-profile/index.html`.

The page mounts the real `ProfilePanel` component and the real panel state
machine. Only the profile service is a local stand-in: it answers with a
fixture profile, refuses the name `rookie` the way the service refuses a name
another profile already owns, and accepts a guest link.

The check confirms the interface behaviour that the service fixtures cannot
show: the loaded profile and its public identifier, the name field, the avatar
choice, the saved state, the name-conflict status, the guest-link status, and
the linked guest seat in the list.

It does not reach a network service, a hosted account, a provider, or a
deployed bundle. It does not certify native accessibility, other browsers, or
devices, and it is not production acceptance. The product acceptance scenarios
`HIS-01` and `HIS-02` remain `not_run` in the acceptance matrix.
