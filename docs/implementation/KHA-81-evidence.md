# KHA-81 evidence — native desktop accessibility of the online flows

Tested commit: `0b24151`.

**Status: not run. No native device run has been performed.**

`UX-02` to `UX-06` need a real Windows or macOS browser with a real screen
reader, and the online flows need the friend routes that are not implemented in
this commit. A viewport emulation, an automated scan or a screenshot does not
close these scenarios, and the evidence ledger refuses to let a local run close
a native scenario.

## What is prepared

- The evidence record format and the gate requirement. The evidence ledger
  accepts a native record only with `kind: "native"`, the tested commit, the
  exact command and the observed result, and the friend release gate reports
  the native requirement as unmet until such a record exists.
- The browser integration spec `tests/e2e/online-clients.spec.ts` drives two
  real browser contexts against the real service. It checks the exact DTO
  field names and the origin policy. It is the closest local proxy for the
  keyboard and pointer flows, and it is not a substitute for the native run.
- The offline layout and the removed attribution block are unchanged by this
  work. No frontend file was modified here.

## What a native run has to record

- The device, the operating system version, the browser version and the
  assistive technology with its version.
- The tested commit.
- The per-flow result for offline play, friend join, both queue modes,
  concurrent games, control and recovery, the profile and replay, and the
  deletion and removal flows.
- The board navigation, the clock and status announcements, the icon names
  and tooltips, the focus restoration, the dialogs and the accessible
  confirmation actions.

## Pending

Everything in `UX-02` to `UX-06` stays pending. The scenarios are recorded as
`not_run` in `docs/spec/online-play-acceptance.json` and in the ledger.
