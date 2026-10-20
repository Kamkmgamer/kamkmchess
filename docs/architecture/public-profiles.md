# Public profiles and explicit guest linking

[KHA-72](https://linear.app/kamkm/issue/KHA-72) adds the public identity of a
signed-in account and the explicit action that attaches a guest seat to it.
It is the slice of
[public identity, attribution and history](https://linear.app/kamkm/issue/KHA-58)
that owns the profile itself. Public history, public replays, and the two
deletion paths belong to KHA-78 and KHA-79 and are not claimed here.

## Identity

A public profile has three things:

- a **public profile identifier**, a random opaque value that is independent of
  the account and never changes;
- a **chosen username**, unique across all profiles and compared
  case-insensitively;
- a **chosen avatar**, a key from a fixed catalog of eight.

Nothing else is public. The account identifier, the sign-in email, the legal
name, the session, the credential, and the hash of any credential stay on the
server. The public payload is an allowlist, and the HTTP and browser
contracts both reject an unknown field, so a private value cannot appear in a
public response even by accident.

The profile is created on first use, so an account never completes a setup
step before it has a public identity. The username starts empty: the owner
chooses it deliberately, and the service publishes no name until they do. The
avatar starts generated; the generated avatar is derived from the public
profile identifier, so it is stable for a person and stores nothing.

A guest has no profile. A guest is labelled `Guest`, and separate guests are
never merged because they share that label.

## HTTP boundary

The server mounts the profile API under its own prefixes, so it never widens
the private single-owner sync API.

| Method and path | Access | Result |
| --- | --- | --- |
| `GET /v1/profiles/{profileID}` | Public | The allowlisted public profile, or 404 |
| `GET /v1/profiles/username/{username}` | Public | The same payload, found by name |
| `GET /v1/account/profile` | Account | The account's own profile and its linked guest seats |
| `PUT /v1/account/profile` | Account | Ownership-checked update of the name and the avatar |
| `GET /v1/account/profile/guest-links` | Account | The linked guest seats |
| `POST /v1/account/profile/guest-links` | Account | Explicit guest link |
| `POST /v1/guest-seats/ownership-proof` | Guest | A short-lived ownership proof for the guest's own seat |

The public reads work without signing in. The account routes take the
verified server principal, and a request body never names an account, a
profile, or an owner: a body that carries one is refused as an unknown field.
The guest link carries its proof in the `X-Guest-Ownership-Proof` header, so
the secret never enters a URL, a shared state, or a log line.

A missing profile and a name that does not exist both answer 404. A name that
another profile already owns answers 409 `username_taken`. A refused name
answers 400 `invalid_username`, and a refused avatar answers 400
`invalid_avatar`.

## Username rules

A name is 3 to 24 characters, starts and ends with a letter or a digit, and
uses only letters, digits, underscores and dashes. It cannot contain a dot or
an `@`, so it can never be read as an email address. The reserved names are
`guest`, `guests`, `anonymous`, `deleted`, `admin`, `administrator`,
`system`, `moderator`, `support`, `staff`, `official`, `root`, `null` and
`undefined`.

Uniqueness is enforced by a partial unique index on the lower-cased name, so
two owners cannot claim the same name with different spelling. The index also
makes the claim race-safe: of two concurrent claims of the same name exactly
one wins, and the other is refused. Two concurrent edits of the same profile
are ordered by a row lock, so the name and the avatar never end up from
different requests.

## Explicit guest linking

Linking a guest seat to an account is an explicit action with three parts.

1. The browser proves that it controls a guest seat. It presents the private
   guest seat credential, and the service mints a short-lived **ownership
   proof** from it. A shareable invitation link is not a proof: anybody can
   hold one, and it never proves that the requester controlled the seat.
2. The signed-in account asks to link the seat. The request names the match
   and the seat, and the proof must name exactly that seat.
3. The service binds the proof to the account's profile.

The link transaction holds the account advisory lock and the guest seat
advisory lock, the same locks the revocation paths hold, so a link is ordered
against a session revocation, a credential rotation and a seat removal
instead of racing them. Inside the transaction, and after the locks were
taken, the service re-checks the account session revocation, the proof, the
parent credential, the seat ownership and every expiry. A lock can be held
for an unbounded time, so an expiry that was checked before the lock is
checked again.

The proof is consumed by the linking transaction. The ledger binds one proof
to one profile, once, and one live guest seat to at most one profile.

The link changes nothing else. The seat owner in `online_seats` is immutable
and stays the guest, the guest stays the actor of every accepted move, the
accepted receipts stay, and the accepted operation fingerprints keep their
original value. The link records the association in its own append-only
ledger.

Signing in never links a seat. The account profile lists the linked guest
seats, and a link only ever happens because the account asked for it.

## Storage

Migration `backend/migrations/0005_public_profiles.sql` adds two tables.

- `online_public_profiles` holds the profile identifier, the account
  identifier, the chosen name, the comparison key, the chosen avatar and the
  timestamps. The account identifier is unique, and the name key is unique
  where a name was chosen. The row identity is immutable.
- `online_profile_guest_links` holds the ledger of verified guest links. The
  proof identifier is unique, and a live seat is unique, so a proof and a
  seat are each bound once. An insert guard refuses a link that names a seat
  the guest does not own, so the ledger can never point at somebody else's
  seat even when it is written directly.

The runtime grants follow the KHA-65 pattern: the API role gets the two new
tables, the private rules process keeps no table privileges, and `PUBLIC`
access is revoked.

## Browser boundary

`src/profile/contracts.ts` is the wire contract and its parsers. A parser
rejects an unknown field, a missing field, an unsupported version, a name
outside the contract, and an avatar outside the catalog.

`src/profile/client.ts` is the client. It has two kinds of call that never
mix: a public read with no credential at all, and an account call that
carries the verified session token in the `Authorization` header. The client
checks the trusted service origin before a credential is minted, keeps
credentials out of URLs and bodies, and omits cookies and refuses redirects.

The guest link is a deliberate two-step action in the client: it mints the
ownership proof from the guest seat credential first, confirms that the proof
names the seat it means to link, and only then binds the proof to the
account.

`src/profile/panel.ts` is the state machine behind the interface. It owns the
drafts, the busy state and the one status line. `src/ui/ProfilePanel.tsx`
renders it. The panel is mounted in the account workspace, next to the
existing sign-in and private account controls, and the offline game layout is
untouched.

## Boundaries

- The public history, the public replay, the control attribution and the
  ordinary and explicit removal paths belong to KHA-78 and KHA-79. This slice
  does not publish a game, does not anonymize a participant, and does not
  remove a replay.
- The link is an association. Seat control stays with the retained guest
  credential, as KHA-67 established. A linked account does not take the seat
  over.
- The proof is a capability for the seat it names. It is minted from the seat
  credential, it is single use, and it is bound to one seat. The browser that
  controls a guest seat is the browser that can link it.
- A guest seat can only be linked while its credential is live. A revoked,
  superseded or expired credential invalidates every proof it issued.
