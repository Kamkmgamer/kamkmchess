# Online tooling

The tooling of the online play service: the local fixture, the operations
audits, the release gates and the evidence ledger.

Nothing here deploys anything, turns a feature on or authorizes a release.
The owner decides; the tools only make the decision reviewable. The runbook of
the operations is [docs/implementation/online-operations.md](../../docs/implementation/online-operations.md).

## The scripts

- `fixture-server.mjs` — starts, stops and describes the local fixture. It
  prints the path of the descriptor of the run.
- `fixture-client.mjs` — the shared helpers of the tooling: the name of the
  descriptor environment variable and the redaction of a database URL.
- `integration-suite.mjs` — runs the Go integration suite against a real
  PostgreSQL schema and the pinned rules worker, maps the results onto the
  approved acceptance scenarios and records the evidence. `--browser` adds the
  browser clients.
- `load-suite.mjs` — synthetic local load against the fixture.
- `backup-coverage.mjs` — the audit of the backup coverage and of the removal
  ledger.
- `restore-proof.mjs` and `restore-interruption-proof.mjs` — the proofs that a
  restore of the backup really works, including the interrupted one.
- `cohort-enforcement.mjs` — the audit of the enforcement of the account
  cohorts. It runs the enforcement tests of the tree and reads the
  composition that passes the cohort into the request path of the surface.
- `feature-gates.mjs` — the release gates and the reversible rollout packet.
- `release-gate-guard.mjs` — the assertion of the continuous integration that
  both release gates stay blocked. It evaluates the friend gate and the public
  queue gate, and it fails when a gate is ready or when the evaluator of a
  gate fails.
- `evidence-ledger.mjs` — rebuilds the evidence ledger of the online play.
- `service-wiring.mjs` — the audit that proves the server, and not the
  browser, owns the rollout.
- `acceptance-map.json` and `browser-map.json` — the maps from an acceptance
  scenario to the tests that exercise it.
- `online-ops.test.mjs` — the own suite of the tooling:
  `node --test scripts/online/online-ops.test.mjs`.

## The evidence ledger and the provenance of a record

`scripts/online/evidence-ledger.mjs` rebuilds the ledger of the acceptance
scenarios. A record is a claim, and the ledger only counts a claim that a run
source backs:

- a record that claims `passed` needs a run source that recorded the scenario
  at the very commit the record names, and that recorded it as passed;
- a record that claims `partial` needs a run source that recorded the
  scenario at that very commit;
- a record that claims `failed` or `blocked` needs no run source, because it
  never opens a gate and it can only lower the status of a scenario;
- a record that names another command than the run source is refused;
- the native, host, live and owner kinds have no registered run source yet, so
  a record of those kinds closes nothing and the kinds fail closed.

The run source of the local evidence is
`docs/evidence/online/KHA-80-integration.json`: the database run carries the
coverage of the scenarios and the browser run carries the cases of the
browser map. The browser map names the cases that exercise a scenario but
carries no statement that they cover the whole approved scenario, so the
browser evidence closes a scenario only when the map states a complete
coverage.

A refused record is listed in `invalidRecords`, the scenario keeps no
evidence, and the ledger exits with a non-zero status. The rules live in
`scripts/online/evidence-provenance.mjs`, and the tests of the rules are in
`evidence-provenance.test.mjs`.

## The cohort enforcement audit

`scripts/online/cohort-enforcement.mjs` audits whether the server really
narrows the account access of a surface. It audits one gate per run:

```sh
node scripts/online/cohort-enforcement.mjs --gate friend
node scripts/online/cohort-enforcement.mjs --gate queue
node scripts/online/cohort-enforcement.mjs --gate friend --json
```

The audit has two parts and both of them have to hold. The executable part
runs the enforcement tests of the tree (`TestTheCohort*` in
`./backend/cohort/`, `./backend/httpapi/` and `./backend/serverapp/`) and
requires every one of them to report a pass. A tree without those tests, a
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
requirement `cohort` is the **recorded** cohort of the gate, and the
requirement `runtime-cohort` is the measurement of the cohort of the running
server. A gate stays blocked until the audit observed the enforcement.

The account subjects of a cohort are private, so they live in one protected
operator input outside the tracked tree
(`.secrets/online-cohort/<gate>-cohort.json`, ignored by git), and the
evidence tree carries only the commitment and the count of the set. The two
cohorts are compared by their commitment, so no account subject of either
side reaches a report, a packet or stdout.

The count is part of the record on both sides: the recorded evidence and the
host record have to carry the commitment and the count of their set. A record
that carries the commitment and no count has not recorded the size of the set,
and a count that is not a positive integer is no count at all, so an absent
count, a malformed count, a zero and a negative count are all unmet
requirements and the gate stays blocked.

```sh
node scripts/online/cohort-commitment.mjs --input .secrets/online-cohort/friend-cohort.json
node scripts/online/cohort-commitment.mjs --env ONLINE_FRIEND_COHORT --json
```

The audit reads the repository and runs the tests of the tree. It proves
nothing about a deployed host, it turns nothing on and it authorizes no
release.

## The accepted friend cohort run

The queue gate requires an accepted friend cohort run, and a file at the
recorded path is not a run. The record has to name the accepted outcome, the
acceptor, the date, the tested commit and the cohort of the run, and the
cohort of the run has to be the recorded friend cohort, compared by its
algorithm, its commitment and its count. The schema of the record is in
[docs/implementation/online-operations.md](../../docs/implementation/online-operations.md),
and the tests of the requirement are in `friend-cohort-run.test.mjs`.

## The cohort settings

`ONLINE_FRIEND_COHORT` and `ONLINE_QUEUE_COHORT` are **server** settings of
the API process. They are read once, when the process boots, so a change of
either one needs a restart of the API container.

- They are comma-separated account identifiers. An empty list admits every
  signed-in account, and a non-empty list admits exactly the named accounts.
- A cohort is an allowlist of **accounts** and narrows the account access of
  its surface only. An account that the cohort does not name is refused with
  `403 not_authorized`.
- A cohort **never excludes a guest**. A guest can still create a friend link
  and can still finish an invitation that was issued while friend play was
  enabled. The public queue is account-only in any case.

The implementation of the settings is recorded in
[docs/implementation/online-cohort-enforcement.md](../../docs/implementation/online-cohort-enforcement.md),
and the contract of the settings is
[docs/architecture/online-operations-contract.md](../../docs/architecture/online-operations-contract.md).

## The browser suites and the descriptor of the run

The browser suites of `tests/e2e` that drive the real service need the
descriptor of a fixture. The descriptor is the machine-readable handoff of the
fixture: the base URL of the service, its issuer, its synthetic accounts and
the path of its signing key. The environment names the file that holds it with
`ONLINE_FIXTURE_DESCRIPTOR`.

Three modes, and they are never mixed up:

| `ONLINE_FIXTURE_DESCRIPTOR` | `ONLINE_FIXTURE_STRICT` | what the fixture-dependent cases do |
| --- | --- | --- |
| not set | not set | they skip. The run succeeds and proves **no online fixture coverage** |
| not set | `1` | the run **fails**. A strict run claims to cover the online service, and without a descriptor it does not |
| set to a file that cannot be read, is not JSON or has another shape | either | the run **fails**. An unusable descriptor is a broken run, not an absent fixture |

The rule that keeps the reports honest: **a skipped case is not a passed
case**. A run without a descriptor never becomes evidence of the online
service, and the reason of the skip says so in the report and on the console.
Only a strict run against a real fixture can carry online coverage.

The suites that depend on the descriptor:

- `tests/e2e/online-ui.spec.ts`
- `tests/e2e/online-requests.spec.ts`
- `tests/e2e/online-clients.spec.ts`
- `tests/e2e/account-online.spec.ts`

The seam of the three modes is `tests/support/online-fixture-descriptor.ts`,
and its own fixture is `tests/support/online-fixture-descriptor.test.ts`:

```sh
pnpm test -- tests/support/online-fixture-descriptor.test.ts
```

## Running the suites against a fixture

```sh
pnpm run online:fixture            # start the fixture; it prints the descriptor path
export ONLINE_FIXTURE_DESCRIPTOR=.scratch/onlinefixture/descriptor.json
export ONLINE_FIXTURE_STRICT=1
pnpm exec playwright test tests/e2e/online-ui.spec.ts tests/e2e/online-requests.spec.ts tests/e2e/online-clients.spec.ts
```

The default browser selection needs no fixture: `pnpm test:browser` starts no
service, so the fixture-dependent cases skip and the run says that it covered
nothing online. The browser workflow of the repository
(`.github/workflows/browser-app.yml`) runs exactly that selection, so the
skips are the reported outcome of the run and not a silent pass.
