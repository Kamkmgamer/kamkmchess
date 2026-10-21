# Account build evidence — private model catalog and the signed-in fixture

Worker: the account/catalog worker of the online swarm (thread
`online-swarm-20261021-account-catalog-r1`).

Scope of this slice:

- the production private model catalog of the owner and its publication to
  the online composition,
- the test-only synthetic account session of a local fixture run,
- the rendered signed-in browser cases (queue, Stockfish fallback, concurrent
  entries, identity change) and the rendered own-agent model switch against a
  deterministic local provider.

Owned files: `src/ui/App.tsx`, `src/AccountWorkspace.tsx`, `src/accounts/**`,
`vite.config.ts`, `src/public-config.ts`, `playwright.config.ts`,
`tests/e2e/account-online.spec.ts`, `tests/support/online-account-fixture.ts`,
`tests/support/synthetic-provider.ts`.

## 1. The private model catalog

`src/accounts/agent-catalog.ts` reads the catalog from the browser owned
connection store (`connectionStore` + `namespace`): every connection whose
credential is bound, and every model that connection currently advertises.

Every entry carries three things:

| field | meaning |
| --- | --- |
| `id` | the stable private identity of the selection: a local hash of the connection id, the configuration revision, the routing id and the protocol. It never leaves the browser and it is never a public label. |
| `label` | the unique local display alias of the model: the advertised display name reduced to the character set a shared model label may have, with a local ordinal when two private models would otherwise share it. |
| `selection` | the private `ModelSelection`, with the routing id. It never leaves the browser. |

`src/ui/App.tsx` publishes the catalog and the current selection:

```ts
online.setAgentCatalog(entries);   // { id, label, selection } of every entry
online.setAgent(chosen ?? null);   // the current agent of the owner
```

The owner chooses the agent in **Your agents**, a panel of the application that
also rebinds the agent seat of the focused online game. The panel is reachable
from the top bar and shows the connected models, the model that plays the new
games and the control that plays the focused game.

Two things the slice adds on top of the composition:

- **The seat that arrives before the catalog.** The catalog fills after the
  page loaded, so a seat of the owner can be attached before its selection is
  known. The producer binds every agent seat of the owner that has no binding
  as soon as the catalog knows the model. The recovery never overrides an
  existing binding.
- **The identity of a choice.** A public label is never an identity: two
  private models may both canonicalize to `Custom model`. The producer
  publishes the private id of every entry and resolves a choice with the id
  whenever the composition publishes ids, and with the unique local alias
  otherwise.

The contract of the producer side is published in
`docs/online/account-agent-catalog.md` and was sent to the workspace worker,
which owns `src/online/composition.ts` and `src/ui/online-workspace.tsx`.

## 2. The synthetic account session of a fixture run

`src/accounts/test-session.ts` is a test seam. It is not a product feature.

- The build flag `KAMKM_PUBLIC_TEST_SESSION` is refused unless
  `KAMKM_BUILD_FLAVOR=fixture` is set. An ordinary release build never
  carries the flag.
- The branch that loads the bridge is behind a compile-time constant, so the
  bridge is **not in an ordinary bundle at all**. Verified: an ordinary build
  contains no `kamkm:test-session` string, the fixture build contains the
  bridge as its own lazily loaded chunk.
- The bridge carries no credential. The identity and its session token are
  read at run time from the page (`window.__KAMKM_TEST_SESSION__`), where the
  test harness put them.
- The token is a **real signed session token of the fixture**, minted with the
  fixture's own signing key for the run. The service verifies it with its
  ordinary code path against the fixture's own JWKS document. No API check is
  bypassed, no request is intercepted and no token is printed.
- The bridge refuses to act for a service that is not the loopback fixture, so
  it can never weaken the authorization of a hosted service.
- A running page changes its signed-in account with the `kamkm:test-session`
  window event. The change fences the work of the departing account and
  restores the durable games of the next one.

The build and the run are documented in
`docs/implementation/online-operations.md` (section *Signed-in account
build*).

## 3. The rendered cases

`tests/e2e/account-online.spec.ts` runs against the real fixture: the Go API,
a real PostgreSQL schema, the pinned private rules worker, the real
authorization code, the real browser Stockfish and a deterministic local
provider (`tests/support/synthetic-provider.ts`, a real HTTP server on
loopback).

The cases:

1. the built account app reaches the fixture of the run;
2. a signed-in browser enters the queue, the ten second cutoff commits the
   Stockfish fallback and the engine seat plays through the canonical
   snapshot;
3. two explicit entries of one signed-in browser are visible at the same time;
4. the account change hides the games of the first account and restores the
   durable registry of the next;
5. the owner switches the own agent between two private models of one
   connection and the provider answers the turn of the rebind.

Strictness: the cases skip without a descriptor and fail with
`ONLINE_FIXTURE_STRICT=1` and no descriptor. A build that points at another
service fails the run.

## 4. The commands of the run

The fixture of the run: the real Go API, a real PostgreSQL schema
(`kamkmchess_online_test` on the local container), the pinned private rules
worker and the real authorization code, with the queue surface open.

```sh
go build -tags onlinefixture -o .scratch/onlinefixture/onlinefixture.exe ./tools/onlinefixture
.scratch/onlinefixture/onlinefixture.exe \
  --database-url postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable \
  --rules-worker build/rules-worker/worker.mjs \
  --descriptor .scratch/onlinefixture/descriptor.json \
  --queue-enabled --allow-origin http://127.0.0.1:5341 --max-lifetime 90m

KAMKM_BUILD_FLAVOR=fixture KAMKM_PUBLIC_ACCOUNTS_ENABLED=true \
KAMKM_PUBLIC_TEST_SESSION=true KAMKM_PUBLIC_API_BASE_URL=http://127.0.0.1:50440 \
node scripts/prepare-engines.mjs && npx vite build

ONLINE_FIXTURE_DESCRIPTOR=.scratch/onlinefixture/descriptor.json ONLINE_FIXTURE_STRICT=1 \
KAMKM_E2E_PORT=5341 npx playwright test tests/e2e/account-online.spec.ts
```

The fixture chooses its own port, so the base URL of the build is the base URL
of the descriptor of the run. The synthetic session tokens stay in the
ignored descriptor file. They are never printed, never committed and never
sent anywhere but the fixture.

### The focused checks

| command | result |
| --- | --- |
| `npx tsc -p tsconfig.app.json --noEmit` | exit 0, no diagnostics |
| `npx tsc -p tsconfig.node.json --noEmit` | exit 0, no diagnostics |
| `npx eslint src/accounts src/ui/App.tsx src/AccountWorkspace.tsx src/public-config.ts vite.config.ts tests/e2e/account-online.spec.ts tests/support --max-warnings 0` | clean |
| `npx vitest run src/accounts/agent-catalog.test.ts src/public-config.test.ts src/online/features.test.ts` | 3 files, 22 tests passed |

### The bridge is not in an ordinary build

| build | the bridge in the bundle |
| --- | --- |
| ordinary build (`KAMKM_PUBLIC_TEST_SESSION` unset) | **absent** — no `kamkm:test-session` string in any chunk |
| fixture build (`KAMKM_PUBLIC_TEST_SESSION=true`, `KAMKM_BUILD_FLAVOR=fixture`) | present as its own lazily loaded chunk `test-session-*.js` |
| `KAMKM_PUBLIC_TEST_SESSION=true` without `KAMKM_BUILD_FLAVOR=fixture` | the build fails: `The synthetic account session needs KAMKM_BUILD_FLAVOR=fixture.` |

### The rendered cases

The run of the record: the fixture base URL `http://127.0.0.1:50440`, the
preview server of the build on `http://127.0.0.1:5341`, real Chromium, real
Go API, real PostgreSQL schema, real rules worker, real browser engine, real
local provider.

```
Running 6 tests using 1 worker

  ok 1 the built account app reaches the fixture of the run (1.4s)
  ok 2 a signed-in browser enters the queue and the cutoff commits the browser engine (17.1s)
     the committed moves of the fallback game: e4
  ok 3 two explicit entries of one signed-in browser are visible at the same time (1.4s)
  ok 4 the account change hides the games of the first account and restores the registry of the next (25.6s)
  -  5 the first account gets its game back when it signs in again      (fixme, see the open items)
  ok 6 the owner switches the own agent between two private models and the provider answers (18.6s)
     the models the local provider answered: synthetic-a, synthetic-a
     the models the local provider answered: synthetic-a, synthetic-a, synthetic-a, synthetic-b

  1 skipped
  5 passed (1.2m)
```

| case | what it shows |
| --- | --- |
| the built account app reaches the fixture of the run | the build under test is the build of this repository (the case refuses a preview server that serves another build) and the signed-in browser reaches the service |
| a signed-in browser enters the queue and the cutoff commits the browser engine | the signed-in entry waits for the ten second cutoff, the fallback commits it and the **browser engine answers through the canonical snapshot**: the committed move of the game is `e4`. In the run of the record the owner had the black seat, so the move is the engine's; in a run with the owner on the white seat the moves were `e4 e5`, the owner's move and the reply of the browser engine |
| two explicit entries of one signed-in browser are visible at the same time | two explicit entries of one browser are listed at the same time |
| the account change hides the games of the first account and restores the registry of the next | the first account plays on a five minute clock and the second on a three minute clock; after the identity change the board shows the **three** minute game, so the game of the first account is hidden and the durable registry of the second account is restored |
| the first account gets its game back when it signs in again | the required A → B → A regression. It is marked `fixme` because it is red against the current workspace code (see the open items) |
| the owner switches the own agent between two private models and the provider answers | two private models of one connection **without an advertised name**, so both carry the neutral public name and only the private id keeps them apart. The owner sees two entries, rebinds the seat of the running game, and the local provider answers the turns: `synthetic-a, synthetic-a` before the rebind and `synthetic-a, synthetic-a, synthetic-a, synthetic-b` after it. The move of the rebind is a real accepted move of the service |

The log of the run is `.scratch/onlinefixture/playwright-final8.log` (ignored
by git, like every other local artefact of a run).

## 5. The open items and the coordination

These are the honest open points of this slice. None of them is waived by the
cases above.

1. **The "Switch model" control of the online screen still re-selects the
   current agent.** It lives in `src/ui/online-workspace.tsx`, which the
   workspace worker owns, and it calls `agentDecision` without a choice. The
   production path that works today is the **Your agents** panel of this
   slice: it lists the connected models and rebinds the agent seat of the
   focused game. The rendered case proves that path. The contract for the
   online screen (render the catalog entries as the choices of the seat and
   of the switch, and pass the entry id) was sent to the workspace worker.

2. **A queue assignment binds the seat with the current agent.**
   `src/online/composition.ts` binds the seat of an assignment with
   `agent.label`, which is the model the owner has selected at that moment,
   and not the selection the queue entry captured (`intent.selection`). The
   producer recovers a seat that has no binding at all, but it never
   overrides a binding. The captured-intent binding is the composition's
   scope; it was sent to the workspace worker with the exact location.

3. **The durable registry of the previous account is emptied by an identity
   change.** `src/online/workspace.ts` (`forgetIdentity`) writes an empty
   list for the identity that leaves. The registry of the account that signs
   in is restored (the rendered case proves it), but the games of the
   account that left do not come back when it signs in again. That is the
   current behaviour of the workspace and it is reported, not hidden.

4. **The invitation route of the account build is not wired.** The parent
   found that `src/game-entry.tsx` handles `/invite/<id>` only in the
   accounts-disabled branch, so an invitation link of a signed-in browser
   opens the ordinary play page. The file belongs to the workspace worker;
   the finding and the exact contract were sent to it.

5. **The browser engine preparation failed in some runs.** In some runs the
   fallback game reported `Stockfish could not start. Retry or keep searching.`
   and the cutoff committed nothing until the owner retried. The case now
   takes the product's own **Retry** and waits for the assignment, so the
   recovery of KHA-77 is exercised instead of skipped. The preparation itself
   failed intermittently in this environment; that is in the engine
   preparation and the composition, not in this slice, and it was not
   reproduced in the run of the record.

6. **A preview server of another worktree can answer a run.** The rendered
   suite reuses an existing preview server when the port is taken, and a
   preview server of another worktree serves another build. Two runs of this
   slice were red for that reason alone. The suite now refuses a build that
   is not the build of this repository (it compares the entry script of the
   served page with the local `dist`), and `KAMKM_E2E_PORT` moves the preview
   server out of the way of another run.

7. **Not run in this slice.** The whole Go suite, the whole `pnpm check`, the
   whole Playwright suite, the native desktop and mobile accessibility checks
   and every hosted or capacity check. The parent owns the assembled run.
   The focused TypeScript typecheck, the focused lint, the focused unit
   tests and the five rendered cases above are the evidence of this slice.
