# Browser module responsibilities

This is the foundation module map for [Establish the React/TypeScript application and build checks](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks). The canonical architecture is the [architecture resolution](https://linear.app/kamkm/issue/KHA-13), comment `64e0511f-3e26-4b79-a3c8-4f834605736c`. The approved specification's [module handoff](../spec/mvp-handoff.md#implementation-sequence-and-module-handoff) identifies the test seams.

The composition entry point, placeholder `src/ui/`, strict `src/rules/` adapter, pure `src/clocks/` calculations, independent `src/proofs/` checker, `src/archive/` and `src/storage/` exist today. The serialized controller and proof search are still planned. Create each other directory when its ticket implements behavior. This map defines responsibilities, not callable stubs or implemented guarantees. Public types should arrive with the first real caller and fixtures rather than anticipate every later ticket.

| Module / planned location | Owns | Interface and authority limits |
| --- | --- | --- |
| Composition / `src/main.tsx` | Browser startup and wiring long-lived instances. | Create one actionable controller per game outside React render/effect lifetimes. React remounts do not create another writer. |
| UI / `src/ui/` | Rendering committed state, accessible inputs, focus and announcements. | Emit controller intents and subscribe to committed state. Pending writes are visibly pending. Never mutate rules, clocks, persistence or results from a renderer/effect. |
| Match controller / `src/controller/` | Serialized intent/event acceptance, request generations, budgets, queued selections, event journal and immutable result latch. | Accept human intents and completed external events. Reconcile time and fences before dispatch, transaction commit and reply acceptance. Only this module authorizes game transitions and final results. |
| Orthodox rules / `src/rules/` | Strict six-field FEN validation, legal transitions, exact counters and repetition ledger. | Use an application-owned chess.js adapter. Return position/transition facts and errors, not independent match verdicts. Generic library draw flags are not authority. Preserve imported declarations; own counters that a library cannot represent exactly. |
| Clock calculation / `src/clocks/` | Time references, banks, deadlines, elapsed charges and increment calculations. | Take explicit time samples. Rendering timers display time only. Controller/checkpoint ordering decides acceptance; sleep, errors, Stop and pending analysis never pause an active clock. |
| Proof analysis/checking / `src/proofs/` | Worker queries, exact hypothetical reachability, checked witnesses/proofs and non-results. | Return identity-tagged evidence or an explicit non-result. Independently check proofs before the controller can accept a verdict. Resource limits never prove impossibility. No solver advice enters model prompts. Bypass the unsafe stock solver. |
| Archive and replay / `src/archive/` | Exact received records, attribution, retained/discarded references and normalized replay. | Preserve full raw records separately from replay. Undo changes retained references, not the archive. No silent trimming or provider continuation IDs that retain discarded history. |
| Local storage / `src/storage/` | IndexedDB namespaces, atomic checkpoints, chunks, operation IDs and outbox. | Complete transactions before reporting durable acceptance. Check persisted revision/epoch and sample decision time immediately before writing. Never span a network wait with an open transaction. Report abort/quota/eviction limits honestly. |
| Provider connections / `src/providers/` | Explicit destinations, local credential binding, catalogs, diagnostics and separate Chat/Responses/Messages wire adapters. | Browser-direct requests only. Return attributed records/completion states to the controller. A token, callback, catalog or diagnostic cannot apply a move. Saving configuration sends nothing. No hidden retries, fallback models or relay. |
| Cloud ordering / `src/cloud/` | Optional Google PKCE identity, owner-only sync, expected-revision/epoch operations, idempotency, deletion and preserved conflicts. | Allowlisted game DTOs exclude credentials. Hosted operations check ownership and storage order, never chess legality or results. Offline divergence stays a separate continuation; no last-write-wins merge. |

## Allowed dependencies

The composition module wires adapters into the controller. The UI calls only the controller's game interface. Rules, clocks and archive calculations remain usable without React, network or IndexedDB. Proof checkers use the orthodox transition interface; Workers do not reach into controller state. Storage and cloud adapters persist explicit versioned records rather than importing UI state. Provider adapters translate wire data without importing React or deciding game outcomes.

Keep public exports small. Import another module through its public entry point when one exists; keep private implementation files local. Enforce these responsibilities in review. No generic event bus, abstract base hierarchy or empty adapter wrappers are needed in the foundation.

## Event and transaction contract

Every asynchronous request/analysis and returned event must carry its game ID, segment ID, position revision, request or analysis generation, and ownership epoch. Include the producing side and connection/configuration revision where applicable. Repeated FENs do not make old work eligible again. Stop, Undo, identity changes, takeover and expiry fence late work.

The serialized acceptance path checks eligibility and the persisted revision, samples decision time immediately before the checkpoint write, and compares the deadline. At the deadline, expiry wins. A completed eligible legal move before it may commit at that effective time. Await transaction completion before presenting acceptance or sending a follow-up request; charge commit delay to the next active clock. An aborted transaction grants no durable move. Preserve operation IDs for uncertain recovery.

The controller alone latches final results. While an exact ending is unresolved, preserve the original position-entry/expiry facts, save pending state, fence play and keep any unexpired active clock running. A later proof can settle an unresolved event at its effective time, never rewrite an accepted final result. Setup pending does not start clocks.

## Persistence and trust

Version storage, checkpoint, archive, proof-search and cloud operation formats in their implementation tickets. Reject incompatible writes and validate restored data before use. Keep guest, account UUID and local credential namespaces separate. Sign-out removes the departing account's AI keys and fences requests while cached games/outbox remain attached to that account.

Provider text is untrusted text. Routine telemetry excludes raw transcripts, secrets, private endpoint configuration and auth tokens. Game sync/export preserves the complete versioned archive through allowlisted DTOs that exclude AI keys, auth tokens, secret headers and secret-bearing endpoint data. A recognized credential echo stays local and blocks the affected sync/export until resolved; never redact the sole exact archive and call it lossless. No administrative key is browser configuration. Static Cloudflare hosting serves public assets; optional Supabase operations never become a generation relay.

## Verification seams

Use deterministic fixture tests at the approved controller, rules, clock/checkpoint, archive/replay, protocol and proof-checker interfaces. Test independent expected outcomes, fault/abort injection and stale-event races through those interfaces. The next tickets establish strict rules/FEN/repetition and atomic archive/storage behavior. Do not test private helper shapes or manufacture placeholder assertions to increase a test count.

Native browser, screen-reader, mobile, deployed account, live-provider and cost runs have separate prerequisites and evidence records. A static build or fixture pass does not certify them.
