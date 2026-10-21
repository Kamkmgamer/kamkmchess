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

## Evidence

`backend/rulesworker/client_test.go` covers the defect with a fake worker
whose readiness probe answers only after a simulated boot delay:

- `TestTheColdStartDoesNotConsumeTheExchangeBudget`: a 150 ms request budget
  and a 400 ms boot. The request succeeds, because the boot is not charged to
  the exchange.
- `TestTheRestartAfterATimeoutKeepsItsOwnStartBudget`: the same budgets after
  a timeout stopped the worker. The restart succeeds, because the restart has
  its own start budget.

Both fail with the old budget accounting and pass with the new one. The
fixtures warm the worker before they measure a protocol behaviour, so they
measure the protocol instead of the host's process start latency.

The real worker bundle is covered as well: with `KHA66_WORKER_ENTRY` set to
the built `build/rules-worker/worker.mjs`, the readiness probe is accepted by
the real process and the online integration fixtures that use the real rules
process (checkmate, timeout policy, candidate fencing) pass unchanged.
