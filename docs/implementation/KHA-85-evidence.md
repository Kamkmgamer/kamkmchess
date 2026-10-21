# KHA-85 evidence — the public queue release

Tested commit: `0b24151`.

**Status: blocked. The public queue is not enabled and must not be enabled
yet.**

## The gate

`node scripts/online/feature-gates.mjs evaluate --gate queue` reports every
requirement of the queue gate. It is stricter than the friend gate:

- everything the friend gate requires;
- an **accepted friend cohort run**, recorded in
  `docs/evidence/online/KHA-84-friend-run.json`;
- passing evidence for `QUE-01`, `QUE-03`, `QUE-09`, `QUE-11` and `QUE-12`;
- a host capacity record.

The queue adds **no owner game cap, entry cap or agent cap**. The gate
requires an accepted friend cohort as a process requirement; it never
introduces an arbitrary limit.

## Current state

| Requirement | State | Detail |
| --- | --- | --- |
| release-decision | unmet | No owner release decision is recorded for the queue gate. |
| cohort | unmet | No opt-in cohort is recorded. |
| host-verification | external | No host verification record exists. |
| backup-coverage | unmet | The restore path does not reapply the online removal markers. |
| runtime-grants | met | The policy matches the writer's statements. |
| local-evidence | unmet | `QUE-01`, `QUE-03`, `QUE-09`, `QUE-11` and `QUE-12` have no passing evidence. |
| friend-cohort-run | unmet | The friend cohort has not run. |

## Not exercised

The queue writer, the competing matchmakers, the cutoff equality, the atomic
allocation, the Stockfish fallback and the fixed opponent are not implemented
in this commit. `QUE-01`, `QUE-03`, `QUE-09`, `QUE-11` and `QUE-12` stay
`not_run`.

No platform-funded AI usage, no deployment and no queue enablement happened.

`REL-02` stays `not_run`: recording the tooling and the gate does not supply
the public-queue release decision.
