# KHA-84 evidence — the opt-in friend release

Evidence pins of the recorded material: the local backend race at
`ab0dba56eaa837d1db3aaea0df2ed3d2773d65d1`, the fixture browser run at
`1e08868d71e3105288ba59af24f55ea3df310593`, the assembled report at
`7caaef4`. The gate output below was produced from the working tree of
`feature/online-play-swarm`, which is not a commit. The earlier
`Tested commit: 0b24151` line is withdrawn: `0b24151` carried the approved
contract and its acceptance trace into the tree, the gate tool did not exist
at that commit, and no recorded evidence is pinned to it, so it never
described the tested tree.

**Status: blocked. The friend cohort is not enabled and must not be enabled
yet.**

## The gate

`node scripts/online/feature-gates.mjs evaluate --gate friend` reports the
current state. It exits with `blocked`, and the table below reproduces it
requirement by requirement.

| Requirement | State | Detail |
| --- | --- | --- |
| release-decision | unmet | No owner release decision is recorded for the friend gate. |
| cohort | unmet | The protected operator input is missing, so no cohort is recorded. |
| runtime-cohort | unmet | No cohort is recorded, so there is no runtime cohort to measure. An unset cohort setting admits every signed-in account. |
| host-verification | external | No host verification record exists. Apache flushing, TLS, CORS, private worker reachability and capacity are measured on the host, not locally. |
| backup-coverage | met | The backup covers the whole database and the restore reapplies the removal ledger. |
| runtime-grants | met | The runtime policy grants the 45 migrated tables exactly what the writer uses. |
| local-evidence | unmet | All 22 local scenarios of this gate are nonpassing. |
| native-evidence | unmet | `UX-02` to `UX-06` have no native run. |
| host-evidence | external | `ARC-05` is `partial` and its record is a local one; `ARC-12` to `ARC-14`, `HIS-06` and `HIS-07` are `not_run`. |
| cohort-enforcement | met | The enforcement tests of the tree passed and the proof of the composition proved that the cohort of `ONLINE_FRIEND_COHORT` reaches the request path of the surface. |

The requirement `cohort-enforcement` is met by the audit of the tree, not by
a released cohort: the enforcement of the cohort is the narrowing of the
account access of the surface, and it is the recorded cohort and the measured
runtime cohort that stay outstanding. The enforcement is written up in
[online-cohort-enforcement.md](online-cohort-enforcement.md). The table
above reproduces the requirements of the gate as the tree reports them now.

The reversible rollout packet is printed by
`node scripts/online/feature-gates.mjs packet --gate friend`. It names the
configuration change, the monitoring, the rollback and the blast radius, and
it applies nothing. It reports `deployable: false` and it names the
requirements that block it. Rollback is reversible: closing the switch stops
new creations and leaves running matches, their results and the issued guest
credentials untouched.

## The local evidence

All 22 local scenarios of this gate are nonpassing. Fourteen of them carry a
`partial` record: a named local case exercised a subset of the scenario, and
a subset is never a pass.

`FRI-01`, `FRI-03`, `MAT-03`, `MAT-04`, `MAT-11`, `MAT-12`, `ARC-02`,
`ARC-03`, `ARC-04`, `ARC-06`, `ARC-08`, `ARC-09`, `ARC-11`, `HIS-10`

Eight of them carry no record at all and stay `not_run`:

`FRI-02`, `FRI-04`, `MAT-01`, `MAT-02`, `MAT-07`, `MAT-09`, `MAT-10`,
`ARC-07`

`ARC-08` is `partial`, not failed. Its record names the two database cases
that cover parts of the approved scenario and says so itself: their passing
does not close the scenario.

## The native and the host evidence

`UX-02` to `UX-06` have no native run. They need the real devices and the
real assistive technology, and no local run stands in for them.

`ARC-05` is `partial` and the record behind it is a local one, so the host
measurement it asks for does not exist. `ARC-12`, `ARC-13`, `ARC-14`,
`HIS-06` and `HIS-07` are `not_run`: they need the host.

## The recorded separation

`REL-02` stays `not_run` in the ledger. `UX-01` and `REL-01` are the two
planning approvals of the unchanged contract, and they are not release
approvals. Approving this backlog, approving the prototype or recording the
tooling does not supply the production acceptance, the paid usage
authorization or the public launch approval. The friend gate needs its own
recorded decision, and the queue gate needs a second one.

## The cohort rule

The cohort is an allowlist of accounts. It never excludes a guest: a guest
must be able to create a friend link and to accept an invitation that was
created while friend play was enabled, or `FRI-01` would fail. The server
switch, not a browser flag, owns the surface.

The account subjects of the cohort are private. They live in one protected
operator input outside the tracked tree, and the evidence tree carries only
the count and the commitment of the set. The gate compares the recorded
cohort with the runtime cohort of the running server by their commitment, and
neither a report nor a packet nor a line of stdout ever names an account
subject. An unset cohort setting admits every signed-in account, so the
runtime cohort has to be measured on the host before the surface opens.

## What the ledger holds

`docs/evidence/online/ledger.json` is generated from the evidence records. It
reports 0 passed, 0 failed, 0 blocked, 16 partial and 46 not run. The
approved contract `docs/spec/online-play-acceptance.json` is unchanged: 62
traced scenarios, 60 implementation scenarios `not_run` and two planning
approvals. A `partial` record is an implementation-evidence status; it does
not change the contract and it does not satisfy a gate.

## What remains unverified

- Native assistive technology on the real devices.
- Deployed host capacity, delivered TLS, CSP and Apache streaming behavior.
- A released cohort: the enrollment of the accounts, and the cohort of the
  running server measured on the host.
- The owner release approval of the friend gate.
- The crash safety of the restore fence. The fence is shared between the
  service and the restore command, and a container-local file was refused
  precisely because it would not survive a restart, so the host has to prove
  it.

The stored load report `docs/evidence/online/KHA-83-local-load.json` measured
the rejection path: all 196 requests answered `401`. It is not
serving-capacity evidence.

## Pending

- The implementation scenarios of the friend gate need passing evidence. The
  local ones are listed above, the native ones need the devices and the host
  ones need the host.
- The server switches and the feature route are wired and default closed, and
  the restore fence is shared between the service and the restore command.
  Neither of them opens a surface on its own.
