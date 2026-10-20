# KHA-74 and KHA-77 browser evidence (UI, workspace, readiness)

Owner: the workspace worker (browser side only). This note records what was
implemented and what was actually executed. It claims no native, host or
acceptance sign-off, and it grants no deployment or public launch.

## What the browser now has

| Module | Purpose |
| --- | --- |
| `src/online/workspace.ts` | concurrent live games, focus, reconnect status, committed results, identity-scoped durable list |
| `src/online/readiness.ts` | own-agent readiness, the ten-second search window, the cutoff fallback, the retry and keep-searching recovery |
| `src/online/engine-seat.ts` | the browser Stockfish 19 Lite seat of a fallback game, with its runner lease |
| `src/online/runner-lease.ts` | the runner lease and runner request client of the participant API |
| `src/online/match-client.ts` | the participant command client, including the optional `leaseId` |
| `src/online/queue-client.ts` | the HTTP adapter of the queue routes |
| `src/online/composition.ts` | the composition of the online browser parts and the real service calls |
| `src/online/features.ts` | the two rollout switches and the loopback-only test opt-in |
| `src/online/clock.ts` | the interpolated reading of the canonical clock |
| `src/ui/online-workspace.tsx` | the online screen: new play, concurrent games, profile and history |
| `src/ui/online-view.ts` | the compact view models of a canonical online snapshot |

The screen is mounted in the current board-and-moves workspace
(`src/ui/App.tsx`): one compact **Online play** control opens it. The offline
game keeps its own controller, its own clock and its own layout; the online
screen is a focus page above it.

## The rules the modules keep

- **Concise states (UX-03).** The online screen uses the shared board, the
  shared move list and icon-only actions with an accessible name and a hover
  label. The visible copy of the online screen is inside the twenty-word
  convention; the engine screen copy is inside the ten-word convention. The
  player names, the model labels, the clocks and the notation are game data.
- **Removed attribution panel (UX-06).** There is no per-move declared-models
  block. A seat shows one compact label: `Human`, `Agent · GPT-4o`,
  `Engine · Stockfish 19 Lite (browser)`.
- **Concurrent navigation (UX-04).** Several matches run at once. Focusing
  another match never disposes another one, so navigation cannot lose shared
  state. The durable list of matches is namespaced by the participant
  identity, and an account identity change disposes the matches of the
  previous identity at once.
- **Readiness (QUE-05, QUE-06).** The own-agent check happens before the
  entry is created, so no search time elapses during the check. A failed
  check blocks the entry and offers Retry or an explicit Play yourself; no
  seat is ever substituted silently.
- **Fallback (QUE-11, QUE-12, QUE-13).** The engine prepares during the
  search and its failure never blocks the search. At the cutoff a compatible
  candidate wins over the engine, including a candidate at exactly the cutoff
  instant. Retry readies the engine and checks once more before the fallback
  is committed. Keep searching explicitly removes the cutoff. The first
  canonical assignment wins: a late candidate, a late engine readiness or a
  reconnected tab never replaces a committed opponent.
- **Fixed entry (QUE-07, QUE-14).** A frozen or disconnected waiting entry
  expires and needs an explicit rejoin. The queue always uses the standard
  position and the clock the owner selected; a friend position never enters a
  queue entry, and the browser never asks for a color.

## The review findings this slice fixed

| Finding | Correction | Regression |
| --- | --- | --- |
| F-12 — a lost fallback answer was never reconciled, so a retry could commit a second game | the entry is re-read before every decision that could create a game, and a committed assignment is adopted | `src/online/readiness.test.ts` "a lost answer never creates a second game (F-12)" |
| F-13 — a refused cancellation still reported "cancelled" | only a confirmed cancellation reports the cancelled phase; a refusal keeps the committed opponent and reads the entry | `src/online/readiness.test.ts` "a refused cancellation keeps the committed opponent (F-13)" |
| F-19 — a missing opponent seat was declared as a human opponent | the control is null when the participant view does not name the opponent seat | `src/online/readiness.test.ts` "never declares an opponent control the view does not name" |
| F-20 — the interface note documented the old rollout rule | the note now states the two default-off switches, the always-mounted features route and the loopback-only opt-in | `docs/online/workspace-interfaces.md` |
| Reviewer finding — the runner lease body did not match the service | the client sends the strict body of the participant API (`action`, `seat`, `runnerId`, `leaseId`, `turnVersion`, `controlEpoch`) on `POST /runner/lease` | `src/online/runner-lease.test.ts` |
| Reviewer finding — the engine waited for the main clock, so it never moved the first reply | the turn is decided by the canonical position and the opening reply window | `src/online/engine-seat.test.ts` "whose turn it is" |
| Reviewer finding — the engine searched the current position without the history | the engine searches the starting position and the accepted UCI moves | `src/online/engine-seat.test.ts` "takes a lease, searches the canonical history" |

## What was actually executed

| Check | Command | Result |
| --- | --- | --- |
| Type check | `corepack pnpm exec tsc -p tsconfig.app.json` | passed, no diagnostics |
| Lint | `corepack pnpm exec eslint . --max-warnings 0` | passed, no findings |
| Fixtures | `corepack pnpm test` | 998 tests in 85 files passed (908 before this slice) |
| Online fixtures | `corepack pnpm vitest run src/online src/ui` | 310 tests in 26 files passed |
| Browser suite | `corepack pnpm exec playwright test` (local config, preview on the loopback) | 77 tests passed, including the 4 new online ones |

The new browser cases are in `tests/e2e/online-workspace.spec.ts`: the online
screen is reachable, the closed surfaces offer no entry, the offline game
survives the visit, the screen fits a 390 pixel viewport, and the icon
actions keep their accessible name, their hover label and a visible focus.

## The limits of this evidence

- **No online service was reachable.** The fixtures drive the browser modules
  through injected ports and a local fetch double. The queue, the invitation
  and the replay routes are implemented by the matching, queue and privacy
  workers; this slice only calls them.
- **No real match was played online.** The engine seat is covered by a
  fixture that proves the lease, the canonical search and the fenced command;
  the actual browser engine answered a real move only in the offline suite.
- **No native, screen-reader or touch acceptance.** The browser cases use
  Chromium and the keyboard only. UX-02 and the native criteria of UX-04
  remain open.
- **No PostgreSQL regression belongs to this slice.** The browser modules
  own no storage. The service-side integration fixtures of the peer workers
  cover the shared schema.
- **The engine seat authority is isolated in the browser only.** The browser
  holds the engine seat credential of the fallback answer and uses it for
  that seat alone. The service still issues a full seat credential, so a
  move-only capability for the engine seat remains with the foundation and
  matching owners (F-10).
- **The provider runner is not wired yet.** The runner lease client is
  published for the provider runner worker
  (`src/online/runner-lease.ts`), and the engine seat uses it. The agent seat
  of an online match waits for that worker's module.

## The interfaces the peers read

`docs/online/workspace-interfaces.md` publishes the routes and the module
boundaries of this slice: the features route, the queue routes, the runner
lease body, the command envelope with its optional `leaseId`, the feature
switches and the privacy port.
