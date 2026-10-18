# MVP implementation progress

Local integration work on 2026-10-18, based on `e803452`. These changes are in the working tree. This record does not certify the 79 native/product acceptance cases or authorize a public release.

## Playable local path

Run `pnpm install --frozen-lockfile`, then `pnpm dev`. Choose New game and AI mode. CLIProxyAPI is preselected. Enter the proxy URL, key and exact model ID, choose Connect and use model, accept the destination disclosure, then Start game after the check passes. Other providers remain available with the explicit connection/check/selection flow. A real provider must allow browser CORS and the player must supply its local credentials. Offline browser tests intercept synthetic providers and consume no provider quota.

The app supports either player color, continuous clocks, persisted requests and received bytes, retained attributed conversation, discarded Undo history, Stop/Retry, explicit compatibility rechecks after reload, queued model selection and practice after a model loss. The model chooses its move independently. The controller checks legality, budgets, clocks and request authority.

The subsequent [CLIProxyAPI setup](CLIProxyAPI.md) adds the default proxy quick form. Its full validation passed 451 unit tests and 12 Chromium scenarios, followed by a focused authentication transition regression after the final review fix.

The later [second-turn position-check fix](MVP-position-checks.md) reproduces and resolves the reported `e4 e5 Nf3` stall before the second provider request. Its validation passed 454 unit tests with four workers and all 13 Chromium journeys, including continued model play on both colors.

## Ticket evidence

| Tickets | Implemented here | Remaining evidence or scope |
| --- | --- | --- |
| KHA-37 | Durable request/response/history/usage integration, retained replay and credential quarantine. | Live cache and charge measurements remain unknown. Protocol cache controls are available to callers but have no play UI control. |
| KHA-38, KHA-40 | Catalog/manual routing IDs, session-bound diagnostics, consent, queued handoffs and recovery controls. | Real provider and cross-provider acceptance remains unrun. |
| KHA-39 | Classic board/editor integrated with the same controller; responsive browser play checked. | Native screen-reader acceptance remains separate. |
| KHA-42, KHA-43 | Official Clerk adapter, exact account namespaces, explicit guest copy, separate account workspaces, manual sync and preserved conflict takeover. | Accounts default off. Real login, hosted storage and multi-device acceptance remain unrun. Automatic sync and browsing/downloading remote games are not implemented in this UI. |
| KHA-44 | Vercel Go entry, routing, public build allowlist, fail-closed server storage gate and CI configuration. | No Vercel project, managed database or Clerk project was provisioned. Exact Clerk CSP origins must be configured before enabling accounts. |
| KHA-45 | Encrypted backups, rotation planning and deletion-ledger restore tools; actual isolated PostgreSQL backup/restore rehearsal. | Private hosted destination, scheduler, retention and managed-service recovery remain unverified. |
| KHA-46, KHA-49 | Controller/storage/provider fixtures, Chromium journeys, Go tests, release audit and complete distribution license notices. | Native concurrency/network/device and deployed configuration checks remain open. |
| KHA-53 | Classified controller effects, durable budgets, violation records and immutable model-loss results are already present in the baseline and exercised by integration. | This work adds their browser consumer and recovery journey. |
| KHA-47, KHA-48, KHA-50, KHA-51, KHA-52 | No native/live acceptance claim. | Required devices, assistive technology, authorized real routes/costs, hosted evidence and the owner's final launch decision remain. |

## Verification

The final `pnpm check` passed ESLint, 444 unit tests across 40 files, both strict TypeScript projects, Vite compilation and runtime license notice generation. The inventory contains 56 installed runtime package records. The build still reports bundle-size warnings for the main application and the optional Clerk chunk; accounts load Clerk only when explicitly enabled.

The final `pnpm test:browser` passed all nine Chromium scenarios in 36.4 seconds against the built distribution. They cover complete legal play through checkmate/reload, retained plans, model White, resignation/practice, Stop/Retry, Undo retention, same-model rematch, queued first-reply promotion, reload recheck, automatic malformed/illegal-reply correction, the formatting limit and explicit failed-candidate Retry. `git diff --check` passed.

Go tests and vet passed for `./backend/... ./cmd/... ./api/...`. All eight isolated PostgreSQL storage integration cases passed. Backup tests passed 28 package and 10 CLI cases. The release-audit test suite passed 19 cases. The real backup rehearsal and its bounds are in [MVP-operations.md](MVP-operations.md).

The local release audit reports zero blockers, five warnings and one external gap with account storage disabled. Warnings cover the missing exact deployed Clerk CSP origins and the preexisting `_headers`/`_redirects` files for other static hosts. Those public files were preserved. Vercel uses `vercel.json`. The external gap is hosted backup execution. Bundle scanning found no credential shape or server-only configuration name. The Impeccable detector reported no findings on the changed UI targets; desktop and mobile captures were inspected.

GPT 6 Luna agents implemented the disjoint gameplay, controller, history, opponent, account and proof slices. Space Bunny Free implemented backup/release tooling and reviewed the integration twice. Its later implementation and final review attempts failed with `Rate limit exceeded. Please try again later.` A fresh Luna review provides the final independent pass.

The final independent review found a takeover crash window and sign-out/resource lifetime defects. These were fixed with a durable pending-adoption transition, idempotent snapshot installation, subscriber notification, composition disposal and controller registry release. A fresh focused review found no remaining P1 or P2 findings in those fixes and passed 30 account/cloud/composition tests. This is a code-review result, not hosted account acceptance.

## Practical limits

Exact proof discovery remains bounded. A checked mating witness can establish that a position is not dead; a cutoff cannot. Local probes found independently checked witnesses for a Ruy Lopez position in 1,011 ms, a Queen's Gambit position in 521 ms and a tactical middlegame position in 60 ms. The Ruy Lopez probe has also reached the 3-second cap under concurrent test load. Difficult positions can remain saved with adjudication pending while the active clock continues. See [MVP-position-checks.md](MVP-position-checks.md). These probes do not establish uninterrupted play for every middlegame.

No real provider call, Clerk/Google login, hosted deployment, managed backup schedule, native screen-reader session or measured provider charge was performed. Account storage stays disabled by default. No commit, push or public deployment was made during this implementation.
