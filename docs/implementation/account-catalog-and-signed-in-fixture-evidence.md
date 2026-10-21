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

### The rendered cases (final state, combined content)

The tested tree: the root `abb47fd` (which carries the provider candidate
`3133c3b` and the nine account paths of this slice) **merged with** the scoped
correction of this slice. The fixture of the run is a fresh local instance of
the real service composition (the Go API, a real PostgreSQL schema, the pinned
rules worker, the real authorization code, the real browser engine) with the
queue open.

```
ONLINE_FIXTURE_DESCRIPTOR=.scratch/onlinefixture/descriptor.json
ONLINE_FIXTURE_STRICT=1 KAMKM_E2E_PORT=5353
npx playwright test tests/e2e/account-online.spec.ts
```

| case | result |
| --- | --- |
| the built account app reaches the fixture of the run | **passed** |
| a signed-in browser enters the queue and the cutoff commits the browser engine | **passed** (`e4 e6`) |
| two explicit entries of one signed-in browser are visible at the same time | **passed** |
| the account change hides the games of the first account and restores the registry of the next | **passed** |
| the first account gets its game back when it signs in again | **failed** — the engine seat of the restored game answers `404`; the durable list itself works (the game returns with its moves). Owner: workspace `13` (`da3cb1a`), not yet in the root |
| a late seat change never writes into the next account | **passed** (the answer of the service is held while the account changes) |
| the owner switches the own agent between two private models and the provider answers | **failed** — the service refuses the switch of the seat with `409 Conflict`, so the seat keeps its model and the interface reports the refusal. Owner: provider `fresh4` |

The account connect, the catalog and the readiness are proven in the browser
against the combined content:

```
the requests of the local provider: [{"path":"/v1/models","authorized":false},
                                     {"path":"/v1/models","authorized":true}]
the models the local provider answered: synthetic-a, synthetic-a
```

The credential of the account is asserted on **every** request of the provider
that is not the preflight and not the catalog, and on **every** generation
request (the provider records a refused attempt before it refuses it, so an
unauthorized attempt is part of the set and fails the case). The case asserts
the guest namespace is empty, the account namespace holds the profile, its
credential and the two advertised models, and the seat of the owner declares
the neutral public label.

## 5. The corrections of the second, third and fourth rounds

The account review (round 1) and the parent named ten findings, and the
browser review (round 5) added the invitation route. They are closed here,
each with a regression, except the ones that belong to another owner.

| finding | what changed |
| --- | --- |
| the seat control followed the global choice | it follows the **seat** now: the control is disabled only for the model the seat already plays, and it compares the private identities, never the labels |
| the fence compared one closure's values | the current `online`, `accountIdentity`, `focusedMatchId` **and the generation of the identity** live in a ref that the render updates. The generation is **captured before the request** and compared after every await, in the `catch` and in the `finally`, so an identity that left and came back cannot be mistaken for the one that is signed in now |
| a swallowed refusal read as success | the seat is read again after the answer and the strict `AgentDecisionOutcome` of the composition decides what the owner is told |
| the automatic binding had two owners | the composition owns the binding of a seat (it binds the selection the entry or the invitation captured). The interface only asks for a binding when the seat has none at all, and it never replaces one. The helper that pretended to own the rule is gone |
| the catalog was read once at the mount | it is read again when the online screen opens and when the account changes, so a model that was connected after the page loaded is known without opening the panel first |
| a provider-advertised route could become the public label | the public label of a catalog entry is a name the **service knows** (the allowlist of migration `0013_online_public_history.sql`, mirrored in the client). An unknown model is published as the neutral `Custom model`; the advertised name stays with the owner as the local display name and no ordinal is published |
| the catalog came from the wrong store | the account build hands the interface the exact store and namespace the online composition uses |
| the connections of the agent were the guest ones | the namespace is **resolved when a request needs it**: the account build hands the composition, the readiness check and the catalog a resolver that reads the active identity |
| the readiness check read the guest credentials | the check runs with the **service of the namespace it resolves**: the account build keeps a provider service per account and the diagnostic of an account never reads the guest credentials, not even when both use the same profile id. The regression uses the same profile id with a different credential in each namespace |
| the synthetic session published a stale identity | the identity changes are serialized and every change carries its own number. The overtaken change publishes nothing and **still clears the credentials of the account that leaves** |
| the notice of the new games was a promise | it is derived from the published agent, so it reports what the product applied |
| the runtime flag was dead code | the bridge is only used when the compile-time flag **and** the runtime flag agree, so the two cannot disagree |
| the account route never opened the invitation | the shell of the account build opens the online screen for a published link (the composition's `pendingInvitation` and the address of the page) |

The hosted Clerk path (`src/accounts/clerk.ts`) is untouched.

### The bearer credential of the account: the causal chain

The synthetic provider of the rendered cases refuses a generation request
that does not carry exactly `Bearer <the synthetic key of the account>`, and
the case asks for the exact authorization of **every** generation request
(no request is filtered out). The catalog of the connection stays public.

Two causes were found and fixed:

1. The preflight of a request that carries the credential of the connection
   was refused: the provider answered `access-control-allow-headers: *`, and a
   wildcard does not cover the `authorization` request header. The provider
   now answers `authorization, content-type` and keeps the `OPTIONS` handling
   without a credential.
2. The account id of the fixture was not a valid account id, so the
   connection store threw for the account namespace and the interface read the
   guest namespace instead. The rendered cases sign in with an id that the
   store accepts and mint the session token for the same subject.

The later bearer run reached the catalog and made four generation requests
with the account credential. The earlier no-request failure had two causes
in the test interaction. Selecting authentication cleared the key, and the
asynchronous creation of the account game remounted the form. The case now
waits for the opened game, selects authentication, then fills the key. It
asserts the account profile, credential and two catalog entries while the
guest profile store stays empty. That run still failed at the later model
switch with a 409. A full run against the assembled provider and workspace
corrections remains required; the historical results above are not final
assembled evidence.

## 6. The open items and the coordination

1. **The engine seat of a restored game cannot play yet.** The durable list of
   an account that leaves survives (the workspace r9 owns it and it works):
   the game of the first account comes back with its moves. The **engine
   credential** of that game is not usable after the return: the engine command
   answers `404` and the committed moves stay at the move of the owner. The
   rendered case is unskipped and red on exactly that step, so the gap is
   proven in the browser and not only described. The owner of the engine
   recovery is the workspace (r13).

2. **The preview of an invitation is the online screen's file.** The shell
   opens the screen for a published link, but the preview of the exact
   invitation and the request-key effect that throws the preview answer away
   are in `src/ui/online-workspace.tsx` (workspace r10).

3. **The outcome of a seat change is explicit now.** The composition answers
   with `accepted` / `refused` / `unknown` and the interface consumes it
   directly. The provider's runner owns the detail of a handoff that could
   not take the lease (provider r8).

4. **The unmount of the shell is fenced in the code but not yet proven in
   the browser.** The lifecycle invalidation (the cleanup of the mount effect
   and the cleanup of the context effect) ends a running change, and the
   rendered case of the identity change proves the fence of a late answer. The
   case of the account *leaving* was written and then removed: the account
   page hides the shell of the application, so the assertions of the case were
   not observable. It is an open case, not a closed one.

5. **The browser engine preparation is intermittently slow.** In some runs the
   fallback reported `Stockfish could not start`; the rendered cases take the
   product's own **Retry** and the run of the record is green.

6. **Not run in this slice.** The whole Go suite, the whole `pnpm check`, the
   whole Playwright suite, the native desktop and mobile accessibility checks
   and every hosted or capacity check. The parent owns the assembled run.
   The focused TypeScript typecheck, the focused lint, the focused unit
   tests and the rendered cases above are the evidence of this slice.
