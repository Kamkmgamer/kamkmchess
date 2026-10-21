# Friend invitation and public queue route contract (KHA-75, KHA-76)

Owner: the matching worker (KHA-75, KHA-76). This note publishes the concrete
HTTP routes, request bodies and answer bodies of the two new online surfaces so
the workspace worker (KHA-74, KHA-77) and the operations worker can call them
without guessing.

It describes the *wire contract only*. It grants no deployment, no public
launch and no paid provider traffic.

The friend routes below are implemented and committed. The queue routes are
owned by the queue worker (KHA-76) and are marked as such.

## Feature gates

The service owns the rollout. Two independent switches, both **default off**:

| Server variable | Default | Opens |
| --- | --- | --- |
| `ONLINE_FRIEND_ENABLED` | `false` | the friend routes (invitations, link joins, rematches) |
| `ONLINE_QUEUE_ENABLED` | `false` | the public queue routes |

A closed surface is not mounted: its routes answer `404`. The existing
participant routes (`/v1/online/matches/...`) are unchanged and stay mounted.

`KAMKM_PUBLIC_ONLINE_FRIEND_ENABLED` and `KAMKM_PUBLIC_ONLINE_QUEUE_ENABLED`
are **presentation only**. They never open a server route.

One route is always mounted, because the browser asks it before it shows
anything:

```
GET /v1/online/features
→ 200 { "friends": boolean, "queue": boolean }
```

The answer carries exactly those two fields. `friends` is true when
`ONLINE_FRIEND_ENABLED` is on, `queue` is true when `ONLINE_QUEUE_ENABLED` is
on. The two switches are independent.

## Credential rules

| Surface | Accepted credential |
| --- | --- |
| friend invitation create / preview / accept / cancel | account session **or** guest seat credential **or** none (a guest link is public) |
| public queue | account session only. A guest can never enter the public queue |

A mutation always needs an explicit `Origin` header. A credential never
travels in a URL, a query string or a body. The guest seat credential uses
`X-Guest-Seat-Token`; the account session uses `Authorization: Bearer`.

The friend routes accept a **guest** inviter and a **guest** invitee. A guest
inviter receives an owner token at creation; that token is the inviter's
recoverable ownership of the invitation and of the created match.

## Friend routes

Mounted under `/v1/online/invitations/` when friend play is enabled.

### Create an invitation

```
POST /v1/online/invitations
```

Request body (every field is required unless stated):

```jsonc
{
  "schemaVersion": 2,
  "kind": "link" | "challenge",   // default "link"
  "recipientAccountId": "user_x",  // required for "challenge", forbidden for "link"
  "seat": "white" | "black",       // the inviter's color
  "timeControl": { "startingTimeMs": 300000, "incrementMs": 2000 },
  "startingFen": "…",              // optional; omitted means the standard position
  "control": { "kind": "human" | "agent", "modelLabel": "…" }  // the inviter's seat
}
```

Answer `201`:

```jsonc
{
  "schemaVersion": 2,
  "invitation": {
    "invitationId": "…",           // the shareable secret; it is the link token
    "kind": "link",
    "status": "open",
    "inviterLabel": "Alice",       // the public name, or "Guest"
    "inviterSeat": "white",
    "inviterControl": { "kind": "human" },
    "timeControl": { "startingTimeMs": 300000, "incrementMs": 2000 },
    "startingFen": "…",            // null for the standard position
    "expiresAt": "2026-10-22T10:00:00Z",
    "createdAt": "2026-10-21T22:00:00Z",
    "consumedAt": null,
    "cancelledAt": null,
    "matchId": null
  },
  "ownerToken": "…"                // the inviter's revocable ownership secret
}
```

`invitationId` is the shareable link secret. The link is
`<origin>/invite/<invitationId>`. It is a bearer secret: it is never written
to a log line, and it is not a credential.

`ownerToken` authorizes the inviter's later actions on this invitation
(cancel, seat credential). It is returned once and is never stored by the
service in readable form.

An **anonymous guest** inviter is a fresh opaque identity, and the service
never tracks people. The service therefore cannot tell that the same human
opens the link it created: an acceptance whose acceptor is the same
participant as the inviter is refused before the invitation is consumed, and
the browser avoids accepting a link it created itself with
`isLocallyOwnedInvitation`. That is a convenience of the interface, not a
sybil defence, and no such claim is made.

### The public model label

A declared model label is a **private routing identity** until its owner
chooses a public label for it. The service never receives a routing
identifier, an endpoint, a connection nickname or a credential, and the
public preview of a link is unauthenticated, so the declared label is
resolved to the label that may be published **before** the invitation is
stored and before any answer carries it.

The resolution is the canonical one of the service
(`online_resolve_public_model_label`):

| Declared label | Published label |
| --- | --- |
| a known public model name (`gpt-4o`) | its published name (`GPT-4o`) |
| a public label the owner registered for their own account | that label (`My Bot`) |
| the browser engine | `Stockfish 19 Lite (browser)` |
| anything else, including a private routing identity | `Custom model` |

A human seat declares no model label and is published unchanged. The friend
surface offers no built-in engine seat, so the engine constant never appears
in a friend answer.

The browser keeps its own binding of a model opponent. The published label
may be collapsed to the neutral label, so the browser never identifies a
model by the published label and never expects it to be unique.

### Read an invitation (the link preview)

```
GET /v1/online/invitations/{invitationId}
```

Answer `200` with the same `invitation` object as above. The preview shows the
inviter name or `Guest`, the inviter's seat, the clock and the custom board
when there is one. It never shows a pairing, a seat of the invitee, a
credential or an owner token.

A `challenge` invitation is visible **only** to its recipient account. Any
other caller receives `404`.

The status of the preview is the *effective* status. An invitation whose
twelve hour deadline passed reads as `expired` even though no sweep ever
wrote that state, so the invitee sees an expired link instead of an open one.

### Accept an invitation

```
POST /v1/online/invitations/{invitationId}/accept
```

Request body:

```jsonc
{
  "schemaVersion": 2,
  "acceptanceKey": "…",            // optional for an account acceptor, REQUIRED for a guest
  "control": { "kind": "human" | "agent", "modelLabel": "…" },  // the invitee's seat
  "rotateCredential": false         // optional, see below
}
```

`acceptanceKey` is a client-generated idempotency key (16 to 128 characters of
`[A-Za-z0-9_-]`). The browser generates it once per accept intent, keeps it
for the page lifetime and reuses it on every retry, so a lost answer is
recovered instead of consuming a second invitation. It is required when the
acceptor is a guest, because a guest has no other identity to resume with.
The service stores only its hash, and the key is the only capability that
resumes an acceptance.

The key is a bearer secret of that accept intent. An **account** acceptor is
additionally bound to its own acceptance, because an account has an identity
the service can check. A **guest** acceptor has no other identity, so the key
is the whole capability of the acceptance: whoever holds it can resume that
acceptance. The browser therefore keeps the key in memory for the page
lifetime only, and never shares it.

Answer `200`:

```jsonc
{
  "schemaVersion": 2,
  "match": { …the participant live view of the created match… },
  "seat": "black",                 // the seat the acceptor plays
  "acceptanceId": "…",
  "guestCredential": {             // present only for a guest acceptor
    "guestId": "…",
    "matchId": "…",
    "seat": "black",
    "token": "…",                  // the plaintext secret; it exists only in this answer
    "expiresAt": "2026-10-22T10:00:00Z"
  }
}
```

The envelope is **not** the match view itself: the match view is the `match`
field, and it is byte-compatible with `onlineMatchResponse`
(`parseOnlineMatchView` accepts it unchanged).

Retrying the same accept with the same `acceptanceKey` returns the same
`matchId` and the same `seat`. A routine retry never supersedes a guest
credential that another request already delivered: the credential is minted
only when the seat has no live credential. A browser that holds no working
credential asks for the replacement explicitly with `"rotateCredential": true`;
the earlier credential is then superseded, so a lost answer never leaves the
guest without a working credential.

The consumption of the invitation, the acceptance record, the canonical match
and the guest seat credential commit in **one** transaction. A crash can never
leave a spent invitation without a game, and no reconciler has to look for an
orphaned acceptance.

Errors:

| Status | Code | Meaning |
| --- | --- | --- |
| `404` | `not_found` | unknown invitation, or a challenge that is not visible to the caller |
| `409` | `conflict` | already consumed by somebody else, or cancelled |
| `410` | `expired` | the twelve hour deadline passed |
| `400` | `invalid_request` | an invalid position, an invalid control or an invalid acceptance key |

A challenge that is not visible to the caller answers exactly like an unknown
invitation, so a caller cannot learn that a named challenge exists.

### The removal of a participant

A write of this surface names a participant: the inviter of an invitation, the
acceptor, the named recipient of a challenge, the proposer of a rematch and
the accepter of one. The removal of a participant is durable, and a removed
participant may not name a new personal row.

Every write therefore takes the **account scope lock** of the participants it
names, before the row lock of the invitation or of the rematch offer, and it
rechecks the durable removal of every participant after the lock. The removal
of a participant takes the same account scope lock and then the row locks of
the rows it sanitizes, so the two flows are ordered instead of racing:

* a write that was authenticated before the removal waits for the removal and
  is then refused, so it never creates a personal row after the removal;
* a write that was authenticated after the removal is refused at once;
* a removed participant never receives a fresh seat credential, so a
  credential that was issued before the removal is not revived after it.

The recheck knows a removed participant in three ways. A participant that
carries the **anonymized sentinel** is a removed participant, because the
privacy sanitation replaces the identifier of a removed subject with that
constant. A participant whose account or of whose guest seat a removal was
recorded is named by the durable removal records. A participant whose **own**
one-way reference **and kind** is named by a row of the **removal ledger** of
that match was removed from that match, so a restore of an older backup cannot
revive it either.

The ledger check is participant scoped: the removal of the opponent of a match
does not take the seat of the survivor away. A surviving participant keeps its
own seat, its own credential and its own writes, and the game stays live. The
kind is part of the check, because an account and a guest that share an
identifier share their one-way reference as well.

The write names the participants it really writes for. A fresh acceptance
creates the match of the inviter and the acceptor, so both are rechecked. A
**resumed** acceptance creates nothing and writes no row of the inviter, so
only the acceptor is rechecked, and the removal of the inviter does not take
the seat of the acceptor away. The credential of a seat is recovered for the
owner of that seat alone.

A resumed acceptance may present **no identity at all**: the acceptance key is
the capability of a guest acceptance. The scope of the stored acceptor is
locked before the row of the invitation in that case as well, so the resume is
ordered against the removal of that acceptor.

The identity of a resumed acceptance is compared **exactly**. The kind is part
of the identity, because the one-way reference of a subject does not carry it:
an account and a guest that share an identifier are two different
participants, and the account never resumes the acceptance of the guest. A
request that presents no identity resumes the acceptance of the key, which is
the bearer capability of that acceptance.

A retry can meet an acceptance that another request is writing right now. The
acceptance of the key is read before the locks, so the retry can miss a row
that is not committed yet. The retry then waits for the row of the invitation,
the first request commits, and the authoritative lookup finds the acceptance
whose acceptor was never locked. The write is **rolled back and started
again** in that case, so the scope of the stored acceptor is always taken
before the row of the invitation and never after it.

The cancellation of an invitation is a write of the surface as well, so it is
fenced the same way: the account scope lock of the inviter is taken before
the row lock of the invitation, and the removal of the inviter is rechecked
after the lock.

A rematch offer that can never be accepted any more is not published. The
pending read is a **projection**: it never writes, so a `GET` never changes
the personal row of a removed participant and never raises a database error
for an offer of an older build.

The refusal is `403` with the code `not_authorized`, the same code as an
unauthorized caller, so the error vocabulary of the surface does not change.

The scopes are taken in ascending order, so two writes that name the same
participants take them in the same order and never deadlock. The guest path is
unaffected: an anonymous guest is a fresh identity that no removal names, and
the acceptance key stays the whole capability of a guest acceptance.

### Cancel an invitation

```
POST /v1/online/invitations/{invitationId}/cancel
```

Authorized by the `ownerToken` (body `{"schemaVersion": 2, "ownerToken": "…"}`)
or by the account session of the inviter. Answer `200` with the invitation.
A cancelled invitation can never be consumed. An invitation whose deadline
passed answers `410` with the code `expired`.

### Claim the inviter's seat credential

```
POST /v1/online/invitations/{invitationId}/seat-credential
```

Body `{"schemaVersion": 2, "ownerToken": "…"}`. Answer `200`:

```jsonc
{
  "schemaVersion": 2,
  "matchId": "…",
  "seat": "white",
  "guestCredential": { "guestId": "…", "matchId": "…", "seat": "white", "token": "…", "expiresAt": "…" }
}
```

A **guest** inviter needs this call once the invitee accepted: the guest seat
credential is minted for the created match seat and cannot be minted before
the match exists. The call supersedes an earlier credential for the same
seat, so it is safe to call again after a lost answer and must not be called
while a working credential is held. An account inviter receives `null` for
`guestCredential`.

### Rematches

```
POST /v1/online/rematches                                   // propose
POST /v1/online/rematches/{rematchId}/accept               // accept
POST /v1/online/rematches/{rematchId}/seat-credential      // the guest seat credential of the proposer
GET  /v1/online/matches/{matchId}/rematch                   // the pending offer
```

Propose body:

```jsonc
{
  "schemaVersion": 2,
  "matchId": "…",                 // the finished match
  "timeControl": { … },           // optional; defaults to the finished match
  "startingFen": "…"             // optional; defaults to the finished match
}
```

Answer `201` with the offer:

```jsonc
{
  "schemaVersion": 2,
  "rematch": {
    "rematchId": "…",
    "matchId": "…",
    "status": "pending",
    "proposerLabel": "Alice",
    "proposerSeat": "black",      // the seat the proposer plays in the new match
    "timeControl": { … },
    "startingFen": "…",
    "expiresAt": "…",
    "newMatchId": null
  }
}
```

A rematch needs both participants. The proposal is the proposer's consent; the
opponent's acceptance creates the new match with **reversed colors** and the
**retained setup** unless the offer proposes a change the opponent accepts by
naming the exact offer. The old match keeps its final result; a rematch is a
new match and never revives the old one.

The offer, the new match and the credential of the accepter commit in **one**
transaction. A crash in the middle leaves the offer `pending` for the
opponent, so a rematch is never stranded by a reservation without a game.

Accept body:

```jsonc
{
  "schemaVersion": 2,
  "rotateCredential": false       // optional, see below
}
```

Answer `200`:

```jsonc
{
  "schemaVersion": 2,
  "rematch": { … "status": "accepted", "newMatchId": "…" },
  "match": { …the participant live view of the new match… },
  "seat": "black",
  "guestCredential": { … }        // present only for a guest acceptor
}
```

A duplicate acceptance returns the same `newMatchId` instead of creating a
second match.

A rematch is a **new match**, so the credential of the finished match cannot
authorize it. A guest participant needs a fresh credential of the new seat:

* the guest **accepter** receives it in the acceptance answer;
* the guest **proposer** claims its own with
  `POST /v1/online/rematches/{rematchId}/seat-credential`, which answers
  `{ "schemaVersion": 2, "matchId": "…", "seat": "…", "guestCredential": { … } }`.

A guest accepter whose answer was lost holds no working credential of the new
match, because the credential it has is bound to the finished match. The
retry therefore answers with a fresh credential of the new seat, and the
browser can read the live view of the new game again. A retry that presents
the credential of the **new** match keeps it, because that credential already
authorizes the new seat. The browser may also ask for the replacement
explicitly with `"rotateCredential": true` when it holds none.

## Public queue routes

Mounted under `/v1/online/queue/` when the queue is enabled. Every route needs
an **account** session.

### Create an entry

```
POST /v1/online/queue/entries
```

Body:

```jsonc
{
  "schemaVersion": 2,
  "control": { "kind": "human" | "agent", "modelLabel": "…" },
  "timeControl": { "startingTimeMs": 300000, "incrementMs": 2000 },
  "clientRequestId": "…"         // optional idempotency key, at least 8 characters
}
```

Answer `201` with the entry (the `QueueEntry` shape of
`src/online/contracts.ts`):

```jsonc
{
  "schemaVersion": 2,
  "entryId": "…",
  "owner": { "kind": "account", "id": "user_x" },
  "control": { "kind": "agent", "modelLabel": "…" },
  "timeControl": { "startingTimeMs": 300000, "incrementMs": 2000 },
  "status": "waiting",
  "version": 1,
  "readyAt": "2026-10-21T22:00:00Z",
  "cutoffAt": "2026-10-21T22:00:10Z",
  "assignedMatchId": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```

The creation **is** the authoritative ready acceptance: the service records
`readyAt` and starts the ten-second window (`cutoffAt = readyAt + 10s`). No
search time elapses during the browser's own agent check, because the check
happens before this call.

`clientRequestId` makes the creation idempotent per owner: a second tab that
sends the same key receives the same entry and creates no second game. The
browser generates it once per entry intent and keeps it in local storage.
Without the key every call creates a new entry.

### The other entry routes

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/v1/online/queue/entries/{entryId}` | GET | – | `QueueEntry` |
| `/v1/online/queue/entries/{entryId}/ready` | POST | `{ "schemaVersion": 2 }` | `QueueEntry` |
| `/v1/online/queue/entries/{entryId}/cancel` | POST | `{ "schemaVersion": 2 }` | `QueueEntry` |
| `/v1/online/queue/entries/{entryId}/keep-searching` | POST | `{ "schemaVersion": 2 }` | `QueueEntry` with `cutoffAt: null` |
| `/v1/online/queue/entries/{entryId}/match` | POST | `{ "schemaVersion": 2 }` | the assignment, or `404` when no candidate exists |
| `/v1/online/queue/entries/{entryId}/fallback` | POST | `{ "schemaVersion": 2 }` | the assignment |

`ready` is idempotent and re-arms the window only for an entry that is not
ready yet. A ready entry keeps its settings: changing the model or the clock
cancels the entry and creates a new one, which starts a fresh window.

`keep-searching` removes the automatic cutoff (`cutoffAt: null`). The entry
then waits until it is matched, cancelled or expired.

`match` asks the service to pair the entry with a compatible ready entry. The
service owns the compatibility rule. A `404` means "no candidate right now",
not an error.

`fallback` commits the Stockfish fallback. The service checks once more for a
compatible candidate before it commits, so a candidate that was eligible at the
original cutoff still wins over the engine. The answer:

```jsonc
{
  "schemaVersion": 2,
  "matchId": "…",
  "seat": "white",
  "opponentLabel": "Stockfish 19 Lite",
  "control": { "kind": "engine", "modelLabel": "Stockfish 19 Lite" }
}
```

A fallback match needs a seat credential for the engine seat, because the
engine runs in the owner's browser. The answer therefore also carries
`guestCredential` (the same shape as the invitation answer) for the engine
seat.

### The entry state on the wire

The wire status is one of `waiting`, `cancelled`, `assigned`, exactly as
`src/online/contracts.ts` declares. The service maps its internal states:

| Internal state | Wire status | `readyAt` | `cutoffAt` |
| --- | --- | --- | --- |
| preparing (created, not accepted) | `waiting` | `null` | `null` |
| waiting (searching) | `waiting` | set | set or `null` |
| reserved (being assigned) | `waiting` | set | set |
| fallback (cutoff reached, engine pending) | `waiting` | set | set |
| expired (the owner stopped responding) | `waiting` | `null` | `null` |
| cancelled | `cancelled` | set or `null` | `null` |
| assigned | `assigned` | set | `null` |

An expired entry is reported as `waiting` with a `null` `readyAt`, which is
the shape the workspace controller already reads as "expired, rejoin
explicitly". An expired entry is never revived: the owner creates a new entry.

### Matching rules the service owns

- Only accounts enter the queue. A guest is refused.
- Two entries match when they have the **same** starting time and increment,
  **different** owners and **at least one agent** seat.
- The oldest eligible entry is preferred, and the oldest compatible candidate
  answers it.
- Colors are random and the starting position is the standard one. A custom
  position never enters the queue.
- Every entry is consumed once. One entry produces exactly one game and one
  fixed opponent.
- A candidate that becomes ready exactly at the cutoff wins over the
  fallback. A candidate that becomes ready after the cutoff does not.
- The engine fallback is committed only after the browser reports a ready
  engine, and only after the final candidate recheck.
- A late candidate, a late engine readiness or a reconnected tab can never
  replace a committed opponent.
- A waiting entry whose owner stops responding expires. The owner rejoins
  explicitly.
- There is no owner concurrency cap: an owner may hold any number of entries
  and games.

## Browser modules

| Module | Owner | Purpose |
| --- | --- | --- |
| `src/online/friends.ts` | matching | typed invitation and rematch client plus the domain rules |
| `src/online/queue.ts` | queue worker | typed queue client plus the queue domain rules |
| `src/online/queue-client.ts` | workspace | HTTP adapter for the queue routes |
| `src/online/match-client.ts` | workspace | participant command client |

`src/online/friends.ts` is written and committed. It exports the route
constants, the request and answer types, the strict parsers, the typed client
and the domain helpers (`isAcceptableInvitation`, `needsGuestSeatCredential`,
`needsCredentialRotation`, `isLocallyOwnedInvitation`, `createAcceptanceKey`).
The transport is an injected port, so the module owns no credential and no
URL.

The workspace should call the matching modules instead of re-declaring the
bodies.

`acceptRematch(rematchId, { rotateCredential })` carries the replacement of a
guest seat credential. The browser asks for it when it holds no working
credential of the new match, for example after a lost answer.

`isLocallyOwnedInvitation(invitationId, ownedIds)` tells the browser that it
created the link itself. The service cannot detect that an anonymous guest
who created a link is the same human who opens it later, because an anonymous
guest is a fresh opaque identity and the service never tracks people. The
helper is a convenience of the interface, not an identity proof, and it is no
substitute for the consent of the other player.

## Status

The routes above are implemented by the matching worker. The acceptance
scenarios `FRI-01`…`FRI-04` and `QUE-01`…`QUE-14`, `ARC-10` remain `not_run`
until the recorded evidence exists.
