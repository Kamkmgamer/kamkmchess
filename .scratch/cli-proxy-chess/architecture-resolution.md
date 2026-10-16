## Resolution

The architecture is a static React/TypeScript/Vite browser application, hosted on Cloudflare Pages, with Supabase Auth and Postgres for optional accounts and private game sync. The browser owns chess, clocks, provider requests and adjudication. The owner selected managed free tiers initially, exact mating rules using legal-move reachability, and saved unresolved adjudications without a promised completion time. No production implementation, provisioning, paid service or launch acceptance is claimed.

This comment is the architecture specification. Earlier product contracts remain canonical in their own tickets. The four attached research reports supply evidence and limitations, rather than passing production tests.

### Stack, interface and distribution

Use React and TypeScript with Vite's static build, a supported build-time Node LTS, and locked dependencies. No SSR application server, generation relay or required companion is needed. Cloudflare serves public versioned assets and the SPA callback/deep-link fallback. Supabase handles authenticated storage and transactional ownership metadata.

Use cm-chessboard as the initial visual/input dependency within the approved A, Classic workspace. Enable its keyboard accessibility facilities explicitly and route its pointer, touch, keyboard and coordinate-form input through the same controller. Supply accessible promotion, editor controls, named squares/pieces, focus restoration and concise event announcements. Library facilities do not certify complete screen-reader play. Preserve the normal board/player/clock and detail-panel arrangement and T3 palettes; the disposable prototype is a design reference, not production source to merge unchanged.

Use chess.js behind an application-owned orthodox rules adapter. Its generic game-over/draw flag is not match authority. The researched versions, chess.js 1.4.0 and cm-chessboard 8.15.3, are compatibility baselines; pin and recheck the actual implementation versions and changes before adoption.

Use MIT for original application code with the BSD/MIT dependency notices. Use cm-chessboard's standard CC BY-SA 3.0 art with its actual credits, source/license links and modification notices, or deliberately licensed original replacements. Exclude the optional NonCommercial piece set. Keep artwork licensing separate from code. The research-only GPL replay bundle is not a production dependency; a final dependency/asset inventory must verify the actual distribution. The owner delegated compatible license defaults and needs no repeated license question.

### Browser modules and authority

The UI renders committed match state and emits intents. A single browser match controller serializes move proposals, completed provider replies, corrections, selections, diagnostics, Stop, Undo, clock events, adjudication and ownership changes. React remounts/effect replay must not create another actionable controller.

Keep narrow interfaces around rules, provider adapters, archive/replay, local storage, cloud sync, time references and the adjudication worker. Each result carries game, segment, position revision, request/analysis generation and ownership epoch. A repeated FEN does not restore an old generation's eligibility. Check identity before dispatch, state commit and reply acceptance.

The controller owns the result latch and an ordered event journal. No renderer, animation, streaming token, generic library predicate, server notification or worker callback can apply a move or result independently. The existing move-contract and lifecycle resolutions own retry budgets, parsing, attribution, queued switching, Undo and fresh-context practice.

### Rules and custom positions

Parse an editable draft separately from the playable rules position. Validate all six FEN fields before constructing or serializing library state. Enforce king/pawn placement, side/check consistency, orthodox castling declarations and en-passant board/state consistency with actionable field/square errors. Preserve valid imported declarations and exact decimal counters; keep authoritative counters outside a library representation that would round or normalize them. Do not infer historical reachability or silently impose a 16-piece/four-digit restriction.

Keep a canonical repetition identity using placement, turn, rights and legally usable en passant. Own the occurrence ledger from the game's start; do not rely on chess.js's imported ineffective-ep hash behavior or reload only FEN. Undo restores the retained ledger and separately archives discarded occurrences. A separate custom game starts its own ledger.

Check actual checkmate before a boundary move-count draw. Apply actual automatic third repetition and 100-halfmove endings, stalemate and proven deadness as specified. Existing terminal setups remain editable with Start disabled. During setup, establish playability before starting clocks or dispatching the game diagnostic; one checked mating-possibility witness is enough to rule out global deadness. If setup classification is unresolved, keep it as a saved pending setup with clocks not started. During an existing match, the owner's live-clock pending policy applies. Explain an illegal proposed move using deterministic single-move rule checks without suggesting an alternative or sending a legal-move list to a model.

### Exact adjudication with explicit pending results

The owner's mating predicate is cooperative reachability through orthodox legal moves, ignoring future repetition/move-count endings in the hypothetical path. Actual games still apply those endings and retain their counters/history. Global deadness requires neither side to be able to mate. Timeout queries the expired side's opponent. Optimal-play WDL and a failed search are insufficient.

Use a browser Worker with a proof-checking interface. It returns a verified mating path, a verified impossibility proof, or a non-result with its reason. Only accepted proof evidence can finalize the relevant candidate event. Verified positive evidence must replay every legal move and end with the intended side's checkmate. It remains internal to adjudication and never enters model advice.

Negative evidence may use small reviewed sufficient proofs with explicit preconditions, or a complete closed-set certificate whose checker regenerates every legal successor and verifies that no target mate exists. The four-state closure is evidence of this approach, not a ready production implementation. A hash alone is not state equality. The trusted checker and legal-transition implementation require their own tests and review.

Use complete cooperative graph exploration as the exact fallback design, with full state identity, a visited set, frontier, parent/path records and a checkable closed set. Its finite-state argument does not supply practical completion bounds. Resource exhaustion leaves a non-result; it is never an impossibility proof. Version any persisted search checkpoint by predicate, rules, schema and proof implementation. Validate a restored checkpoint; restart from the saved query when it cannot be reused safely.

CHA-Solver is an optional accelerator behind this interface. Do not ship the stock Rust path for unrestricted input: the parser-accepted 21-origin fixture violates its unchecked 18-entry move-buffer assumptions. A safe reviewed fork/adapter must address all relevant input and move-generation assumptions, not just enlarge one array. Its source witness-reconstruction gap also needs repair. Until then, bypass it and use safe proof paths or pending status. Even after hardening, an unsupported Rust negative classification is a hint, not an independently checked negative proof. No claim is made that the changed deductions are universally proved.

The initial automatic analysis policy is one foreground pass of at most five seconds. Stop starting work after that budget; timers are not hard real-time. The complete-graph implementation starts with a conservative 10,000-discovered-state pass limit and chunked checkpointing. The researched WASM variant has a 128 MiB linear-memory ceiling; that is neither a total-process limit nor mobile certification. These are routine initial resource defaults, to be reduced if native acceptance shows pressure. Changing a work budget changes availability, never the chess predicate or verdict. Larger explicit analysis remains within a validated device budget.

If proof is unavailable, visibly save "Adjudication pending." Play waits, no result is declared and no finish time is promised. Save the query, canonical position, event/deadline facts and valid analysis checkpoint. Offer explicit Continue analysis and Stop analysis. Do not automatically repeat expensive analysis indefinitely, run provider checks, or claim a closed/suspended browser keeps computing. A stopped, failed, invalid, stale, out-of-memory or budget-limited worker produces a non-result.

### Clocks, event ordering and recovery

The owner accepted pending play with an unexpired clock still running. Reconcile elapsed time before every actionable event, including restore and takeover. Rendering intervals only display time.

Persist each side's bank, active-side reference, effective deadline, credited increments, elapsed-time basis and ordered clock events. During a live page use a monotonic reference for ordinary elapsed measurement and compare it with wall time; persist a wall-time anchor for absence. Use hosted timestamp/offset metadata when available for cross-device reference alignment, without moving chess calculations or results to the server. This is casual honest-device timing, not tamper-resistant anti-cheat.

On a detected clock discrepancy, preserve both readings and require reconciliation before accepting another move. Use available trusted reference metadata and disclose unresolved timing; do not silently reset a deadline or grant time. Offline closed-browser wall-time assumptions and real sleep behavior remain explicit acceptance constraints. No browser-only method can prove true time across arbitrary clock manipulation.

Define local event acceptance through a serialized checkpoint transaction. After eligibility and persisted revision checks, sample the decision time immediately before writing the transition. At or beyond a reached deadline, expiry wins. A completed legal eligible move sampled before it can commit with that effective time; display it as pending until transaction completion and dispatch no follow-up generation first. On success, charge the next clock from the stored effective event time, including commit delay. On abort, no durable event was accepted; retain received content, reconcile from the previous checkpoint and report the save failure. Never backdate to first-token/provider timestamps. Refresh resolves an uncertain operation from its operation ID and stored checkpoint.

If adjudication is pending at position-entry time, preserve that candidate event before later flag candidates. At expiry record its original instant, stop actionable generation and reject later moves. An exact proof can later settle an unresolved earlier dead-position candidate or the flag candidate at its effective time. It does not rewrite an already accepted result or grant new playable time. The interface must distinguish an elapsed clock from a finalized time-loss result.

Undo applies the lifecycle's elapsed charges and removes only the undone increment credits. It cannot erase an earlier expiry or final result. New requests receive fresh time/position suffixes. Sleep, navigation, errors, pending analysis and sync never pause an unfinished active clock.

### Local persistence, archives and credentials

Use IndexedDB append-only received chunks plus atomic checkpoint, current-line references, separate discarded-line records and an idempotent sync outbox. Observe transaction completion, not individual request success. Do not hold transactions open across network waits. Store the full match contract, not FEN alone.

Keep exact application-received data and attributed normalized replay separately. No silent trimming, summarization or deletion of discarded continuations. Byte/chunk durability has a receive-to-commit crash window; quota refusal, browser eviction/deletion, private-session closure and device loss remain possible. State memory/local-saved/cloud-synced status accurately, provide full versioned export/import, request persistent storage where available, and show save failures. Capacity never silently deletes old games or context.

Separate local guest-context, account-UUID and credential namespaces. A dedicated local credential store holds AI keys by connection and revision. Sync/export DTOs allowlist game data and exclude AI keys, auth headers/tokens and secret-bearing endpoint configuration. Bind a restored game deliberately to a connection on that device.

Device-local credential saving remains the default. Per-connection replacement/forgetting and clear-all-local-credentials controls are required. Sign-out fences requests, clears in-memory identity, deletes that account's saved AI credentials and hides its private views. Keep cached games/outbox under the original UUID for recovery on that account's reauthentication; do not relabel them as guest or account B. An explicit remove-from-device action must disclose pending unsynced data before deleting it. Per-device sign-out uses local auth-session scope.

Namespacing is application isolation, not protection from same-origin scripts, extensions or a person controlling the browser profile. Do not claim encryption merely by storing a key beside data. Known credential echoes in a raw response stay local and block the affected sync/export until resolved; do not redact the sole exact archive and call it lossless or upload a recognized secret.

### Optional accounts and accepted cloud history

Use Supabase Auth with Google OAuth/PKCE as the initial routine account method. Guest play remains account-free. Configure exact production callback origins and test native mobile/browser return contexts, missing/expired verifier, canceled/overlapping flows and token refresh. Public default-SMTP signup is not part of this initial route; any later email-auth path needs configured/tested custom SMTP. No account/provider was provisioned by this decision.

Use owner-UUID RLS on games, chunks and every related access path. The browser gets only the publishable project key and its user session. Administrative keys stay out of the bundle. A reviewed transactional expected-revision/ownership-epoch operation enforces accepted cloud order, idempotency, deletion fencing and final-record immutability. Remove direct writes/upserts that could bypass it. Hosted operations verify access and storage ordering, not chess legality.

Use Postgres rows for initial immutable chunks/checkpoints and private game metadata, with indexes and bounded delta batches. Keep analysis frontiers local by default; sync the pending query and game facts so another device can restart analysis. Supabase object storage is not needed initially. Moving large archive chunks to a private object store is a later capacity migration requiring manifests, cleanup and separate backup/deletion handling.

Coordinate same-device writers with Web Locks plus IndexedDB epoch/revision checks and BroadcastChannel notices. Use the transaction checks as fallback; heartbeats alone are insufficient. Cloud takeover explicitly advances the accepted epoch from the last acknowledged checkpoint. Fences prevent stale commits even when an old direct provider request cannot be recalled.

Apply the owner's unsynced-continuation choice. An offline account device can continue locally with clear pending-sync status. On reconnect publish idempotently only when its epoch/base revision is still accepted. Preserve divergence as a separate conflicting continuation; never overwrite the synced line, Undo, deletion or accepted final result. No automatic chess-branch merge or last-write-wins rule. Query uncertain cloud operation IDs before retrying. Ordinary sync delay does not decide a chess clock event.

### Provider protocols, replay and cost

Keep separate browser-direct adapters for Chat Completions, Responses and native Anthropic Messages, with explicit provider/endpoint/protocol/auth profiles. Apply the resolved connection, catalog and move-contract policies without reintroducing a fixed model-family allowlist or assuming a preset certifies a route.

Construct every generation/correction from the complete retained attributed text and canonical current state. Do not rely on provider continuation IDs to retain history that Undo must remove. Preserve full received content and opaque source records while replaying only supported received text; unavailable private provider reasoning cannot be invented. Rejection of full history produces explicit recovery, without silent trimming, substitution, reset or hidden probes.

Version connection-scoped IDs, destination/protocol/credential/request configuration and routing assumptions. Keep historical compatibility observations separate from reusable current-session passes. New-game/practice checks precede clocks; midgame checks follow the settled changed-selection/pass-reuse policy. Serialize diagnostics, queued switches and first candidate responses with expiry and Undo.

Use stable prompt/history prefixes and a fresh position/clock suffix. Expose cache-read/write and uncached usage when actually reported; preserve raw usage, price source/version and all billed categories. Missing rates or usage remain unknown/estimates, not measured cost. Real cold/warm cache and match-affordability claims require separately authorized evidence in acceptance. No platform-funded generation is introduced.

### Operations, retention and acceptance handoff

Start with free Cloudflare static hosting and Supabase Free, as selected. Account sync/auth may be unavailable under inactivity pausing, read-only quotas or service failure; local play and pending outboxes remain visible. Free plans do not establish public availability, permanent retention, email delivery, backups or sufficient archive capacity. No synthetic keepalive plan or paid upgrade is implied.

Retain account games until owner deletion; no application age-based purge. Show capacity pressure and reject/hold new cloud writes visibly before losing data. Provide owner exports and require an encrypted operator logical-backup/restore procedure before public account storage is enabled. Target daily exports, a rolling seven daily/four weekly copies, and a documented restore/deletion-tombstone rehearsal. A no-cost private destination and automation must be verified in deployment setup; if unavailable, return the operating constraint to the owner before paying or claiming protected account storage. Hosted suspension/deletion and offline local copies remain real limits.

Delete through an idempotent owner-only workflow covering records/chunks, local caches/outbox and tombstones that reject stale resurrection. Keep deletion markers through the documented backup rotation and reapply them during restore. Distinguish removal from live application access from eventual expiry of backup copies.

Use stable HTTPS origin, versioned storage/RPC/checkpoint schemas, restricted third-party script loading and CSP compatible with explicit direct endpoint profiles. Render provider text as untrusted text. Allowlist sanitized operation IDs/revisions/protocol/status telemetry; exclude prompts, raw errors, transcripts, tokens and private endpoints from routine logs. Export sanitized diagnostics deliberately. No per-second backend clock writes are needed.

The next ticket, [Agree on MVP acceptance criteria and the specification handoff](https://linear.app/kamkm/issue/KHA-14/agree-on-mvp-acceptance-criteria-and-the-specification-handoff), owns the final requirement matrix and handoff agreement. It must include the four research reports and their exact limits, native Windows Chrome/Edge/Firefox, macOS Safari, iOS Safari and Android Chrome; actual assistive-technology full play; rules/FEN/repetition/Undo fixtures; proof checks and honest pending paths; clock/commit/expiry races; raw archive/quota/crash recovery; two-user RLS/CAS and actual-device conflicts; auth redirects; backup restoration/deletion; and separately authorized live protocol/cache/cost evidence.

The initial budgets, stack and operational choices are implementation defaults, not claims that these checks passed. No blanket promptness or practical completion guarantee for all custom boards remains after the owner's pending-adjudication choice. Exact accepted results, preserved data boundaries and truthful unresolved states remain mandatory.
