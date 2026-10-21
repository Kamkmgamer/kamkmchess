# The rules worker start budget

Owner: the matching worker, for the rules worker client (`backend/rulesworker`).

This note records a real robustness defect of the private rules worker client,
the fix, and the contract change that the fix makes. It applies to every
caller of `rulesworker.Client`: the online writer, the deadline reconciler and
the integration fixtures.

## The defect

`Client.Evaluate` used one deadline for the whole request: the queue wait
behind another request, the start of the worker process, the retries and the
exchange. `Config.RequestTimeout` documented that contract explicitly.

The consequence was that the host's process start latency was charged to the
request that needed the worker. The Node worker boots a fresh V8 runtime and
loads its bundle before it answers the first line, and that latency grows with
the load of the host. On a loaded host the boot alone could consume the whole
request budget, and the failure was self-perpetuating:

1. the request timed out while the worker was still booting,
2. a timeout stops the worker, so the next request paid the boot again,
3. the rules service stayed unavailable while the host stayed loaded.

Two fixtures reported the defect under full-suite load while they passed in
isolation:

- `TestEvaluateReturnsValidatedMoveCandidate` (a one second request budget)
  failed with `rules worker timed out` after 1.11 s: the cold start ate the
  budget of the first request.
- `TestTimeoutKillsTheWorkerAndTheNextRequestRestartsIt` (a 500 ms request
  budget) failed on the restart: the timeout stopped the worker as designed,
  and the cold start of the replacement worker had to fit into the next
  request's 500 ms.

Nothing leaked: the process is killed and reaped in `stop`, the slot is
released in every path, and the worker environment stays narrow. The defect
was the budget, not a leaked process.

## The fix

The cold start is a one-time cost of a shared resource, so it no longer
belongs to the request budget.

- `Config.StartTimeout` (default 10 s) bounds the cold start of the worker
  process **and** its readiness probe.
- The readiness probe is a facts-only request for the standard position
  (`ReadinessRequestID`). Its reply proves that the worker booted and speaks
  the protocol, and the reply is discarded. The probe costs one cheap
  evaluation and it never carries a move intent.
- The time the start spends is **added back** to the exchange deadline, so
  the request budget still covers the queue wait and the exchange. A request
  that waited behind another request therefore still cannot consume a fresh
  budget once it is admitted.
- The caller's own context still bounds the whole call, start included.
- The probe is not retried in a loop. A failed probe stops the worker, and
  the next request starts a fresh one.

`Client.Warm(ctx)` starts the worker and waits for the readiness probe. A
caller that wants the cold start paid before the first request needs the
worker can call it at boot. The server composition is not part of this
change.

## The contract change

| Concern | Before | Now |
| --- | --- | --- |
| `RequestTimeout` | the queue wait, the process start, the retries and the exchange | the queue wait, the exchange and the retries |
| the process start | charged to `RequestTimeout` | `StartTimeout`, and its duration is added back to the exchange deadline |
| readiness | the first exchange proved it | an explicit facts-only probe, and the exchange runs against a warm worker |
| the caller's context | bounded the whole call | still bounds the whole call, start included |
| the failure class | depended on which case the select picked | a specific failure always wins over a generic timeout |
| a worker that answered late | killed with the exchange | stays alive, so the next request does not pay a cold start |

## The end-to-end bound of one call

The call is bounded by three things, and the caller must know all of them:

- the **caller's context** bounds the whole call, start included. The online
  path passes the request context of the command, so a caller that has a
  deadline keeps it.
- the **exchange budget** (`RequestTimeout`) covers the queue wait and the
  exchange. A request that waits behind another request spends that budget
  while it waits.
- the **start budget** (`StartTimeout`) covers each cold start, and a call
  starts the worker at most twice: once for the request and once for the
  retry after a crash.

The wall-clock bound of one call is therefore `RequestTimeout + n *
StartTimeout + cleanup` for a call with `n` starts, where `n` is at most two.
The start durations are added back to the exchange deadline, so the exchange
always keeps its own budget. The cleanup is the kill and the reap of the
worker process; it is not part of any budget and it measured 7 to 19 ms on the
host of the review. The client does not wait past the deadline of its caller
to classify a failure; only that cleanup can outlive the deadline.

**The cold start is charged to the requests that are queued behind it.** The
worker has one slot, and the request that triggers a cold start holds that
slot while the worker boots. The queued requests spend their own queue budget
while they wait, so a slow start on a loaded host can make a *different*
request run out of time. The queue wait is not reset and a queued request
does not get a fresh budget; the remedy is to keep the worker warm, not to
relax the budget.

The client of the composition is not warmed at boot. The composition
creates one rules worker client, closes it with the server, and does not call
`Warm`, so the first request after a server start or after a crash of the
worker still meets a cold worker. A `client.Warm(ctx)` call next to the
creation of the client in the composition closes that window. The composition
is not part of this change.

## The failure of a call

The call reports the failure that happened, and it never reports a contract
outcome for a request that ran out of time.

- The exchange ends with the deadline of the caller. A late answer is never
  read, so it can never be mistaken for the answer of a newer request, and a
  late **rejection** can never reach the participant as "illegal move". A
  request that ran out of its deadline is a timeout.
- The caller's own **cancellation** keeps its class: a caller that went away
  is told that it was canceled, not that the worker was slow. The
  cancellation wins over a specific failure of an earlier attempt, because
  the caller knows that it left.
- The class of a **timeout** follows the deadlines, not the moment of the
  check. The cleanup of the worker process can outlive the deadline of the
  caller, and the cause of the caller must never be invented from that.
  - The internal deadline of the client is kept **explicitly**. A derived
    context clamps its own deadline to the earlier of the requested deadline
    and the deadline of its parent, so the class must not be read from the
    clamped value: when the deadline of the caller ends first, the clamped
    deadline equals the deadline of the caller and the internal budget would
    look like the one that ended the exchange.
  - The deadline of the caller, when it is strictly earlier than the internal
    deadline, is carried as the cause.
  - An internal timeout of the request or of the start carries **no** cause,
    so a genuine outage of the worker is never recorded as the deadline of a
    caller.
  - At the boundary the two deadlines are equal and the internal budget
    wins: the worker had its whole budget, and the caller had no more than
    that.
- The cancellation carries the **cause** of the context, so that every caller
  of the client can tell a cancellation from a failure of the worker. An
  internal timeout carries none.
- A canceled call **reaps the worker**. The exchange kills the worker when
  the deadline passes, and a killed worker must be reaped and must never stay
  the ready worker of the client: the next request has to start a fresh one.
  A write that fails while the caller goes away keeps the class of the
  cancellation as well.
- A **specific** failure survives the retry and the restart. A worker that
  died on the first exchange and hung on the second is reported as the crash,
  and a replacement worker that never becomes ready does not replace it
  either, because the caller must be able to tell "the worker died" from
  "the replacement never became ready". The generic timeout of the last
  attempt never replaces a crash or a malformed answer.
- An answer that arrives after the budget of the exchange is not accepted:
  the budget is checked again before the answer or the rejection is used, so
  a request that ran out of time is never answered with a contract outcome.

### What a caller must give the client

The taxonomy above has one requirement for the caller: **the deadline of the
caller must be later than the internal request budget of the client**, when
the caller wants a failure of the worker to be reported as such.

The two cases are distinguishable, and the client keeps them apart. A worker
that hangs while it is idle gives the **internal** timeout, without a cause. A
caller that went away gives its own cause: an explicit cancellation, or its
deadline when that deadline is the earlier one. A caller that probes the
worker therefore has to give the client a deadline that is longer than the
internal request budget of the client, so that the internal timeout is the
one that fires and the outage of the worker is recorded.

The client does not wait past the deadline of the caller to classify the
failure. A bounded grace was tried and removed: it extended the caller's
deadline, it held the shared worker slot for the queued requests, and it
turned the cancellation of a caller into a timeout. The failure of a call is
decided by the exchange that produced it.

### The busy worker and the probe

A worker that is busy with a request is healthy. The client reports the three
classes that the health of the service needs:

| Class | Reported as | Meaning |
| --- | --- | --- |
| the caller canceled or the caller's deadline passed | the context cause | the caller went away; the dependency is untouched |
| the worker is busy with another request | `online.ErrRulesBusy` | the process is healthy and busy |
| the exchange exceeded the internal bound of the worker | the error of the worker | an outage of the dependency |

`Client.Probe` is the optional seam for a health monitor. It takes the worker
slot only when the slot is free; when a participant request holds it, the
probe reports `online.ErrRulesBusy` and returns at once. It never queues
behind a participant request, it never spends the budget of that request, and
it never makes a healthy worker look broken. `OnlineEvaluator.Probe` is the
same seam for the evaluator of the service, and it maps the busy signal of
the client to `online.ErrRulesBusy`.

A probe of a free worker performs a **real bounded exchange** with it. The
readiness flag alone is not evidence: a worker that hung or exited after it
became ready would look healthy forever. The probe never gives the client a
deadline of its own, so the internal bound of the client decides an outage.
A worker that does not answer is killed, reaped and reset, and the next
probe starts and proves a fresh one.

A probe keeps the class of the failure that produced it, exactly like a
participant request:

- an explicit cancellation of the caller stays a cancellation,
- the deadline of the caller, when it is earlier than the internal bound,
  stays that deadline, so a caller that went away does not mark a healthy
  worker as an outage,
- only the internal bound of the client is a bare timeout, and that is the
  class of an outage.

The service therefore never invents a deadline in front of the bound of the
client: the internal bound of the client is the one that ends an exchange
of a worker that does not answer.

**A probe does not start the worker.** A monitor must not warm the traffic
path, and the cold start belongs to the request that needs the worker. A
probe of a worker that is not running therefore reports the busy class and
returns at once, without starting a process and without holding the slot for
a start.

**The recovery of a worker that is gone is `Client.Repair`.** It starts the
worker when it is not running and proves that it answers. A repair of a
worker that is running is a plain probe: the worker is talked to, and a
worker that does not answer is killed, reaped and reset, so that the next
repair starts a fresh one.

The two calls exist because a check that started the worker would hold the
only worker slot for the whole cold start, and a request that arrived in that
window would fail. The failure would look like an outage of the worker, and
the service would refund the clocks of the unfinished matches for a worker
that was merely cold.

The recovery of a **closed** health gate is the repair: the gate is closed
because the worker was found broken, the service serves no traffic then, and
holding the worker slot for the cold start is safe. Without the repair, a
closed gate could not recover: the worker is gone after the outage, a check
reports the busy class, and no participant request can start the replacement
because the gate refuses the traffic.

The health glue of the service therefore has to use the two calls. The
seam is the client of the rules worker, and it is called by the monitor
through an optional interface of the service:

| Seam | Package | Meaning |
| --- | --- | --- |
| `rulesworker.Client.Probe(ctx) error` | `backend/rulesworker` | the check: never starts a worker, `rulesworker.ErrBusy` when the worker is busy or not running |
| `rulesworker.Client.Repair(ctx) error` | `backend/rulesworker` | the recovery: starts the worker when it is gone and proves that it answers |
| `rulesworker.OnlineEvaluator.Probe(ctx) error` | `backend/rulesworker` | the same check for the service, with the busy signal translated to `online.ErrRulesBusy` |
| `rulesworker.OnlineEvaluator.Repair(ctx) error` | `backend/rulesworker` | the same recovery for the service |

```go
// while the gate is closed, repair the dependency; otherwise check it.
if repairer, ok := s.evaluator.(interface{ Repair(ctx context.Context) error }); ok && gateClosed {
    err = repairer.Repair(ctx)
} else if prober, ok := s.evaluator.(interface{ Probe(ctx context.Context) error }); ok {
    err = prober.Probe(ctx)
} else {
    err = s.evaluator.ValidateSetup(ctx, input)
}
```

A **failed** repair is a failure of the check: the monitor reports it and
retries it on the next tick. A repair that only logs leaves the gate closed
and the dependency down, which is the deadlock the composed proof measured.

The boot warm of the composition stays what it is: it is the healthy boot
path, and a failure of it does not stop the service. The dependency still
comes back, through the repair of a closed gate.

The setup validation of a match creation keeps its waiting behaviour: a
creation waits for the worker instead of refusing the match. Only a probe
reports the busy worker.

## The fixture budgets

A fixture budget must cover the bounded work the fixture performs. The size
limit fixture installs a line that is longer than the limit, and it
configures a **small response limit** (8 KiB) for that fixture, so the
violation is detected after a modest transfer instead of after a megabyte of
pipe traffic. The transfer is bounded by the read buffer of the client
(64 KiB), not by the limit itself, because the reader takes a whole buffer
before it compares the length. The assertion stays exact: an oversized answer
is malformed. The other fixtures perform one bounded exchange and use the
budget of the original fixtures (one second).

The cold start of the worker is not part of any of these budgets: the client
budgets the start separately, and the regressions below cover it. The
warm-up of a fixture client runs under a bounded context, so a stalled
warm-up fails the fixture instead of the package.

## Evidence

`backend/rulesworker/client_test.go` covers the defect with a fake worker
whose readiness probe answers only after a simulated boot delay:

- `TestTheColdStartDoesNotConsumeTheExchangeBudget`: a one second exchange
  budget and a two second simulated boot. The request succeeds, because the
  boot is not charged to the exchange.
- `TestTheRestartAfterATimeoutKeepsItsOwnStartBudget`: the same budgets after
  a timeout stopped the worker. The restart succeeds, because the restart has
  its own start budget.

Both fail with the old budget accounting and pass with the current one. The
fixtures warm the worker before they measure a protocol behaviour, so they
measure the protocol instead of the host's process start latency.

Three regressions cover the failure of a call. They are written against the
probes of the independent review, and all three fail with the reviewed
candidate and pass with the current code:

- `TestTheCrashOfTheFirstExchangeIsNotReplacedByTheTimeoutOfTheRetry`: a
  worker that dies on the first exchange and hangs on the second. The call
  reports the crash, not the timeout of the retry.
- `TestACanceledCallerKeepsItsCancellation`: a caller that cancels while the
  worker answers. The caller is told that it was canceled, not that it timed
  out.
- `TestALateRejectionIsNotAContractOutcome`: a worker that rejects after the
  deadline. The call reports a timeout, and the rejection never reaches the
  participant as "illegal move".

The regressions of the causes and the starts are:

- `TestTheCancellationCarriesTheCauseOfTheCaller`: the cancellation carries
  the cause of the context, and an internal timeout carries none.
- `TestTheCrashSurvivesAFailedStartOfTheReplacement`: a worker that dies and
  a replacement that never becomes ready. The call still reports the crash.
- `TestTheCancellationWinsOverAnEarlierCrash`: a crash followed by the
  cancellation of the caller. The call reports the cancellation.
- `TestTheCallerDeadlineIsCarriedDuringTheReadiness` and
  `TestTheCallerDeadlineIsCarriedInAWarmedExchange`: the deadline of the
  caller is carried when it ends the call, in the readiness phase and in a
  warmed exchange.
- `TestAnInternalTimeoutCarriesNoCause`: a worker that does not answer
  inside its own budget is an outage of the worker.
- `TestAnExpiredInternalBudgetIsNotTheDeadlineOfTheCaller`: an internal
  budget that was already spent when the call reached the queue is not the
  deadline of the caller.
- `TestTheEqualBoundaryBelongsToTheInternalBudget`: the boundary rule.
- `TestACanceledCallReapsTheWorker`: a canceled call leaves no dead worker
  behind, and the next request starts a fresh one.
- `TestTheProbeReportsABusyWorkerWithoutWaiting` and
  `TestTheEvaluatorReportsTheBusySignal`: a probe of a busy worker reports
  `online.ErrRulesBusy` and returns at once.
- `TestTheProbeDetectsAWorkerThatHungAfterItsReadiness` and
  `TestTheProbeDetectsAWorkerThatExitedAfterItsReadiness`: a probe of a ready
  worker that hung or exited fails, the process is killed and reaped, and the
  next probe proves a fresh worker.
- `TestTheProbeKeepsTheClassOfAnEarlierCallerDeadline` and
  `TestTheProbeReportsTheInternalBoundAsABareTimeout`: the probe keeps the
  class of the failure that produced it, and the process is reaped either
  way.

`TestTheRealBundleAnswersAColdRequest` is the smoke test of the pinned worker
bundle: the real process accepts the readiness probe and answers a cold
request. It deliberately does not claim that the cold start is outside the
exchange budget, because the length of the real boot depends on the host. The
regression that proves the add-back simulates the boot instead of measuring
one.

The real worker bundle is covered as well: with `KHA66_WORKER_ENTRY` set to
the built `build/rules-worker/worker.mjs`, the readiness probe is accepted by
the real process and the online integration fixtures that use the real rules
process (checkmate, timeout policy, candidate fencing) pass.

### What was measured, and what was not

- The five regressions above fail with the old behaviour and pass with the
  current one.
- The failure that was reported on the assembled root is a load-fragile
  fixture, not the start accounting. The fixture installed a line of twice
  the response limit, so the client had to read about a megabyte through a
  pipe before it could report the violation, and that transfer exceeded the
  fixture's exchange budget on a starved host. The fixture now detects the
  violation after a modest transfer, and the failure class of a crash no
  longer depends on which case the select picks.
- The load measurements of the whole package are **not** a proof: an
  independent review reproduced a failure of that fixture in 12 of 60 runs
  under a 16-CPU load before the fixture was separated, and the same review
  could not reproduce the reported assertion of the assembled root. The
  honest statement is that the fixture was the fragile part, that its
  remaining fragility came from a bounded transfer that the fixture itself
  chose, and that the fixture no longer performs that transfer.