# KHA-31 proof search evidence

## Scope and build

Implementation branch: `t3/resumable-cooperative-analysis` in worktree `C:\Users\Lenovo\.t3\worktrees\kamkmchess\t3-9fabe572`.

The required proof and storage source was present at integrated commit `55e5ce84335ac1e474e39ba556777928cbac247d`. KHA-31 adds a pure TypeScript cooperative graph search, a browser Worker entry, and a separate IndexedDB database for validated proof-search checkpoints. Existing proof checker tests, game/archive storage schema, and archive storage files were not changed.

Build environment: Node `v24.22.0`, npm `11.19.1`, Vite `8.3.4`.

Commands: `npm run lint`, `npm run test -- --no-file-parallelism`, and `npm run build`.

Expected: lint, every offline fixture, both TypeScript projects, the production bundle, and distribution notices complete successfully.

Observed: ESLint passed with no warnings. The full Vitest suite passed all 123 tests across 7 files with file parallelism disabled. Both TypeScript projects passed. Vite produced `dist/index.html`, `dist/assets/index-Dn1Kj2XK.css`, and `dist/assets/index-CE2xj8Mp.js` at 219.19 kB (68.45 kB gzip). The notice script wrote `dist/DEPENDENCY_INVENTORY.json`, `dist/LICENSE.txt`, and `dist/THIRD_PARTY_NOTICES.txt`.

The standard parallel `npm run check` was attempted twice. Both runs hit Vitest's five-second wall-time guard in the unchanged 768-state checker fixture while other files ran in parallel. That fixture passed by itself, and the complete suite passed with file parallelism disabled. The checker source and its tests were not changed.

Artifacts: [proof search implementation](../../src/proofs/search/search.ts), [canonical search FEN reconstruction](../../src/proofs/search/state-position.ts), [checkpoint validator](../../src/proofs/search/checkpoint.ts), [Worker entry](../../src/proofs/proof-search.worker.ts), [checkpoint storage adapter](../../src/storage/proof-search.ts), [search fixtures](../../src/proofs/search/search.test.ts), and [storage fixtures](../../src/storage/proof-search.test.ts). The built main app artifacts are under `dist/` in the implementation worktree.

## Behavioral evidence

The tests call the public proof-query/search/checker APIs. They use the existing independently recorded checker fixtures and research counts as expected values.

| Case | Expected | Observed |
| --- | --- | --- |
| Reviewed forced cycle | Complete four-state, four-edge closure; dead | Search returned `accepted/dead` with 4 states and 4 edges. |
| Locked pawn wall from the KHA-25 research | Complete 768-state, 3,808-edge closure; dead | Search returned `accepted/dead` with exactly 768 states and 3,808 edges. The test holds only the monotonic deadline clock stable during this correctness fixture; move generation and checker edge regeneration run normally. |
| One-ply rook-assisted white mate | Checked positive witness for white | Search returned a witness for `d6-f7`; the public checker independently accepted it. |
| Black already delivered checkmate | Checked empty witness for black | Search returned `accepted/mate-reachable` for black. |
| Timeout query | Only the opponent of the expired side may supply a mate witness | The checkmated-black root returned `opponent-can-mate` when black expired, and `opponent-cannot-mate` when white expired. |
| Promotion checkmate | Legal promotion move replays to intended checkmate | Search returned the independently expected bishop promotion `a7-a8=B`. |
| White-to-move usable en-passant root | Search finds a mate and the public checker accepts its witness | The query `8/P7/8/3pP3/8/6K1/4N3/7k w - d6 0 2` returned `accepted/mate-reachable`; `checkProofEvidence` independently accepted the returned witness. |
| En-passant after a black double push | Checkpoint retains the canonical `... w - f6 0 2` position and validates before resume | The `f7-f5` successor appeared in the saved graph, validation returned `valid`, and the next pass returned `checkpointDisposition: resumed`. |
| Altered successor and matching parent | Corrupt progress restarts without a conclusion | Replacing a cycle edge and its parent move with `a1-a2` returned `restart-required`; search returned `invalid-checkpoint` with `checkpointDisposition: restarted`. |
| Prior search implementation checkpoint | Unsupported search versions restart from the saved query | Stored `kha31-cooperative-search/1` data returned `restart-required/incompatible-checkpoint`; the saved query started a fresh pass. |
| Proof store database upgrade | Existing connection closes so another tab can upgrade | The fake IndexedDB upgrade request opened version 2 without a blocked result. |
| Counter-99 position | Hypothetical legal reachability ignores future draw thresholds | Search returned `mate-reachable`; no halfmove cutoff was applied. |
| One-state partial pass | A cutoff remains non-result and can resume | First pass returned `state-budget` with a validated frontier. Resumed passes produced the accepted four-state closure. |
| Cancelled pass | Cancellation remains non-result and retains validated progress | Search returned `cancelled`, a valid checkpoint, and fewer than 1,000 processed edges. |
| Corrupt checkpoint controls | Duplicate/missing states, stale identity, unsupported version, orphan parent, missing edge, or incomplete frontier cannot grant a verdict | The validator returned `restart-required`. Search starts a new checkpoint and returns `invalid-checkpoint` without a conclusion. |
| Durable checkpoint | Saved chunks reload after database reopen, isolated by namespace and query | Account checkpoint reloaded with exact state/frontier/parent data. Guest and changed-query lookups returned `missing`. |
| Storage corruption/version/abort | Damaged or incompatible data restarts from the saved query; aborted write reports failure without a partial record | Digest tampering returned `restart-required/corrupt-checkpoint`; an incompatible version returned the current query for a fresh search; injected quota abort returned `quota` and left the lookup `missing`. |

The real five-second unknown uses the researched fixture `kb6/b1p2p1p/1pP5/1P6/8/8/5P1P/5K2 w - - 0 1` from [browser adjudication research](../../research/browser-adjudication-solver.md). The test allows 100,000 newly discovered states to isolate time exhaustion. It measures both the pass clock and wall clock, asserts each reached at least 5,000 ms, and observes `time-budget` with no verdict before its 20-second test guard. This is one measured unknown case, not an availability guarantee.

## API and resource contract

`runProofSearchPass(query, options)` defaults to at most 10,000 discovered states and 5,000 ms per pass. On a fresh pass, the root counts as one discovered state. On resume, the state budget counts only new states discovered in that pass. A caller may pass the returned checkpoint to resume or an `AbortSignal` to cancel. Canceled, timed-out, cut off, rejected, corrupt, incompatible, or failed work never yields a negative conclusion.

The search uses full canonical state strings as `Map` keys, records every generated legal successor, and retains first-discovery parent moves. Positive witnesses pass through `checkProofEvidence` before the result can be accepted. A negative result requires an exhausted frontier and a complete closed-successor-set accepted by that checker. The checker independently regenerates legal edges. Its current certificate limits are 10,000 states and 100,000 edges; larger closures remain unknown.

Proof checkpoints carry predicate, rules adapter, proof schema, checker, search implementation, and checkpoint schema versions. The separate `openProofSearchStore()` adapter hashes and writes state, frontier, and parent records in bounded chunks in one IndexedDB transaction. It resolves saves only after transaction completion. Callers must treat `restart-required` as a request to start from its returned query, when available, or from their current saved query.

The default pass deadline and cancellation checks run cooperatively between small batches. Browser scheduling and a single synchronous legal-move or checker call prevent a hard real-time guarantee. The researched 128 MiB cap describes WASM linear memory in the historical solver experiment. It is not a JavaScript total-memory limit and is not enforced here.

## Acceptance and platform limits

This commit records deterministic implementation evidence only. All 79 product acceptance cases in `docs/spec/mvp-acceptance.json` remain `not_run`. The Worker entry passed TypeScript compilation. The main app does not call the Worker factory, so its production bundle contains no Worker artifact. Worker startup, MIME/CSP behavior, cancellation in a real browser, rendering responsiveness, and IndexedDB behavior in native browsers were not run. Mobile memory, Windows/macOS/iOS/Android, assistive technology, live provider, account/cloud, and launch evidence remain unrun. The test pass does not claim universal graph completion, production adjudication wiring, or a mobile memory guarantee.
