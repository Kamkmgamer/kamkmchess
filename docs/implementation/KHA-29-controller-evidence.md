# KHA-29 serialized controller core evidence

## Status and boundary

This branch publishes the deterministic controller core on the public `59ec885598cd45c223bc5656de5638ee3b8587f7` base. It does not complete the full KHA-29 issue, certify product acceptance, or claim a playable application. The placeholder UI does not call the controller.

The controller exports `getOrCreateGameController`, `modelConfigurationIdentity`, its setup, fence, snapshot, intent, request and result types, and `GameControllerError`. One controller is registered per game ID for the page lifetime. Its operations are `initialize`, versioned `dispatch`, `reconcile`, `snapshot` and `subscribe`. Setup supports White, Black or Random human-side selection, a diagnostic-passed model selection, a guest or account namespace, an ownership epoch, optional strict FEN and optional time control. The default is 15+10.

Requests and move intents carry a fence for game, segment, side, checkpoint revision, board-position revision, request and analysis generations, ownership epoch, and secret-free model configuration identity. The controller serializes intents and checks persisted revision and epoch. The storage decision hook samples time immediately before the checkpoint write. Deadline equality expires. A predeadline move can commit later, but the delay is charged to the next clock bank. The controller publishes only after the storage transaction completes. An aborted transaction grants no move or increment.

Accepted move events retain elapsed charge, increment credit, the next clock anchor, and monotonic, wall and optional host-offset references. Restore remains non-actionable until absence reconciliation commits. Checkmate, stalemate, threefold repetition and the 50-move rule latch an immutable result with a paused final clock that preserves the remaining banks. This slice does not settle exact deadness or proof-based pending results.

## Source and dependency boundary

The branch starts at public commit `59ec885598cd45c223bc5656de5638ee3b8587f7`. It does not contain private foundation commit `2408ee1` in its ancestry. The two controller files were copied byte for byte from `a178753f4b45ae0b19d3e664c9f0fdc5dab8fca4`:

| Source path | Git blob at `a178753` and this branch |
| --- | --- |
| `src/controller/index.ts` | `bbec235a5ddc09b162914a95f40f1026cc8ece28` |
| `src/controller/index.test.ts` | `cdf6b18fc66fd26a1743d72d653da3ce8458d8d9` |

The shared public build inputs match root integration commit `3bcfe7aacb9d56771dbf8c1f242e204ca3c1aed3`. The only shared input paths added between the public base and that integration commit are the two controller files above, and their blobs match. The package files, scripts, public assets and build configuration match. The public base's proof-search, storage and provider protocol source remains unchanged.

## Review record

The final r3 spec review by DeepSeek and the final r3 standards review by DeepSeek were clear. The standards report documents no breaches. It lists code smell judgments as advisory. An earlier Luna standards review found no documented breach; its smell judgments also remain advisory. The GLM standards attempt failed because its endpoint was unavailable and was replaced by the DeepSeek review. This evidence does not claim a GLM pass.

The spec review records the fixes for the first observed preaction clock discrepancy, blocked intents after discrepancy detection, abort and retry behavior, restored-clock recovery through a committed reconciliation, and rejection of an unknown intent before time sampling or writes. The carried readiness advisory remains: a persisted timeout can have readiness `ready` while `checkpoint.result` is pending. Callers must inspect the result. This branch adds no readiness state and does not refactor the controller.

## Verification record

The root integration run passed all 26 controller fixtures against the accepted storage, graph and protocol dependencies. Those results are reused here because the controller bytes and shared runtime/build inputs match root commit `3bcfe7aacb9d56771dbf8c1f242e204ca3c1aed3`.

The root's 195 base cases were verified across one 194 case full attempt and one targeted correctness fixture after the test runner's 30 second guard fix. This was not one full 195 case green run. Root typechecking, distribution notice generation and targeted ESLint passed. The controller author's earlier 106 case run used the previous dependency set and is historical evidence only. This candidate does not claim one new 221 case full suite run.

The candidate install and production build results, including the committed archive path and hashes, are recorded in the artifact section of this evidence. The production build typechecks the browser and Node TypeScript projects, builds the static placeholder, and generates the dependency notices.

The repository's acceptance matrix has 79 cases, all `not_run`. The KHA-29 trace `MOV-08`, `CLK-01`, `CLK-02`, `CLK-03`, `CLK-04`, `CLK-05`, `CLK-07` and `LIF-02` remains `not_run`. Deterministic fixtures do not certify native browser, sleep or closure behavior, live providers, assistive technology, or the full product.

## Separate work

KHA-36 owns reply parsing, protocol completion and move attempt budgets. KHA-33 owns full Undo behavior and budget restoration. KHA-32 owns exact deadness and proof settlement for pending results. The UI remains unwired. Native and live certification remain unrun. These boundaries keep the claim to the controller core.
