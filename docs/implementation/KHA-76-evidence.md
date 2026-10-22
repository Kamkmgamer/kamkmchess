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
window `cutoffAt = readyAt + 10s`, and it never moves afterwards. The
declared model label is resolved through the canonical resolution of the
shared schema before it is accepted, so a raw requested label never reaches a
durable row and never crosses an owner boundary. Candidate selection,
reservation, the write of the canonical match, cancellation and the engine
fallback are one decision inside one transaction that holds the time-control
bucket lock: the shared writer writes the match inside that transaction, so
the game and the consumption of the entries commit together and two owners
of one pair can never write the same match. A delayed timer, a competing
matchmaker and a cancellation observe one order. The unique index on the
consumed entry is the database fact behind "one entry produces one game".

## Acceptance scenarios

| Scenario | Evidence | Status |
| --- | --- | --- |
| `QUE-01` account and consent | `TestQueueRefusesGuestsAndConsumesAnEntryOnce` (a guest is refused; one entry produces exactly one game; the repeat call returns the same game; the opponent is consumed as well), `TestOnlineQueueRefusesGuestsAndUnauthenticatedCallers` | covered |
| `QUE-02` compatible pairing | `TestQueueMatchesOnlyDifferentOwnersWithAnAgentSeat` (human/human and same owner are ineligible; a different clock is ineligible; human/agent matches) | covered |
| `QUE-03` concurrent games | `TestQueueOwnerHoldsUnlimitedConcurrentEntries` (three intents of one owner, no extra entry), `TestQueueCompetingMatchersProduceOneGame` (two assigned entries and one waiting) | covered |
| `QUE-04` multi-tab entry | `TestQueueCreationIsIdempotentPerOwner` (the replay of an intent answers the same entry; the same intent with another request is a conflict; another owner may use the same intent value) | covered |
| `QUE-05` readiness start | `TestQueueWindowStartsAtTheReadyAcceptance` (the ready time is the acceptance time; the cutoff is the ten second window after it; the window does not move) | covered |
| `QUE-07` background eligibility | `TestQueueUnresponsiveEntryExpiresAndNeedsAnExplicitRejoin` (the lease runs out, the entry expires and is reported without a ready time, it leaves the eligibility, and an explicit rejoin arms a fresh window), `TestQueueResponsiveBackgroundEntryStaysEligible` (a responsive owner stays eligible and is still a candidate), `TestQueueExpiredInitiatorNeverConsumesACandidate`, `TestQueueLateHeartbeatNeverRevivesADeadLease` | covered |
| `QUE-08` selection change | `TestQueueSelectionStaysFixedAndOtherEntriesSurvive` (the settings of an entry are fixed, a change is a cancellation and a new entry with a fresh window, the other entry of the owner is unaffected) | covered |
| `QUE-09` deadline equality | `TestQueueCutoffEqualityWinsAndLaterCandidatesDoNot` (a candidate that becomes ready exactly at the cutoff wins over the engine; a later candidate never replaces the committed opponent) | covered |
| `QUE-10` atomic allocation | `TestQueueCompetingMatchersProduceOneGame` (three competing matchmakers produce exactly one game), `TestQueueCancelAndAssignmentRaceHasOneOutcome` (the cancellation and the assignment race to one outcome), `TestQueueCompetingOwnersNeverSeeAServerError` (five rounds of two competing owners: one game, no server error), `TestQueueSweepAndOwnerRaceOnTheSameAllocation` (the reconciliation loop and the owner race on one allocation) | covered |
| `QUE-13` fixed opponent | `TestQueueCommittedOpponentIsNeverReplaced` (a late candidate cannot replace the committed engine), `TestQueueCommittedAllocationIsNeverResolvedAgain` | covered |
| `QUE-14` queue position isolation | `TestQueueUsesTheStandardPositionAndRandomColors` (the standard position, the requested clock, two different seat owners), `TestQueueMatchIdentifiersNeverCollideAcrossOwners`, `TestQueueRawRequestedLabelNeverCrossesTheOwnerBoundary` (a raw requested label never reaches a row or another owner) | covered |
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

The runs below are the runs of this branch. The host was busy with the tests
of the other workers, so an isolated schema test took six to eleven seconds
instead of half a second, and the integration package needs a longer timeout
than the ten minutes of the Go default.

```
go test ./backend/integration -run TestQueue -count=1
ok   github.com/Kamkmgamer/kamkmchess/backend/integration  271.112s

go test ./backend/httpapi/ ./backend/serverapp/ -count=1
ok   github.com/Kamkmgamer/kamkmchess/backend/httpapi       7.660s
ok   github.com/Kamkmgamer/kamkmchess/backend/serverapp     0.634s

pnpm vitest run src/online/queue.test.ts
Test Files  1 passed (1)
     Tests  16 passed (16)
```

The complete `go test ./backend/...` was **not** run to the end on this
machine: the integration package exceeded the ten minute default timeout of
the Go tool because of the load of the concurrent workers, and the run was
stopped. The queue, HTTP, serverapp and browser suites above are the runs
that cover the changes of this branch; the parent runs the complete
assembled suite after the integration.

The rules worker package has a timing test that starts a Node process. It
failed under the load of the parallel run ("rules worker timed out") and
passed in isolation; the package is untouched by this ticket.

## Review findings of round 3 (independent queue review)

The independent review of round 3 (`queue-review-r3.md`) found ten items. Each
of them is fixed and covered by a regression in this branch. The review
reproduced the defects against the reviewed head; the corrections below are
the ones this branch ships.

| Item | Disposition | Evidence |
| --- | --- | --- |
| Q-01 the completion of one allocation is not serialized | **fixed**: the decision is one transaction that holds the bucket lock, and the shared writer writes the match inside it. The pending allocation state is gone. | `TestQueueAllocationRacesAreSerialized` (three rounds of two competing owners, no server error, one game each), `TestQueueSweepAndOwnerRaceOnTheSameAllocation` (the sweep and the owner race on one allocation, one game, no error), `TestQueueCompetingMatchersProduceOneGame` |
| Q-02 every fallback rotates the engine credential | **fixed**: the credential is issued once. A routine retry keeps the live credential and answers without a secret; an explicit recovery rotates it on purpose. | `TestQueueEngineCredentialLifecycle`, `TestQueueHTTPFallbackCarriesTheEngineCredential` |
| Q-03 the operation receipt stores the plaintext engine credential | **fixed**: the durable receipt stores the assignment without the secret. | `TestQueueEngineCredentialLifecycle` (the stored row carries neither the token nor a credential) |
| Q-04 the answer carries the raw requested model label | **fixed**: the declared control is resolved through the canonical resolution of the shared schema before it is stored or returned. | `TestQueueCanonicalLabels` (the answer, the allocation row, the entry row and the canonical seat all carry the resolved label) |
| Q-05 the engine label drifts from the canonical one | **fixed**: the engine seat and the answer carry the canonical model label `Stockfish 19 Lite (browser)` and the public label `Stockfish 19 Lite`. | `TestQueueCanonicalLabels` |
| Q-06 the readiness lease of the initiator is not enforced | **fixed**: a dead lease is refused inside the decision, and a heartbeat never revives it. | `TestQueueReadinessLeaseIsEnforced` |
| Q-07 a fallback pending entry never expires | **fixed**: the expiry sweep covers the `fallback` state as well. | `TestQueueFallbackPendingEntryExpires` |
| Q-08 the failures of the reconciliation loop are invisible | **fixed**: the pass result and every failure reach the logger or the error hook of the composition. | `TestQueueReconcilerReportsTheSweepResult`, `TestQueueReconcilerReportsAFailedPass` |
| Q-09 the documentation and the evidence drift | **fixed**: the contract and this file state the canonical engine label, the credential lifecycle, the canonical label resolution, the lease enforcement and the atomic allocation. The recorded runs below are the ones of this commit. | the "Executed results" section |
| Q-10 the HTTP regressions are stub only | **fixed**: the HTTP surface is exercised end to end against the real queue, the real database and the real shared writer, and the engine credential of the production composition is exercised against the real authorization service. | `TestQueueHTTPRoutesRunAgainstTheRealQueue`, `TestQueueHTTPFallbackCarriesTheEngineCredential`, `TestQueueRealEngineCredentialIsScopedAndRefusedByTheQueue` |

The foundation owns `backend/online/allocation_writer.go`. This branch does
not edit it: it uses the exported in-transaction seam
(`CreateMatchInTx`, `ValidateSetup`, `NewAllocationCommand`) exactly as it
is, and the queue regressions reproduce the races against it.

### The credential design of Q-02 and Q-03

The two requirements pull in opposite directions: a routine retry must not
rotate a secret the browser holds, and an owner that lost the answer must be
able to get a usable credential again - without a plaintext durable receipt.

The resolution has three parts:

1. The service issues the credential once. A repeated fallback checks whether
   the seat has a live credential and, if it has, answers the assignment
   **without** a secret. The browser keeps the secret it received, so the
   engine seat of a running game keeps working.
2. The durable receipt stores the assignment **without** the secret. The
   plaintext of a credential exists only in the answer that delivered it, and
   the database keeps the hash of the secret.
3. The owner that lost the answer asks for the explicit recovery
   (`credentialRecovery: true`). That rotation is the only one, and it is the
   owner's own decision. The browser client asks for it exactly when the
   browser holds no usable credential, and the port that reports that state
   is handed to the workspace composition.

No encryption was invented and no boundary was weakened: the credential stays
seat-scoped, origin-scoped and revocable, and the queue stays account-only.

### The composition of the credential port

`createQueueClient(requester, credentials?)` in `src/online/queue.ts` takes
the engine credential port. The workspace composition has to pass it:

```ts
const queueClient = createQueueClient(requester, {
  holdsEngineCredential: matchId => engineSeatStore.holds(matchId),
});
```

Without the port the client never rotates a credential, so a browser that
lost the answer of a fallback stays without an engine credential until the
owner asks for the recovery. The composition already sends an operation
identifier for every mutation.

## The removal of an account and the queue writes

The queue and the removal of an account share the account scope lock of the
online service, and every queue write re-reads the durable removal inside its
own transaction. An account that was authenticated before its removal
therefore cannot write queue state afterwards, and it is never paired.

| Write | The service takes | The removal is re-read |
| --- | --- | --- |
| the creation of an entry | the bucket lock, then the account scope lock | yes, inside the transaction |
| the rearm, the cancellation, the keep-searching and the heartbeat | the bucket lock, then the account scope lock | yes, inside the transaction |
| the allocation of a match | the bucket lock, then the account scope locks of both participants in ascending order | yes, for both participants, inside the transaction |
| the reconciliation loop | the same locks, through the same decision | yes, and a removed account is skipped without a failure |

The lock order of the queue is fixed: the bucket lock, then the account scope
locks in ascending order, then the row locks. Every queue write takes them in
that order, so two allocations never wait for each other in the opposite
order. The scope locks come before the row locks, and the removal of a
participant takes the same scope lock, so an allocation and a removal of one
participant are ordered instead of racing.

The comparison uses the one-way reference of the subject
(`subject.Reference`), so the removal tables never see an account identifier
and the service never sends one to the database.

The regressions are `TestQueueRemovedAccountCannotWriteQueueState`,
`TestQueueRemovedAccountIsNeverPaired`,
`TestQueueRemovalOrdersTheQueueWrites` (the write waits for the scope lock
and is refused once the removal committed) and
`TestQueueSweepSkipsARemovedAccount`.

## Known limitations

1. The engine credential is minted in its own transaction, after the match
   exists, because the credential needs the committed seat row. A crash in
   between leaves a committed match without a credential; the owner asks for
   the explicit recovery and receives a fresh credential for the same seat.
2. The reconciliation loop never commits the browser engine fallback. That
   needs a ready engine in the owner's browser, so the loop only records that
   the cutoff was reached.
3. The service does not run the browser agent or the engine. It allocates the
   match and names the opponent; the moves, the clocks and the results stay
   with the shared match service of KHA-65 and KHA-73.
4. The candidate order is the ready time and then the creation time. Two
   entries that became ready at the very same instant are a tie, and the tie
   is broken by the entry identifier. The tie is stable but not
   creation-ordered; a monotonic sequence column would remove it.
5. The workspace composition has to pass the engine credential port to
   `createQueueClient` before a browser that lost the answer of a fallback
   can recover it. The contract change is recorded above.
6. The account path of the HTTP regressions uses a fixture token: producing a
   genuine Clerk session token would need a live JWKS endpoint. The guest
   path, the origin rule, the strict bodies and the real engine credential
   are exercised against the real services.

## Status

The implementation, the schema, the HTTP surface, the browser contract and the
regressions above are in the branch of this ticket. The acceptance scenarios
of KHA-76 are covered by the recorded runs. Nothing here claims a deployment,
a capacity check or a public launch.
