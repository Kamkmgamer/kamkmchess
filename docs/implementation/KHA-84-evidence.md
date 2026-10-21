# KHA-84 evidence — the opt-in friend release

Tested commit: `0b24151`.

**Status: blocked. The friend cohort is not enabled and must not be enabled
yet.**

## The gate

`node scripts/online/feature-gates.mjs evaluate --gate friend` reports the
current state:

| Requirement | State | Detail |
| --- | --- | --- |
| release-decision | unmet | No owner release decision is recorded for the friend gate. |
| cohort | unmet | No opt-in cohort is recorded. |
| host-verification | external | No host verification record exists. |
| backup-coverage | met | The dump covers the database and the restore reapplies the removal ledger. |
| runtime-grants | met | The policy grants the 45 migrated tables exactly what the writer uses. |
| local-evidence | unmet | `FRI-02`, `FRI-04`, `MAT-01`, `MAT-02`, `MAT-07`, `MAT-09`, `MAT-10` and `ARC-07` have no passing evidence, and `ARC-08` is recorded as failed. |
| native-evidence | unmet | `UX-02` to `UX-06` have no native run. |
| host-evidence | external | `ARC-12`, `ARC-13`, `ARC-14`, `HIS-06` and `HIS-07` have no host record. |

The reversible rollout packet is printed by
`node scripts/online/feature-gates.mjs packet --gate friend`. It names the
configuration change, the monitoring, the rollback and the blast radius, and
it applies nothing. Rollback is reversible: closing the switch stops new
creations and leaves running matches, their results and the issued guest
credentials untouched.

## The recorded separation

`REL-02` stays `not_run` in the ledger. Approving this backlog, approving the
prototype or recording the tooling does not supply the production acceptance,
the paid usage authorization or the public launch approval. The friend gate
needs its own recorded decision, and the queue gate needs a second one.

## The cohort rule

The cohort is an allowlist of accounts. It never excludes a guest: a guest
must be able to create a friend link and to accept an invitation that was
created while friend play was enabled, or `FRI-01` would fail. The server
switch, not a browser flag, owns the surface.

## Pending

- The implementation scenarios of the friend gate need passing evidence.
  `FRI-01` and `FRI-03` have local browser evidence now; `FRI-02`, `FRI-04`,
  `MAT-01`, `MAT-02`, `MAT-07`, `MAT-09`, `MAT-10` and `ARC-07` do not, and
  `ARC-08` is recorded as failed.
- The native scenarios need real devices.
- The host scenarios need the host.
- The server switches and the feature route are wired and default closed, and
  the restore fence is shared between the service and the restore command. The
  crash safety of that fence still needs the host: a container-local file was
  refused precisely because it would not survive a restart.
