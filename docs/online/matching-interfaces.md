# Friend invitation and public queue route contract (KHA-75, KHA-76)

Owner: the matching worker (KHA-75, KHA-76). This note publishes the concrete
HTTP routes, request bodies and answer bodies of the two new online surfaces so
the workspace worker (KHA-74, KHA-77) and the operations worker can call them
without guessing.

It describes the *wire contract only*. It grants no deployment, no public
launch and no paid provider traffic.

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

### Accept an invitation

```
POST /v1/online/invitations/{invitationId}/accept
```

Request body:

```jsonc
{
  "schemaVersion": 2,
  "acceptanceKey": "…",            // optional for an account acceptor, REQUIRED for a guest
  "control": { "kind": "human" | "agent", "modelLabel": "…" }  // the invitee's seat
}
```

`acceptanceKey` is a client-generated idempotency key (at least 16 characters
of `[A-Za-z0-9_-]`). The browser generates it once per accept intent, keeps it
for the page lifetime and reuses it on every retry, so a lost answer is
recovered instead of consuming a second invitation. It is required when the
acceptor is a guest, because a guest has no other identity to resume with.

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
`matchId`, the same `seat` and a freshly minted `guestCredential`. The earlier
credential is superseded, so a lost answer never leaves the guest without a
working credential.

Errors: `404` unknown or cancelled invitation, `409` already consumed by
somebody else, `409` expired, `403` a challenge accepted by a non-recipient,
`400` an invalid position or an invalid control.

### Cancel an invitation

```
POST /v1/online/invitations/{invitationId}/cancel
```

Authorized by the `ownerToken` (body `{"schemaVersion": 2, "ownerToken": "…"}`)
or by the account session of the inviter. Answer `200` with the invitation.
A cancelled invitation can never be consumed.

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
    "proposerSeat": "white",      // the seat the proposer plays in the new match
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

Accept body `{"schemaVersion": 2}`. Answer `200`:

```jsonc
{
  "schemaVersion": 2,
  "rematch": { … "status": "accepted", "newMatchId": "…" },
  "match": { …the participant live view of the new match… },
  "seat": "black"
}
```

A duplicate acceptance returns the same `newMatchId` instead of creating a
second match.

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
| `src/online/queue.ts` | matching | typed queue client plus the queue domain rules |
| `src/online/queue-client.ts` | workspace | HTTP adapter for the queue routes |
| `src/online/match-client.ts` | workspace | participant command client |

The workspace should call the matching modules instead of re-declaring the
bodies. `src/online/queue.ts` exports the route constants, the request and
answer types, the parsers and the domain helpers (`isExpiredEntry`,
`isAssignedEntry`, `queuePhaseOf`).

## Status

The routes above are implemented by the matching worker. The acceptance
scenarios `FRI-01`…`FRI-04` and `QUE-01`…`QUE-14`, `ARC-10` remain `not_run`
until the recorded evidence exists.
