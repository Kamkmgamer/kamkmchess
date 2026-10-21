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

Current honest result: the export covers the whole database and the game
deletion ledger is reapplied, but the **online removal markers are not
reapplied** by the restore command. An online replay whose erasure was
requested can therefore come back with an old bundle. That is an open blocker
for the online release, not a passing check.

## Release gates

```sh
pnpm run online:gates               # the friend gate
node scripts/online/feature-gates.mjs evaluate --gate queue
pnpm run online:packet               # the reversible friend rollout packet
```

A gate is open only when every requirement is met: a recorded owner decision,
a recorded opt-in cohort, a host verification record, a passing backup
coverage check, a passing runtime grant check, and passing evidence for every
scenario of the gate.

The queue gate additionally requires an accepted friend cohort run. The queue
adds no owner game cap.

The packet is a review document. It names the configuration change, the
monitoring, the rollback and the blast radius, and it never applies anything.
Rollback is reversible: closing a switch stops new creations and leaves
running matches and their results untouched.

## Evidence

```sh
pnpm run online:evidence             # rebuild docs/evidence/online/ledger.json
pnpm run online:integration          # run the local suite and record the evidence
```

A record names the scenario, the status, the evidence kind, the tested commit,
the exact command, the expected behaviour and the observed result. The ledger
refuses a record without those fields, refuses a second contradicting record,
and refuses to let a local run close a native scenario.

The approved contract in `docs/spec/online-play-acceptance.json` is read-only.
The ledger never edits it.

## Production wiring

```sh
pnpm run online:wiring
```

The audit proves that the server, not the browser, owns the rollout: the
feature route is served from the production composition, both server switches
are read, and an unset switch leaves the surface closed. A tree that only has
browser flags fails this audit.

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
