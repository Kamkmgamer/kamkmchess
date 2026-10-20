# The browser-owned online agent runner

This note is the interface contract of
[`src/online/provider-runner.ts`](../../src/online/provider-runner.ts), the
browser runner that plays one agent seat of one online match. It is the
[KHA-73](https://linear.app/kamkm/issue/KHA-73/run-browser-owned-online-agents-with-turn-leases-and-safe-handoffs)
work. The approved specification and the acceptance matrix stay canonical; the
runnable implementation is this module and its fixtures.

Nothing in this note changes the shared match command contract. The runner
speaks the runner lease route and the uncertain provider request route of the
service, and it uses the shared command route for the moves, the resignations,
the control changes and the spent recovery attempts.

## The rules the runner keeps

- One lease per seat and per turn. The runner acquires the lease before the
  first provider request, renews it while it works and before it submits an
  answer, and releases it when the turn ends. A second runner of the same seat
  is refused by the service, so a duplicate tab shares the game.
- The service owns the outcome. The runner proposes a move, a resignation, a
  control change or a spent recovery attempt. It never decides a result.
- The budgets are the service's. Four illegal attempts and three automatic
  formatting corrections are counted by the service. A retry, a switch or a
  takeover never refills a spent budget.
- A provider failure never concedes. It produces an explicit owner decision.
- Uncertain billable work is never repeated by itself. The runner leaves the
  request identifier behind in the service lease and in the browser-local
  pending record, and it offers Retry, switch or takeover.
- A stale answer is dropped. A snapshot that changes the position, the side to
  move or an epoch cancels the pending answer.
- Exactly one accepted move. Every command carries an operation identifier, and
  a lost acknowledgement is retried with the same identifier.
- Nothing private is shared. The credential, the provider route and the model
  conversation stay in the browser.

## The wire the runner speaks

The service decodes both bodies strictly, so an unknown field is refused. The
runner therefore never sends a `generation` field and never uses a method per
operation.

### The runner lease route

`POST /v1/online/matches/{matchID}/runner/lease`

```jsonc
{
  "schemaVersion": 2,
  "action": "acquire" | "renew" | "release",
  "seat": "white" | "black",
  "runnerId": "<opaque runner identifier>",
  "leaseId": "<only for renew and release>",
  "turnVersion": 7,          // only when it is known
  "controlEpoch": 3          // always
}
```

`GET /v1/online/matches/{matchID}/runner/lease?seat=white` reads the lease of
a seat. The answer is the lease record: `leaseId`, `matchId`, `seat`,
`controlEpoch`, `generation`, `runnerId`, `status`, `acquiredAt`, `expiresAt`,
`revokedAt`, `turnVersion`, `runnerEpoch`, `pendingRequestId`,
`pendingRequestStartedAt`, `revokedReason` and `lastRenewedAt`.

### The uncertain provider request route

`POST /v1/online/matches/{matchID}/runner/request`

```jsonc
{
  "schemaVersion": 2,
  "action": "begin" | "clear",
  "seat": "white" | "black",
  "runnerId": "<opaque runner identifier>",
  "leaseId": "lease-…",
  "requestId": "<opaque request identifier>",
  "controlEpoch": 3,
  "turnVersion": 7            // only when it is known
}
```

`begin` records that a billable request started, `clear` records that it
settled. The service refuses a second `begin` while another request is
recorded, so the runner settles a request before it starts the next one.

The bodies are built by `buildRunnerLeaseBody` and `buildRunnerRequestBody`, and
the lease answer is read by `parseRunnerLeaseAnswer`. Both live in the module,
so a change of the contract lands in one place.

### The failures the runner reads

| Status | Meaning | Runner behaviour |
| --- | --- | --- |
| 400 | The body or the contract was refused | The runner stops and reports the failure |
| 404 | The match, the seat or the lease does not exist | The runner stops |
| 409 | A stale version, a stale epoch, a held seat, a revoked lease | The runner gives the lease up and waits |
| 401 / 403 | The credential was refused | The runner stops |
| 503 | The service could not serve the request | The runner retries the same operation |

`classifyProviderRunnerError` maps a failure of any client onto these kinds. A
failure that carries only an HTTP status is mapped by the table; a failure that
carries a `kind` is taken as it is.

## The ports the UI injects

### The lease client

```ts
export interface ProviderRunnerLeasePort {
  readonly runnerId: string;
  acquire(input: { controlEpoch: number; turnVersion: number | null }): Promise<ProviderRunnerLease>;
  renew(input: { controlEpoch: number; turnVersion: number | null; leaseId: string }): Promise<ProviderRunnerLease>;
  release(input: { controlEpoch: number; turnVersion: number | null; leaseId: string }): Promise<ProviderRunnerLease>;
  beginRequest(input: { controlEpoch: number; turnVersion: number | null; leaseId: string; requestId: string }): Promise<ProviderRunnerLease>;
  clearRequest(input: { controlEpoch: number; turnVersion: number | null; leaseId: string; requestId: string }): Promise<ProviderRunnerLease>;
  read(): Promise<ProviderRunnerLease | null>;
}
```

The client owns the runner identifier. Two tabs of one owner must not share
it, because the service refuses a second runner of a seat that a live lease
holds. The client is per match and per seat.

### The command client

```ts
export interface ProviderRunnerCommandPort {
  submit(action: OnlineAction, options?: ProviderRunnerCommandOptions): Promise<Receipt>;
  setControlEpoch?(epoch: number): void;
  setVersion?(version: number): void;
}
```

The participant command client of the online workspace satisfies this shape.
The runner always sends the lease identifier, the expected version and the
operation identifier of the command.

### The provider client

```ts
export interface ProviderRunnerProviderPort {
  run(prompt: ProviderRunnerPrompt): Promise<ProviderRunnerAnswer>;
}
```

The client owns the credential, the route and the conversation. It never
receives a credential of the service. `createProtocolProviderPort` builds one
from the shared protocol encoders, the shared protocol decoders and the shared
provider transport, so the request building of the offline game and the request
building of the online game agree.

### The private stores

The conversation store and the pending store are browser-local. The module
ships an in-memory conversation store, a local storage conversation store and a
local storage pending store. Nothing of them is ever sent to the service.

## The state the runner needs

The runner acts on the canonical match state. The interface is
`ProviderRunnerSnapshot`:

| Field | Source |
| --- | --- |
| `version` | The match version of the snapshot |
| `controlEpoch` | The control epoch of the snapshot |
| `status` | The match status |
| `sideToMove` | `clock.replySeat ?? clock.activeSeat` |
| `positionFen`, `startingFen`, `moves` | The snapshot |
| `clock` | `clock.whiteMs`, `clock.blackMs`, `timeControl.incrementMs` |
| `seatControl` | The seat view of the snapshot |
| `illegalAttemptsSpent`, `formatCorrectionsSpent` | The seat view of the snapshot |
| `serviceEpoch`, `seatEpoch` | Optional. The service epoch and the seat binding epoch |

The runner is fed with `applySnapshot`. A snapshot that changes the position,
the side to move, the control epoch, the service epoch, the seat epoch or the
declared control of the seat cancels the pending answer.

## The phases of the runner

| Phase | Meaning |
| --- | --- |
| `idle` | No work is running |
| `waiting-lease` | The seat is not held by this runner |
| `generating` | A provider request is running |
| `submitting` | A command is on its way to the service |
| `uncertain` | Uncertain billable work waits for an explicit owner decision |
| `paused` | The automatic formatting budget is spent. The owner recovers |
| `failed` | The provider or the transport failed. The owner recovers |
| `stopped` | The runner was stopped on purpose |

The `uncertain`, `paused` and `failed` phases offer the decisions `retry`,
`switch-model` and `takeover`. The runner never leaves one of them by itself.

## The explicit owner decisions

- `retry()` sends the lost operation again with the same operation identifier
  and starts one more provider request. The owner accepts that the uncertain
  work may be paid twice. The spent budgets stay spent.
- `switchModel(publicModelLabel)` sends `set_control` with a new public label.
  The control epoch advances, the lease of the seat is revoked and the runner
  continues with the new agent.
- `takeover()` sends `set_control` with the human control. The seat belongs to
  the owner and the runner stops.

A public label is a chosen name. `isPublicModelLabel` refuses a label that
could name a route, and `assertSharedActionSafe` refuses a shared action with
an unknown field.

## The turn of the runner

1. The runner takes the lease of the turn. A lease that carries a pending
   request, or a browser-local pending record, stops the runner: the previous
   runner may have started billable work.
2. The runner renews the lease, records the request with `begin` and asks the
   provider.
3. The answer is read with the shared classified decoder. A move, an explicit
   resignation, a formatting failure or an illegal move.
4. The runner renews the lease again, because a lease that expired during a
   long turn may not submit an answer.
5. A move is submitted as `submit_move`. An illegal move is reported as
   `record_recovery_attempt` with `illegal_move` and the turn continues with a
   correction. A formatting failure is reported as `record_recovery_attempt`
   with `formatting_correction`. A resignation is submitted as `resign`.
6. The lease is released when the turn ends.

The expected version of every command is the version the lease is bound to.
The service checks that the lease of an agent seat is live and bound to the
turn of the command, so a reply of a superseded runner can never become an
accepted move.

## The uncertainty of a lost runner

When the runner loses its lease while a provider request may still be running,
it stops with the phase `uncertain`. It keeps the request identifier in the
service lease and in the browser-local pending record, so the next runner of
the seat sees that billable work may be pending. The next runner never issues
a provider request by itself. It offers Retry, switch or takeover, and the
owner decides whether the work is paid twice.

## What the UI has to change

1. **The lease client.** `src/online/runner-lease.ts` currently sends
   `POST`/`PUT`/`DELETE` with a `generation` field. The service accepts one
   `POST` with an `action` field and refuses an unknown field. The client has
   to use `buildRunnerLeaseBody` and `buildRunnerRequestBody` and to speak
   `acquire`, `renew`, `release`, `begin` and `clear`.
2. **The snapshot mapping.** The workspace delivers an `OnlineMatchView`. The
   UI maps it to a `ProviderRunnerSnapshot` and hands it to the runner.
3. **The provider client.** The UI resolves the connection profile and the
   credential of the agent, and it builds a `ProviderRunnerProviderPort`. The
   credential never leaves the browser. After a model switch the UI resolves
   the provider target of the new agent again, because the runner keeps the
   public label and the provider client owns the route.
4. **The owner decisions.** The interface shows the decisions of the runner
   state and calls `retry`, `switchModel` or `takeover`.

## The evidence

`tests/online/provider-runner.test.ts` drives the runner through its public
API with a deterministic provider, a deterministic lease client and a
deterministic command client. The lease client speaks the exact wire of the
service and applies the documented rules of the service, so the runner is
exercised against the contract and not against a private shortcut.

| Case | Fixture |
| --- | --- |
| ARC-08 | The lease of the turn, one accepted move, the release of the lease |
| ARC-08 | A duplicate tab is refused and never asks the provider |
| ARC-08 | Three separately requested games run at the same time |
| ARC-09 | A lease that is lost during a request asks the owner and issues no second request |
| ARC-09 | A pending request of a previous runner asks the owner |
| ARC-09 | A pending request of the browser survives a reload |
| ARC-09 | A lost acknowledgement recovers the original receipt and accepts one move |
| MAT-08 | The spent budgets survive a control change |
| MAT-09 | The answer of a superseded turn is dropped |
| MAT-09 | The late reply of a superseded controller is fenced |
| MAT-09 | A takeover hands the seat to the owner, a switch names a new public label |
| MAT-10 | Four illegal attempts lose, the formatting budget stays independent |
| MAT-10 | Three formatting corrections pause the turn and wait for the owner |
| MAT-10 | A provider failure never resigns and never repeats the request |
| — | The shared commands carry no credential, no route and no conversation |

The fixtures send no provider request and need no credential, no account and no
paid request. They are deterministic evidence of the behaviour, not of the
live readiness of the service.

## Contract notes

- The request body of the lease route carries `controlEpoch` and no
  `generation` field. The generation belongs to the answer of the service. If
  the foundation adds a `generation` field to the request, the change lands in
  `buildRunnerLeaseBody` and in the lease client of the UI together.
- The service refuses a lease request whose `controlEpoch` or whose
  `turnVersion` does not match the current state. The runner sends the epoch
  and the turn version it acts for and gives the lease up when the service
  refuses them.
- A new lease carries the pending request of the previous lease of the seat.
  That is the honest record of uncertain billable work, and the runner honours
  it.
