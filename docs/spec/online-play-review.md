# Online-play review packet

The behavior, privacy and architecture decisions are recorded in [the Linear map](https://linear.app/kamkm/issue/KHA-54). The owner accepted the planning contract on 2026-10-20 with the offline-preservation, icon-action and replay-list corrections incorporated.

Read [the specification](online-play-handoff.md) and [the proposed acceptance scenarios](online-play-acceptance.json). The packet has 62 traced scenarios: two planning agreements are approved, and 60 implementation scenarios remain not run.

The disposable [interface review](http://127.0.0.1:5188/?variant=A) offers three structures within the existing app design. A is accepted for online play. The existing offline game stays as it is, with draw/resign icons added; clearly represented actions use icons, and the separate Declared models list is removed. B gives games a permanent list. C uses focused task steps. The inline preview and this local server run synthetic state only.

The agreement accepts the corrected interface and specification as the basis for implementation. It does not deploy, provision services, authorize paid AI calls or upgrades, enable public account data, or waive the future production readiness and launch review.

The architecture reuses the current Go/PostgreSQL host, adds a private Node/chessops rules process and uses direct authenticated HTTP plus finite SSE or polling. Provider calls and keys remain browser-local. Host streaming, rules conformance, capacity, native accessibility, concurrency and restore/deletion are explicit implementation gates.

The prototype branch is `prototype/online-play-map`. The specification branch is `planning/online-play-handoff`. Both start from inspected local commit `cd714f5bfdce389979cf3e45afa12e434c20060b`; no production source behavior is changed. The research branch/report remains separately preserved.
