# KHA-41 Go API local integration evidence

**Status:** local Go and PostgreSQL checks pass; no full acceptance case is passed by this record.

- Review base: `4208383ef8c3ade88087983e7dfe42647eb774d4` (present in the repository).
- Database: isolated PostgreSQL 17.6 Windows x64 binaries under `.scratch/kha41/postgresql`; local-only cluster on `127.0.0.1:55441`.
- Fixture command:

  ```powershell
  $env:KHA41_TEST_DATABASE_URL = 'postgres://kha41_test@127.0.0.1:55441/kha41_test?sslmode=disable'
  $env:KHA41_REQUIRE_POSTGRES = '1'
  go test ./backend/integration -count=1 -v
  ```

  Or run `scripts/kha41-test.ps1`. Tests create and clean a unique schema per case and apply the checked-in migration. The script fails if PostgreSQL is unavailable in required mode.

Latest observed run on 2026-10-17: all eight top-level PostgreSQL integration tests pass. Authenticated archive tests cover create/commit/fetch, retained and discarded model history, exact event/chunk DTO round-trip, rejection of dangling event references, and payload-free receipt lookup after deletion. The batch endpoint returns the versioned batch directly. `go vet ./backend/... ./cmd/...` and `go test ./backend/... ./cmd/... -count=1` also passed with PostgreSQL required.

| Acceptance case | Local deterministic evidence | Full case status and remaining evidence |
| --- | --- | --- |
| DAT-04 | Actual HTTP API + Clerk-compatible RSA session fixture against PostgreSQL; unauthenticated and foreign-owner reads denied; mismatched namespace and credential-bearing checkpoint rejected; operation and archive owner scopes exercised. | `not_run`. No two real Clerk accounts, deployed direct-write/RLS paths, or hosted RPC review. |
| DAT-05 | Concurrent PostgreSQL CAS and stale epoch/revision write fixture; takeover advances cloud revision and epoch and preserves checkpoint metadata. | `not_run`. No tabs/devices, lock/channel fallback, or stale browser/provider response journey. |
| DAT-09 | Repeated delete, stale create/commit rejection, checkpoint/archive retrieval denial and payload-free operation receipt assertions. | `not_run`. No offline reconnect, real caches, backup rotation, or restore rehearsal. |
| OPS-01 | Go HTTP/storage packages compile through the integration package; migration applied locally. | `not_run`. No locked production build review, Vercel HTTPS route, Clerk callback, CSP/MIME/bundle/network evidence. |

The fixture suite also verifies identical concurrent operation retries, operation lookup after an uncertain acknowledgment, conflicting operation-ID reuse, semantic final-result immutability, exact archive event and chunk item JSON byte round-trip over the authenticated HTTP API, owner-only archive reads, and transaction rollback when duplicate archive sequence insertion fails. The create-time dangling-reference and scrubbed-receipt regressions now pass. These are local database/API checks only.

No provider credentials, hosted database, production Clerk project, live model, external service spending, or browser suite was used. No credentials are present in the test DSN.

## Final build checks

The coordinator ran the production Go checks with PostgreSQL required: `go vet ./backend/... ./cmd/...` and `go test ./backend/... ./cmd/... -count=1` passed. The frontend `corepack pnpm check` passed lint, all 273 tests in 18 files, TypeScript checks, the Vite production build, and distribution notice generation. A process-local Corepack shim directory was prepended to `PATH` so nested pnpm scripts used the pinned pnpm 12.14.0 rather than an older global executable. No package-manager version requirement was relaxed.

## Standards review

An independent GPT-6 Luna agent reviewed the implementation against base `4208383` and found zero actionable documented-standard violations or correctness-relevant code smells. It checked public test seams and the browser/server responsibility boundary.

## Spec review

A separate GPT-6 Luna agent reviewed the same diff against KHA-41 and the amended specification and found zero actionable spec findings. Hosted and native acceptance remains unrun. The reviewers made no implementation edits.
