# Online workspace and queue interface decisions

Owner: KHA-74 (online board workspace, concurrent-game navigation) and KHA-77 (queue
readiness and Stockfish fallback), browser side only.

This note publishes the concrete browser-side route and TypeScript interface
decisions of the workspace worker so the matching, privacy and foundation
workers align on the same wire shapes. It describes what the browser *calls*.
It does not describe service internals, and it grants no deployment or
public-launch permission.

## Existing routes the workspace already uses

These routes exist in `backend/httpapi/online.go` and are not changed here.

| Route | Method | Request | Answer |
| --- | --- | --- | --- |
| `/v1/online/matches/{matchID}` | GET | participant credential | `onlineMatchResponse` (the participant live view) |
| `/v1/online/matches/{matchID}/updates` | GET | participant credential, `Accept: text/event-stream` or `application/json` | `{ schemaVersion: 1, cursor, snapshot }` |
| `/v1/online/matches/{matchID}/commands` | POST | participant credential, body = `online.Command` | `online.Receipt` |
| `/v1/online/matches/{matchID}/operations/{operationID}` | GET | participant credential | `online.Receipt` |
| `/v1/online/matches/{matchID}/replay` | GET | none | `online.PublicProjection` |

The browser command body is exactly the TypeScript `Command` of
`src/online/contracts.ts` (schema version 2): `schemaVersion`, `matchId`,
`operationId`, `expectedVersion`, `seat`, `controlEpoch`, `action`. The
workspace never sends a credential in a URL, a query string or a body.

## Routes the workspace needs from the matching worker

The browser sends and receives the shared contracts of
`src/online/contracts.ts` (`QueueEntry`, `SeatControl`, `TimeControl`). The
workspace expects these routes; the matching worker owns their implementation
and may rename them once, in which case only
`src/online/queue-client.ts` changes.

| Route | Method | Request body | Answer |
| --- | --- | --- | --- |
| `/v1/online/queue/entries` | POST | `{ schemaVersion: 2, control, timeControl }` | `QueueEntry` |
| `/v1/online/queue/entries/{entryID}` | GET | - | `QueueEntry` |
| `/v1/online/queue/entries/{entryID}/ready` | POST | `{ schemaVersion: 2 }` | `QueueEntry` with `readyAt` and `cutoffAt` set |
| `/v1/online/queue/entries/{entryID}/cancel` | POST | `{ schemaVersion: 2 }` | `QueueEntry` with status `cancelled` |
| `/v1/online/queue/entries/{entryID}/keep-searching` | POST | `{ schemaVersion: 2 }` | `QueueEntry` with `cutoffAt: null` |
| `/v1/online/queue/entries/{entryID}/fallback` | POST | `{ schemaVersion: 2 }` | `{ matchId, seat }` |

`QueueEntry.readyAt` is set by the service when it accepts the ready entry, and
`cutoffAt` is the absolute instant of the ten-second search window. The
service owns the window; the browser never invents a deadline. A `fallback`
answer names the created Stockfish match and the seat the caller plays.

The invitation routes belong to the same worker. The workspace only needs to
know that accepting an invitation answers with the participant live view of the
created match, so it can attach the match without a second lookup:

| Route | Method | Request body | Answer |
| --- | --- | --- | --- |
| `/v1/online/invitations/{invitationID}/accept` | POST | `{ schemaVersion: 2 }` | `onlineMatchResponse` |

## Browser-side TypeScript modules

| Module | Owner | Purpose |
| --- | --- | --- |
| `src/online/workspace.ts` | workspace | concurrent live games, focus, reconnect status, results |
| `src/online/match-client.ts` | workspace | participant command client over the existing command route |
| `src/online/queue-client.ts` | workspace | HTTP adapter for the queue routes above |
| `src/online/readiness.ts` | workspace | own-agent readiness, search window, cutoff fallback state machine |
| `src/online/engine-seat.ts` | workspace | browser Stockfish 19 Lite seat for a fallback game |
| `src/online/runner-lease.ts` | workspace | runner lease and runner request client |
| `src/online/composition.ts` | workspace | the composition of the online browser parts |
| `src/online/features.ts` | workspace | the two rollout switches and the loopback test opt-in |
| `src/online/clock.ts` | workspace | the interpolated reading of the canonical clock |
| `src/online/queue.ts` | matching | queue domain rules (not written here) |
| `src/online/friends.ts` | matching | invitation domain rules (not written here) |

`src/online/workspace.ts`, `src/online/readiness.ts` and
`src/online/engine-seat.ts` are pure orchestration modules with injected
ports. They own no transport, no chess authority and no provider request.

## Feature enablement

The online surface is **off by default**. A configured service origin never
opens a surface on its own: a production account build already configures an
origin, so the origin says nothing about the rollout.

Two independent switches exist, both defaulting to false:

| Switch | Opens |
| --- | --- |
| friend play | the friend routes: invitations, link joins, rematches |
| queue play | the public queue, the readiness flow and the Stockfish fallback |

The service owns the rollout and answers it on one always-mounted route:

```
GET /v1/online/features
→ 200 { "friends": boolean, "queue": boolean }
```

The answer carries exactly those two fields. A missing field, an unknown field
or a non-boolean value closes every surface (`src/online/features.ts`).

A test build may opt in locally with `?online=1` (or `?online=queue`,
`?online=friends`). The opt-in is honored **only** against a loopback service
origin, so a deployed build ignores it and a deployed service stays closed
unless it opens the surface itself.

The browser asks the features route without a participant credential: the
answer is public, so a signed-out visitor discovers it too.

## Routes this workspace uses

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/online/features` | GET | the two rollout switches |
| `/v1/online/matches/{matchID}` | GET | the participant live view |
| `/v1/online/matches/{matchID}/updates` | GET | the finite update stream and its polling fallback |
| `/v1/online/matches/{matchID}/commands` | POST | the versioned participant command |
| `/v1/online/matches/{matchID}/presence` | POST/GET | the liveness heartbeat and the presence view |
| `/v1/online/matches/{matchID}/runner/lease` | POST | the runner lease of an agent or engine seat |
| `/v1/online/matches/{matchID}/runner/request` | POST | the uncertain provider request of a runner |
| `/v1/online/queue/entries…` | GET/POST | the queue entry routes of the queue worker |
| `/v1/online/invitations…` | GET/POST | the friend invitation routes of the matching worker |
| `/v1/online/rematches…` | POST/GET | the rematch routes of the matching worker |
| `/v1/public/matches/{matchID}/replay` | GET | the public replay of a finished match |
| `/v1/public/profiles/{profileID}/history` | GET | the public game history of a profile |
| `/v1/privacy/account/deletion` | POST | the ordinary account deletion |
| `/v1/privacy/account/removal` | POST | the explicit removal of the shared replays |
| `/v1/privacy/guest/removal` | POST | the explicit removal of a guest seat owner |
| `/v1/privacy/account/model-labels` | POST | the public label of an owner chosen agent |

The queue routes and their answers are published by the queue worker in
`docs/online/queue-contract.md` and implemented by its typed client
`src/online/queue.ts`. The browser uses that client; the workspace owns no
second queue client.

The friend routes and their answers are published in
`docs/online/matching-interfaces.md`. The browser adapter of the workspace is
`src/online/friend-routes.ts`; the matching worker's typed client
`src/online/friends.ts` is the canonical one and replaces the adapter when the
two are reconciled.

The public reads and the removal flows are the typed clients of the privacy
worker: `src/online/history.ts` and `src/online/privacy.ts`.

### The queue answers the browser reads

- The creation is the authoritative ready acceptance: `readyAt` is set and
  `cutoffAt` is `readyAt + 10s`.
- `cutoffAt: null` means the owner removed the automatic cutoff.
- A waiting entry with `readyAt: null` is expired and needs an explicit
  rejoin with `POST /entries/{id}/ready`.
- The fallback answer carries the engine seat credential:
  `schemaVersion, matchId, seat, opponentLabel, control,
  guestCredential{guestId, matchId, seat, token, expiresAt}`.
- The entry heartbeat renews the readiness lease of a waiting entry.

The runner lease body is the one of the participant API:

```jsonc
{
  "schemaVersion": 2,
  "action": "acquire" | "renew" | "release",
  "seat": "white" | "black",
  "runnerId": "…",
  "leaseId": "…",       // renew and release
  "turnVersion": 7,
  "controlEpoch": 3
}
```

The service decodes the body strictly, so the browser sends exactly these
fields. The command envelope carries the optional `leaseId` of the turn.

### The agent label

The service canonicalizes the label of an agent seat: a known public model
name becomes its public form, and an unknown name becomes a generic one
unless the owner registered it. The browser therefore registers the chosen
public label with `POST /v1/privacy/account/model-labels` before it asks for
a queue entry, a friend invitation or a control change, and it binds the
canonical label the service answers to the private selection. The binding
never guesses: the private routing identity stays in the browser.

## Privacy actions

The privacy worker owns removal. The workspace renders a removal action and
calls the typed client of that worker. The owner-requested removal of one
replay is the participant command `remove_public_replay` of the match.
