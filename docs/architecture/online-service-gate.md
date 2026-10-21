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

## The rules health probe and the dependency taxonomy

The probe evaluates the **primary** rules process, so its answer is evidence
about the process that serves the traffic. A probe that answers can recover an
interruption of that process, and a probe that fails never does. There is no
second rules process: one client, one process, one liveness signal.

The probe has **no budget of its own**. It uses the internal bound of the
rules client, so a hung process ends in the client's own timeout and stays an
outage. A shorter caller budget would cancel a healthy exchange and could
never tell a busy process from a hung one.

The client answers in three classes, and the service reads them apart:

| Class | Signal | Meaning | Effect |
| --- | --- | --- | --- |
| The caller left | the context error (`context.Canceled`, `context.DeadlineExceeded`) | the caller went away | the dependency is untouched |
| The slot was occupied | `online.ErrRulesBusy` | the process is healthy and busy | the dependency is untouched, no interruption |
| The internal bound elapsed | the worker's own timeout error | the process is hung | the dependency is degraded and an interruption is planned |

The rules client owns the first and the third class; it maps the second one
to `online.ErrRulesBusy`. The parent must keep those three apart, because a
caller deadline that inherits the internal deadline cannot tell them apart.

The recovery never reports the health of the dependency. The dependency is
healthy when the rules process answered, and the answer is the evidence of the
probe or of a real evaluation, never of the recovery itself.

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

A check never starts a worker, so a worker that is gone answers the busy
class. The recovery of a closed gate is therefore a **repair**: the
replacement of the same client is started and proven. The monitor owns the
decision — a pending durable suspension means the gate is closed, so the
dependency is repaired and the interruption is recovered after the
replacement answered; an open gate is only checked, so the cold start of the
worker stays with the traffic. A failed repair is a failure of the check: the
gate stays closed, the failure is reported, and the next tick repairs again.
The interruption is never recovered on a failed repair, because the recovery
would publish a dependency that was never proven.

The refused traffic does not use the worker. The authoritative gate check
stays inside the acceptance transaction of a mutation, so a command that
raced a suspension is still refused there. The check before the evaluation
keeps the refused traffic away from the worker: a closed gate must not start
a cold worker, and it must not hold the slot that the repair of the closed
gate needs. It covers the move and the creation, so no refused command asks
the rules process.

The health boundary fails closed. A shared health state that cannot be read
is an unavailable service, never a healthy one, so a service that cannot
confirm its own health never hands out a win.

A healthy service refreshes its durable liveness on every check of the
monitor. The liveness record is the evidence that the service was alive, so a
restart of a healthy instance is not read as an interruption: the recovery
would otherwise derive an unexpected interruption out of a service that never
stopped, open a new epoch, refund the clock of every unfinished match and
fence the runner leases of the peers. The refresh happens only while every
dependency is healthy, so a service that cannot serve keeps the stale
liveness — that record is how the recovery locates the interruption. The
liveness carries the clock of the database and never moves backwards, because
the record is shared by every instance of the service and the clock of one
host may neither future-date it nor regress it.

One outage is one interruption. The interruption of an outage is identified by
the **failure episode** of the instance that saw it: the epoch of its
earliest observation. The identity of the episode does not change while the
episode is open, so every failure of the same episode plans the same
boundary, and the plan of a boundary that exists changes nothing. The episode
ends when the dependency of that instance answers again, so a failure after an
answer is a new outage with a new interruption. The identity is not the epoch
alone: every applied interruption opens a new epoch, so the epoch moves with
the recovery of the outage and cannot identify the outage that is still open.

The observations are numbered, and two watermarks order them: the newest
failure and the newest success. A success that is not newer than the newest
failure answered before that failure, so it neither closes the episode nor
reports the dependency as healthy — a healthy report would hide the
dependency that is still broken. A failure that is older than the newest
success is stale, so it neither opens an episode nor degrades the dependency.
The transitions are serialized, and the ordered decision, the update of the
episode and the report of the dependency happen in **one** critical section,
so a success that completes in between can neither hide the failure nor be
hidden by it.

The identity of the episode is fixed by the first plan of the outage. The
identity of a planned interruption is its **boundary**, so the next plan of the
same outage finds it and changes nothing. Every observation of the outage
identifies the episode with the epoch of that observation, so a plan that
arrives after the recovery of a peer finds the boundary of the outage and
plans nothing. When the epoch of an observation could not be read, the plan
falls back to the epoch of the plan itself and binds the boundary it wrote.

An interruption of a dependency is planned only for an open episode of the
instance that observed it. A stale failure whose episode was closed already
may not plan a new interruption: the plan of the current epoch would be an
outage that never happened. The explicit planning of an administrator is not
identified by an episode, so it always plans the interruption of the current
epoch.

The episode guard is held across the whole decision of a plan: the open
check, the plan of the interruption and the binding of its identity. A
success that completes in between may not leave a plan of a closed episode
behind, and a plan that belongs to a closed episode may not write a boundary
of an outage that never happened. The lock order is the episode guard and
then the gate lock of the plan. The evaluation path takes the episode guard
before it opens its transaction, so no flow takes the two the other way
round.

A busy process and a departing caller are not broken dependencies, so they
open no episode and they leave the durable health alone.

The pending interruption is read inside the same transaction, under the gate
lock, so the plan never needs a second connection of the pool while it holds
the lock.

An observation of a failure that arrives after the recovery of a peer plans
nothing: the boundary of the outage exists, and the plan finds it. The
identity does **not** declare the dependency healthy. The worker of that
instance may really be broken: the next check of the monitor proves the
current state, and the instance refuses its own mutations while its worker
cannot answer. The explicit planning of an administrator is not identified by
an episode, so it always plans the interruption of the current epoch.

Every instance keeps its own health reporter, but the durable checkpoints are
written for the dependency, not for the instance, and the shared state reads
the newest checkpoint of every dependency. A healthy instance therefore
overwrites the degraded checkpoint of a broken one, so the shared state is not
the evidence that every instance is healthy, and the recovery of a planned
boundary is not gated on it. The evidence that a dependency is broken is the
local health of the instance that saw it, and that instance keeps it until its
own worker answers again.

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
