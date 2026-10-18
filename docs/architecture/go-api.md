# Go API and PostgreSQL

The Go service is an owner-scoped persistence API for optional account sync. The browser remains responsible for chess rules, clocks, results, provider requests, and AI credentials. The service verifies Clerk session tokens and uses the verified `sub` as the PostgreSQL owner key. It does not relay provider requests.

## Local run

The service reads `DATABASE_URL`, `CLERK_ISSUER`, `CLERK_JWKS_URL`, `CLERK_AUTHORIZED_PARTIES`, and `APP_ALLOWED_ORIGINS`. `DATABASE_URL` is a PostgreSQL URL. The party and origin settings are comma-separated lists. Configure secrets in the local process environment; do not put credentials in checkpoints, archives, or source control. Run the service from the repository root with:

```powershell
$env:DATABASE_URL = 'postgres://app_user:password@127.0.0.1:5432/kamkmchess?sslmode=disable'
$env:CLERK_ISSUER = 'https://your-clerk-issuer'
$env:CLERK_JWKS_URL = 'https://your-clerk-issuer/.well-known/jwks.json'
$env:CLERK_AUTHORIZED_PARTIES = 'http://localhost:5173'
$env:APP_ALLOWED_ORIGINS = 'http://localhost:5173'
go run ./cmd/server
```

Apply the schema before starting the server with `go run ./cmd/migrate`, using a migration role in `DATABASE_URL`. The command applies the embedded checked-in migrations in a transaction and tracks applied versions in `kamkmchess_schema_migrations`. Then set `DATABASE_URL` to the runtime role and run the server. `storage.Open` does not alter the schema. The runtime role needs only the required schema/table access; it should not own the database or have superuser privileges. Supply role credentials through deployment secrets.

## HTTP contract

All routes are under `/v1`. Requests require `Authorization: Bearer <Clerk session token>` and an allowed `Origin`. Responses use JSON, `Cache-Control: no-store`, and never expose the owner ID. JSON request bodies reject duplicate keys, unknown top-level fields, trailing data, and bodies larger than 8 MiB. Error bodies have the form `{"error":"code"}`.

| Method and route | Request | Success |
| --- | --- | --- |
| `GET /v1/games?limit=&after=` | Optional page cursor | `200 {games,next}` |
| `POST /v1/games` | `{"gameId":"…","checkpoint":{…}}` | `201` game DTO |
| `GET /v1/games/{gameID}` | None | `200` game DTO |
| `POST /v1/games/{gameID}/commit` | `{"operationId":"…","expectedRevision":1,"expectedEpoch":1,"checkpoint":{…},"archiveBatch":{…}}` | `200 {game,operation,duplicate}` |
| `POST /v1/games/{gameID}/takeover` | `{"expectedRevision":1,"expectedEpoch":1}` | `200` game DTO |
| `DELETE /v1/games/{gameID}` | `{"expectedRevision":1,"expectedEpoch":1}` | `204` |
| `GET /v1/games/{gameID}/operations/{operationID}` | None | `200` accepted receipt |
| `GET /v1/games/{gameID}/archives?after=&limit=` | Optional sequence cursor | `200 {archives,nextAfter}` |
| `GET /v1/games/{gameID}/events?after=&limit=` | Optional sequence cursor | `200 {events,nextAfter}` |
| `GET /v1/games/{gameID}/archive-batch` | None | `200` complete archive batch |

The game DTO is `{id,revision,epoch,checkpoint,createdAt,updatedAt}`. `checkpoint` is embedded as JSON. A commit atomically advances the cloud revision by one, accepts a strictly increasing local checkpoint revision, validates the current ownership epoch, stores the checkpoint plus any event/chunk records, and records an idempotent operation receipt. A takeover advances cloud revision and epoch while preserving the last acknowledged checkpoint bytes and its local revision/epoch. A final result cannot change, though non-result checkpoint state can advance.

`archiveBatch` has format `kamkmchess.cloud-archive-batch`, schema version `1`, game and base revision/epoch metadata, checkpoint revision, event/chunk sequence range receipts, and `events` and `chunks` arrays. Each event/chunk item is a raw versioned DTO. The request parser retains the exact bytes of each item; `GET …/archive-batch` returns the complete versioned batch directly as JSON. The API does not canonicalize item DTO JSON. Chunk DTOs carry base64 provider bytes and an inner payload SHA-256. Event payload fields are untrusted content and are not recursively interpreted as application configuration. Checkpoint fields and substructures are validated. Browser controller extensions are opaque `{version,data}` sections with positive safe-integer versions; credential-bearing field names are rejected recursively. The browser additionally checks configured credential values before upload. Local history segments use a null provider/model/revision triple; model segments require a complete binding.

Deletion removes checkpoint and archive payloads, scrubs operation response payloads, and retains only payload-free tombstone/receipt data needed to prevent stale resurrection and support idempotent deletion. Reads and mutations are scoped to the verified owner.

## PostgreSQL fixture

For a generic local PostgreSQL install or Docker PostgreSQL, create a disposable database and a least-privileged test role with permission to create/drop schemas for the integration fixture. Set `KHA41_TEST_DATABASE_URL` to that database URL and `KHA41_REQUIRE_POSTGRES=1`, then run:

```powershell
go test ./backend/integration -count=1 -v
```

Each test creates a uniquely named schema, applies the checked-in storage migration inside that schema, and drops only its own schema during cleanup. The repository's `scripts/kha41-test.ps1` is a convenience wrapper for the isolated local PostgreSQL 17.6 cluster described in `docs/implementation/KHA-41-go-evidence.md`; no untracked executable is needed to follow the generic fixture instructions.

Local deterministic integration checks establish HTTP/API and PostgreSQL fixture behavior only. Hosted Clerk configuration, deployed access control, real multi-device behavior, backup restoration, browser acceptance, and HTTPS deployment evidence require separate runs. Hosting/deployment acceptance belongs to KHA-44.
