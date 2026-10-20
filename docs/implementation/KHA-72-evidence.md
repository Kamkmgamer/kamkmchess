# KHA-72 public profile and explicit guest linking evidence

Locally verified on 2026-10-20 on `t3/public-profiles-guest-linking`.
Tested source commit: `cf222f01116e89bf478d085e89cf0470a4fa5177`.
The branch starts at `a1e069e`, which includes the KHA-64 through KHA-67
foundations.

The implementation commits are `fc814b2` (the service, the routes, the
storage and the PostgreSQL fixtures), `b5baafb` (the browser boundary, the
panel state machine and the interface), and `cf222f0` (the browser check
harness).

## Implemented contract

A signed-in account has a stable public identity that is independent of its
editable name, its chosen avatar, and its private sign-in identity. The
public profile identifier is a random opaque value, the username is chosen
deliberately and compared case-insensitively, and the avatar is a key from a
bounded catalog of eight. A generated avatar is the default until the owner
chooses one, and it is derived from the public profile identifier, so it is
stable for a person and stores nothing.

The public payload is an allowlist: the public identifier, the chosen name,
the chosen avatar, and the timestamps. The account identifier, the sign-in
email, the legal name, the session, the credential and every hash stay on the
server. The HTTP response and the browser parser both reject an unknown
field, so a private value cannot reach a public payload even by accident.

A guest has no profile. A guest stays labelled `Guest`, and separate guests
are never merged because they share that label.

Linking a guest seat to an account is an explicit action. The browser proves
that it controls the seat by minting a short-lived ownership proof from the
private guest seat credential; a shareable invitation link is never a proof.
The signed-in account then asks to link the seat, and the proof must name
exactly that seat. The link transaction holds the account advisory lock and
the guest seat advisory lock, the same locks the revocation paths hold, and
inside the transaction it re-checks the account session revocation, the
proof, the parent credential, the seat ownership and every expiry, because a
lock can be held for an unbounded time. The proof is consumed in that same
transaction.

The link changes nothing else. The seat owner in `online_seats` stays the
guest, the guest stays the actor of every accepted move, the accepted
receipts stay, and the accepted operation fingerprints keep their original
value. Signing in never links a seat on its own.

The service, the routes, the storage, the username rules and the boundaries
are described in [the public profile contract](../architecture/public-profiles.md).

## Verification

`pnpm check` passed ESLint, both TypeScript projects, 775 tests across 70
files, the browser production build, the private rules-worker build and the
distribution notices. The pre-change baseline had 744 tests across 67 files.

PostgreSQL 17.11 ran in the isolated local `kamkmchess-kha67-local`
container on loopback port 55467. Each database fixture created and dropped
its own schema. The final commands were:

```powershell
$env:KHA41_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable'
$env:KHA41_REQUIRE_POSTGRES='1'
$env:KHA66_WORKER_ENTRY=Join-Path (Get-Location).Path 'build/rules-worker/worker.mjs'
go test -count=1 ./backend/... ./cmd/...
go vet ./backend/... ./cmd/...
```

Both commands passed. The full integration package took 47 seconds. The
checks used the real private Node rules artifact and required PostgreSQL
rather than skipping absent-database fixtures. The Windows race detector was
not run locally because this host has no C compiler; the existing Linux Go CI
configuration runs `go test -race` against PostgreSQL and the built worker.

The new fixtures are:

- 13 PostgreSQL integration fixtures in
  `backend/integration/online_profile_test.go`, over the real HTTP
  composition, the real authorization service and the real database.
- 4 unit fixtures in `backend/profile/profile_test.go` for the public name
  and avatar rules.
- 31 browser fixtures in `src/profile/` for the wire contract, the client and
  the panel state machine.

The integration fixtures cover:

- A public profile created on first use and published without the account
  identity. The signed-out read returns exactly the allowlisted fields, and
  the payload carries no account identifier, email, session or Clerk value.
  An unknown profile is a 404.
- The username lookup a named friend challenge needs. It is
  case-insensitive, it finds the owner whichever spelling the challenger
  typed, it keeps the chosen spelling, and an unknown name is a 404.
- Username uniqueness. The same name in another spelling belongs to the same
  owner, and two accounts racing for one free name produce exactly one
  winner and one `username_taken` refusal, with one profile owning the name
  afterwards.
- Ownership-checked edits. A body that names another profile, another
  account or an owner is refused as an unknown field and the other
  account's profile is untouched. A guest credential never acts on an
  account route.
- The avatar. An avatar outside the catalog is refused and the stored choice
  never changes; a chosen avatar is published as a bounded key; clearing the
  choice returns the generated default.
- Reserved and unsafe names. The reserved names, a name that is too short, a
  name with a space, a name that reads as an email address, a name with a
  leading or trailing dash and an over-long name are all refused, and a
  refused name is never published.
- Two concurrent edits of the same profile. The row lock orders them, so the
  name and the avatar never end up from different requests.
- The explicit guest link. The guest moves before the link, so an accepted
  fingerprint exists. Signing in does not link the seat. The guest mints an
  ownership proof from its own seat credential, the account links the seat,
  the seat owner is still the guest afterwards, the stored receipt is still
  readable, the duplicate operation still returns it, the link is listed on
  the account's profile, and the same proof cannot link a second profile.
- The rejection of another person's seat. A proof for another seat never
  links this one, in both directions and for both accounts. A guest seat
  credential is not an ownership proof. A request without a proof is refused.
  A guest never links a seat to an account. A seat that is already linked is
  refused for a second account, even with a fresh valid proof of that seat.
  No refused request created a link.
- A dead proof and a dead credential. A revoked seat credential invalidates
  every proof it issued, so the link is refused.
- A revoked account session. The link is refused and no link row is
  created.
- The link ledger guard. A link row that names a seat the guest does not
  own is refused by the database with SQLSTATE 55000, even when it is
  written directly.
- The stored profile keeps the account identifier on the server, and the
  public identifier does not contain it.

The browser fixtures cover the closed wire contract (an unknown field, a
missing field, an unsupported version, a name outside the contract and an
avatar outside the catalog are all refused), the client (a public read with
no credential at all, an account call that keeps the credential in the
`Authorization` header and out of the body, a name that another profile
already owns, a request without a signed-in account, the two-step guest
link, a proof that names another seat, a browser that holds no guest
credential, a base URL that is not a trusted service origin, and a failed
request with its status), and the panel state machine (the load, the save,
the refused name before the request leaves, the name conflict, the guest
link, the missing guest seat, the already linked seat, and a failed load).

## Browser check

A real Chromium check through T3 preview confirmed the interface behaviour
that the service fixtures cannot show. The harness in
`experiments/kha72-profile/` mounts the real panel and the real state
machine against a local stand-in for the profile service.

The loaded panel showed the public profile identifier, the chosen name, the
name field, the avatar choice with the selected swatch outlined, the save
action and the guest seat section. Typing a name that another profile owns
and saving answered `That name is already taken.` and left the published
name unchanged. Typing a new name, choosing another avatar and saving
answered `Profile saved.`, published the new name and selected the new
avatar. Linking the guest seat answered `Guest seat linked to your account.`
and listed the linked seat. The panel was inspected in the light and the
dark appearance, and the automated design detector reported no findings on
the changed interface files.

This is a local check of the interface against a stub service. It is not a
deployed acceptance run, and it does not certify native accessibility, other
browsers or devices.

## Acceptance boundaries and review disposition

`HIS-01` and `HIS-02` have local service, HTTP, database and browser
evidence. The scenarios in the acceptance matrix remain `not_run`, because
that matrix is only updated by the owner against the deployed product, and
these fixtures do not establish deployed or native acceptance.

The public history, the public replay, the control attribution, the ordinary
account deletion and the explicit removal request belong to KHA-78 and
KHA-79. This slice does not publish a game, does not anonymize a
participant, does not remove a replay, and does not claim any of those
behaviours.

Three boundaries are deliberate and are stated rather than hidden:

- The link is an association, not a seat takeover. Seat control stays with
  the retained guest credential, as KHA-67 established, and a linked account
  does not gain the ability to command the seat.
- The ownership proof is a capability for the seat it names. It is minted
  only from the seat credential, it names one seat, it is single use, and
  the browser that controls a guest seat is the browser that can link it.
  A stolen guest seat credential would therefore be as consequential as a
  stolen session token; the link does not add a new transfer of authority.
- A guest seat can only be linked while its credential is live. A revoked,
  superseded or expired credential invalidates every proof it issued, so a
  guest that returns after the credential expired cannot link that seat
  later.

The invitation, queue and match-claiming surfaces are not part of this
slice. The named friend challenge that uses the username lookup is a later
ticket. The offline game layout, the existing sign-in controls and the
private account controls are unchanged.

Deployment and provider spending were not performed. The verification above
used the local source tree and the local PostgreSQL container; branch
publication and the pull request are tracked separately.

OpenCode `opencode/minimax-m3.1-flash-free` handled the implementation, the
fixtures and the browser check. The parent reviewed the findings, the
integration and the tracker updates.
