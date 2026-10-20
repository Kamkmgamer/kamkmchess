# KHA-76 evidence — transaction-safe queue matchmaking

Owner: the queue worker (KHA-76). This file records what was implemented and
what was actually executed. It claims no deployment, no public launch and no
native or host acceptance.

The wire contract of the queue is published in
[`docs/online/queue-contract.md`](../online/queue-contract.md).

## What was built

| Area | Files |
| --- | --- |
| Schema | `backend/migrations/0011_online_queue_entries.sql`, `backend/migrations/0012_online_queue_allocations.sql` |
| Queue writer | `backend/queue/queue.go`, `backend/queue/allocate.go`, `backend/queue/worker.go` |
| Engine credential | `backend/onlineauth/engine.go` |
| HTTP surface | `backend/httpapi/queue.go`, `backend/httpapi/features.go` |
| Composition | `backend/serverapp/server.go`, `backend/serverapp/queue_worker.go` |
| Browser contract | `src/online/queue.ts`, `src/online/queue.test.ts` |
| Regressions | `backend/integration/queue_test.go`, `backend/httpapi/queue_test.go` |

## The design in one paragraph

An entry is created by an explicit, account-only request. The creation is the
authoritative ready acceptance: it records `readyAt` and arms the ten second
window `cutoffAt = readyAt + 10s`, and it never moves afterwards. Candidate
selection, reservation, cancellation and the engine fallback are serialized
per time-control bucket with a transaction advisory lock, so a delayed timer,
a competing matchmaker and a cancellation observe one order and a candidate is
never skipped because another transaction held its row. The allocation itself
has three durable steps: the reservation row (and the consumed entry rows) are
written inside the bucket lock, the shared writer writes the canonical match
outside the queue transaction with the idempotency key of the reservation, and
the reservation is completed and the entries are published as assigned. A
failure between the steps leaves a pending reservation that the reconciliation
loop finishes into the same match. The unique index on the consumed entry is
the database fact behind "one entry produces one game".

## Acceptance scenarios

| Scenario | Evidence | Status |
| --- | --- | --- |
| `QUE-01` account and consent | `TestQueueRefusesGuestsAndConsumesAnEntryOnce` (a guest is refused; one entry produces exactly one game; the repeat call returns the same game; the opponent is consumed as well), `TestOnlineQueueRefusesGuestsAndUnauthenticatedCallers` | covered |
| `QUE-02` compatible pairing | `TestQueueMatchesOnlyDifferentOwnersWithAnAgentSeat` (human/human and same owner are ineligible; a different clock is ineligible; human/agent matches) | covered |
| `QUE-03` concurrent games | `TestQueueOwnerHoldsUnlimitedConcurrentEntries` (three intents of one owner, no extra entry), `TestQueueCompetingMatchersProduceOneGame` (two assigned entries and one waiting) | covered |
| `QUE-04` multi-tab entry | `TestQueueCreationIsIdempotentPerOwner` (the replay of an intent answers the same entry; the same intent with another request is a conflict; another owner may use the same intent value) | covered |
| `QUE-05` readiness start | `TestQueueWindowStartsAtTheReadyAcceptance` (the ready time is the acceptance time; the cutoff is the ten second window after it; the window does not move) | covered |
| `QUE-07` background eligibility | `TestQueueUnresponsiveEntryExpiresAndNeedsAnExplicitRejoin` (the lease runs out, the entry expires and is reported without a ready time, it leaves the eligibility, and an explicit rejoin arms a fresh window) | covered |
| `QUE-08` selection change | `TestQueueSelectionStaysFixedAndOtherEntriesSurvive` (the settings of an entry are fixed, a change is a cancellation and a new entry with a fresh window, the other entry of the owner is unaffected) | covered |
| `QUE-09` deadline equality | `TestQueueCutoffEqualityWinsAndLaterCandidatesDoNot` (a candidate that becomes ready exactly at the cutoff wins over the engine; a later candidate never replaces the committed opponent) | covered |
| `QUE-10` atomic allocation | `TestQueueCompetingMatchersProduceOneGame` (three competing matchmakers produce exactly one game), `TestQueueCancelAndAssignmentRaceHasOneOutcome` (the cancellation and the assignment race to one outcome) | covered |
| `QUE-13` fixed opponent | `TestQueueCommittedOpponentIsNeverReplaced` (a late candidate cannot replace the committed engine), `TestQueuePendingAllocationIsRecovered` | covered |
| `QUE-14` queue position isolation | `TestQueueUsesTheStandardPositionAndRandomColors` (the standard position, the requested clock, two different seat owners), `TestQueueMatchIdentifiersNeverCollideAcrossOwners` | covered |
| `ARC-10` late timer | `TestQueueDelayedWorkerResolvesTheOriginalCutoff` (a late worker pairs the candidate that was ready before the original cutoff and leaves the post-cutoff candidate waiting), `TestQueueLateWorkerDoesNotMatchPostCutoffCandidates` (a late worker never matches a post-cutoff candidate; the entry waits for the engine fallback) | covered |

`QUE-06` (readiness failure), `QUE-11` (Stockfish assignment), `QUE-12`
(fallback failure) and `QUE-15` are not owned by this ticket: they are the
readiness and browser engine flows of KHA-77. The queue side they need is
implemented and covered: the fallback commits only after the browser reports a
ready engine (`TestQueueCommittedOpponentIsNeverReplaced`,
`TestOnlineQueueAssignmentAnswerCarriesTheEngineCredential`) and the engine
seat is identified as the engine (`TestQueueFallbackEngineSeatIsASeparateParticipant`).

## Executed results

Fixture: the local trust-authenticated PostgreSQL of the workspace
(`postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable`,
`KHA41_REQUIRE_POSTGRES=1`). Every queue test creates its own schema and
applies every migration, so the migration set is exercised as well.

```
go test ./backend/integration -run TestQueue -count=1
ok   github.com/Kamkmgamer/kamkmchess/backend/integration  21.289s

go test ./backend/httpapi -run "TestOnlineQueue|TestOnlineFeatures" -count=1
ok   github.com/Kamkmgamer/kamkmchess/backend/httpapi  0.546s

go test ./backend/... -count=1
ok   github.com/Kamkmgamer/kamkmchess/backend/auth            3.211s
ok   github.com/Kamkmgamer/kamkmchess/backend/backup          4.267s
ok   github.com/Kamkmgamer/kamkmchess/backend/backup/cmd/khabackup 5.853s
ok   github.com/Kamkmgamer/kamkmchess/backend/httpapi         7.519s
ok   github.com/Kamkmgamer/kamkmchess/backend/integration   437.138s
ok   github.com/Kamkmgamer/kamkmchess/backend/online           1.190s
ok   github.com/Kamkmgamer/kamkmchess/backend/onlineauth       0.125s
ok   github.com/Kamkmgamer/kamkmchess/backend/profile          0.181s
ok   github.com/Kamkmgamer/kamkmchess/backend/serverapp       0.425s
ok   github.com/Kamkmgamer/kamkmchess/backend/storage         0.171s
FAIL github.com/Kamkmgamer/kamkmchess/backend/rulesworker    15.793s
    --- FAIL: TestTimeoutKillsTheWorkerAndTheNextRequestRestartsIt
        client_test.go:295: restart after timeout: rules worker timed out
```

The rules worker failure is a load flake of a timing test that starts a Node
process: it passed in isolation right after the full run
(`go test ./backend/rulesworker/ -run TestTimeoutKillsTheWorkerAndTheNextRequestRestartsIt -count=1`
→ `ok ... 0.629s`). The package is untouched by this ticket.

```
pnpm vitest run
Test Files  76 passed (76)
     Tests  921 passed (921)

pnpm exec tsc -p tsconfig.app.json --noEmit      # clean
pnpm exec tsc -p tsconfig.node.json --noEmit    # clean
pnpm exec eslint . --max-warnings 0             # clean
```

## Review findings

### F-10 — the browser engine seat (P1, `early-authority-review.md`)

**Assessed against the approved specification, and partially addressed.**

The approved specification (KHA-60) says: "Stockfish fallback runs in the
initiating browser using a narrowly scoped engine-seat grant. Its accepted
moves still require server validation." The published matching contract says
the fallback answer carries a seat credential for the engine seat.

Addressed in this ticket:

* The engine seat is **its own participant**. It is a guest identity derived
  from the idempotency key of the allocation, and it is never the requesting
  account. The requesting account therefore cannot act as the opponent
  through its account session, and the seat owner in `online_seats` stays
  immutable (`TestQueueFallbackEngineSeatIsASeparateParticipant`).
* The credential is scoped to one match and one seat, revocable, and
  superseded by every later issuance
  (`backend/onlineauth/engine.go`).
* No ownership proof is minted for the engine seat, so the engine seat can
  never be linked to an account.

**Residual and coordination.** The credential is a full *seat* credential, so
its holder may also resign the engine seat, and the runner model of KHA-73
treats the holder as the legitimate runner of that seat. A move-only
capability would change the approved contract, so it is not invented here.
The matching worker (KHA-75) and the runner worker (KHA-73) own that
boundary; the queue keeps the engine seat a separate participant and never
gives the account the opponent seat. The note records the residual for the
integrator.

### F-14 — the feature route and the server gates (P1)

**Addressed.** `GET /v1/online/features` answers exactly
`{"friends": boolean, "queue": boolean}`
(`TestOnlineFeaturesAnswerCarriesExactlyTwoSwitches`). The queue routes are
mounted only when `ONLINE_QUEUE_ENABLED` is on, and both switches default to
off. The route is registered in exactly one place
(`backend/serverapp/server.go`); a second registration of the same pattern
would panic the server, so the composition keeps one.

### F-22 — the match identifier of an allocation (P2)

**Addressed by construction.** The queue never uses the client intent
identifier as the idempotency key of a match: every reservation gets its own
server generated operation identifier, and the shared writer derives the
match identifier from that key and the participant that caused the
allocation. Two owners that use the same intent identifier therefore never
share a match (`TestQueueMatchIdentifiersNeverCollideAcrossOwners`).

### The review note about the queue expiry

The wire answer of an expired entry is `waiting` with a `null` `readyAt`, so
the browser can tell "expired" from "still searching"
(`TestQueueUnresponsiveEntryExpiresAndNeedsAnExplicitRejoin`).

## Known limitations

1. The public label of an owner comes from a `LabelResolver` port. The queue
   ships with a default resolver that names every owner "Player"; the
   production composition should pass the public profile service. The port is
   `queue.Options.Labels`.
2. The queue asks the shared writer for the canonical match **outside** the
   queue transaction, because the shared writer owns its transaction. The
   durable reservation is what makes that safe: it names the idempotency key
   of the match, and the reconciliation loop finishes a pending reservation
   into the same match. A match that exists while the reservation is still
   pending is never published as an assignment.
3. The engine credential is minted in its own transaction, after the match
   exists (the credential needs the committed seat row). A crash in between
   leaves a committed match without a credential; the owner asks again and
   receives a fresh credential for the same seat.
4. The reconciliation loop never commits the browser engine fallback. That
   needs a ready engine in the owner's browser, so the loop only records that
   the cutoff was reached.
5. The service does not run the browser agent or the engine. It allocates the
   match and names the opponent; the moves, the clocks and the results stay
   with the shared match service of KHA-65 and KHA-73.
6. The candidate order is the ready time and then the creation time. Two
   entries that became ready at the very same instant are a tie, and the tie
   is broken by the entry identifier. The tie is stable but not
   creation-ordered; a monotonic sequence column would remove it.

## Status

The implementation, the schema, the HTTP surface, the browser contract and the
regressions above are in the branch of this ticket. The acceptance scenarios
of KHA-76 are covered by the recorded runs. Nothing here claims a deployment,
a capacity check or a public launch.
