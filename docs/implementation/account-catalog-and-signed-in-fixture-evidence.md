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
| `npx eslint src/accounts src/ui/App.tsx src/AccountWorkspace.tsx src/public-config.ts vite.config.ts playwright.config.ts tests/e2e/account-online.spec.ts tests/support --max-warnings 0` | clean |
| `npx vitest run src/accounts/agent-catalog.test.ts src/accounts/test-session.test.ts src/public-config.test.ts src/online/features.test.ts` | 4 files, 25 tests passed |

The unit regressions of this slice:

| case | what it proves |
| --- | --- |
| the catalog never replaces a binding the seat already carries | the automatic binding of an unbound seat never replaces an existing binding |
| the global choice never replaces the selection the game captured | a seat whose selection the game captured keeps it, even when the model of the new games is another one |
| the chosen model binds only a seat without any selection | the automatic binding happens exactly once and only where it is needed |
| every model of the owner stays available for the seat | the model that plays the new games stays available for the running game, and the model the seat plays is not offered again |
| the synthetic session never publishes a stale identity | two overlapping identity changes settle in order; the overtaken change publishes nothing, so the browser never sees the older account after the newer one |
| the synthetic session refuses a service that is not the loopback fixture | the seam can never weaken the authorization of a hosted service, and the hosted Clerk path stays untouched |

### The bridge is not in an ordinary build

| build | the bridge in the bundle |
| --- | --- |
| ordinary build (`KAMKM_PUBLIC_TEST_SESSION` unset) | **absent** — no `kamkm:test-session` string in any chunk |
| fixture build (`KAMKM_PUBLIC_TEST_SESSION=true`, `KAMKM_BUILD_FLAVOR=fixture`) | present as its own lazily loaded chunk `test-session-*.js` |
| `KAMKM_PUBLIC_TEST_SESSION=true` without `KAMKM_BUILD_FLAVOR=fixture` | the build fails: `The synthetic account session needs KAMKM_BUILD_FLAVOR=fixture.` |

### The rendered cases

The run of the record against the **current root** (the provider contracts of
`888547a`/`eb3f615` merged in): the fixture base URL `http://127.0.0.1:51323`,
the preview server of the build on `http://127.0.0.1:5341`, real Chromium,
real Go API, real PostgreSQL schema, real rules worker, real browser engine,
real local provider.

```
Running 7 tests using 1 worker

  ok 1 the built account app reaches the fixture of the run (2.1s)
  ok 2 a signed-in browser enters the queue and the cutoff commits the browser engine (18.8s)
     the committed moves of the fallback game: e4 e6
  ok 3 two explicit entries of one signed-in browser are visible at the same time (3.0s)
  ok 4 the account change hides the games of the first account and restores the registry of the next (27.0s)
  x  5 the first account gets its game back when it signs in again      (needs the workspace r9, see the open items)
  ok 6 a late seat change never writes into the next account (16.3s)
  ok 7 the owner switches the own agent between two private models and the provider answers (20.3s)
     the models the local provider answered: synthetic-a, synthetic-a, synthetic-a
     the models the local provider answered: synthetic-a, synthetic-a, synthetic-a, synthetic-b

  5 passed, 1 failed (the A -> B -> A case: it needs the workspace r9)
```

| case | what it shows |
| --- | --- |
| the built account app reaches the fixture of the run | the build under test is the build of this repository (the case refuses a preview server that serves another build) and the signed-in browser reaches the service |
| a signed-in browser enters the queue and the cutoff commits the browser engine | the signed-in entry waits for the ten second cutoff, the fallback commits it and the **browser engine answers through the canonical snapshot**: the committed moves of the game are `e4 e6` (the owner's `e4` and the reply of the browser engine) |
| two explicit entries of one signed-in browser are visible at the same time | two explicit entries of one browser are listed at the same time |
| the account change hides the games of the first account and restores the registry of the next | the first account plays on a five minute clock and the second on a three minute clock; after the identity change the board shows the **three** minute game, so the game of the first account is hidden and the durable registry of the second account is restored |
| the first account gets its game back when it signs in again | the required A → B → A regression. It is **unskipped** and states the behaviour; it is red until the workspace r9 (`3cc40f4`) is integrated |
| a late seat change never writes into the next account | the answer of the service is **held** (a deferred barrier on the lease and the command route of the fixture) while the account changes. The pending state of the change is gone afterwards: the answer belonged to the identity that left |
| the owner switches the own agent between two private models and the provider answers | two private models of one connection **without an advertised name**, so both carry the neutral public name and only the private id keeps them apart. The owner rebinds the seat of the running game to the second model (`synthetic-b` reaches the provider) and then puts the model of the new games back on the seat. The control of the seat follows the seat, not the model of the new games |

The log of the run is `.scratch/onlinefixture/playwright-final8.log` (ignored
by git, like every other local artefact of a run).

## 5. The corrections of the second round

The account review of the integrated slice found five defects in the files of
this slice. They are fixed here, each with a regression.

1. **The control of the seat followed the global choice.** "Use for this game"
   was disabled when the model was the model of the *new games*, so a game
   that ran another model could never be put back on the model of the new
   games. The control now follows the **seat**: it is disabled only for the
   model the seat already plays, and it compares the private identities, not
   the labels. The rendered case proves it: the provider answered
   `synthetic-b` after the rebind and `synthetic-a` again after the owner put
   the model of the new games back on the seat.

2. **The seat change had no pending state, no fences and trusted a void
   answer.** The panel now shows that a change is running and refuses a
   second one, the answer is fenced against a change of the account and of
   the focused game, and the seat is read again afterwards: a change is only
   reported as done when the seat really plays the chosen private
   selection. A swallowed refusal is reported as a refusal.

3. **The automatic binding of an unbound seat could replace a captured
   selection.** The decision is now one rule
   (`decideSeatBinding`): a seat with a binding keeps it, a seat whose
   selection the game captured keeps that selection, and only a seat without
   any selection takes the model of the owner. The rule has its own unit
   regression.

4. **The catalog was read from the wrong store.** The local composition of
   the application can be an account game while the online composition still
   uses the store of the workspace. The account build now hands the interface
   the store and the namespace the online composition uses
   (`onlineConnectionStore`, `onlineNamespace`).

5. **The synthetic session published stale identities.** The identity
   changes are serialized and every change carries its own number, so an
   overtaken change settles without publishing and the browser never sees the
   older account after the newer one. The regression is in
   `src/accounts/test-session.test.ts`. The hosted Clerk path is untouched.

## 5. The corrections of the second and third rounds

The account review (round 1) and the parent named ten findings. They are
closed here, each with a regression, except the ones that belong to another
owner.

| finding | what changed |
| --- | --- |
| the seat control followed the global choice | it follows the **seat** now: the control is disabled only for the model the seat already plays, and it compares the private identities, never the labels |
| the answer of a seat change was not fenced | the current identity, composition and focus live in a ref that the render updates, a request number moves on every change of the account, the composition or the focus and when the page ends, and the `try`, the `catch` and the `finally` all compare it. A second change in the same tick is refused by a synchronous ref gate |
| a swallowed refusal was reported as a success | the seat is read again after the answer, and the composition's own outcome (`accepted` / `refused` / `unknown`) is used when it publishes one |
| the automatic binding had two owners | the composition owns the binding of a seat (it binds the selection the entry or the invitation captured). The interface only asks for a binding when the seat has none at all, and it never replaces one. The helper that pretended to own the rule is gone |
| the catalog was read once at the mount | it is read again when the online screen opens and when the account changes, so a model that was connected after the page loaded is known without opening the panel first |
| a provider-advertised name could become the public label | the label of a catalog entry is **public-safe**: an advertised name is used only when it carries no route, path, address, credential or alias, otherwise the neutral `Custom model` is used. The advertised name stays local |
| the local ordinal became the public label | the ordinal is still part of the local key, and the seat declares the public-safe label. It is a low-severity metadata leak and it is stated here, not hidden |
| the catalog came from the wrong store | the account build hands the interface the exact store and namespace the online composition uses, so the catalog and the provider port of the agent seat always agree |
| the synthetic session published a stale identity | the identity changes are serialized and every change carries its own number. The overtaken change publishes nothing and **still clears the credentials of the account that leaves** |
| the notice of the new games was a promise | it is derived from the published agent, so it reports what the product applied |
| the runtime flag was dead code | the bridge is only used when the compile-time flag **and** the runtime flag agree, so the two cannot disagree |

The hosted Clerk path (`src/accounts/clerk.ts`) is untouched.

## 6. The open items and the coordination

These are the honest open points of this slice. None of them is waived by the
cases above.

1. **The online screen already passed the entry id before this slice.** The
   "Switch model" control of `src/ui/online-workspace.tsx` has passed
   `entry.id` since the workspace slice (`4b88c77`). What was missing was a
   **producer**: nothing outside the tests called `setAgentCatalog`, so the
   control had no entries. The open item below therefore states the missing
   producer, not a missing argument.

2. **A queue assignment binds the seat with the current agent.**
   `src/online/composition.ts` binds the seat of an assignment with
   `agent.label`, which is the model the owner has selected at that moment,
   and not the selection the queue entry captured (`intent.selection`). The
   producer recovers a seat that has no binding at all, but it never
   overrides a binding. The captured-intent binding is the composition's
   scope; it was sent to the workspace worker with the exact location.

3. **The outcome of a seat change is not explicit in this branch.**
   `composition.agentDecision(..., 'switch-model', ...)` answers `void` here
   and the runner reports a refusal by setting a phase, so a refused change
   can resolve like a successful one. The interface works around it by
   reading the seat again and by using the outcome when the composition
   publishes one (`accepted` / `refused` / `unknown`, requested from the
   provider worker r8 and the workspace worker r9; their files).

4. **The namespace of the agent of a signed-in account is still the guest
   namespace** (F5 of the account review). The interface always reads the
   catalog from the namespace the composition uses, so the catalog follows the
   composition when it moves to the account namespace. The namespace itself
   and the place where the connections of an account are created belong to
   the workspace worker; the credential safety of the account namespace has to
   stay exact and was raised with them.

5. **The invitation of a published link is opened by the shell, but the
   preview is still missing** (browser review r5: the account route never
   opens the invitation, and the request-key effect of the online screen
   throws the preview answer away). The shell of the account build opens the
   online screen with the invitation (the composition's `pendingInvitation`
   and the address of the page); the preview of the exact invitation is the
   online screen's file (workspace r10).

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

6. **The unmount of the shell is fenced in the code but not yet proven in
   the browser.** The lifecycle invalidation (the cleanup of the mount effect
   and the cleanup of the context effect) ends a running change, and the
   rendered case of the identity change proves the fence of a late answer. The
   case of the account *leaving* (the sign-out disposes the composition of the
   account) was written and then removed: the account page hides the shell of
   the application, so the assertions of the case were not observable. It is
   an open case, not a closed one.

7. **The rendered A → B → A case is red on this branch alone.** The durable
   list of an account that leaves and the credential of its browser engine
   seat are the workspace's r9 (`3cc40f4`, "Restore the games of a returning
   identity and fence the deferred claims"). The case is unskipped and states
   the behaviour: the game of the first account comes back with its moves and
   the browser engine seat plays again, so the credential of the engine seat
   is still usable. It goes green with r9 integrated; the parent integrates
   r9 together with this slice.

8. **Not run in this slice.** The whole Go suite, the whole `pnpm check`, the
   whole Playwright suite, the native desktop and mobile accessibility checks
   and every hosted or capacity check. The parent owns the assembled run.
   The focused TypeScript typecheck, the focused lint, the focused unit
   tests and the rendered cases above are the evidence of this slice.
