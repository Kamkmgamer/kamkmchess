# Online operations contract

Operations-side contract for the online service. It names the configuration
surfaces the release gates read, the evidence files they require, the route
assumptions the operational tooling makes, and the files each owner changes.
It does not enable any feature and does not describe a deployed service.

The owner decides release. This document only makes the decision auditable.

## Server enforcement settings

These are **server** settings read by the Go API. They are not browser
configuration. The browser build has its own explicit flags, owned by the
browser worker, defaulting to off; a browser flag never grants access, it only
hides a surface the server would refuse anyway.

Both enforcement settings are **off by default**. Nothing in this repository
turns them on, and no automated tool may write them into a deployed
configuration.

| Setting | Scope | Default | Meaning |
| --- | --- | --- | --- |
| `ONLINE_FRIEND_ENABLED` | API server | `false` | Friend invitation creation, acceptance and friend play are served. |
| `ONLINE_QUEUE_ENABLED` | API server | `false` | Public queue entry, allocation and fallback are served. |
| `ONLINE_OWNER_ACCOUNTS` | API server | empty | Comma-separated account identifiers that may open and close friend play and the public queue from the site's Account panel (`GET`/`PUT /v1/account/online-switches`). The two switches above are the defaults; an owner's choice is stored in `online_runtime_switches` and every API process picks it up within 5 seconds. Empty means the switches follow the configuration only. |
| `ONLINE_FRIEND_COHORT` | API server | empty | Optional comma-separated account identifiers allowed to use friend play. Empty means every signed-in account. |
| `ONLINE_QUEUE_COHORT` | API server | empty | Optional comma-separated account identifiers allowed to use the public queue. Empty means every signed-in account. |

An account identifier of a cohort is the **opaque account subject** of a
signed-in account, for example the Clerk user id (`user_2abc…`) that the
session token carries in its `sub` claim. It is not a public username, not an
email address and not a display name: a cohort of public usernames matches no
account at all, so it admits nobody while the guests stay admitted. The
identifier is private and never leaves the server: it is read from the
verified session, and the recorded cohort of the release gate is operator
material, not public material.

Because the identifier is private, it never enters the evidence tree, a
rollout packet, a report or a log line. The tooling compares two cohorts by
their **commitment** instead of by their members, and the commitment is the
only part of a cohort that is public material.

### The protected cohort input

The account subjects of a cohort live in one protected operator input, outside
the tracked tree. The default path is
`.secrets/online-cohort/<gate>-cohort.json`, and the directory is ignored by
git. The gate also accepts another path with `--cohort-input <path>`, and it
refuses a protected input that lies inside the tracked tree.

```json
{
  "accounts": ["<the opaque account subject>", "<another one>"]
}
```

The file may also carry the value of the setting itself (`"value":
"user_2abc…,user_2def…"`). The subjects are read once, they are compared
through their commitment, and they are never reported.

The **commitment** of a cohort is the SHA-256 digest of the canonical form of
the set. The canonical form trims every identifier, drops the empty ones,
keeps one copy of a repeated identifier and sorts the rest by code unit, so
the canonical form of a set is unique and the order of a setting does not
change it.

| Field | Value |
| --- | --- |
| `algorithm` | `sha256-canonical-set-v1` |
| `commitment` | `sha256:` followed by the lowercase hex digest of `online-cohort:sha256-canonical-set-v1\n` and the canonical form |
| `count` | the number of accounts of the set |

The commitment is one-way: it does not recover the set. It confirms a
candidate set, and an account subject is a high-entropy opaque identifier, so
a candidate set cannot be enumerated from a commitment.

The operator records the commitment and the count of the recorded cohort in
the evidence tree, and the commitment and the count of the measured cohort of
the running server in the host record:

```json
{
  "algorithm": "sha256-canonical-set-v1",
  "commitment": "sha256:9f2c…",
  "count": 3
}
```

The measurement of the host is made with the same tool, and the tool prints
the commitment and the count and never a subject:

```sh
node scripts/online/cohort-commitment.mjs --env ONLINE_FRIEND_COHORT
node scripts/online/cohort-commitment.mjs --input .secrets/online-cohort/friend-cohort.json --json
```

The **exact verification** of the runtime cohort is then the comparison of
two commitments: the gate recomputes the commitment of the protected input
and compares it with the commitment of the host record. Two commitments are
equal exactly when the two sets of accounts are equal, so a host that carries
another member, another count or another set blocks the gate. The gate never
reads the subjects of either side into a report, and a record that carries raw
subjects instead of a commitment is an unmet requirement, not a cohort.

The count is part of the record of a cohort on both sides. The recorded
evidence and the host record have to carry the commitment **and** the count of
their set: a record that carries the commitment and no count has not recorded
the size of the set, and a count that is not a positive integer is no count at
all. An absent count, a malformed count, a zero and a negative count are all
unmet requirements, so the gate stays blocked.

The gate can verify the runtime cohort only where the protected operator
input is available. A run without it, a continuous integration run for
example, keeps the gate blocked: the recorded cohort is operator material,
not public material.

The two cohort settings are read once, when the API process boots, so a change
of either one needs a restart of the API container.

### Guest rule

A guest must be able to create and use a friend link, and must be able to
accept an invitation that was created while friend play was enabled. A cohort
of account identifiers must therefore **never** exclude a guest, and must
never be the mechanism that enables friend play for everyone.

Consequences the API owner implements:

- `ONLINE_FRIEND_COHORT` narrows **account** access only. It is an allowlist
  of accounts, not a requirement that an account be present in it.
- A cohort never excludes a guest, and it never narrows the owner recovery of
  an invitation: the owner of an invitation keeps the preview and the
  cancellation of the invitation it owns, because the owner token of the
  invitation is the proof of that ownership.
- A guest request is allowed when `ONLINE_FRIEND_ENABLED` is true, or when
  the invitation it presents was created while friend play was enabled.
  The invitation records that it was issued under an enabled configuration, so
  a guest can finish an enabled invitation after the switch is turned off.
- The guest seat credential issued on acceptance stays revocable and scoped to
  its seat. Consuming an invitation grants no other match control.

### Rollback behaviour

Turning `ONLINE_FRIEND_ENABLED` or `ONLINE_QUEUE_ENABLED` off stops new
creations immediately. It does not abort, resign or invalidate matches that
are already running, and it does not remove issued guest credentials. Rollback
is therefore reversible and does not change a result. The same holds when a
site owner closes a surface from the Account panel.

### Queue

The queue adds no arbitrary per-owner game, entry or agent cap. The queue
release gate requires an accepted friend cohort as a process requirement; the
runtime does not enforce a game cap.

### Ownership

The API owner implements and enforces these settings inside the request path.
A script that only reads flags is not enforcement, and the release gate treats
an unimplemented setting as an unmet requirement rather than as a passed
check. The operations owner checks configuration with
`scripts/online/feature-gates.mjs` and never edits a deployed environment.

## Route assumptions

The operational tooling only needs to know which routes exist so it can report
an unimplemented route honestly instead of measuring a 404. The route manifest
is `scripts/online/online-routes.json`, and it is the route contract of the
tooling: the tooling reads it, compares it with the routes the production code
registers, and the API owner adds a route to it in the same change that serves
it.

The manifest records `provisional: false`. The list is not a draft: every route
in it is registered by the production code, and the tooling verifies that claim
against the repository with `scripts/online/route-manifest.mjs`. A route the
production code does not register is reported as `not_implemented`, and a
scenario that depends on such a route is never counted as a passed acceptance
scenario. A closed surface answers 404, so the tooling reads
`GET /v1/online/features` first and reports a closed surface as `disabled`,
never as a passed scenario.

The routes of the online surface:

| Method | Path | Family |
| --- | --- | --- |
| GET | /v1/online/features | features |
| POST | /v1/online/invitations | friend |
| GET | /v1/online/invitations/{invitationID} | friend |
| POST | /v1/online/invitations/{invitationID}/accept | friend |
| POST | /v1/online/invitations/{invitationID}/cancel | friend |
| POST | /v1/online/invitations/{invitationID}/seat-credential | friend |
| POST | /v1/online/rematches | friend |
| POST | /v1/online/rematches/{rematchID}/accept | friend |
| POST | /v1/online/rematches/{rematchID}/seat-credential | friend |
| GET | /v1/online/matches/{matchID}/rematch | friend |
| POST | /v1/online/queue/entries | queue |
| GET | /v1/online/queue/entries/{entryID} | queue |
| POST | /v1/online/queue/entries/{entryID}/ready | queue |
| POST | /v1/online/queue/entries/{entryID}/cancel | queue |
| POST | /v1/online/queue/entries/{entryID}/keep-searching | queue |
| POST | /v1/online/queue/entries/{entryID}/heartbeat | queue |
| POST | /v1/online/queue/entries/{entryID}/match | queue |
| POST | /v1/online/queue/entries/{entryID}/fallback | queue |
| POST | /v1/online/matches/{matchID}/commands | match |
| GET | /v1/online/matches/{matchID} | match |
| GET | /v1/online/matches/{matchID}/updates | match |
| GET | /v1/online/matches/{matchID}/replay | match |
| GET | /v1/online/matches/{matchID}/operations/{operationID} | match |
| GET | /v1/online/matches/{matchID}/presence | presence |
| POST | /v1/online/matches/{matchID}/presence | presence |
| POST | /v1/online/matches/{matchID}/presence/keep-waiting | presence |
| POST | /v1/online/matches/{matchID}/claim | presence |
| GET | /v1/online/matches/{matchID}/runner/lease | presence |
| POST | /v1/online/matches/{matchID}/runner/lease | presence |
| POST | /v1/online/matches/{matchID}/runner/request | presence |

The profile and the account routes (`/v1/profiles/...`, `/v1/account/...`) are
outside the online manifest. They are not part of the online surface and the
online tooling does not probe them.

A route that is absent is reported as `not_implemented`. It is never counted as
a passed scenario.

## Evidence contract

Machine-readable evidence lives under `docs/evidence/online/`.

| Path | Producer | Content |
| --- | --- | --- |
| `docs/evidence/online/records/*.json` | `scripts/online/integration-suite.mjs`, `scripts/online/load-suite.mjs`, or an operator | One record per acceptance scenario. |
| `docs/evidence/online/KHA-80-integration.json` | `scripts/online/integration-suite.mjs` | Aggregated local integration trace. |
| `docs/evidence/online/KHA-83-host.json` | operator | Host configuration identifiers and sanitized measurements. The cohort field carries the commitment and the count of the measured cohort, never an account subject. |
| `docs/evidence/online/release-decisions/*.json` | owner | Recorded release decision per gate. |
| `docs/evidence/online/release-decisions/<gate>-cohort.json` | owner | The commitment and the count of the recorded cohort. Never the account subjects. |
| `.secrets/online-cohort/<gate>-cohort.json` | operator | The protected input of the cohort: the account subjects. It is ignored by git, it is never committed and it is never printed. |

A record has this shape:

```json
{
  "scenarioId": "QUE-09",
  "status": "passed",
  "kind": "local",
  "commit": "<git commit>",
  "command": "<exact reproduction command>",
  "expected": "<what the specification requires>",
  "actual": "<what the run observed>",
  "notes": "<optional limits and caveats>"
}
```

`kind` is one of `local`, `native`, `host`, `live`. The evidence ledger refuses
to mark a scenario passed without a `commit`, a `command`, an `actual` result
and a `kind` that matches the scenario's domain. Native assistive-technology
evidence, live host measurements and owner release decisions are never produced
by a local run.

### The provenance of a record

A record is a claim, and a claim is only evidence when a run source recorded
the behaviour of the scenario. The ledger therefore compares every record that
claims an observation against the run sources of the tree, and it refuses the
record when the source does not back it:

- a record that claims `passed` needs a run source that recorded the scenario
  **at the very commit the record names**, and that recorded it as passed;
- a record that claims `partial` needs a run source that recorded the scenario
  at that very commit;
- a record that claims `failed` or `blocked` needs no run source: it never
  opens a gate and it can only lower the status of a scenario;
- a record that names another command than the run source is refused;
- a kind of evidence without a registered run source fails closed. The native
  assistive technology, the deployed host, the released cohort and the owner
  decision have no verifiable artifact in the tree yet, so no record of those
  kinds closes a scenario.

The run source of the local evidence is
`docs/evidence/online/KHA-80-integration.json`: the database run carries the
coverage of the acceptance scenarios and the browser run carries the cases of
the browser map. The browser map names the cases that exercise a scenario but
carries no statement that they cover the whole approved scenario, so the
browser evidence closes a scenario only when the map states a complete
coverage. The rules live in `scripts/online/evidence-provenance.mjs`, and the
ledger never rewrites a record: it refuses it and says why.

A record that the ledger refuses is listed in `invalidRecords`, the scenario
keeps no evidence, and the ledger exits with a non-zero status. A hand-written
record can therefore never close an acceptance scenario.

## Release gates

`scripts/online/feature-gates.mjs` evaluates two independent gates.

- `friend` (KHA-84): requires the recorded owner release decision, a passing
  local evidence ledger for the friend scenarios, a host verification record, a
  passing backup coverage check and a passing runtime grant check.
- `queue` (KHA-85): requires everything the friend gate requires, plus the
  friend cohort having run, plus the queue-specific evidence.

The queue gate requires an **accepted** friend cohort run, and the file that
carries the run is not the run. The record at
`docs/evidence/online/KHA-84-friend-run.json` names the outcome of the run
(`"status": "accepted"`), the acceptor, the date, the tested commit and the
cohort of the run, and the cohort of the run is bound to the recorded friend
cohort of `docs/evidence/online/release-decisions/friend-cohort.json` by its
algorithm, its commitment and its count. A missing record, a record that is
not JSON, an empty record, a record of another outcome and a record of another
cohort are unmet requirements, so a file at the recorded path never clears the
prerequisite of the queue. The two sets are compared by their commitment, so
the record carries the count and the commitment of the set and never an
account subject of it.

Both gates require the enforcement of the account cohort as a requirement of
its own. The recorded cohort is a set of accounts, and only an observed
enforcement narrows the account access of the server request path;
`scripts/online/cohort-enforcement.mjs` audits it, and the gate stays blocked
while the audit is unproven.

The recorded cohort and the runtime cohort of the host are compared by their
commitment, never by their members. The gate recomputes the commitment of
the protected operator input and compares it with the commitment of the host
record, so a host that carries another set of accounts blocks the gate while
no account subject of either side reaches a report.

Both sides also carry the count of their set, and the gate compares it with
the count of the recorded cohort. A recorded evidence or a host record that
carries the commitment and no count, a count that is not an integer and a
count that is not positive are all unmet requirements: a commitment without a
count has not recorded the size of the cohort.

Both gates produce a reversible rollout packet: the exact configuration change,
the monitoring to watch, the rollback command, and the blast radius. The
packet names the cohort setting, the count and the commitment of the cohort,
and never an account subject of it. The tool never applies the packet.

## Ownership of files

| Area | Owner |
| --- | --- |
| `deploy/` | Operations |
| `scripts/online/` | Operations |
| `.github/workflows/` | Operations |
| `backend/`, `src/`, `api/` | Application workers |
| `docs/architecture/online-contracts.md`, `docs/architecture/online-updates.md` | Application workers |

The operations tooling reads the application tree; it never edits it.
