# Online presence, recovery and the browser agent runner

This note records the interface decisions of
[KHA-70](https://linear.app/kamkm/issue/KHA-70),
[KHA-71](https://linear.app/kamkm/issue/KHA-71) and
[KHA-73](https://linear.app/kamkm/issue/KHA-73). It is the contract the peer
UI and backend work align on. The approved specification and the acceptance
matrix remain canonical; the snapshots under `docs/spec/online-play-*` are the
read-only source this work was implemented against.

Nothing here changes the shared match command contract except one additive
optional envelope field, described in [Command envelope](#command-envelope).

## Fixed numbers

| Constant | Value | Meaning |
| --- | --- | --- |
| Application heartbeat | 5 s | How often a connected browser reports in |
| Liveness lease | 15 s | How long one heartbeat keeps a participant connected |
| Continuous offline minute | 60 s | Offline time that enables the optional claim |
| Claim grace start | lease expiry | The offline minute starts when the lease expires, not when the last heartbeat was sent |

A responsive background tab keeps heartbeating and stays connected. A
suspended client stops heartbeating, its lease expires, and the participant
counts as offline from that moment. A fresh heartbeat starts a fresh offline
minute, so a reconnect always clears the claim eligibility.

## HTTP routes

All routes live under the existing participant API prefix `/v1/online` and
use the existing participant credential. A mutation requires an `Origin`
header, exactly like the match command route.

Every route is a `POST` or a `GET`. The online CORS method set stays
`GET, POST, OPTIONS`, so no preflight change is needed anywhere.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| `GET` | `/v1/online/matches/{matchID}/presence` | – | `PresenceView` |
| `POST` | `/v1/online/matches/{matchID}/presence` | `SeatRequest` | `SeatPresence` |
| `POST` | `/v1/online/matches/{matchID}/presence/keep-waiting` | `SeatRequest` | `SeatPresence` |
| `POST` | `/v1/online/matches/{matchID}/claim` | `ClaimCommand` | `Receipt` |
| `GET` | `/v1/online/matches/{matchID}/runner/lease?seat=white` | – | `RunnerLease` |
| `POST` | `/v1/online/matches/{matchID}/runner/lease` | `RunnerLeaseRequest` | `RunnerLease` |
| `POST` | `/v1/online/matches/{matchID}/runner/request` | `RunnerRequestRequest` | `RunnerLease` |

### The exact request bodies

```jsonc
// POST /v1/online/matches/{matchID}/presence
{ "seat": "white" }

// POST /v1/online/matches/{matchID}/presence/keep-waiting
{ "seat": "white" }

// POST /v1/online/matches/{matchID}/claim
{
  "schemaVersion": 2,
  "matchId": "match-0001",
  "operationId": "operation-0001",
  "expectedVersion": 7,
  "seat": "white",
  "controlEpoch": 3
}

// POST /v1/online/matches/{matchID}/runner/lease
{
  "schemaVersion": 2,
  "action": "acquire",          // acquire | renew | release
  "seat": "black",
  "runnerId": "opaque-runner-identifier",
  "leaseId": "lease-0001",      // required for renew and release
  "turnVersion": 7,             // the turn the runner acts for
  "controlEpoch": 3             // the control epoch the runner believes
}

// POST /v1/online/matches/{matchID}/runner/request
{
  "schemaVersion": 2,
  "action": "begin",            // begin | clear
  "seat": "black",
  "runnerId": "opaque-runner-identifier",
  "leaseId": "lease-0001",
  "requestId": "request-0001",  // the opaque provider request identity
  "turnVersion": 7,
  "controlEpoch": 3
}
```

A body with an unknown field, a trailing value, or a wrong
`schemaVersion` is refused with `400`.

The lease rules are enforced by the server, not by the client:

- `acquire` takes the lease of the seat for the current turn. The runner that
  already holds it gets the same lease back, so a retry after a lost
  acknowledgement never creates a second lease. Another runner is refused
  with `409` while the lease is live.
- `renew` extends a live lease. An expired lease is never revived: the
  renewal is refused with `409` and the runner has to acquire a new one.
- `release` gives the lease back. It is the explicit takeover path.
- `turnVersion` must be the current match version, and `controlEpoch` must be
  the current control epoch. A runner that did not see the latest control
  change is refused with `409`.
- A move submitted with a lease is fenced in the acceptance transaction: an
  expired lease, a revoked lease, a lease of an older control epoch, a lease
  of an older service epoch, and a lease of another turn are all refused.
- The uncertain provider request survives a lease change. A new lease of the
  seat carries the pending request of the previous lease, so the new runner
  knows that the previous runner may have started billable work.
- The lease of a seat is only readable by the participant that owns the seat.
  A lease names the runner of a seat, so it is not a shared view.

Errors reuse the existing mapping: a membership failure and a missing match
are both `404`, a stale version, seat, epoch or lease is `409`, and a service
that cannot serve is `503`.

## Command envelope

The shared match command gains one optional field:

```jsonc
{
  "schemaVersion": 2,
  "matchId": "match-0001",
  "operationId": "operation-0001",
  "expectedVersion": 7,
  "seat": "black",
  "controlEpoch": 3,
  "leaseId": "lease-0001",   // optional
  "action": { "kind": "submit_move", "move": "e2e4" }
}
```

`leaseId` is required by the server when the seat is controlled by an agent
or an engine, and it is ignored by a human seat. A lease that was revoked, a
lease of an older control epoch, and a lease of an older turn are all fenced
in the acceptance transaction, so a reply from a superseded runner can never
become an accepted move. The field is optional, so an existing command
without it keeps its exact fingerprint and its stored receipt.

## TypeScript contracts

`src/online/contracts.ts` gains the presence and lease DTOs and their
parsers. `src/online/presence.ts` and `src/online/runner.ts` hold the client
interfaces.

```ts
export type PresenceState = 'connected' | 'offline' | 'unknown';

export type ClaimReason =
  | 'eligible'
  | 'opponent-connected'
  | 'opponent-unknown'
  | 'awaiting-first-moves'
  | 'opening-reply-outstanding'
  | 'service-unavailable'
  | 'match-ended'
  | 'offline-grace-period';

export interface SeatPresence {
  readonly seat: Seat;
  readonly state: PresenceState;
  readonly lastHeartbeatAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly offlineSince: string | null;
  /**
   * When the other participant chose to keep waiting for this seat.
   * It belongs to the offline interval of this seat, so the heartbeat of
   * the waiting participant never clears it and the reconnect of this seat
   * does.
   */
  readonly keepWaitingAt: string | null;
}

export interface ClaimAvailability {
  readonly eligible: boolean;
  readonly reason: ClaimReason;
  readonly opponentSeat: Seat | null;
  readonly offlineSince: string | null;
  readonly graceSecondsLeft: number;
  /** When the participant chose to keep waiting for the opponent. */
  readonly waitingSince: string | null;
}

export interface PresenceView {
  readonly schemaVersion: number;
  readonly matchId: string;
  readonly version: number;
  readonly controlEpoch: number;
  readonly status: MatchStatus;
  readonly seats: readonly SeatPresence[];
  readonly serviceState: 'healthy' | 'degraded' | 'unavailable';
  /** False while the canonical recovery of an interrupted service runs. */
  readonly recovered: boolean;
  readonly claim: ClaimAvailability;
  readonly yourSeat: Seat | null;
}
```

The parsers are `parsePresenceView`, `parseSeatPresence`,
`parseClaimAvailability`, `parseClaimCommand` and `parseRunnerLease`. The
match command parser accepts the optional `leaseId`.

The lease DTO extends the existing `RunnerLease` shape:

```ts
export interface RunnerLease {
  readonly schemaVersion: number;
  readonly leaseId: string;
  readonly matchId: string;
  readonly seat: Seat;
  readonly controlEpoch: number;
  readonly generation: number;
  readonly runnerId: string;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  // added by KHA-73
  readonly turnVersion: number | null;
  readonly runnerEpoch: number;
  readonly pendingRequestId: string | null;
  readonly pendingRequestStartedAt: string | null;
  readonly revokedReason: string | null;
  readonly lastRenewedAt: string | null;
}
```

## Client interfaces

```ts
export interface PresenceClient {
  /** Reports in and extends the liveness lease. */
  heartbeat(seat: Seat): Promise<SeatPresence>;
  /** Reads the presence of both seats and the claim option of this client. */
  view(): Promise<PresenceView>;
  /** Chooses to keep waiting. The claim option and the clock are preserved. */
  keepWaiting(seat: Seat): Promise<SeatPresence>;
  /** Claims the win because the opponent is offline. */
  claimAbandonment(input: ClaimInput): Promise<Receipt>;
}

export interface RunnerLeaseClient {
  acquire(input: AcquireLeaseInput): Promise<RunnerLease>;
  renew(input: RenewLeaseInput): Promise<RunnerLease>;
  release(input: ReleaseLeaseInput): Promise<RunnerLease>;
  read(): Promise<RunnerLease | null>;
  beginRequest(input: RunnerRequestInput): Promise<RunnerLease>;
  clearRequest(input: RunnerRequestInput): Promise<RunnerLease>;
}
```

The claim is never shown while `serviceState` is not `healthy`, and never
while `claim.eligible` is false. The `Claim win` and `Keep waiting` actions
are the only two states the offline minute produces, and `Keep waiting` never
concedes a result.

## Runner rules

- One lease per seat. The lease binds a runner to a seat and to the turn it
  was taken for. A second tab of the same owner shares the same game and
  cannot take the lease while the first tab holds it.
- Separate explicit games run concurrently. There is no owner-wide cap.
- A control change (human takeover, agent handoff, model or connection
  switch) advances the control epoch, revokes the seat lease, and fences the
  old runner. Clocks and spent recovery budgets are preserved.
- A lease that is lost while a provider request may still be running reports
  the pending request. The new runner offers an explicit Retry, switch, or
  takeover. It never issues another provider request by itself, because
  exactly-once external billing is not guaranteed.
- The accepted move itself is exactly-once: the operation receipt returns the
  original result for an identical retry.

## Recovery rules

- A planned suspension is persisted before the service stops, so its interval
  is exact.
- An unexpected suspension derives a conservative interval from the durable
  health checkpoints and the accepted match activity.
- The canonical adjustment shifts the armed deadline of an unfinished match
  once per interruption boundary, and it is published as a versioned event
  before resumed actions are accepted.
- Already final results stay final. A service outage never awards a
  peer-abandonment win.
- The service epoch advances once per detected interruption, under a shared
  leadership lock, so an instance that merely joins never invalidates the
  leases of its peers.
