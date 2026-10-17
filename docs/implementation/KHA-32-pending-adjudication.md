# KHA-32 pending adjudication

Ticket: [Integrate exact endings and saved pending adjudication](https://linear.app/kamkm/issue/KHA-32/integrate-exact-endings-and-saved-pending-adjudication).

The controller now separates board classification from starting a game. A new
nonterminal setup saves a canonical deadness query and unstarted clocks. A checked
non-dead result enables the diagnostic/start step; `startGame` requires a passed
current-session diagnostic. A terminal setup or checked dead position cannot start
generation. Editing a setup is performed by creating a separate game ID, leaving
the source game intact.

During play, position-entry and timeout candidates retain their original event
IDs and times in the versioned `adjudication` checkpoint extension. Pending
analysis blocks moves and model requests while any unexpired active clock
continues. Expiry is a recorded fact rather than an assumed loss. The controller
settles the earlier unresolved candidate first and independently checks evidence
before accepting an exact result. Accepted final results remain immutable.

`continueAdjudication` durably authorizes one analysis request and returns its
query, request ID and fence. `stopAdjudication` fences late replies.
`acceptAdjudicationResult` accepts only the authorized request for the same game,
segment, position, generation and ownership. Snapshot adjudication status exposes
pending, running, stopped and setup-ready states without a completion estimate.

`createAdjudicationAnalysisRunner` runs one bounded Worker pass per explicit
Continue, defaulting to 10,000 discovered states and five seconds. It saves
validated search checkpoints in the separate proof-search database and resumes
compatible checkpoints. Errors and exhausted limits remain non-results.
`createControllerAnalysis` connects the controller authorization to that runner,
cancels execution when its fence changes, and sends results back through the
controller's checked acceptance path. Its Stop persists the fence before
cancelling the Worker. It schedules no repeated passes.

The controller and runner are implemented here as reusable application modules.
The React page remains a placeholder and does not invoke them. GPT-6 Luna's
standards and specification reviews both called out that setup classification
and Continue/Stop are not yet reachable as a user journey. The controller API
supports those actions, but UI journey acceptance is not claimed by this
change. Search proofs remain local and never enter model prompts or the Go API.

## Verification

The baseline from `main` at `3fa3730` passed 278 tests before changes. The final
`pnpm check` passed: lint clean, 22 test files and 294 tests passed, both TypeScript
projects typechecked, and the Vite production build plus distribution notices
completed. `git diff --check` passed.

The [browser helper](../../experiments/adjudication-controller/README.md) passed
in Chrome 154 against Vite 8.3.4. It exercised the real module Worker and native
IndexedDB close/reopen: unknown setup stayed pending with clocks unstarted, a
bounded pass stayed pending, and the resumed checked deadness proof settled the
original position-entry event as a durable draw. The helper is the retained
reproduction artifact; no screenshot or recording was retained. This is
development-server evidence, not deployed or native product acceptance.

Two independent GPT-6 Luna reviews verified the earlier reconciliation, expiry
ordering, restored-query binding and documentation findings. Both identified the
unwired React page as an outstanding product-journey gap. The acceptance matrix
remains `not_run` for the UI journeys, native/assistive-technology, live-provider
and hosted-account runs; controller fixtures and the browser helper do not certify
those journeys.
