# KHA-82 evidence — native mobile accessibility of the online flows

Tested commit: `0b24151`.

**Status: not run. No iOS or Android device run has been performed.**

`UX-02` to `UX-06` need a real iOS VoiceOver run and a real Android TalkBack
run. Viewport emulation does not close them, and the evidence ledger refuses
to let a local run close a native scenario.

## What is prepared

- The evidence record format, the gate requirement and the ledger rules that
  keep a native scenario open until a native run is recorded.
- The browser integration spec, which uses real browsers and a real service
  against the loopback fixture. It proves the transport, the origin policy and
  the DTO shape. It proves nothing about a touch target, a native screen
  reader or a suspended application.

## What a native run has to record

- The device, the iOS or Android version, the browser and the assistive
  technology with its version.
- The tested commit.
- The per-flow result for board play, friend setup and join, both queue
  choices, concurrent games, the agent recovery, the replay and the privacy
  actions.
- The touch targets, the icon names, the logical focus order, the dialogs,
  the status and clock announcements and the move history review across the
  phone sizes.
- The backgrounding and suspension behaviour: no silent queue re-entry, no
  duplicated provider work and no lost game navigation.

## Pending

Everything in `UX-02` to `UX-06` stays pending for the mobile platforms.
