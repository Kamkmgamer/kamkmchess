# KHA-65 shared state and transactions

Implemented and locally verified on 2026-10-20.
Tested source commit: `692b1c60a7f169c88919a122210f1a40b3e5e12b` on `feature/online-foundations`.

## Contract and storage

The additive `0002_online.sql` migration creates shared matches/seats, clocks/deadlines, accepted moves/events, operation receipts, queue entries, runner leases, public projections and deletion markers. It preserves the private archive schema. Go and TypeScript contracts use closed actions and reject arbitrary state or private connection fields.

The Go service is the transaction writer. Commands carry the expected version, control epoch, seat and operation ID. Authenticated actor identity is a separate trusted server argument. Seat membership is checked before expiry can write a result. HTTP authentication and guest credentials belong to KHA-67.

Receipts and state commit atomically. Identical retries return the original receipt bytes, including after completion. Changed payloads or actors reusing an operation ID fail. Final results and their result version are latched.

The writer locks the match first, then samples database `clock_timestamp()` in a separate statement. The sample is floored at the prior accepted event time to keep event time nondecreasing across backward host-clock adjustment. A real lock wait crossing expiry rejects the late move.

Rules evaluation happens outside locks. Re-locking verifies version, input hash, control epoch, side and move. Checkmate awards the mover in both contract validators. Timeout adjudication uses separately evaluated, version-bound material facts; a missing policy fails closed. Shared reads use one repeatable-read snapshot.

Online tables have no foreign keys into private games/archives. Shared contracts exclude provider credentials, requests, reasoning, conversations and private routes. Public projections use an allowlist. Replay removal revokes the projection and records a durable marker.

The online API role receives only online-table grants. The rules role has no table/sequence privileges and cannot read the private archive. Local PostgreSQL tests exercised real roles and permission denials. Grant assertions explicitly skip when roles cannot be created; the verified local run did not use that skip.

## Verification

Isolated local PostgreSQL 17.11 ran in `kamkmchess-kha65-local` on loopback port 55465. Each test created and dropped its own schema.

```powershell
$env:KHA41_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55465/kamkmchess_online_test?sslmode=disable'
$env:KHA41_REQUIRE_POSTGRES='1'
$env:KHA66_WORKER_ENTRY=(Join-Path (Get-Location).Path 'build/rules-worker/worker.mjs')
go test -count=1 ./backend/... ./cmd/...
go vet ./backend/... ./cmd/...
```

Both commands passed. Tests cover migrations/grants, competing writers, lost acknowledgements, payload/actor reuse, post-lock deadline expiry, unauthorized expiry attempts, candidate/timeout fencing, consistent snapshots, projection removal and lease constraints.

Parent integration fixtures run the real Node worker through PostgreSQL for checkmate, timeout wins/material draws, exact receipt retries and crash/timeout/malformed-output refusal. Failed requests leave canonical state unchanged and write no accepted receipt.

`pnpm check` passed lint, typechecking, 668 unit tests and both builds. The shared fixture and candidate-result tests cover Go/TypeScript contracts.

An initial broader `go test ./...` / `go vet ./...` encountered an excluded experiment requiring an uninstalled Gin dependency. Production checks use the documented package scope above. Local Windows race-detector execution needs a missing C compiler; Linux CI retains `go test -race` with PostgreSQL and the built worker.

## Handoff

ARC-02, ARC-03 and ARC-04 have local service/database evidence. Authenticated routes, opening clocks and the 15-second reply, full outcomes, subscriptions, queue allocation, agent leases, public history, erasure/retention/restore and staging continue in their dependent tickets. The overall product acceptance matrix remains unmodified.

DeepSeek implemented the slice and most review corrections. Its corrective review hit the free-endpoint rate limit; the parent completed and verified the partial edits.
