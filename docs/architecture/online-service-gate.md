# The online service gate, the recovery and the shared transaction protocol

This note records the interface decisions of the foundation slice (KHA-70,
KHA-71, KHA-73) that the other workers integrate against. The approved
specification and the acceptance matrix remain canonical.

## The shared transaction gate

Every mutation of the online service passes one gate inside the transaction
that writes it. The gate is durable, so a second instance, a restored
database and a service that is recovering all refuse the same mutations, and
it is ordered, so a suspension that is opened while a command runs is
committed after that command and never before it.

The gate reads three durable sources:

| Source | Closed while |
| --- | --- |
| `online_restore_gates` | a restored database did not replay the removal ledger yet |
| `online_suspension_boundaries` | a planned suspension or an interruption was not applied yet |
| `online_service_epochs` | the latest epoch did not finish its recovery |

Only the **latest** epoch counts. An epoch an earlier instance opened and
never completed is history, not a pending recovery, so a stale row never
closes the gate of a healthy service.

The gate covers every mutation:

- the acceptance of a move (checked after the rules process answered, so a
  command that started before a suspension cannot commit after it),
- the offer, the control change, the resignation, the cancellation and the
  spent recovery attempt,
- the creation of a match and the trusted allocation of a match,
- the presence heartbeat, the keep waiting choice, the abandonment claim,
- the runner lease, its renewal, its release and the record of a provider
  request.

The reads never change. The live clocks, the live views, the update stream
and the public replay keep working while the gate is closed, and the
presence view reports the recovering state.

## The lock order

The shared seams take their locks in one fixed order:

```
invitation or rematch row (caller) -> account scope locks (ascending) -> gate lock -> match scope lock -> match row locks
```

- The account scope lock is the shared `locks.AccountScope` /
  `locks.LockAccountScopes` helper. Its key is derived in the database, so
  the online writer, the authorization service, the privacy service, the
  profile service and the private store take exactly the same lock. The
  exported API of the `locks` package is unchanged.
- The gate lock is a PostgreSQL advisory lock. A mutation takes the shared
  lock and a suspension takes the exclusive one. The gate is taken **before**
  the match row lock, so a suspension is committed after the mutations that
  are already running and the gate state stays stable for the whole
  transaction.
- The match scope lock orders two allocations of the same match. A match that
  does not exist yet has no row to lock, so the scope lock is what makes two
  allocations of one match wait for each other instead of racing for the
  insert.
- The trusted deadline sweep takes the gate before the match row as well, so
  a match whose clock is about to be refunded is never settled by the sweep.
- A flow that never holds a seat lock must not take one while it holds an
  account scope lock. The privacy flow sanitizes invitations and rematches
  while it holds the account scope, so it must not take an invitation lock
  after it. The friend flow moved its account scopes before its invitation
  and rematch row locks for the same reason.

The gate and the removal fence live **inside** `CreateMatchInTx`, so the
friend acceptance, the rematch acceptance and the queue allocation are all
fenced by the same checks, and a refused allocation consumes nothing.

## The removal fence of a trusted allocation

A trusted allocation presents no credential, so the writer checks the removal
state of both participants itself:

- the account scope locks of the participants are taken first, in ascending
  order, so the allocation is ordered against the removal of the same
  participant,
- the removal ledger and the account deletions are read by the one-way
  reference of the subject, so the removal tables never receive the
  identifier of a participant,
- a participant that was removed is refused with `ErrNotAuthorized`.

A replay removal is not an identity removal. The removal of a public replay
is a match scoped marker, and it never appears in the removal requests or in
the account deletions, so a participant whose replay was removed may still
play.

## The recovery

- A planned suspension is persisted before the service stops, so its interval
  is known exactly. The plan takes the exclusive gate lock, so the
  suspension is committed after the mutations that were already running.
- An unexpected suspension is derived from the durable liveness record and
  the accepted match activity. The liveness record is refreshed only while
  the service is healthy, so a dependency that stays down is located instead
  of being hidden.
- The refund of an interruption is the whole interruption when the clock was
  running when the service went down, even when the deadline passed while
  the service was down. The player keeps the time they had left when the
  service went down. A deadline that expired before the interruption is
  preserved, and a clock that started inside the interruption is refunded
  only for the part of its charge that fell inside it.
- The liveness lease of a connected seat is refunded by the same
  interruption, so a service that was down never manufactures an absent
  opponent.
- The adjustment is exactly once per interruption boundary. A repeated
  recovery of the same boundary changes nothing, and two distinct
  interruptions are two distinct boundaries.
- The recovery locks the match row like the writer does, so an accepted move
  and the adjustment are ordered instead of racing.
- The epoch of a recovery is completed when the canonical state was
  published, so the durable gate opens again for every instance.

## The dependency interruption without a restart

The rules dependency is probed by the service itself. A failed probe records
a planned boundary, so the gate closes and the clock of the unfinished
matches is refunded when the dependency answers again. The recovery runs
before the service reports itself healthy, so the canonical state is
published before resumed actions are accepted.

The health boundary fails closed. A shared health state that cannot be read
is an unavailable service, never a healthy one, so a service that cannot
confirm its own health never hands out a win.

## The runner fence

- A command that presents a runner lease may only act while the lease is
  live. The fence covers every action, not only the move: a stale runner may
  not resign, spend a recovery attempt or change the control of its seat.
- An agent seat spends its recovery budget only through its runner lease.
  The owner may always resign or cancel, because that is the owner's own
  decision.
- A lease of a finished match is not renewed. It is revoked with the reason
  `match_ended`.
- A lease is only readable by the participant that owns the seat.
