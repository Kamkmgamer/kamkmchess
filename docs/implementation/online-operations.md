# Online operations runbook

Operations material for the online service: the local fixture, the
least-privilege runtime grants, the backup coverage and removal ledger, the
release gates and the recorded evidence.

Nothing in this runbook deploys anything, turns a feature on or authorizes a
release. The owner decides; the tools only make the decision reviewable.

## Local fixture

The fixture is the real service composition — the Go API, a real PostgreSQL
schema, the pinned private rules worker and the real authorization code — on
loopback, with its own signing key.

```sh
pnpm run online:fixture            # start it and print the descriptor path
pnpm run online:fixture -- --stop .scratch/onlinefixture/descriptor.json
pnpm run online:fixture -- --clean
```

- The helper is behind the `onlinefixture` build tag. A normal `go build ./...`
  never compiles it, and the deployed API image never contains it.
- It creates an isolated schema, applies the checked-in migrations to it and
  drops the schema when it stops.
- It serves its own JWKS document over HTTPS on `127.0.0.1`, so the API's own
  verifier runs its real path and no hosted identity provider is contacted.
- The synthetic session tokens live in the ignored descriptor file. They are
  never committed and never printed.

The fixture enables the friend surface for the run (`ONLINE_FRIEND_ENABLED`)
and leaves the queue closed, so a run cannot reach the public queue by
accident. The queue is opened for a run that needs it with
`pnpm run online:fixture -- --queue-enabled`.

## Signed-in account build

The account surfaces need a signed-in browser. The hosted identity provider is
not reachable from a local run, so a fixture run uses a synthetic account
session. The seam is a test build only.

```sh
# 1. the fixture of the run (its descriptor holds the base URL and the accounts)
pnpm run online:fixture -- --queue-enabled

# 2. the account build of that fixture
export KAMKM_BUILD_FLAVOR=fixture
export KAMKM_PUBLIC_ACCOUNTS_ENABLED=true
export KAMKM_PUBLIC_TEST_SESSION=true
export KAMKM_PUBLIC_API_BASE_URL=http://127.0.0.1:<the port of the descriptor>
node scripts/prepare-engines.mjs
npx vite build

# 3. the rendered signed-in cases
export ONLINE_FIXTURE_DESCRIPTOR=.scratch/onlinefixture/descriptor.json
export ONLINE_FIXTURE_STRICT=1
npx playwright test tests/e2e/account-online.spec.ts
```

- `KAMKM_PUBLIC_TEST_SESSION` is refused unless `KAMKM_BUILD_FLAVOR=fixture`.
  An ordinary release build never carries the flag, and the branch that loads
  the bridge is removed from its bundle, so the bridge is not in an ordinary
  build at all.
- The bridge carries no credential. The page receives the identity and its
  session token at run time:
  `window.__KAMKM_TEST_SESSION__ = { accountId, token }`. The token is minted
  for the run with the fixture's own signing key, so the service verifies it
  with its ordinary code path. No API check is bypassed and no token is
  printed.
- A running page changes its signed-in account with the
  `kamkm:test-session` window event:
  `window.dispatchEvent(new CustomEvent('kamkm:test-session', { detail: { accountId, token } }))`.
  The change fences the work of the departing account and restores the
  durable games of the next one.
- The bridge refuses to act for a service that is not the loopback fixture, so
  it can never weaken the authorization of a hosted service.
- The rendered cases live in `tests/e2e/account-online.spec.ts`. They skip
  without a descriptor and fail with `ONLINE_FIXTURE_STRICT=1` and no
  descriptor.


## Least-privilege runtime grants

The policy is explicit: one list of privileges per table, no blanket grant and
no default privilege.

```sh
pnpm run grants:check               # the policy against the migrations and the writer
pnpm run grants:probe               # the same grants executed against a real PostgreSQL
node deploy/runtime-grants.mjs --emit   # the SQL an operator reviews and runs
```

`grants:check` fails when a migration creates a table the policy does not
cover, when the writer uses a verb the policy does not grant, or when the
policy grants a verb the writer never uses.

`grants:probe` creates a throwaway role and schema in a local database,
applies the migrations and the grants, and then executes statements as that
role. It proves that the role can do exactly what the policy says: read and
write the allowed tables, never delete from an append-only table, never read a
table outside the policy, and never create, drop or grant.

The probe needs `psql` on the path, or it runs `psql` inside the local
fixture container.

## Backup coverage and the removal ledger

```sh
pnpm run online:backup
```

The audit reports whether the export covers the whole database, whether the
restore reapplies the deletion ledger, and whether the newest removal ledger
is applied before a restored copy serves traffic. It prints the runbook hooks
an operator follows for a restore.

Current honest result: the export covers the whole database, and the restore
reapplies the game deletion ledger, the online removal ledger and the subject
level removal ledger. The replay happens after the import of the export and
before the restore gate is released, so a restored copy cannot serve a removal
that was not replayed.

The audit reads the restore path itself and follows its calls. It does not
search the text of the package for the name of the replay method, because the
interface of the removal sink carries that name even when the restore never
calls it. A restore that stops replaying the ledger is reported as
`online-removal-ledger-uncovered`, the run fails, and the release gate does not
report the backup coverage as met.

What this audit does **not** prove: it reads the repository only. It restores
nothing, it connects to no hosted database and it certifies no rehearsal. The
reapply of the ledger on a real host is proven by the host record and by the
native restore proof, not by this audit.

## The enforced account cohort

The two cohort settings are **server** settings of the API process. They are
read once, when the process boots, so a change of either one needs a restart
of the API container. The rollout packet says the same for the two switches.

| Setting | Surface | Default | Meaning |
| --- | --- | --- | --- |
| `ONLINE_FRIEND_COHORT` | friend | empty | Comma-separated account identifiers allowed to use friend play. Empty admits every signed-in account. |
| `ONLINE_QUEUE_COHORT` | public queue | empty | Comma-separated account identifiers allowed to use the public queue. Empty admits every signed-in account. |

- An account identifier of a cohort is the **opaque account subject** of a
  signed-in account, for example the Clerk user id (`user_2abc…`) that the
  session token carries in its `sub` claim. A public username is not an
  account identifier: a cohort of usernames matches no account, so it admits
  nobody while the guests stay admitted. The identifier is private, it is
  read from the verified session, and it never appears in a public answer.
- A cohort is an allowlist of **accounts**. It narrows the account access of
  its surface and nothing else. An account that the cohort does not name is
  refused with `403 not_authorized` before the service is reached, so the
  refusal never reveals whether an invitation or a queue entry exists.
- A cohort **never excludes a guest**. A guest can still create a friend link
  and can still finish an invitation that was issued while friend play was
  enabled. The public queue is account-only in any case.
- A cohort does not end a match. The participant surface keeps serving a
  match that already exists, so a narrowed account keeps its running game.
- A cohort does not strand an invitation. The owner of an invitation keeps
  the preview and the cancellation of the invitation it owns, because the
  owner token of the invitation is the proof of that ownership. Every other
  route of the surface stays refused for the excluded account.

The audit of the enforcement:

```sh
node scripts/online/cohort-enforcement.mjs --gate friend
node scripts/online/cohort-enforcement.mjs --gate queue
node scripts/online/cohort-enforcement.mjs --gate friend --json
```

The audit has two parts and both of them have to hold. The executable part
runs the enforcement tests of the tree (`TestTheCohort*` in
`./backend/cohort/`, `./backend/httpapi/` and `./backend/serverapp/`) and
requires every one of them to report a pass; a tree without those tests, a
missing toolchain, a failed run, a run that exceeded its budget and a test
that did not run are all blockers. The proof of the wiring is part of that
run: `backend/serverapp/cohort_wiring_test.go` reads the composition
`backend/serverapp/server.go` with the parser of Go, proves that the setting
reaches the request path of the surface and prints the marker
`COHORT-WIRING <surface>=proven` for every surface it proved. The audit
requires the marker of every surface of the gate, so a composition that lost
the wiring and a tree without the proof are blockers as well. The queue gate
covers both surfaces, because the queue needs the friend cohort to have run.

`scripts/online/feature-gates.mjs` reports the audit as the requirement
`cohort-enforcement` of both gates, and it is a requirement of its own. The
requirement `cohort` is the **recorded** cohort of the gate. The requirement
`runtime-cohort` is the measurement of the cohort of the running server, and
it stays unmet while the host record does not name the runtime cohort or
names another one. The gate stays blocked until the audit observed the
enforcement, and the gate runs the audit itself, so `pnpm run online:gates`
includes it.

### The protected cohort input

The account subjects of a cohort are private, so they live in one protected
operator input and not in the evidence tree:

```sh
# the protected input of the friend gate (the directory is ignored by git)
mkdir -p .secrets/online-cohort
# {"accounts": ["<the opaque account subject>"]}
printf '%s\n' '{"accounts": ["<the opaque account subject>"]}' > .secrets/online-cohort/friend-cohort.json
```

The file names at least one account: a protected input that names none is an
invalid input and the gate stays blocked.

The gate reads the subjects of that file, compares them with the recorded
cohort through their commitment, and never reports one of them. A file inside
the tracked tree is refused instead of read, so the protected input lives in
`.secrets/`, in `.scratch/` or outside the tree. Another path is named with
`--cohort-input <path>`.

A run without the protected input keeps the gate blocked, so a continuous
integration run never opens a surface: the recorded cohort is operator
material, not public material.

The **commitment** of a set is the SHA-256 digest of its canonical form: every
identifier trimmed, the empty ones dropped, the rest deduplicated and sorted
by code unit. The algorithm is `sha256-canonical-set-v1`, the value is
`sha256:<hex>` and the count is the number of accounts of the set. The tool
prints the commitment of a set and never a subject:

```sh
node scripts/online/cohort-commitment.mjs --input .secrets/online-cohort/friend-cohort.json
node scripts/online/cohort-commitment.mjs --env ONLINE_FRIEND_COHORT --json
```

The operator records the commitment and the count of the recorded cohort in
`docs/evidence/online/release-decisions/<gate>-cohort.json`, and the
commitment and the count of the measured cohort of the running server in the
`cohort` field of `docs/evidence/online/KHA-83-host.json`:

```json
{
  "algorithm": "sha256-canonical-set-v1",
  "commitment": "sha256:9f2c…",
  "count": 3
}
```

The gate recomputes the commitment of the protected input and compares it
with the commitment of the host record. The two commitments are equal exactly
when the two sets of accounts are equal, so a host that carries another
member, another count or another set keeps the gate blocked. A recorded
evidence or a host record that carries raw account subjects instead of a
commitment is an unmet requirement, never a cohort.

The count is part of the record on both sides: the recorded evidence and the
host record have to carry the commitment **and** the count of their set. A
record that carries the commitment and no count has not recorded the size of
the set, and a count that is not a positive integer is no count at all, so an
absent count, a malformed count, a zero and a negative count are all unmet
requirements and the gate stays blocked.

The audit reads the repository and runs the tests of the tree. It proves
nothing about a deployed host, it turns nothing on and it authorizes no
release. The implementation of the settings is recorded in
[online-cohort-enforcement.md](online-cohort-enforcement.md).

## Release gates

```sh
pnpm run online:gates               # the friend gate
node scripts/online/feature-gates.mjs evaluate --gate queue
pnpm run online:packet               # the reversible friend rollout packet
```

A gate is open only when every requirement is met: a recorded owner decision,
a recorded opt-in cohort, the enforced account cohort, a host verification
record, a passing backup coverage check, a passing runtime grant check, and
passing evidence for every scenario of the gate.

The queue gate additionally requires an accepted friend cohort run. The queue
adds no owner game cap.

The packet is a review document. It names the configuration change, the
monitoring, the rollback and the blast radius, and it never applies anything.
It names the cohort setting, the count and the commitment of the cohort, and
never an account subject of it: the subjects live in the protected operator
input and belong in the server configuration. Rollback is reversible: closing
a switch stops new creations and leaves running matches and their results
untouched.

### The accepted friend cohort run

The run of the friend cohort is recorded in
`docs/evidence/online/KHA-84-friend-run.json`, and the file is not the run. The
record names the outcome of the run, the acceptor, the date, the tested commit
and the cohort the run covered:

```json
{
  "status": "accepted",
  "acceptedBy": "<the owner who accepted the run>",
  "acceptedAt": "<the date of the acceptance>",
  "commit": "<the tested commit of the run>",
  "cohort": {
    "algorithm": "sha256-canonical-set-v1",
    "commitment": "sha256:9f2c…",
    "count": 3
  }
}
```

The cohort of the record is the recorded friend cohort of
`docs/evidence/online/release-decisions/friend-cohort.json`, and the two are
compared by their algorithm, their commitment and their count. A missing
record, a record that is not JSON, an empty record, a record of another
outcome, a record without an acceptor, a date or a commit, a record of another
cohort and a record that carries the account subjects of the cohort are all
unmet requirements. The gate never reports an accepted run it did not read.

## Evidence

```sh
pnpm run online:evidence             # rebuild docs/evidence/online/ledger.json
pnpm run online:integration          # run the local suite and record the evidence
```

A record names the scenario, the status, the evidence kind, the tested commit,
the exact command, the expected behaviour and the observed result. The ledger
refuses a record without those fields, refuses a second contradicting record,
and refuses to let a local run close a native scenario.

A record is a claim, so the ledger checks it against the run that produced
it. A record that claims a pass or a partial observation is only evidence when
a run source recorded the scenario **at the very commit the record names**;
otherwise the record is refused, the scenario keeps no evidence, and the
ledger exits with a non-zero status and says why. The run source of the local
evidence is `docs/evidence/online/KHA-80-integration.json`, and the native,
host, live and owner kinds have no registered run source yet, so a record of
those kinds closes nothing. The rules are in
`scripts/online/evidence-provenance.mjs` and the contract is in
[docs/architecture/online-operations-contract.md](../architecture/online-operations-contract.md).

The approved contract in `docs/spec/online-play-acceptance.json` is read-only.
The ledger never edits it.

## Route manifest

```sh
node scripts/online/route-manifest.mjs                 # the manifest and its coverage
node scripts/online/route-manifest.mjs --base-url URL  # the same, with a live probe
```

`scripts/online/online-routes.json` is the route contract of the tooling. The
manifest is not provisional: every route in it is registered by the production
code, and the tooling verifies that claim against the repository.

- A route the production code does not register is reported as
  `not_implemented`. The run fails and the route is never counted as a passed
  acceptance scenario.
- The dependency of a scenario on a route is read from the tests of the
  scenario, so a scenario whose route is missing is reported as
  `not_implemented` instead of passed.
- A closed surface answers 404. The tooling reads `GET /v1/online/features`
  first and reports a closed surface as `disabled`, never as a passed scenario.
- The live probe reads only the routes that read. A route that writes is not
  probed, because a probe of it would change the state the probe observes.

The route contract is stated in
`docs/architecture/online-operations-contract.md`, and the two have to agree.

## Production wiring

```sh
pnpm run online:wiring
```

The audit proves that the server, not the browser, owns the rollout: the
feature route is served from the production composition, both server switches
are read, and an unset switch leaves the surface closed. A tree that only has
browser flags fails this audit.

## A planned restart of the API

A restart of the API is an interruption, and the interval of the interruption
has to be known before the service stops. The private operator command
`khasuspend` announces it, and the deployment runbook names the exact
commands in
[`MVP-operations.md`](MVP-operations.md#a-planned-restart-of-the-api).

```sh
go run ./backend/online/cmd/khasuspend plan    --database-url-env DATABASE_URL
go run ./backend/online/cmd/khasuspend recover --database-url-env DATABASE_URL
go run ./backend/online/cmd/khasuspend abort   --database-url-env DATABASE_URL
go run ./backend/online/cmd/khasuspend status  --database-url-env DATABASE_URL
```

The command reads the database url only from the environment variable that
the operator names. It has no public route, because a route that closes the
durable gate would be an unauthenticated way to stop the service.

## Load

```sh
pnpm run online:load -- --clients 20 --duration 20
```

The traffic is synthetic and local. The report records the request rate, the
latency percentiles, the database connections the service holds and the
behaviour of a slow reader on the finite stream. It is not a capacity claim
and it says so.

## What this runbook does not cover

- Native assistive-technology runs on real Windows, macOS, iOS and Android
  devices. They need the devices and the recorded versions.
- Live host measurements: Apache flushing, TLS, CORS, delivered CSP, the
  private worker reachability and the hosting capacity.
- The owner release decisions. They are the owner's, and they are recorded
  separately.
