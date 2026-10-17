# KHA-31 Worker continuation

Linear issue: [Build resumable exact cooperative graph analysis](https://linear.app/kamkm/issue/KHA-31/build-resumable-exact-cooperative-graph-analysis).

The original implementation is on `t3/resumable-cooperative-analysis` in `C:/Users/Lenovo/.t3/worktrees/kamkmchess/t3-9fabe572`. Its search and checkpoint store were already integrated into main when this continuation started from `1627930`. The continuation checkout is `D:/projects/kamkmchess-kha31-continue`, branch `feat/kha31-search-continuation`. The [original evidence](KHA-31-evidence.md) remains the record of that earlier build.

## Changes

The Worker now rejects nonpositive resource budgets as invalid messages rather than silently allowing the search API to substitute defaults. Its message runtime is separate from the browser entry so the lifecycle boundary can be exercised directly. A cancellation fence prevents an accepted verdict from being published after its request is aborted. Cooperative cancellation still returns its non-result and checkpoint, and replacing a request ID still suppresses the old request's reply.

The added fixtures cover start/resume, malformed requests and budgets, cancellation and duplicate request IDs. Three GPT-6 Luna agents audited the engine, checkpoint store and Worker boundary. The engine and store audits found no concrete defect and made no changes. Independent review of the Worker and browser helper checked cancellation, stale reply fencing and checkpoint preservation.

## Final checks

On Node 24.22.0 and pnpm 12.14.0, `pnpm lint`, `pnpm test --no-file-parallelism` and `pnpm build` passed. The suite passed 278 tests across 19 files, including five Worker lifecycle tests. Both TypeScript projects, Vite output and distribution notices passed. `git diff --check` passed. Final independent Luna review reported no actionable production defect.

An earlier `corepack pnpm build` attempt resolved pnpm 12.6.0 inside its nested script and failed the repository's package-manager version guard. The direct `pnpm build` invocation used the configured 12.14.0 and passed. Early fixture scheduling, lint and typing failures were corrected before these final checks.

## Browser evidence

The [reproducible smoke helper](../../experiments/proof-search-worker/README.md) ran in T3's Windows Chromium 152 / Electron 44 preview through Vite on 2026-10-17. The [observed record](../../experiments/proof-search-worker/observed.json) includes the exact user agent and result.

Expected and observed: a one-state pass returns `state-budget`; its checkpoint survives native IndexedDB close/reopen; the actual module Worker resumes it to a checked `dead` closure with four states and four edges; cancellation of the larger researched position returns `cancelled` with a checkpoint. The helper throws if any expectation fails and removes its disposable database.

This extends the earlier evidence with actual development Worker execution and native IndexedDB reopen in one embedded Chromium build. It does not certify deployed Worker bundle/CSP behavior, crash durability, controller integration, mobile memory or the required native browser/device/assistive technology matrix. Product acceptance statuses remain unchanged. No live provider, hosted account or paid request was performed.
