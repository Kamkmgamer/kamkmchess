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
- The heartbeat of the lease survives a transient failure. A failed renewal is
  armed again with a bounded backoff, and the runner fails closed before the
  lease of the service expires.
- The service owns the outcome. The runner proposes a move, a resignation, a
  control change or a spent recovery attempt. It never decides a result.
- The budgets are the service's and they are per turn. Four illegal attempts
  and three automatic formatting corrections are counted by the service. The
  browser follows the canonical counts of the current turn: a retry, a switch
  or a takeover never refills a spent budget, and the next turn starts with the
  budget of the service.
- The corrections of the prompt belong to the turn. A correction of an earlier
  turn belongs to another position and is never sent again, while a correction
  of the same turn survives a retry, a switch and a takeover. The history of
  the conversation is never cleared.
- The controller of the seat is the control epoch of the seat, never a label.
  A runner of a superseded controller stands down and never submits a move.
- The published label of the agent is the label the service resolves, never the
  label the owner declared. The runner adopts it from the receipt of a control
  change and from the seat view of the snapshot.
- A provider failure never concedes. It produces an explicit owner decision.
- The phase of a runner may only be left by an explicit owner decision. The
  generation of the lifecycle moves when the owner stops the runner, when the
  match ends, when another controller takes the seat and when the runner is
  disposed, and every answer of a request that was still in flight belongs to
  the generation it was sent in. A late answer therefore writes no phase,
  starts no work and asks the provider for no second answer.
- The decision of the owner settles the uncertain work. `retry()` and
  `switchModel()` close the pending record of the browser and the pending
  record of the service, so the decision is effective: the provider is asked
  again. Without that, the guard that keeps the runner from asking the
  provider again would swallow the decision of the owner. `takeover()` leaves
  the record open on purpose: the seat belongs to a human owner, who does not
  pay for the billable request of the agent, and the record keeps the seat
  honest until a decision of the owner closes it.
- The settlement closes exactly the record the owner decided about. The
  record is captured in the tick of the decision, before any await, and it is
  the record the uncertainty names. A record that another tab of the same
  browser writes while the decision waits for the service is a different
  request: it is neither settled nor authorized by that decision.
- The settlement of a switch runs under the epoch of the seat now. The service
  revokes the lease of the seat with a control change, so the request of the
  old epoch cannot be closed under the lease it was recorded on. The runner
  takes a lease of the new epoch for the settlement alone: the lease is never
  installed, it arms no heartbeat, and it is given back right after the
  settlement, because the runner of the old selection never plays the seat
  again. Only the request the decision captured is closed, and only when the
  new lease still carries exactly that request. A newer request of another
  runner keeps its record, and the record of the old epoch is not open at the
  service any more.
- The lease of a settlement carries its own envelope. The control epoch and
  the turn of the request that closes a record are the epoch and the turn of
  the lease it is closed under, never the facts the runner knows in the
  meantime. A lease of another epoch is not the lease of this seat, and a
  release never presents the epoch of another decision either.
- The settlement belongs to the decision of the owner that started it. After
  every await the runner checks that decision again: a newer decision of the
  owner, a stop or a dispose ends the settlement, and the record of the
  service keeps its state. The lease of the settlement is given back, and only
  that lease: a decision that adopted the very same lease owns the seat now,
  so the settlement never revokes it.
- The runner remembers the billable request the service recorded on the lease
  of the seat. The record of the service survives the change of the lease, so
  a decision of the owner settles exactly that request, even when the
  uncertainty of the browser names another one.
- A settlement the service refuses is a recoverable outcome. The record of the
  billable work stays open at the service, so the seat asks the owner about it
  instead of playing with work that may be paid twice, and the runner keeps
  the envelope of the accepted command: the owner may send the very same
  command again and read the receipt the service already earned. The switch
  itself stays the decision of the owner, because the receipt of the accepted
  command proves the control change: its outcome is `accepted` and the detail
  names what the settlement had to leave out. A retry stays `unknown` in that
  case, because the decision of the owner was to let the runner play again.
- The authorization of the owner is recorded only when the settlement reached
  its end while the decision was still the decision of the owner. A superseded
  decision leaves no authorization behind and sends no command, so the next
  turn is fenced again by the record it could not settle.
- Every action of the owner belongs to a generation. `retry()`,
  `switchModel()`, `takeover()` and `stop()` check the generation after every
  await: a newer action of the owner, a stop or a dispose ends the older
  action. The older action then writes no phase, sends no command and changes
  no record, so the newest decision of the owner is the one that counts. The
  settlement of a pending record only clears the record it read, so a newer
  record of a billable request is never erased.
- The owner actions have an order and a report. Every action takes a token
  before it sends its command, so two decisions that compete reach the service
  in the order of the owner, and the refusal of the newest one is sent again
  with the version the service has now. A decision that is not the newest one
  is `unknown` and never retries: its command is not sent again, not even when
  the acknowledgement of the first attempt was lost. The generation of the
  lifecycle fences the same actions: a decision that waits while the match
  ends is `unknown` as well, because the outcome could not be established.
- Every command of the runner belongs to a fence. The command of an owner
  action belongs to the token of that action, and the command of the runner's
  own work belongs to the generation of the lifecycle the turn was started in.
  The fence decides whether the command may be sent again after a lost
  acknowledgement: a move of a turn the owner stopped, and a command of a
  decision that a newer decision superseded, are never sent again. A
  superseded command changes nothing: it spends no attempt, writes no phase
  and gives no lease back.
- The bookkeeping of a command belongs to that command. The runner keeps the
  operation identifier of the command whose acknowledgement is missing, so
  the owner may send it again. A command that answers late never clears the
  bookkeeping of a newer command that is still waiting, so the newer unknown
  command stays retriable. The version and the control epoch of a receipt are
  facts of the service: they move on even when the receipt arrives late,
  because the next command of the runner has to carry them.
- The bookkeeping of a command keeps the whole envelope of the command. The
  service hashes the expected version, the control epoch, the lease and the
  action of a command into the fingerprint of its operation identifier, and it
  hands the stored receipt out again only when the replay carries the very
  same command. A replay therefore sends the expected version, the control
  epoch and the lease the command was sent with, never the facts the runner
  knows in the meantime. A command that presents no lease presents none
  again: the lease of the original command is part of its fingerprint.
- A command the service refused was not applied under the envelope it carried.
  The service refuses a stale version or epoch, and it refuses a changed
  payload under an operation identifier it already accepted. The runner sends a
  refused command again with the facts it knows now, exactly like the handoff
  of the seat does, and the operation identifier stays the same. The service
  applies a command at most once: an operation it accepted is answered with
  its stored receipt, and a changed payload under an accepted operation
  identifier is refused.
- The bookkeeping of a refused command follows the command. The refusal of the
  old envelope clears the record of the command, so the record is installed
  again with the envelope of the last attempt, as long as the decision of the
  owner is still the newest one. A command the service applied and never
  answered therefore stays retriable, and a newer command that waits for its
  acknowledgement keeps its own record.
- A command whose acknowledgement is lost is an uncertainty, whoever sent it.
  The runner keeps the operation identifier of the command, the phase is
  `uncertain`, and the owner may send the command again with the same
  operation identifier. The handoff of the seat is no exception: a switch or
  a takeover whose acknowledgement is lost leaves the seat in the state the
  owner can recover from, and the command is replayed with the identifier it
  was sent with.
- The decision of the owner is bound to the request it settled. The guard of
  the turn asks whether the record in the store is one of them: that record
  may be passed once, and every other record fences the runner again. The
  records the owner decided about are captured before the acquisition of a
  lease waits for the service, so a record of another tab that appears in the
  meantime is neither authorized nor deleted.
- The handoff of the seat is the authority of the owner and it needs no
  lease. The handoff presents no lease at all: the service accepts the
  command of the owner without a lease and fences a stale runner with the
  control epoch and the version of the match, so a seat whose runner is gone
  or whose lease died can still be handed over. The runner takes the lease of
  the seat before the handoff anyway, so the pending record of the service can
  be closed with it. When that lease cannot be taken, the handoff goes
  without a lease and the outcome names the reason instead of hiding it.
- While an uncertainty is open the runner never asks the provider again. The
  browser-local pending record is checked before every request of a turn, not
  only when a lease is taken, and the check honours the decision of the owner.
- Uncertain billable work is never repeated by itself. The runner leaves the
  request identifier behind in the service lease and in the browser-local
  pending record, and it offers Retry, switch or takeover.
- A stale answer is dropped. A snapshot that changes the position, the side to
  move or an epoch cancels the pending answer.
- Exactly one accepted move. Every command carries an operation identifier, and
  a lost acknowledgement is retried with the same identifier.
- A fenced command is not a rules refusal. A command the service refuses
  because the lease no longer accepts it drops the lease and waits, and it
  never spends a recovery attempt.
- A refused credential stops the runner. It is not a lost acknowledgement and
  it is never retried.
- A finished match keeps no lease. The runner gives the lease back and stops
  the heartbeat when the match ends.
- A stopped runner is resumable. The owner may stop an agent and start it
  again, and an uncertainty that is open is never swallowed by a stop.
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

The body of that route is the shared envelope of the contract
(`buildRunnerRequestEnvelope` of `src/online/contracts.ts`). The runner builds
it through that builder, so the browser and the service read one shape. The
envelope always carries the turn version: the service reads a missing version
as the turn that is current now, and the shared parser of the contract
requires the field.

The bodies are built by `buildRunnerLeaseBody` and `buildRunnerRequestBody`,
and the lease answer is read by `parseRunnerLeaseAnswer`. The answer is read
with the strict parser of the shared contract, so the browser and the service
agree on one DTO and on one set of identifiers; the runner adds the two checks
of its own scope, the match and the seat. The shared fixture of the service is
read by the same parser on both sides.

### The failures the runner reads

| Status | Meaning | Runner behaviour |
| --- | --- | --- |
| 400 | The body or the contract was refused | The runner stops and reports the failure |
| 404 | The match, the seat or the lease does not exist | The runner drops the lease and waits. A command that carried a lease was fenced by the lease, not refused by the rules |
| 409 | A stale version, a stale epoch, a held seat, a revoked lease | The runner gives the lease up and waits |
| 401 / 403 | The credential was refused | The runner stops |
| 503 | The service could not serve the request | The runner retries the same operation |

`classifyProviderRunnerError` maps a failure of any client onto these kinds. A
failure that carries only an HTTP status is mapped by the table, a failure that
carries an authentication `code` is mapped with the codes of the participant
boundary, and a failure that carries a `kind` is taken as it is.

The codes of the participant boundary matter. A cleared, expired or changed
credential is not a lost acknowledgement: the runner stops instead of sending
the command again, and it never asks for a lease on every snapshot.

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

The lease answer has to carry the whole lease record. The runner reads
`pendingRequestId`, because it is the field that tells a new runner that a
previous runner may still have started billable work, and it reads
`runnerEpoch`, `revokedReason` and `lastRenewedAt`, because they explain the
state of the lease. The shared parser of the module reads all of them.

### The command client

```ts
export interface ProviderRunnerCommandPort {
  submit(action: OnlineAction, options?: ProviderRunnerCommandOptions): Promise<Receipt>;
  setControlEpoch?(epoch: number): void;
  setVersion?(version: number): void;
}
```

The participant command client of the online workspace satisfies this shape.
The runner always sends the lease identifier, the expected version, the
control epoch and the operation identifier of the command.

The control epoch of a command may be named by the caller:

```ts
export interface ProviderRunnerCommandOptions {
  operationId?: string;
  expectedVersion?: number;
  controlEpoch?: number;
  leaseId?: string;
}
```

The epoch of a command that names one is the epoch of that command, and the
epoch of the client is only the fallback for the commands that name none. The
runner therefore never changes the epoch of the client around a command that
waits: a newer command of another decision would otherwise ride the epoch of
the older one.

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

A conversation record carries the turn it belongs to, named by the canonical
position of that turn. The prompt of a turn reads the corrections of that
turn only, while the history of the conversation itself stays in the store:
the accepted moves of the game are never cleared, and the correction of a
turn survives a retry, a switch and a takeover of that turn.

## The state the runner needs

The runner acts on the canonical match state. The interface is
`ProviderRunnerSnapshot`:

| Field | Source |
| --- | --- |
| `version` | The match version of the snapshot |
| `controlEpoch` | The control epoch of the snapshot |
| `status` | The match status |
| `sideToMove` | `onlineSideToMove(view)` of `src/online/turn.ts` |
| `positionFen`, `startingFen`, `moves` | The snapshot. The moves are the notation of the game record |
| `clock` | `clock.whiteMs`, `clock.blackMs`, `timeControl.incrementMs` |
| `seatControl` | The seat view of the snapshot. The label it carries is the published one |
| `seatControlEpoch` | `seatView.controlEpoch`. The canonical answer to the question which controller plays the seat |
| `illegalAttemptsSpent`, `formatCorrectionsSpent` | The seat view of the snapshot. The canonical counts of the current turn |
| `serviceEpoch`, `seatEpoch` | Optional. The service epoch and the seat binding epoch |

`providerRunnerSnapshotFromView(view, seat, options)` is the canonical
conversion of the match view of the service. The UI uses it instead of
building the state by hand, because the control epoch of the seat, the
published label of the agent and the canonical counters of the turn all come
from the same seat of the same view. A hand-built state that names the wrong
epoch makes the runner stand down for a controller it still owns, and a state
without the epoch never fences the runner at all.

The side to move is the shared rule of the service, the interface, the engine
seat and the runner: the seat of the opening reply window while it is open,
the seat whose main clock runs otherwise, and the seat the canonical position
names while no clock runs at all. The main clock is never the authority for
the turn, because the service arms no main clock for the seat that has to move
first. A fresh match therefore starts with the side of the canonical
position, and a custom position that starts with Black starts with Black.

The moves of the match are the notation of the game record, exactly like the
request building of the offline game, so the provider reads the same history
in an online game and in a local one.

The runner is fed with `applySnapshot`. A snapshot that changes the position,
the side to move, the control epoch, the service epoch, the seat epoch or the
control epoch of the seat cancels the pending answer.

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
| `stopped` | The runner was stopped on purpose, or the credential was refused |

The `uncertain`, `paused`, `failed` and `stopped` phases offer the decisions
`retry`, `switch-model` and `takeover`. The runner never leaves one of them by
itself, and `start()` and `resume()` start a stopped runner again. A provider
that answers with an error leaves the phase `failed`, so the next snapshot of
the match does not ask the provider again without a decision of the owner.

The state of the runner also carries `publicModelLabel`, the label the service
publishes for the agent, `boundSeatControlEpoch`, the control epoch of the seat
the runner is bound to, and `superseded`, which is true when another
controller took the seat.

## The explicit owner decisions

- `retry()` sends the lost operation again with the same operation identifier
  and with the envelope it was sent with, so the service answers with the
  original receipt instead of accepting the command twice. When the browser
  holds no command, `retry()` starts one more provider request. The owner
  accepts that the uncertain work may be paid twice. The spent budgets stay
  spent.
- `switchModel(publicModelLabel)` sends `set_control` with a new public label.
  The control epoch advances, the lease of the seat is revoked and the runner
  hands the seat to the new agent. The service resolves the declared label to a
  publishable one, so the runner adopts the published label of the receipt and
  binds the new control epoch of the seat. The runner of the old model does
  not play the seat any more: the private selection of the seat belongs to the
  caller, and the caller binds the model of the new control and builds the
  runner of the seat again.
- `takeover()` sends `set_control` with the human control. The seat belongs to
  the owner and the runner stops. The record of an uncertain billable request
  stays open: a human owner does not pay for the request of the agent, and the
  record keeps the seat honest until a decision of the owner closes it.
- `start()` and `resume()` start a stopped runner again.

Every one of them answers with the outcome of the decision:

| Outcome | Meaning |
| --- | --- |
| `accepted` | The decision was accepted. `retry()` accepted the replay of the pending command, or the scheduling of one more request of the provider when the browser holds no command; `switchModel()` and `takeover()` accepted the canonical command of the service. The seat declares this public label |
| `refused` | The service or the runner refused the decision. The seat keeps its state |
| `unknown` | The outcome could not be established. The owner may retry |

An accepted decision of a handoff may carry a detail. It names what the
runner had to leave out, for example that the lease of the seat could not be
taken and that the handoff therefore went without it. The detail never
replaces the outcome: an outcome of `accepted` still means that the decision
was applied.

An accepted decision may carry the control of the seat that the receipt
proves. It is set only when the accepted command was a control change and the
receipt of the service proves it: `agent` for the browser, `human` for the
owner. The runner adopts the published label of the receipt and binds the
control epoch of the seat, and it stands down when the seat belongs to the
human owner. The receipt is only read when it is not older than the control
epoch the runner already knows, so a receipt that arrives after a newer
canonical state never binds a stale epoch of the seat. The control carries no
private choice of the owner: the caller binds the selection it captured before
it asked the service, and it never infers a private choice from a public
label.

The caller keeps the decision of the owner. A handoff whose acknowledgement is
lost is a decision the browser cannot prove, so the caller captures the choice
of the owner and the private selection it resolves to before it asks the
service. The capture survives an unknown outcome and every retry of it: a
later catalog entry, an identity that comes and goes and a newer decision
never replace it. The caller applies it only when the outcome proves it: the
receipt has to name the control of the seat, the captured decision has to be
the decision that was replayed, and the identity that took the decision has to
be the identity of the browser now. The generation of the identity decides
that: the generation is monotonic, so an identity that leaves and comes back
is a different generation and never inherits the decision of the older one.
A proven switch binds the captured private
selection and builds the runner of the seat again, so the seat plays the model
the owner chose with the credential of that model. A proven takeover removes
the private binding of the seat from the memory and from the device, so the
seat is never played by the browser again.

A runner that proved a control change asks the provider for nothing after the
receipt. The private selection of the seat belongs to the caller, and only the
caller can bind the model of the new control: the runner of the old selection
would ask the provider with the credential of the old model.

The outcome carries no routing identifier, no credential and no private
selection; it carries the public label the seat declares. The caller reads it:
a takeover that the service refused must not delete the runner of the seat, and
a decision that a newer decision superseded must not be reported to the owner
as applied.

The public label of the outcome is **not** the identity of the model that
plays the seat. The service publishes a resolved label, and two private
selections may share one published label, the neutral label of an
unregistered route included. The caller that has to know which model plays
the seat compares the private selection it bound, never the published label.

The caller publishes the binding of a seat by its private identity. Two
private models of one connection carry the same public label, so a label can
never name the model that plays the seat: `agentBindingFor` answers with the
private identity of the binding and `agentBindingLabelFor` answers with its
public label, which is what the interface shows. The identity is the identity
of the catalog entry of the selection, so the interface resolves the seat to
exactly one model, and it stays in the browser: it never leaves the device and
never reaches the shared data of a match.

A public label is a chosen name. `isPublicModelLabel` refuses a label that
could name a route, and `assertSharedActionSafe` refuses a shared action with
an unknown field.

## The turn of the runner

1. The runner takes the lease of the turn. A lease that carries a pending
   request, or a browser-local pending record, stops the runner: the previous
   runner may have started billable work.
2. The runner renews the lease, records the request with `begin` and asks the
   provider. A request that the service could not record is never sent, because
   a billable request without a record hides the uncertainty of a lost runner.
3. The answer is read with the shared classified decoder. A move, an explicit
   resignation, a formatting failure or an illegal move.
4. The runner renews the lease again, because a lease that expired during a
   long turn may not submit an answer.
5. A move is submitted as `submit_move`. An illegal move is reported as
   `record_recovery_attempt` with `illegal_move` and the turn continues with a
   correction. A formatting failure is reported as `record_recovery_attempt`
   with `formatting_correction`. A resignation is submitted as `resign`.
6. The lease is released when the turn ends, and the accepted move resets the
   recovery budget of the seat, exactly like the service does.

The expected version of every command is the version the lease is bound to.
The service checks that the lease of an agent seat is live and bound to the
turn of the command, so a reply of a superseded runner can never become an
accepted move.

## The renewal of the lease

The lease of the service lives for thirty seconds and the runner renews it
every five seconds. A renewal that fails is armed again with a bounded
backoff, so a single transient failure never ends the heartbeat of the seat.

The backoff never grows past the life of the lease. The next renewal happens
before the lease expires and it keeps a safety margin of one interval, so the
runner knows that it lost the seat before the seat belongs to another runner.
The runner fails closed when the lease is about to expire, when the credential
was refused, and when the backoff would reach past the expiry. The fail close
happens on the timer alone: it never waits for another provider answer or for
another snapshot.

A lease that was revoked or that expired is given up and taken again, at most
a few times per turn.

The answers of the lease requests are fenced by the generation of the lease.
The generation moves on every path that gives the lease back, also when no
lease is held and when the lease is lost, and the identifier of the lease
names the answer. An answer of a request that is still in flight therefore
never resurrects a lease the runner does not hold, never overwrites the lease
it holds now and never arms a heartbeat for it. A lease answer never installs
a lease of a match that is already over, so a finished match keeps no lease
and no heartbeat. A stopped or a disposed runner holds no lease at all, so
every answer that arrives after it changes nothing. The durable pending record
of an uncertain request is never dropped by this fence: the uncertainty of a
lost runner stays recoverable.

## The uncertainty of a lost runner

When the runner loses its lease while a provider request may still be running,
it stops with the phase `uncertain`. It keeps the request identifier in the
service lease and in the browser-local pending record, so the next runner of
the seat sees that billable work may be pending. The next runner never issues
a provider request by itself. It offers Retry, switch or takeover, and the
owner decides whether the work is paid twice.

## What the UI has to change

1. **The lease client.** The wire of `src/online/runner-lease.ts` is the wire
   of the service now. It has to use the shared builders and the shared parser
   of the module, it has to answer the whole lease record, and its
   `turnVersion` has to accept `null`, because a runner that has not seen a
   snapshot yet does not know the turn.
2. **The snapshot mapping.** The workspace delivers an `OnlineMatchView`. The
   UI converts it with `providerRunnerSnapshotFromView` and hands the result to
   the runner, and it drops its own duplicate mapper of the agent seat. The
   conversion reads the seat view of the same view, so the control epoch of
   the seat, the published label of the agent and the canonical counters of
   the turn always belong together, and it reads the side to move with the
   shared rule of `src/online/turn.ts`, so a fresh match and a custom
   position that starts with Black both start with the right seat.
3. **The provider client.** The UI resolves the connection profile and the
   credential of the agent, and it builds a `ProviderRunnerProviderPort`. The
   credential never leaves the browser. After a model switch the UI resolves
   the provider target of the new agent again, because the runner keeps the
   published label and the provider client owns the route.
4. **The owner decisions.** The interface shows the decisions of the runner
   state and calls `retry`, `switchModel` or `takeover`, and it starts a
   stopped runner again with `start()` or `resume()`. It reads the outcome of
   the decision: it binds the new agent to the seat and drops the old runner
   only when the outcome is `accepted`, and it keeps the binding and the
   runner when the outcome is `refused` or `unknown`. It must not report a
   success it cannot prove, and it must not decide the identity of the model
   that plays the seat by comparing published labels.
5. **A superseded controller.** When the state of the runner reports
   `superseded`, the seat belongs to another controller. The UI binds the agent
   it wants to the seat or it leaves the seat to its owner.

## The evidence

`tests/online/provider-runner.test.ts` drives the runner through its public
API with a deterministic provider, a deterministic lease client and a
deterministic command client. The lease client speaks the exact wire of the
service and applies the documented rules of the service, so the runner is
exercised against the contract and not against a private shortcut. The fixture
resolves a declared label to a published one and it resets the counters of the
seat with an accepted move, exactly like the service does.

| Case | Fixture |
| --- | --- |
| ARC-08 | The lease of the turn, one accepted move, the release of the lease |
| ARC-08 | A duplicate tab is refused and never asks the provider |
| ARC-08 | Three separately requested games run at the same time |
| ARC-09 | A lease that is lost during a request asks the owner and issues no second request |
| ARC-09 | A pending request of a previous runner asks the owner |
| ARC-09 | A pending request of the browser survives a reload |
| ARC-09 | A lost acknowledgement recovers the original receipt and accepts one move |
| MAT-08 | The spent budgets survive a control change of the same turn |
| MAT-09 | The answer of a superseded turn is dropped |
| MAT-09 | The late reply of a superseded controller is fenced |
| MAT-09 | A takeover hands the seat to the owner, a switch names a new public label |
| MAT-10 | Four illegal attempts lose, the formatting budget stays independent |
| MAT-10 | Three formatting corrections pause the turn and wait for the owner |
| MAT-10 | A provider failure never resigns and never repeats the request |
| — | The shared commands carry no credential, no route and no conversation |
| — | The published label of the seat is the identity of the agent |
| — | The first move of a fresh match and of a custom position that starts with Black |
| — | The provider reads the moves of the match in the notation of the game record |
| — | The corrections of an earlier turn are not sent again, the corrections of the same turn are |
| — | A lease answer that arrives after a release, after the end of the match or after a new lease changes nothing |
| — | A stop inside the acquisition, the record of the request, the settlement or the renewal before the submit keeps the phase of the runner |
| — | A finished match keeps no lease and no heartbeat when the acquisition answers late |
| — | The provider is not asked again while the uncertainty of a stopped request is open |
| — | The explicit retry of the owner asks the provider again and is not swallowed by the late answer of the aborted request |
| — | A stop or a dispose while the pending record is settled keeps the phase of the owner and the honest record |
| — | Two competing owner actions: the newest decision wins and the older one sends nothing |
| — | The acquisition of a lease does not clear a newer pending record |
| — | A superseded decision does not send its command again after a lost acknowledgement |
| — | A decision that waits while the match ends reports an unknown outcome |
| — | A superseded settlement settles no newer record and leaves no authorization behind |
| — | The command of a superseded decision is not sent again when the owner retries a lost command |
| — | The move of a stopped runner is not sent again after a lost acknowledgement |
| — | The command of a newer unknown decision stays retriable when an older command answers late |
| — | The takeover that waits while the match ends reports an unknown outcome |
| — | The acquisition of a lease settles no record the owner never decided about |
| — | The command of a newer unknown decision is replayed with its operation identifier |
| — | The fixture fences a lease of an older control epoch, of an older service epoch or an expired lease |
| — | A receipt that arrives after the end of the match changes no lease |
| — | The service fences a command that presents a lease and accepts the command of the owner |
| — | The decision of the owner authorises one request, so a dropped turn is not billed twice |
| — | The late rejection of an aborted request does not swallow the decision of the owner |
| — | A replaced credential stops the runner instead of asking for the lease on every snapshot |
| — | A provider that answers with an error waits for the owner instead of being retried by the next snapshot |
| — | The Go answer of the service is read by the parser of the runner and by the shared parser |
| — | The budget of the browser follows the canonical counts of the turn |
| — | The heartbeat of the lease survives a transient failure and fails closed near the lease expiry |
| — | No renewal is ever armed behind the life of the lease |
| — | A stopped runner plays again and keeps an open uncertainty |
| — | A refused credential stops the runner instead of retrying |
| — | A finished match keeps no lease |
| — | A fenced command is reported as a fence and spends no attempt |
| — | A switch settles the request of the old epoch with a lease of the new epoch |
| — | The record of a newer request of another runner survives the settlement of a switch |
| — | A newer decision of the owner ends the settlement and settles nothing |
| — | A stop or a dispose while the lease of the new epoch is acquired settles nothing |
| — | The retry of a switch whose command never reached the service proves the switch and settles the record |

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
- The service revokes the lease of the seat with a control change, so the
  request of the old epoch cannot be closed under the lease it was recorded
  on. The runner settles it with a lease of the new epoch: the lease is taken
  for the settlement alone, it is never installed, and it is given back right
  after the settlement. The request that closes a record carries the control
  epoch and the turn of the lease it is closed under, so a settlement of the
  old epoch is never smuggled under the facts of a newer one.
- The service fences every command that presents a lease: the lease must be
  live, of the match and the seat of the command, of the current control
  epoch, of the current service epoch and bound to the turn the command acts
  for. A command that presents no lease is the decision of the owner and
  stays allowed, except the move of an agent seat and the spent recovery
  attempt of an agent seat: both are the work of the browser runner and they
  need the lease of the seat. The service closes an expired lease and never
  revives it, and it revokes the lease of a seat when the match ends. The
  fixtures apply that fence by default, so a tracked case never claims a
  fence the service does not apply.
- The service resolves a declared label to a publishable one before it accepts
  it, and an unknown label resolves to a neutral label. The runner therefore
  never compares a declared label with a published one, and the control epoch
  of the seat is the canonical answer to the question which controller plays
  the seat.

## Open items of the peers

These items are outside the module. They are recorded here because the runner
depends on them.

- **The foundation fences the agent mutations.** The service checks the runner
  lease when it accepts a move, and it fences every command that presents a
  lease. The runner presents the lease with the commands of its own work and
  presents no lease with the handoff of the seat, which is the authority of
  the owner.
- **The lease client answers the whole lease record.** The runner reads
  `pendingRequestId` to know that a previous runner may have started billable
  work, and it reads `runnerEpoch`, `revokedReason` and `lastRenewedAt` to
  explain the state of the lease. A client that drops those fields cannot be
  wired to the runner, and a runner without the pending request identifier
  would silently issue a second paid request after a runner loss.
- **The engine seat releases its lease.** A disposed engine seat that keeps its
  lease blocks the seat for the whole life of the lease. The release has to
  happen before the requester is disposed.
