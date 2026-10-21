# Server deployment

Vercel serves the frontend at `https://chess.khalil.mageed.net`. The Go API is
`https://chess-api.agent.soft-magic.com`. The frontend calls that API directly;
Vercel's `/v1/*` rewrite preserves compatibility with same-origin API clients.
Vercel also runs the stateless `api/provider-relay.ts` Node function for remote
custom AI endpoints that do not support browser CORS, such as Ollama Cloud.
It forwards each request's API key and streams the provider response without
storing or logging either. Public HTTPS destinations on port 443 are checked
and pinned to public DNS addresses; local networks and redirects are rejected.
The same handler runs in Vite development and preview. A static-only `dist/`
deployment cannot serve the relay. No database credential or shared provider
key is needed for this function, and the Go API deployment is unchanged.

The server deployment directory is `/home/agentsoftmagic/kamkmchess`.
Apache owns HTTPS and proxies the API's cPanel document root through
`api.htaccess` to `127.0.0.1:18081`. The API container runs as UID 65532 with a
read-only filesystem. PostgreSQL 16 has no published host port. It is reachable
only through the dedicated Docker network, using SCRAM passwords and verified
TLS for the runtime role. The network alias matches the AutoSSL certificate.
Migrations and backups use a separate administrative role inside the container.

## Online update delivery

Online fetch-SSE uses the configured direct API origin, bypassing Vercel's
compatibility rewrite. See the [online update contract](../docs/architecture/online-updates.md).
The participant `/v1/online/matches/{matchID}/updates` route accepts bearer or
guest credentials in headers and `Last-Event-ID` for reconnects. Keep those
headers allowed only on the online API; private account sync retains its
existing CORS policy.

Before enabling online play, inspect the actual Apache route with an
authorized participant session. Confirm the initial snapshot and heartbeat
comments arrive before the response ends, each stream ends within 20 seconds
or credential expiry, and a renewed stream obtains fresh authorization.
Disable compression or buffering for `text/event-stream` if it delays frames.
Verify the same snapshot through the JSON polling path, denied origins and
revoked membership, then measure concurrent streams against the existing host
and database pool. Go's flush calls and response headers do not prove Apache
delivery or hosting capacity. Record these checks in KHA-83 before rollout.

## Build and start

Build static Linux amd64 binaries from the repository using Go 1.26 or newer.
The following commands use a POSIX shell; in PowerShell set the equivalent
`GOOS`, `GOARCH`, and `CGO_ENABLED` environment variables before building.

```sh
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o bin/kamkmchess-api ./cmd/server
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o bin/kamkmchess-migrate ./cmd/migrate
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o bin/khabackup ./backend/backup/cmd/khabackup
```

Upload the deployment files and `bin/` into the private server directory. Upload
`api.dockerignore` as `.dockerignore`. The API and database subdomains must
already exist in cPanel with AutoSSL enabled. Place `api.htaccess` in
`/home/agentsoftmagic/public_html/chess-api/.htaccess`. No credentials or
deployment binaries belong in that document root.

```sh
python3 bootstrap-secrets.py
python3 sync-postgres-tls.py
docker compose -f postgres.compose.yml up -d --wait
python3 provision-runtime.py
docker compose -f postgres.compose.yml -f api.compose.yml up -d --build --wait
```

`postgres.env`, `runtime.env`, `api.env`, and `backup.env` have mode 0600 and
remain on the server. Provisioning preserves existing credentials. The runtime
role can read and mutate only the application tables; it cannot own the
schema, create roles or databases, or bypass row security. The API uses a pool
of at most four connections. A browser build receives only the three public
`KAMKM_PUBLIC_*` settings from `.env.example`.

## The durable restore fence

A restore replaces the schema of the target database. A fence inside that
schema would be replaced with it, so a crash between the import and the
replay of the removal ledger would leave the restored database with the old
ledger and nothing inside it to say so. The fence therefore lives outside the
database, in a marker directory that the restore writes before it imports
anything and that it removes only after the newest merged removal ledger was
replayed and verified.

The deployment wires it as one shared volume:

- the database service mounts `restorefence` at
  `/var/lib/kamkmchess/restore-fence`, read-write, because the restore
  command writes and clears the fence there;
- the API service mounts the same volume at the same path, read-only, because
  the service only reads it;
- both services receive
  `ONLINE_RESTORE_FENCE_PATH=/var/lib/kamkmchess/restore-fence`.

The setting names the **parent** of the fence, not a file. The restore writes
the owner of the fence into `<parent>/restore-fence/owner` and takes the
sibling `<parent>/restore-fence.lock`. The service does **not** read that
owner marker: its admission check only *observes* the marker directory
`<parent>/restore-fence`, and it refuses to serve while that directory
exists.

Beside the marker directory the parent holds a second directory,
`<parent>/restore-requirements`, with the **durable evidence of the removal
ledger every restore owed**. The import of a restore replaces the schema of
the target database, so a removal that only the live database carried is
destroyed by the import itself; the evidence of that removal lives outside
the database, is written and flushed before the import starts, and holds the
one-way references of the removed subjects and never an identifier. The
directory is created by the service with mode `0700` and the records in it
with mode `0600`, so only their owner reads them.

The evidence is **never cleaned by hand**. It is the proof that a crashed
restore owed a removal, and the next restore discharges it when the removal
is applied; the newest record is retained on purpose, because it is the
evidence that the last restore closed the fence it owed. The directory
belongs in the backup of the deployment: a restore of a database without the
evidence of the pending restores cannot replay the removals they owed. The
restore procedure is in
[`MVP-operations.md`](../docs/implementation/MVP-operations.md): the API is
stopped and drained, the restore is run, and a restore that crashed is
recovered with `khabackup recover` or continued with `--takeover`. The runbook in
[`MVP-operations.md`](../docs/implementation/MVP-operations.md) names the same
parent, and the proof below compares the runbook, this note and the rendered
compose configuration, so the three cannot drift apart again.

A path below the parent is a *different* fence: a restore that holds it
leaves the service serving during the import, because the service never sees
an open fence.

The volume must be the same volume for both services and it must outlive a
container restart. A container-local file, a path inside the database schema
or a path the two services do not share is not a fence: the service would
never see an open fence and would serve a restored copy whose removal ledger
was not applied.

The restore command runs inside the database container, so the setting is
configured for that service as well, and the documented restore command names
the fence path explicitly. The restore also has to run as the user the API
observes the fence as: the marker directory is private to its owner, and the
API refuses every request while it cannot observe it. The secret file of the
restore stays
private as well: the shell of the container reads it as root and hands the
values to the restore through the environment, so the restore user never
reads a file it may not read.

```sh
node verify-fence-access.mjs      # proves the access with two throwaway containers
```

The proof writes a fence with the modes the restore uses, in a container that
runs as the database user, and reads it from the same volume as the API user.
It also proves that the fence the runbook opens is the fence the service
reads: the volume is mounted at the path of the configuration and at the path
the runbook names, and the service has to see the marker the runbook wrote.
The comparison covers the **volume** and not only the path: the two services
have to mount the same named volume at the configured path, the API service
read-only and the database service writable. A configuration that mounts
another volume is rendered as well and has to be refused.
At the moment it **passes**: the fence is written by the API user, so it is
readable without loosening the mode; the fence code owns the mode and the
deployment owns the user.

The server must load `ONLINE_RESTORE_FENCE_PATH` into its online configuration.
`node scripts/online/service-wiring.mjs` reports it as a blocker while the
setting is not read, so a configuration that silently disables the fence
cannot pass the release gates.

## Runtime grants and the private rules runtime

`runtime-grants.policy.json` lists the privileges of the runtime role table by
table. It is explicit: there is no blanket grant, no default privilege and no
grant on a table the application does not use.

```sh
node runtime-grants.mjs --check      # the policy against the migrations and the writer
node runtime-grants.mjs --propose     # the entries a new migration still needs
node runtime-grants.mjs --emit       # the SQL an operator reviews and runs
node runtime-grants-probe.mjs        # the same grants executed against a real PostgreSQL
```

The check fails when a migration creates a table the policy does not cover,
when the writer uses a verb the policy does not grant, when the policy grants
a verb the writer never uses, and when a migration grants privileges of its
own outside the reviewed policy.

The probe creates a throwaway role and schema in a local database, applies the
migrations and the grants, and then executes real statements as that role:
reads, inserts, updates and deletes on every table the policy covers, and the
refusals on every table it does not. A granted privilege is proven, not
assumed.

### The image carries the private rules runtime

The API image is built on the pinned Node 24 runtime and carries the private
rules bundle. The Go match authority runs the bundle as a child process; it
has no public endpoint, no provider access and no database access.

```sh
pnpm build:rules-worker                 # build/rules-worker/worker.mjs
cp build/rules-worker/worker.mjs build/rules-worker/LICENSE.txt \
   build/rules-worker/THIRD_PARTY_NOTICES.txt deploy/rules-worker/
node verify-runtime-image.mjs           # build and inspect the image locally
```

`verify-runtime-image.mjs` builds the image from the deploy context and proves
the runtime composition inside it: the pinned Node version, the bundle at its
configured entry path, a real protocol request answered by the worker, the
non-root user and the absence of any credential file. It builds and inspects a
local image only. It never pushes and never deploys.

The `tools/onlinefixture` helper is behind the `onlinefixture` build tag and
never ships in a production binary.

## Backups and certificates

`backup.sh` creates and authenticates encrypted daily and weekly logical
exports, retaining seven daily and four weekly bundles. It uses the matching
PostgreSQL 16 tools in the database container. The daily cron entry runs the
certificate sync first, then the backup, and appends results to `operations.log`.
`sync-postgres-tls.py` follows certificate cross-signatures, verifies the full
chain and hostname, and reloads PostgreSQL after an AutoSSL renewal. The API's
public certificate is managed directly by cPanel.

The backup passphrase is in the server's private `backup.env`. An operator
recovery copy and encrypted bundles are kept outside the server under
`~/.config/kamkmchess/`. Keep that recovery directory private. The local copy is
an initial recovery copy, not a continuously synchronized offsite backup.

To run a backup or inspect service state:

```sh
./backup.sh
docker compose -f postgres.compose.yml -f api.compose.yml ps
docker compose -f postgres.compose.yml -f api.compose.yml logs --tail=50 api
```

Restore into a separate database first. Initialize it with the migration binary,
then run `khabackup restore` inside the PostgreSQL container, using a process
environment with that database's URL and the escrowed passphrase. Include newer
daily bundles with `--newer-ledger` so an old weekly export cannot resurrect
deleted games. Never point a rehearsal at the live database. The detailed
container format and recovery contract are in
[`MVP-operations.md`](../docs/implementation/MVP-operations.md).

## Identity and release checks

Clerk application `app_3KsNBjdK2nyfmuRJ4gnk8z2LwhB` has separate development
and production instances. The production issuer is
`https://clerk.chess.khalil.mageed.net`. Its frontend, account portal, and mail
DNS records are in the delegated `khalil.mageed.net` zone. Email code sign-in
is enabled. Google sign-in uses a dedicated web OAuth client named
`Kamkm Chess production` in Google Cloud project `wise-reporter-479504-e5`.
Its authorized origin is `https://chess.khalil.mageed.net` and its callback is
`https://clerk.chess.khalil.mageed.net/v1/oauth_callback`. It requests only
OpenID, email and basic profile scopes. The public privacy policy is
[`https://chess.khalil.mageed.net/privacy.html`](https://chess.khalil.mageed.net/privacy.html),
with its source in `public/privacy.html`. The Account screen links to it.

Release verification covers real Clerk sessions, isolated owners, create/read,
atomic commits and idempotent retries, takeover epochs, stale-write rejection,
deletion, denied origins, missing credentials, HTTPS, and backup restoration.
Evidence for this deployment is recorded in
[`server-deployment.md`](../docs/evidence/server-deployment.md).
