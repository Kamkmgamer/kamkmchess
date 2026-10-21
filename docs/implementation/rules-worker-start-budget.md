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

The wall-clock bound of one call is therefore `RequestTimeout + StartTimeout`
for a call that starts the worker once, and `RequestTimeout + 2 *
StartTimeout` for a call that starts it twice. The start durations are added
back to the exchange deadline, so the exchange always keeps its own budget.
The call never outlives the deadline of its caller: the client does not wait
past it to classify a failure.

**The cold start is charged to the requests that are queued behind it.** The
worker has one slot, and the request that triggers a cold start holds that
slot while the worker boots. The queued requests spend their own queue budget
while they wait, so a slow start on a loaded host can make a *different*
request run out of time. The queue wait is not reset and a queued request
does not get a fresh budget; the remedy is to keep the worker warm, not to
relax the budget.

The server composition keeps the worker warm through the health monitor: the
periodic rules probe of `backend/serverapp/health.go` evaluates a position
through the same client, so the worker is started and ready again after a
crash. The probe runs on its interval, so the first requests after a server
start still meet a cold worker; a `client.Warm(ctx)` call next to the
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
  is told that it was canceled, not that the worker was slow.
- A **specific** failure survives the retry. A worker that died on the first
  exchange and hung on the second is reported as the crash, because the caller
  must be able to tell "the worker died" from "the worker was slow". The
  generic timeout of the last attempt never replaces a crash or a malformed
  answer.

The client does not wait past the deadline of the caller to classify the
failure. A bounded grace was tried and removed: it extended the caller's
deadline, it held the shared worker slot for the queued requests, and it
turned the cancellation of a caller into a timeout. The failure of a call is
decided by the exchange that produced it.

## The fixture budgets

A fixture budget must cover the bounded work the fixture performs. The size
limit fixture installs a line that is longer than the limit, and it
configures a **small response limit** (8 KiB) for that fixture, so the
violation is detected after a modest transfer instead of after a megabyte of
pipe traffic. The assertion stays exact: an oversized answer is malformed.
The other fixtures perform one bounded exchange and use the production
budget of the client.

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
