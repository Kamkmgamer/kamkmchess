# MVP specification handoff

Revision 1, approved by the owner on 2026-10-16 in [Agree on MVP acceptance criteria and the specification handoff](https://linear.app/kamkm/issue/KHA-14/agree-on-mvp-acceptance-criteria-and-the-specification-handoff), resolution comment `3bcd24a7-2bd5-43fb-8a35-095bac2575f2`.

This packet defines the approved implementation scope and the evidence needed before launch. The owner approved the reviewed content at commit `35444e0`; the approval is recorded on KHA-14. Every product acceptance case in [the machine-readable matrix](mvp-acceptance.json) is `not_run`. Research and specification approval do not pass those cases.

The destination is a public, open-source website where a casual chess player brings an AI connection, chooses an exact model ID and plays against the model's independently chosen moves. Guest play is account-free. Optional accounts provide private game sync. Approval of this specification alone does not authorize production implementation, provisioning, credential access, live requests, spending or launch.

## Canonical sources and precedence

Linear resolution comments remain the canonical decisions. The source keys below also appear in the acceptance matrix. Local files are a traced handoff, not a replacement decision tracker. If a conflict is found, follow the later explicit owner decision and correct the packet before implementing the affected behavior.

| Key | Decision | Resolution comment |
| --- | --- | --- |
| connections | [Choose provider connections and credential handling](https://linear.app/kamkm/issue/KHA-8/choose-provider-connections-and-credential-handling) | `bab521f6-8e67-4a3c-8b7e-0c18df1cd564` |
| caching | Same connection decision, effective prompt caching | `30b80ea3-97ee-4885-96f4-0aeb4fd9ca2d` |
| selection | [Choose the model catalog and opponent selection rules](https://linear.app/kamkm/issue/KHA-9/choose-the-model-catalog-and-opponent-selection-rules) | `6cf8d029-1457-4d8d-bc15-ef622a8da4e3` |
| moves | [Define legal move selection and model failure behavior](https://linear.app/kamkm/issue/KHA-10/define-legal-move-selection-and-model-failure-behavior) | `64c107b9-2653-44f4-8496-2de310dbcb81` |
| lifecycle | [Define the MVP match lifecycle](https://linear.app/kamkm/issue/KHA-11/define-the-mvp-match-lifecycle) | `084530f6-8495-4a8c-b5b8-bcc93f7b10ac` |
| interface | [Validate the connection and chess match interface](https://linear.app/kamkm/issue/KHA-12/validate-the-connection-and-chess-match-interface) | `d83e2c28-a5ba-48a4-a9b7-efee6228d228` |
| architecture | [Choose the application architecture and data boundaries](https://linear.app/kamkm/issue/KHA-13/choose-the-application-architecture-and-data-boundaries) | `64e0511f-3e26-4b79-a3c8-4f834605736c` |
| conflicts | Same architecture decision, offline continuation | `b94b7653-aa8d-411c-af60-c7fe185b6ce4` |
| mating | Same architecture decision, legal-move-only possibility | `80a638a0-55e8-4cf8-8cf7-3814a6ab832b` |
| pending | Same architecture decision, unresolved games allowed | `abb8709e-42c3-4a03-8549-117d459ea7df` |
| disclosure | [Choose supported model access and usage disclosure](https://linear.app/kamkm/issue/KHA-17/choose-supported-model-access-and-usage-disclosure) | `89ae3dca-03b6-4354-87d3-d28d784b593c` |
| custom | [Define custom starting positions and position editor](https://linear.app/kamkm/issue/KHA-19/define-custom-starting-positions-and-position-editor) | `549fc01e-8804-423d-a6f1-338981f2ae3d` |
| costs | This acceptance decision, show costs without a fixed target | `80adad92-20e5-4280-af73-9fc68e449a46` |

The lifecycle's continuous clocks and Undo override older pause/replay wording. Connections and selection override the move ticket's older Chat-only example and fixed-family verification list. Architecture settles storage, event ordering and exact adjudication. Legal-move-only mating and saved pending games supersede research reports that describe those choices as unresolved. Original provider disclosure wording was proxy-specific; apply its notice policy accurately to direct providers as well.

## Specification outline

1. **Application and ownership.** React/TypeScript/Vite static assets on Cloudflare Pages. The browser owns rules, game transitions, clocks, catalog, direct generation and proof checking. Supabase Auth/Postgres supplies optional accounts, owner-only storage and transactional revision/ownership metadata. Google OAuth with explicit PKCE is the initial account route. AI secrets never enter the chess backend. Use one serialized controller per actionable game, with identity/version fences and an immutable result latch.
2. **Connection setup.** OpenAI defaults to Responses, OpenRouter to Chat Completions, Anthropic to native Messages. Explicit alternatives and custom profiles select one protocol. CLIProxyAPI v8.0.30 Chat is a researched baseline. Show final URLs and preserve prefixes. Saving a profile sends nothing. Explicit connection checking is catalog-only; model diagnostics are disclosed generation requests. Bind keys deliberately to destinations, omit fetch credentials and reject redirects.
3. **Selection and diagnostics.** Show all advertised models and exact manual IDs without a model-family or price allowlist. Preserve case and punctuation; reject empty or surrounding-whitespace IDs. Track requested/reported IDs, connection/configuration revisions, unknown capability, incompatibility, stale/partial discovery and mutable aliases honestly. A new game/practice needs a fixed-format marker diagnostic before clocks. Midgame passes are reusable only for unchanged configurations in the current session. A switch stays a candidate until its first interpretable real reply; failure needs explicit recovery.
4. **Game and custom setup.** Orthodox chess, White/Black/Random, White default, 15 minutes plus 10 seconds default, positive starting time and nonnegative increment. Use cm-chessboard with application input/accessibility integration and chess.js behind a strict adapter. Visual editing and six-field FEN import validate current-state consistency without requiring a normal-start history. Preserve exact counters and valid rights. An edit creates a separate labeled game, fresh model context and a new repetition ledger.
5. **Independent moves and failures.** Send a current FEN, piece list, colors/turn and fresh clock snapshot after the complete retained attributed history. Never send solver lines, legal-move lists or engine advice. Parse only a completed choice-zero answer. Accept unambiguous coordinate JSON, the documented fallback or explicit final resignation. Plans, reasoning and other choices are history only. Four illegal attempts lose; three independent automatic formatting corrections cause no chess loss. Manual Retry sends one request and refills no budget. Technical failures stop generation while time runs. Stop fences late replies; no automatic network-generation retry or extra application timeout.
6. **History, Undo and continuation.** Preserve exact application-received data separately from normalized replay. Ordinary model/provider switches send all retained text, including returned plans/reasoning. Never silently trim, summarize or substitute. Undo returns to the previous human decision, restores its rules/budgets/selection and removes that discarded line from replay while keeping it in the archive. Elapsed time stays charged and undone increments are removed. Model-loss practice is explicit, unscored and timed with fresh context/budgets. Preserve actual rules/repetition state and the original final result. Restart/rematch create separate games.
7. **Clocks and endings.** Active time continues through generation, errors, Stop, switching, Undo, navigation, sleep, closed pages, auth and sync. Reconcile before every actionable event. A checkpoint transaction samples decision time just before writing: deadline reached means expiry wins; a legal completed eligible move before it may commit at that effective time. Await transaction completion before presenting it as accepted or dispatching a follow-up. Include commit delay in the next clock. Abort grants no durable move. Results distinguish checkmate, resignation, illegal attempts, time loss and each draw rule.
8. **Exact adjudication and pending.** Actual games draw at third repetition or 100 halfmoves, with checkmate precedence on the boundary move. Deadness means neither side has a cooperative legal path to mate. Timeout asks only whether the opponent can mate. Hypothetical paths ignore future repetition/move-count draws. A browser Worker must return a checked positive path, a sound checked negative proof, or a non-result. Exact accepted outcomes are mandatory; practical completion for every board is not promised. Pending play waits without a result, an unexpired clock keeps running, and expiry/earlier-event facts survive. Setup pending keeps clocks unstarted. A later proof settles an unresolved event and cannot rewrite a final result.
9. **Persistence, identity and sync.** IndexedDB stores received chunks, atomic checkpoints, active/discarded references and idempotent outboxes. Report memory, local-save, pending-sync, synced revision and failure accurately. Export/import the full versioned game. Separate guest, account UUID and credential namespaces. Sign-out fences requests and removes that account's AI keys; cached games/outbox stay attached to the original UUID. Owner RLS and epoch/revision CAS permit one accepted cloud history. Continue offline with an unsynced warning; preserve divergence separately after takeover. Never merge chess branches automatically or use last-write-wins.
10. **Interface, disclosure and costs.** Implement approved A, Classic workspace, with the normal board/player/clock and detail-panel structure, T3 themes and complete screen-reader, keyboard, pointer and touch play. Show provider restrictions and usage/account consequences before the first request without repeated consent dialogs. Use stable prompt prefixes, supported cache controls and fresh suffixes. Report actual usage, rate estimates and unknown costs separately. There is no fixed per-game price target.
11. **Operations and distribution.** Start on managed free tiers. Bring paid upgrades to the owner before charges. Pin and review actual dependencies; MIT original code, BSD/MIT notices and separately credited CC BY-SA standard art. Exclude the NonCommercial set and research-only GPL replay dependencies from production. Use HTTPS, schema versioning, restricted scripts/CSP and untrusted-text rendering. Verify capacity, private access, backups, restore and deletion before public account storage.

## Acceptance matrix and pass rules

[mvp-acceptance.json](mvp-acceptance.json) is the detailed executable-checklist handoff. Each uniquely identified case states required behavior, canonical source keys, verification methods, platform coverage and evidence. The case status and evidence list start as `not_run` and empty.

| Cases | Area | Required evidence |
| --- | --- | --- |
| CON-01 through CON-08 | Connection routes, catalogs, destination safety and disclosure | Request captures with secret checks, synthetic errors and scoped native/live routes |
| MOD-01 through MOD-07 | Catalog identity, diagnostics, reuse and queued switches | Paginated discovery, marker and race fixtures, exact configuration records |
| MOV-01 through MOV-09 | Parsing, protocol completion, illegal/format/refusal/technical outcomes | Independent expected fixtures, all three adapters, budgets and stale-response traces |
| HIS-01 through HIS-05 | Full history, capacity, Undo and attribution | Exact archive comparisons and complete outgoing payload captures |
| RUL-01 through RUL-07 | Orthodox rules, custom validation, FEN and draw identity | Boundary/special-move fixtures, strict state assertions and editable setup journeys |
| ADJ-01 through ADJ-09 | Proof trust, safety, unknowns and saved pending | Reviewed proof/checker assumptions, positive/negative controls, corruption and resource tests |
| CLK-01 through CLK-07 | Continuous clocks and transactional ordering | Deterministic deadline tests plus actual sleep/closure/takeover traces |
| DAT-01 through DAT-09 | Local data, credentials, RLS, conflict and deletion | Transaction/crash/quota evidence, two-user denial checks and real-device conflicts |
| UX-01 through UX-05 | Layout, all inputs, native AT and recovery | Complete native journeys, focus/announcement records and responsive captures |
| LIF-01 through LIF-04 | New games, immutable results and practice | Separate IDs/results/segments, clocks, rules and history evidence |
| CST-01 through CST-04 | Prompt caching, accounting and reference costs | Authorized cold/warm/expiry/Undo/retry/switch usage and rate reconciliation |
| OPS-01 through OPS-05 | Build boundaries, auth, free tiers, backups and licenses | Deployed configuration, access/restore/deletion records and distribution inventory |

Every required case must pass on its listed applicable coverage before the corresponding launch claim. Record each actual platform/route run separately under the case; one passing subrun cannot hide a failed or unrun required subrun. `blocked` identifies an unmet prerequisite, not a waiver. Specification approval does not change these statuses. The owner must explicitly accept any later scope change through the canonical tracker.

A pending-adjudication scenario passes when it correctly saves and fences an unknown result, keeps the required clock/event facts and makes no verdict. It need not finish analysis within a promised time. A proven fixture whose applicable verified proof path is implemented must produce its correct outcome. All accepted positive and negative verdicts require valid evidence. No `unknown`, timeout, library draw flag or heuristic guess can count as a correct verdict.

## Native browser and assistive-technology plan

Use stable versions current when execution occurs. Record browser, OS, AT and application versions, device model, input equipment, date and origin. All six combinations are launch requirements and currently untested in the production app.

| Coverage key | Native target | Assistive technology |
| --- | --- | --- |
| win-chrome | Windows Chrome | NVDA |
| win-edge | Windows Edge | NVDA |
| win-firefox | Windows Firefox | NVDA |
| mac-safari | macOS Safari | VoiceOver |
| ios-safari | iOS Safari | VoiceOver |
| android-chrome | Android Chrome | TalkBack |

These AT choices are the proposed routine acceptance configurations. Use actual devices and AT, not viewport emulation or injected DOM events. Each journey covers setup and model selection, board inspection, legal full-game play, coordinate input/board operation, all promotions, custom editing, switches, Stop/retry/error recovery, Undo, practice, pending, expiry/results and dialogs/focus restoration. Test desktop keyboard/mouse and mobile touch/AT gestures; test keyboard access on mobile with a representative external keyboard. Speak meaningful turns, errors and outcomes without per-tick clock chatter. Include zoom, narrow reflow, contrast and reduced-motion checks.

Native acceptance also exercises storage, public HTTPS transport, Worker/WASM startup/MIME/CSP, resource unknowns, sleep/background/closed-browser recovery and Google callback context. The existing Helium solver sample and Windows Chromium transport probes do not pass any of these product runs.

## Provider, protocol and handoff plan

All three adapters need deterministic completion/stream/history/error fixtures. Primary live routes are OpenAI Responses, OpenRouter Chat, native Anthropic Messages and a public HTTPS custom Chat route, using the pinned CLIProxyAPI baseline when available. Run diagnostic, a legal live move, full-history continuation, Stop and explicit recovery on each primary route across all six native browser targets. Native Anthropic requires an eligible organization; an established ZDR browser restriction must be reported as blocked/incompatible, never worked around secretly.

Before calling any selectable alternative verified, run its exact route: OpenAI Chat, OpenRouter Responses/Messages and custom Responses/Messages as available. Record supported, unknown, failed and blocked configurations honestly. A primary-route failure remains a launch gate for the promised route/platform. Do not broaden a sampled pass to every model, account, pooled backend or custom deployment. HTTP loopback, LAN/private HTTPS and mobile access to a PC proxy require their own route evidence before a support claim; they are outside the common public HTTPS certification.

Choose exact available connection/model IDs, credential bindings, endpoint versions and spend authorization with the owner at execution. No fixed GPT/Claude/Gemini trio is required. Exercise all ordered protocol transitions with synthetic full-history fixtures. Authorized live handoffs must cover Chat to Responses, Responses to Messages and Messages to Chat, plus at least one return to an unchanged current-session checked selection. Include plans/reasoning when actually returned, manual IDs/ambiguous aliases, a failed candidate, Undo after switching and a full-history capacity rejection. Clearly separate fixture, catalog, diagnostic, live-move and handoff evidence.

## Cost and cache evidence

The owner chose to show costs without a fixed target. There is no US$0.50 or US$1.00 gate and no price-based model restriction. Retain effective prompt caching as a separate MVP requirement. At least one eligible, actually tested configuration must demonstrate a real warm prompt-cache read with fresh generated moves and complete history before claiming effective caching. A route without usage visibility remains unknown; it does not establish a hit or a zero cost.

For separately authorized runs, record per request and game totals: request purpose, producing selection/configuration, raw usage, billing units, cache read/write and uncached input, output/reasoning, diagnostics, corrections, manual retries and failed requests where charged. Preserve rate currency/source/effective date and the provider's category relationships. Subtract included cache tokens from total input when required by that provider's accounting; do not add reasoning twice when it is included in billed output. Where possible reconcile estimates with provider-reported charge records. Never label a rate calculation as measured money charged.

Use about 40 model turns as a comparable reporting workload, not a mandatory game length, price ceiling or spending authorization. Report actual accepted turns, requests, outcomes, tokens, cache proportions, latency and totals. Ended games stay ended. Label an extrapolated 40-turn figure as a projection with assumptions; an early failure is not evidence of cheap full-history play. Keep separate cold start, warm history, cache expiry/long pause, Undo/retry and provider/model-switch scenarios. Compare cache behavior without replacing fresh generations with whole-response replay. Do not claim cache hits enlarge context or guarantee discounts on each turn.

## Research provenance

Linear resolutions remain canonical. The source research notes, probes and raw evidence are not included in this public baseline. The source commit IDs below identify material in the private source snapshot; they are not ancestors of this branch. These references document the basis for planning and do not pass product acceptance.

| Area | Canonical Linear source | Source snapshot commit | Limit |
| --- | --- | --- | --- |
| Browser transport and provider protocols | [KHA-15](https://linear.app/kamkm/issue/KHA-15/verify-browser-to-proxy-connectivity-with-synthetic-credentials), [KHA-20](https://linear.app/kamkm/issue/KHA-20/establish-direct-browser-provider-protocols-and-endpoint-compatibility), [KHA-21](https://linear.app/kamkm/issue/KHA-21/verify-provider-browser-preflights-and-synthetic-streaming) | No research bundle is included | Sampled protocol/transport checks do not establish authenticated generation, cache behavior, cost, or support across all required routes and platforms. |
| Approved interface | [KHA-12](https://linear.app/kamkm/issue/KHA-12/validate-the-connection-and-chess-match-interface) | `6af7fa61aec5668b4e8b42c1f1ba4a89f37cda45` | The owner selected the Classic workspace. The prototype source is omitted; captures and DOM-dispatched checks do not certify native assistive-technology use. |
| Chess dependencies | [KHA-22](https://linear.app/kamkm/issue/KHA-22/verify-chess-rules-board-accessibility-and-dependency-licenses) | `27a53c1` | Dependency research does not prove complete production rules or native accessibility. |
| Persistence and hosting | [KHA-23](https://linear.app/kamkm/issue/KHA-23/verify-browser-persistence-clock-recovery-and-managed-sync-hosting) | `ff40ae9` | Synthetic local probes do not certify deployed auth, crash recovery, cross-device behavior, or backups. |
| Browser solver portability | [KHA-24](https://linear.app/kamkm/issue/KHA-24/verify-browser-local-chess-adjudication-solver-portability-and) | `2fd8607` | Sampled Worker/WASM runs do not establish mobile resource limits or universal completion. Resource cutoffs remain non-results. |
| Exact adjudication | [KHA-25](https://linear.app/kamkm/issue/KHA-25/establish-soundness-and-complete-outcomes-for-exact-chess-adjudication) | `7b8bd05` | The theoretical argument does not establish practical coverage. The stock solver input path needs repair or bypass before production use. |

The owner has since settled legal-move-only hypothetical mating and accepted saved pending games. Those choices are reflected in the approved specification and are not open decisions.

## Implementation sequence and module handoff

Implementation is future work after specification agreement and a separate execution instruction. Keep acceptance IDs on implementation tasks and record evidence against the shipped build.

1. Establish locked static build, schema/event contracts, strict rules/FEN/repetition adapter and a serialized controller with result/identity fences. Implement clocks and checkpoint acceptance together. Keep UI effects outside authority.
2. Build append-only archives, retained/discarded replay, transactional IndexedDB, export/import and credential namespaces. Verify crash/abort/quota behavior before claiming saves. Add Undo and immutable practice boundaries against these contracts.
3. Implement the checked adjudication interface, safe proof paths and complete cooperative graph exploration fallback with validated checkpoints. Audit the trusted transition/checker code. Harden and review optional solver input/witness paths or bypass them. Implement saved pending and original event-time ordering before wiring automatic endings. Exhaustion may remain impractical; every resource cutoff stays unknown.
4. Add separate Chat/Responses/Messages adapters, deterministic prompt/cache construction, usage accounting, parser/budgets, catalog/diagnostics and queued switches. Exercise complete protocol-transition and stale-response fixtures without live credentials.
5. Implement the approved Classic workspace, accessible board/editor/promotion and complete recovery journeys against the shared controller. Run actual native/AT checks during development.
6. Add optional Supabase Google/PKCE accounts, owner RLS, transactional CAS/epochs, guest import, outbox/conflict handling and deletion. Demonstrate free capacity and encrypted backup/restore before public account storage. Test actual devices/users and production redirect contexts.
7. With explicit credentials and spend authorization, execute the native provider/handoff/cache/cost plan. Finish distribution/license, deployment/security, restore and launch review. Record failures and unknown configurations without broad certification claims.

Suggested module interfaces own intents/committed state, strict legal transitions, time references, atomic checkpoints, archive/replay, exact proof queries, provider wire translation, selection evidence and cloud ordering. UI, callbacks and hosted sync cannot choose moves or declare results independently. Carry game/segment/revision/request-or-analysis generation and ownership epoch through asynchronous work. Test seams at these authority boundaries rather than mirroring rendering details.

## Execution prerequisites and final agreement

The owner approved this concrete packet. No unresolved product choice is currently known. These execution prerequisites remain open and must not be reported as completed work:

- Actual implementation, dependency pins and proof/transition code review, including repair or bypass of unsafe solver paths.
- Native Windows/macOS/iOS/Android devices and actual NVDA/VoiceOver/TalkBack access.
- Owner-controlled free hosting/auth projects, production origin/callbacks, no-cost private encrypted backup destination and automation. If free operation cannot meet the contract, return the specific constraint before buying an upgrade or claiming protected public storage.
- Owner-selected exact live configurations, private credential entry and explicit spend authorization. This packet supplies no model keys or live budget.
- Completed product evidence and a separate launch decision.

Account retention is until owner deletion with no automatic age purge. Free services and browser storage have capacity/eviction/availability limits. Target encrypted daily logical exports with seven daily and four weekly copies, a restore rehearsal and deletion tombstones reapplied through backup rotation. Preserve unsynced local copies and disclose read-only/pause recovery. A failure to establish this at no cost is an operating constraint to resolve, not permission to reduce the promise silently.

The owner agreed that this packet is ready to hand off for implementation. The acceptance decision and planning map were marked Done, with all 20 child decisions closed. The static KHA-26 foundation exists, but it does not implement playable chess, pass any product acceptance case or approve public launch. Later constraints that require changing a settled promise belong in explicit tracker decisions.
