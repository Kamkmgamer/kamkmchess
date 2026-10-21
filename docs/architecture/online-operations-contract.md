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
| `ONLINE_FRIEND_COHORT` | API server | empty | Optional comma-separated account identifiers allowed to use friend play. Empty means every signed-in account. |
| `ONLINE_QUEUE_COHORT` | API server | empty | Optional comma-separated account identifiers allowed to use the public queue. Empty means every signed-in account. |

### Guest rule

A guest must be able to create and use a friend link, and must be able to
accept an invitation that was created while friend play was enabled. A cohort
of account identifiers must therefore **never** exclude a guest, and must
never be the mechanism that enables friend play for everyone.

Consequences the API owner implements:

- `ONLINE_FRIEND_COHORT` narrows **account** access only. It is an allowlist
  of accounts, not a requirement that an account be present in it.
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
is therefore reversible and does not change a result.

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
is `scripts/online/online-routes.json`. It is a **provisional** list published
so the API, browser and operations workers agree on names; the API owner
corrects it in the same change that adds the route.

Existing routes (already served, unchanged by this contract):

- `POST /v1/online/matches/{matchID}/commands`
- `GET /v1/online/matches/{matchID}`
- `GET /v1/online/matches/{matchID}/updates`
- `GET /v1/online/matches/{matchID}/operations/{operationID}`
- `GET /v1/online/matches/{matchID}/replay`
- `GET /v1/profiles/{profileID}`, `GET /v1/profiles/username/{username}`
- `GET /v1/account/profile`, `PUT /v1/account/profile`

Provisional routes the tooling probes but never requires:

- `POST /v1/online/invitations`, `POST /v1/online/invitations/{invitationID}/accept`
- `POST /v1/online/queue/entries`, `GET /v1/online/queue/entries/{entryID}`
- `POST /v1/online/matches/{matchID}/rematch`

A route that is absent is reported as `not_implemented`. It is never counted as
a passed scenario.

## Evidence contract

Machine-readable evidence lives under `docs/evidence/online/`.

| Path | Producer | Content |
| --- | --- | --- |
| `docs/evidence/online/records/*.json` | `scripts/online/integration-suite.mjs`, `scripts/online/load-suite.mjs`, or an operator | One record per acceptance scenario. |
| `docs/evidence/online/KHA-80-integration.json` | `scripts/online/integration-suite.mjs` | Aggregated local integration trace. |
| `docs/evidence/online/KHA-83-host.json` | operator | Host configuration identifiers and sanitized measurements. |
| `docs/evidence/online/release-decisions/*.json` | owner | Recorded release decision per gate. |

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

## Release gates

`scripts/online/feature-gates.mjs` evaluates two independent gates.

- `friend` (KHA-84): requires the recorded owner release decision, a passing
  local evidence ledger for the friend scenarios, a host verification record, a
  passing backup coverage check and a passing runtime grant check.
- `queue` (KHA-85): requires everything the friend gate requires, plus the
  friend cohort having run, plus the queue-specific evidence.

Both gates produce a reversible rollout packet: the exact configuration change,
the monitoring to watch, the rollback command, and the blast radius. The tool
never applies the packet.

## Ownership of files

| Area | Owner |
| --- | --- |
| `deploy/` | Operations |
| `scripts/online/` | Operations |
| `.github/workflows/` | Operations |
| `backend/`, `src/`, `api/` | Application workers |
| `docs/architecture/online-contracts.md`, `docs/architecture/online-updates.md` | Application workers |

The operations tooling reads the application tree; it never edits it.
