# Public queue route and DTO contract (KHA-76)

Owner: the queue worker. This note publishes the concrete HTTP routes, the
request bodies and the answer bodies of the public matchmaking queue, so the
workspace worker (KHA-74, KHA-77) and the operations worker can call them
without guessing.

It describes the *wire contract only*. It grants no deployment, no public
launch and no paid provider traffic.

## Feature gate

| Server variable | Default | Opens |
| --- | --- | --- |
| `ONLINE_QUEUE_ENABLED` | `false` | the public queue routes |

A closed surface is not mounted: its routes answer `404`.
`KAMKM_PUBLIC_ONLINE_QUEUE_ENABLED` is presentation only and never opens a
server route.

The feature answer is always mounted:

```
GET /v1/online/features
  200 { "friends": boolean, "queue": boolean }
```

The answer carries exactly those two fields. `queue` is true when
`ONLINE_QUEUE_ENABLED` is on. The feature route is registered in exactly one
place: `backend/serverapp/server.go`. A second registration of
`/v1/online/features` panics the server, so the composition keeps one.

## Credential rules

| Surface | Accepted credential |
| --- | --- |
| public queue | account session **only** |

A guest can never enter the public queue. A mutation always needs an explicit
`Origin` header. The credential never travels in a URL, a query string or a
body.

## Routes

Mounted under `/v1/online/queue/` when the queue is enabled.

### Create an entry

```
POST /v1/online/queue/entries
```

```jsonc
{
  "schemaVersion": 2,
  "control": { "kind": "human" | "agent", "modelLabel": "…" },
  "timeControl": { "startingTimeMs": 300000, "incrementMs": 2000 },
  "clientRequestId": "…"   // optional, at least 8 characters
}
```

Answer `201` with the entry, or `200` with the same entry when the intent
already existed:

```jsonc
{
  "schemaVersion": 2,
  "entryId": "qe_…",
  "owner": { "kind": "account", "id": "user_x" },
  "control": { "kind": "agent", "modelLabel": "…" },
  "timeControl": { "startingTimeMs": 300000, "incrementMs": 2000 },
  "status": "waiting",
  "version": 1,
  "readyAt": "2026-10-21T22:00:00Z",
  "cutoffAt": "2026-10-21T22:00:10Z",
  "assignedMatchId": null,
  "createdAt": "2026-10-21T22:00:00Z",
  "updatedAt": "2026-10-21T22:00:00Z"
}
```

The creation **is** the authoritative ready acceptance: the service records
`readyAt` and starts the ten second window (`cutoffAt = readyAt + 10s`). No
search time elapses during the browser's own agent check, because the check
happens before this call.

`clientRequestId` makes the creation idempotent per owner: a second tab that
sends the same key receives the same entry and creates no second game. The
same key with another request is a `409`: the settings of an entry are fixed.

The `owner` field is the caller's own participant reference. No route ever
answers with the owner reference of another participant.

### The other entry routes

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/v1/online/queue/entries/{entryId}` | GET | – | `QueueEntry` |
| `/v1/online/queue/entries/{entryId}/ready` | POST | `{ "schemaVersion": 2 }` | `QueueEntry` |
| `/v1/online/queue/entries/{entryId}/cancel` | POST | `{ "schemaVersion": 2 }` | `QueueEntry` |
| `/v1/online/queue/entries/{entryId}/keep-searching` | POST | `{ "schemaVersion": 2 }` | `QueueEntry` with `cutoffAt: null` |
| `/v1/online/queue/entries/{entryId}/heartbeat` | POST | `{ "schemaVersion": 2 }` | `QueueEntry` |
| `/v1/online/queue/entries/{entryId}/match` | POST | `{ "schemaVersion": 2 }` | the assignment, or `404` when no candidate exists |
| `/v1/online/queue/entries/{entryId}/fallback` | POST | `{ "schemaVersion": 2 }` | the assignment |

Every mutating body accepts one optional field, `operationId` (at least eight
characters of `[A-Za-z0-9_-]`). When it is present the answer is stored with
the operation, so a repeated call returns the same answer and never performs
the operation twice. Without it the operations are idempotent by state
already.

`ready` is the explicit rejoin. It re-arms a fresh window for an entry that
is not ready (an expired entry), and it is idempotent for an entry that is
already waiting: a running window is never extended.

`heartbeat` renews the readiness lease of a waiting entry. One heartbeat
keeps the entry eligible for fifteen seconds. A responsive background tab
keeps its entry; a frozen or disconnected entry loses the lease, expires and
needs an explicit rejoin.

`keep-searching` removes the automatic cutoff (`cutoffAt: null`). The entry
then waits until it is matched, cancelled or expired, and it never falls back
to the browser engine on its own again.

`match` asks the service to pair the entry with a compatible ready entry. The
service owns the compatibility rule. A `404` means "no candidate right now",
not an error.

`fallback` commits the Stockfish fallback. The service checks once more for a
compatible candidate before it commits, so a candidate that was eligible at
the original cutoff still wins over the engine. The call is the report that
the browser engine is ready. The answer:

```jsonc
{
  "schemaVersion": 2,
  "matchId": "m_…",
  "seat": "white",
  "opponentLabel": "Stockfish 19 Lite",
  "control": { "kind": "engine", "modelLabel": "Stockfish 19 Lite" },
  "guestCredential": {
    "guestId": "engine_…",
    "matchId": "m_…",
    "seat": "black",
    "token": "kmgc1_…",
    "expiresAt": "2026-10-22T10:00:00Z"
  }
}
```

`guestCredential` is present only for a browser engine fallback. A candidate
match answers the same shape without the credential.

### The entry state on the wire

The wire status is one of `waiting`, `cancelled`, `assigned`, exactly as
`src/online/contracts.ts` declares. The service maps its internal states:

| Internal state | Wire status | `readyAt` | `cutoffAt` |
| --- | --- | --- | --- |
| waiting (searching) | `waiting` | set | set or `null` |
| reserved (the decision is written, the match is not yet) | `waiting` | set | set |
| fallback (the cutoff was reached, the engine is pending) | `waiting` | set | set |
| expired (the owner stopped responding) | `waiting` | `null` | `null` |
| cancelled | `cancelled` | set or `null` | `null` |
| assigned | `assigned` | set | `null` |

An expired entry is reported as `waiting` with a `null` `readyAt`, which is
the shape the workspace controller reads as "expired, rejoin explicitly". An
expired entry is never revived: the owner rejoins explicitly.

## Matching rules the service owns

- Only accounts enter the queue. A guest is refused.
- Two entries match when they have the **same** starting time and increment,
  **different** owners and **at least one agent** seat. Human/human and
  same-owner pairs are ineligible.
- The oldest eligible ready entry answers. Colors are random and the
  starting position is the standard one. A custom position never enters the
  queue. The order is the ready time and then the creation time; two entries
  that became ready at the very same instant are a tie, and the tie is broken
  by the entry identifier, which is stable but not creation-ordered.
- Every entry is consumed once. One entry produces exactly one game and one
  fixed opponent. The database enforces it: the consumed entry has a unique
  row in the allocation ledger.
- A candidate that becomes ready exactly at the cutoff wins over the engine.
  A candidate that becomes ready after the cutoff does not.
- The engine fallback is committed only after the browser reports a ready
  engine and after the final candidate recheck.
- A late candidate, a late engine readiness or a reconnected tab can never
  replace a committed opponent.
- A waiting entry whose owner stops responding expires. The owner rejoins
  explicitly.
- There is no owner concurrency cap: an owner may hold any number of entries
  and games.

## The browser engine seat

The engine of a fallback runs in the requesting owner's browser, so the owner
needs an authority that can move the engine seat and nothing else.

The implementation gives the engine seat **its own participant identity**, a
guest identity that is derived from the idempotency key of the allocation and
that is never the requesting account. The answer carries a seat credential
for that participant, scoped to that one match and that one seat, revocable,
and superseded by every later issuance.

```
online_seats:  engine seat  -> owner_kind='guest', owner_id='engine_…'
credential:    bound to (match_id, seat) with the engine guest identity
```

The requesting account therefore never owns the opponent seat: it cannot act
for the engine through its account session, and the credential it receives
acts for the engine seat only. The participant checks of the match are not
weakened: the credential is checked against the seat binding on every use,
and the seat owner in `online_seats` is immutable.

**Known residual (coordination, not a queue defect).** The credential is a
full *seat* credential, so its holder may also resign the engine seat. The
approved specification and the published matching contract both describe the
engine seat grant in exactly this shape ("a narrowly scoped engine-seat
grant"), and the per-turn lease of KHA-73 is what fences the runner. A
move-only capability for the engine seat would be a change of the approved
contract, so it is not invented here. The matching worker (KHA-75) and the
runner worker (KHA-73) own that boundary; the queue keeps the engine seat a
separate participant and never gives the account the opponent seat.

## Browser modules

| Module | Owner | Purpose |
| --- | --- | --- |
| `src/online/queue.ts` | queue | the route constants, the request and answer types, the parsers and the domain rules (`isExpiredEntry`, `isAssignedEntry`, `queuePhaseOf`) |
| `src/online/queue-client.ts` | workspace | the HTTP adapter for the queue routes |

`src/online/queue.ts` exports `createQueueClient(requester)`, which takes the
authorized request boundary and calls the routes above. The workspace should
use it instead of re-declaring the bodies.

## Composition notes for the integrator

- The queue allocates matches through the **shared** trusted writer
  (`online.MatchAllocator`: `CreateAllocatedMatch` and `ValidateSetup`). The
  queue never writes a match row itself, so there is one copy of the
  acceptance SQL and one rules-policy check. The queue asks the writer for
  the match **outside** the queue transaction, after the durable reservation
  row was written; a failure in between leaves a recoverable pending
  allocation that the reconciliation loop finishes.
- The composition reads `cfg.Online.FriendEnabled` and
  `cfg.Online.QueueEnabled` and passes
  `httpapi.NewFeatures(httpapi.OnlineFeatures{Friends: …, Queue: …})`.
- The queue reconciliation loop (`StartQueueReconciler`) expires the
  unresponsive entries, resolves the cutoffs that passed against their
  original deadline and finishes the pending allocations. It never commits
  the engine fallback: that needs a ready engine in the owner's browser.
- The public label of an owner comes from a `LabelResolver` port. The queue
  ships with a default resolver that names every owner "Player"; the
  production composition should pass the public profile service.

## Status

The routes above are implemented by the queue worker. The acceptance
scenarios `QUE-01` … `QUE-05`, `QUE-07` … `QUE-10`, `QUE-13`, `QUE-14` and
`ARC-10` are recorded in `docs/implementation/KHA-76-evidence.md`.
