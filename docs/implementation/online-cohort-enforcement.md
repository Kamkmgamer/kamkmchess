# The enforced account cohort

This note records the enforcement of `ONLINE_FRIEND_COHORT` and
`ONLINE_QUEUE_COHORT`. It is the implementation report of the finding that
the two settings were read by nothing, and it states what is proven and what
is not.

The contract of the settings is
[docs/architecture/online-operations-contract.md](../architecture/online-operations-contract.md):
both are optional comma-separated account identifiers, an empty list means
every signed-in account, a cohort narrows **account** access only, and a guest
is never excluded by it.

## What was wrong

- `serverapp.Load` read only `ONLINE_FRIEND_ENABLED` and
  `ONLINE_QUEUE_ENABLED`. The two cohort settings were never read, so the
  request path admitted every signed-in account.
- `.env.example` did not name them, so a local operator had nothing to set.
- The release gate marked the requirement `cohort` as met whenever
  `docs/evidence/online/release-decisions/<gate>-cohort.json` named at least
  one account, while the rollout packet told the operator to set a variable
  the server ignored. An owner who followed the packet would have believed
  that the access was restricted while every signed-in account was admitted.
- The recorded cohort was a plain list of account subjects in the tracked
  evidence tree, and the packet copied that list into its configuration and
  printed it. A packet, a committed record or a CI artifact therefore
  disclosed private account subjects to every reader of the repository, of a
  pull request and of an artifact store. The subjects are private and never
  leave the server, so the tooling may not print them.

## What is implemented

### The configuration

`backend/cohort` owns the setting. `cohort.Parse` reads the comma-separated
identifiers of a setting, and the parser is well defined:

- every token is trimmed,
- an empty token is ignored, so a trailing or a doubled comma changes
  nothing,
- a repeated identifier is kept once, and the first occurrence wins,
- the identifiers keep the order of the setting.

`cohort.Cohort.Allows` narrows a participant of kind `account` only. Every
other participant, a guest included, is allowed, so a cohort can never
exclude a guest. The empty cohort allows every account, which keeps the
default of the server configuration unchanged.

`serverapp.Load` reads `ONLINE_FRIEND_COHORT` and `ONLINE_QUEUE_COHORT` into
the online configuration, and `serverapp.Open` passes the cohort into the
request path of the friend surface and of the public queue.

### Which identifier a cohort names

An account identifier of a cohort is the **opaque account subject** of a
signed-in account: the identifier that the verified session carries, for
example the Clerk user id (`user_2abc…`) of the `sub` claim. The cohort
compares it exactly with the account of the request.

It is **not** a public username, an email address or a display name. A named
challenge is addressed by the public username of its recipient, and the
service resolves that name to the account subject itself; a cohort that holds
usernames therefore matches no account at all. Such a cohort admits nobody,
and the guests stay admitted, so the surface looks open while it is closed.
The identifier is private: it never leaves the server, it never appears in a
public answer, and the recorded cohort of the release gate is operator
material.

### The request path

`backend/httpapi/cohort.go` owns the account authorization seam of the HTTP
layer. `httpapi.AccountAuthorizer` is the generic seam, and the friend
routes and the queue routes ask it after the authentication and before the
service is called.

- An account that the cohort does not name is refused with `403`
  `not_authorized`. The refusal happens before the service is reached, so it
  never reveals whether an invitation or a queue entry exists, and the answer
  is the same for every caller.
- A guest is never refused. The friend surface keeps its guest path: a guest
  creates a friend link, and a guest finishes an invitation that was issued
  while friend play was enabled, even after the switch closed.
- The narrowing is scoped to the friend and the queue surfaces. The
  participant surface keeps serving a match that already exists, so a cohort
  never invalidates a running game.
- The queue keeps its own rules: it is account-only, it adds no owner game
  cap, and the cohort narrows the accounts that may enter it.

### The owner recovery of an invitation

A cohort narrows the account access of a surface, and it must never strand an
invitation that was issued while the surface was open. The owner of an
invitation therefore keeps the preview and the cancellation of the invitation
it owns:

- The **owner token** of the invitation is the proof of the ownership, and it
  travels in the dedicated private header of the surface.
- The **account identity** of the inviter is the proof of the ownership for
  the cancellation, exactly like it is for the service itself.

The proof is read before the service is called, and it covers the invitation
of the request and nothing else:

- an excluded account without any owner credential is refused exactly like it
  is refused on every other route of the surface,
- a proof that fails is answered exactly like an unknown invitation
  (`404 not_found`), so a wrong owner token is indistinguishable from an
  invitation that was never issued,
- the creation of an invitation, the acceptance of a challenge, the seat
  credential and every other route stay refused for the excluded account,
- a service that cannot prove the ownership fails closed.

`invite.Service.OwnsInvitation` is the read-only proof. It changes nothing,
it opens no transaction and it answers no state of the invitation.

### The release gate

`scripts/online/cohort-enforcement.mjs` audits the enforcement, and
`scripts/online/feature-gates.mjs` reports it as the requirement
`cohort-enforcement` of both gates. The audit has two parts and both have to
hold.

- The executable part runs the named enforcement tests of the tree
  (`go test -count=1 -v -run '^TestTheCohort' ./backend/cohort/
  ./backend/httpapi/ ./backend/serverapp/`) and requires every one of them to
  report a pass. A tree without those tests, a missing toolchain, a failed
  run, a run that exceeded its budget and a test that did not run are all
  blockers.
- The proof of the wiring is part of that run.
  `backend/serverapp/cohort_wiring_test.go` reads the composition
  `backend/serverapp/server.go` with the parser of Go and proves four facts
  for every surface: the server reads the setting into the online
  configuration, the configuration carries the cohort, the composition hands
  the cohort of the configuration to the constructor of the surface, and the
  request path of the surface asks the cohort. The proof prints the marker
  `COHORT-WIRING <surface>=proven` for every surface it proved, and the audit
  requires the marker of every surface of the gate.

The audit never claims the wiring from a string of the source. A text of the
composition can name an assignment that no longer runs, so a composition whose
wiring was commented out, a composition that reads the setting and then
ignores it, and a tree without the proof are all blockers.

The requirement `cohort` stays the requirement of the *recorded* cohort, and
its detail says that the recorded set is not the enforcement. The requirement
`runtime-cohort` is the measurement of the cohort of the **running** server:
it stays unmet while no host record names the runtime cohort, while the host
record is not verified, or while the measured cohort differs from the recorded
one.

### The privacy of the cohort

The account subjects of a cohort are private: they are read from the verified
session and they never leave the server. The release gate therefore never
stores, prints or transmits them.

The subjects live in one protected operator input outside the tracked tree
(`.secrets/online-cohort/<gate>-cohort.json`, ignored by git, or another path
named with `--cohort-input`). The evidence tree carries only the **commitment**
and the **count** of the set: the SHA-256 digest of its canonical form, under
the algorithm `sha256-canonical-set-v1`.

The gate compares the two cohorts through their commitments. It recomputes the
commitment of the protected input and compares it with the commitment of the
host record, so the runtime cohort blocks unless the host carries exactly the
recorded set of accounts. No account subject of either side is read into a
report, a packet or a line of stdout, and a recorded evidence or a host
record that carries raw subjects instead of a commitment is an unmet
requirement, never a cohort.

The rollout packet carries the cohort setting, the count and the commitment of
the cohort. It is `deployable` only when every requirement of the gate is met
and the recorded cohort names at least one account. The gate never reports an
enforcement it did not observe, so an unimplemented or unverified enforcement
leaves the gate blocked.

### The constructor of the public queue

The public queue has exactly one constructor, `httpapi.NewQueue`, and it
takes the options of the queue. A second constructor that took the options of
another surface would drop the cohort on the way in and would admit every
signed-in account, so the wrapper does not exist.
`backend/httpapi/queue_constructor_test.go` reads the sources of the package
and fails when a second constructor appears.

## The tests

| Test | What it proves |
| --- | --- |
| `backend/cohort/cohort_test.go` | The parser trims, ignores empty tokens and keeps one copy of a repeated identifier. The empty cohort admits every account. A cohort never excludes a guest. |
| `backend/serverapp/cohort_test.go` | The two settings are read into the configuration, they are independent of each other, and an unset setting is the empty cohort. |
| `backend/serverapp/cohort_wiring_test.go` | The composition reads the setting, carries the cohort, hands it to the constructor of the surface, and the request path asks the cohort. The test prints the marker of every surface it proved. |
| `backend/httpapi/cohort_test.go` | The request path refuses an excluded account on the friend surface and on the queue surface, never refuses a guest, admits every account when the cohort is empty, and never narrows a match that already exists. |
| `backend/httpapi/friends_cohort_test.go` | The excluded owner keeps the preview and the cancellation of the invitation it owns, an account that owns nothing is refused, a wrong owner token is answered like an unknown invitation, and the creation, the acceptance and the seat credential stay refused. |
| `backend/httpapi/queue_constructor_test.go` | The package carries exactly one constructor of the public queue, it takes the options of the queue and it hands them to the request path. |
| `backend/integration/online_cohort_test.go` | The composed service reads the setting and narrows both surfaces, a guest creates a link and finishes an invitation that was issued while the surface was open, and the account of a running match keeps its match. |
| `scripts/online/cohort-enforcement.test.mjs` | The audit reports a missing composition, a missing test, a failed run, a test that did not run, a missing toolchain and a run that did not prove the wiring. The audit fails closed on a composition whose wiring was commented out, and the gate keeps the requirement unmet until the enforcement is observed. The gate of the release keeps the runtime cohort unmet while the host proof is missing, and the packet of a gate without a recorded cohort names no account and is not deployable. |
| `scripts/online/cohort-commitment.test.mjs` | The commitment of a set is canonical, order independent and set sensitive. A protected input inside the tracked tree is refused. A synthetic account subject never reaches the material of the gate, the packet, the report or stdout, while a matching commitment passes the runtime cohort and a changed cohort blocks it. |

The commands:

```
go test ./backend/cohort/ ./backend/httpapi/ ./backend/serverapp/ -run Cohort -v
go test ./backend/integration/ -run TestPostgresTheCohort -v
node --test scripts/online/cohort-enforcement.test.mjs
node --test scripts/online/cohort-commitment.test.mjs
node scripts/online/cohort-enforcement.mjs --gate friend
node scripts/online/feature-gates.mjs evaluate --gate friend
```

## The limits

- The gate proves the behaviour of the pieces executably and the wiring of
  the composition in the source of the composition. The end-to-end proof
  against a real PostgreSQL is `TestPostgresTheCohortNarrowsTheComposedSurfaces`,
  and it runs in the local integration suite, not in the gate.
- The cohort narrows the account access of the friend and the queue
  surfaces. It does not narrow the participant surface, the public history or
  the private storage, and it does not end a match.
- The feature route carries exactly the two rollout switches, so it does not
  report the cohort. An account that the cohort excludes learns about it from
  the `403 not_authorized` answer of the surface, which the browser already
  maps onto a refusal.
- The cohort narrows the account access of the friend surface, and the owner
  of an invitation keeps the recovery of the invitation it owns. The proof of
  that ownership is the owner token of the invitation or the account identity
  of the inviter, and it never covers another invitation, the creation of an
  invitation, the acceptance of a challenge or the seat credential.
- The cohort is read once, when the process boots, so a change of the setting
  needs a restart of the API container. The rollout packet says the same for
  the two switches.
- A guest seat credential is never narrowed by a cohort. A guest that holds a
  credential for a seat of a match keeps it, and the credential stays
  revocable and scoped to its seat.
- The comparison of the two cohorts is a comparison of **sets**. The order of
  a cohort setting does not change the membership of the cohort, so the
  commitment of a set does not depend on the order of the setting.
- The commitment is not a secret. It is one-way, so it does not recover the
  set, but it confirms a candidate set. The count of the cohort and the
  commitment of the cohort are public material, and a reader of the
  repository learns the size of the cohort from them.
- The commitment of the host record is measured by the operator on the host.
  The gate compares the commitments, so it trusts the measurement of the
  host; a host record that carries raw account subjects instead of a
  commitment is refused, and a host record with a wrong commitment blocks
  the gate.
- The gate can verify the runtime cohort only where the protected operator
  input is available. A run without it, a continuous integration run for
  example, keeps the requirement `cohort` and the requirement
  `runtime-cohort` unmet and the gate blocked. That is the intended
  behaviour: the recorded cohort is operator material, not public
  material.
- The tables of `docs/implementation/KHA-84-evidence.md` and
  `docs/implementation/KHA-85-evidence.md` reproduce the requirements of the
  gate as the tree reports them now, `cohort-enforcement` and
  `runtime-cohort` included. They are a snapshot of the working tree of
  `feature/online-play-swarm`, and the gate tool is what decides the state of
  a gate, so a tree that changes the requirements changes the tables with it.
- Nothing here turns a release gate on. Both switches stay off by default,
  the runtime cohort of the host is unmeasured, and the release decisions of
  the two gates are still outstanding.
