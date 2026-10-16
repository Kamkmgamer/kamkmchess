# Browser-local adjudication solver portability and resource limits

Research for [KHA-24](https://linear.app/kamkm/issue/KHA-24/verify-browser-local-chess-adjudication-solver-portability-and), conducted on 2026-10-16. The baseline is [the committed dependency investigation](chess-dependencies.md). The owner retained exact dead-position and position-sensitive timeout rules in KHA-13 comment `c4b31f8e-fcde-445c-920b-0632092bbb70`. [Current issue and architecture reads][requirements], [lifecycle and custom-start reads][canonical].

## Finding

CHA-Solver 3.0.0 at `3484c7e65247003fac8705a9290dc2b5d0978b94` builds without solver-source changes for `wasm32-unknown-unknown` and runs inside a dedicated browser Worker. This experiment used T3 collaborative preview on Windows with Helium. The generated WASM has no host imports, no shared memory and a 128 MiB linear-memory maximum. A backend, WASI runtime, AI relay, threads and SharedArrayBuffer were unnecessary for this variant. [Build][build], [module inspection][artifact], [browser evidence][main], [host identification][host].

The experiment does not establish a complete, usable exact adjudicator for every permitted custom board. One real upstream fixture remained unknown after both a one-second budget and a five-second follow-up. Another query allocated 44.5625 MiB of linear memory. All six required native browser targets remain untested. A bounded Worker can preserve an honest unknown outcome and keep rendering active, but cannot turn that unknown into the mandatory exact result. Source soundness, domain coverage and a complete fallback belong to concurrent KHA-25. The architecture remains unresolved until the parent reconciles both reports. [Stress evidence][stress], [five-second follow-ups][extended], [verification][verification].

## Scope and evidence labels

Inspected source means code, manifests or specifications at the cited revision. Upstream claim means a statement by the solver author that this research did not independently establish. Experiment means an observed result from these disposable fixtures. Proposal means a possible integration rule that has not been implemented in the application. Unknown means a required fact remains unverified. The [source manifest][source-manifest] records pinned URLs and inspected/downloaded hashes.

The author reports coverage of all known legal positions and a ten-million-game benchmark with a 930 ms worst case. The README explicitly says theoretical completeness is unproved and the API can return `None`. Those dataset and performance claims do not establish bounds for allowed custom positions or these browsers. This work inspected the public result types, build inputs, mirroring and resource-control points. It did not audit the proof deductions or establish an exhaustive fallback. [Pinned README][cha-readme], [API][cha-api], [search orchestration][cha-full].

All experiments used local synthetic positions, including selected positions from the pinned upstream test file. Their expected labels are upstream claims, not an independent oracle. The four original fixtures reuse the baseline's FENs. The locked-wall closure proof remains in the baseline report; this work did not repeat that enumeration. [Fixtures][fixtures], [selection script][make-fixtures], [upstream positions][cha-tests], [baseline](chess-dependencies.md).

## Actual build and dependencies

The build host was Windows 11 Pro, build 26300, with an AMD Ryzen 5 3400G, four cores and eight logical processors. Browser-reported device memory was 16 GiB. Tools were Rust 1.98.1, commit `48a229ceaefd4985c50990b14116b6d856af0985`, Cargo 1.98.1, LLVM 22.1.8, Node 24.22.0, npm 11.19.1, Python 3.13.5 and Python Brotli 1.2.0. [OS][os], [CPU][cpu], [versions][versions], [compression settings][artifact].

`build.py` downloads the exact source archive, whose SHA-256 is `7a1695b1fade44908c9d2b6a244c68523963b042d6392c207d94ff7843b86181`. It uses a small raw-memory research ABI, `cdylib`, release optimization, LTO, one codegen unit, `panic=abort` and `-C link-arg=--max-memory=134217728`. It does not use wasm-bindgen, Emscripten or a WASI shim. The successful incremental build took 7.77 seconds after the first build had compiled dependencies and failed on an implicit-reference error in the research ABI. That error was corrected in the wrapper. The first attempt is retained and is not evidence of an upstream portability defect. Individual build commands have a 240-second bound. [Build script][build-script], [manifest][cargo-manifest], [ABI][abi], [first attempt][first-build], [successful log][build-log].

The WASM artifact is 1,076,857 bytes, 114,054 bytes with gzip and 78,376 bytes with Brotli. Its SHA-256 is `2bce4c5d69b2ff75ab79696f3a4e9f62ee3e91fdb7b7359eca755bbe738de2a2`. The verification Worker bundle is 131,626 bytes, 28,446 bytes with gzip and 24,610 bytes with Brotli. These are offline compression sizes. The local HTTP server sent uncompressed files. The Worker bundle contains two independent JavaScript replay libraries and is not a measured production bundle. [Artifact measurements][artifact].

CHA-Solver depends on `chess` 3.2.0 and `rustc-hash` 2.1.3. The checked Cargo lock came from the baseline graph with the research root package renamed. `chess` uses `rand` to generate tables in its host build script. The compiled browser module imports no random-number function or other host function. `rayon` is only a CHA-Solver development dependency and is absent from this probe graph. No solver source was patched. The pinned upstream CI tests native Ubuntu builds; it does not claim a browser/WASM matrix. [Target graph][cargo-tree], [lock][cargo-lock], [CHA manifest][cha-manifest], [chess build script][chess-build], [CI][cha-ci], [module imports][artifact].

The Rust target documentation at the installed compiler commit describes a minimal host interface, unsupported operating-system operations, a `dlmalloc` allocator, and an evolving default WebAssembly feature set. This successful build establishes this tested engine's compatibility. It does not certify older Safari versions or every engine supported by an eventual browser minimum-version policy. [Pinned Rust target documentation][rust-target].

## Inputs, colors and local witness checks

All eight original position/color queries returned the same classifications as the native baseline. The locked wall returned unwinnable for both colors. The asymmetric wall and bare-king/rook positions returned a white mating witness and black unwinnability. The knight/rook position returned witnesses for both colors. These are observed solver verdicts. Browser execution did not independently verify negative proof internals. [Main raw evidence][main], [baseline](chess-dependencies.md).

CHA-Solver analyzes black by reflecting ranks, swapping colors, mirroring the side to move and rights, then translating the returned moves back. The browser probe replayed the returned original-coordinate witnesses using the Rust legal-move generator, chess.js 1.4.0 and chessops 0.15.1. Each replay checked every move's legality, final checkmate and the intended mating color. Separate white and black mirrored promotion fixtures each returned a legal three-ply witness containing one promotion. Castling and en-passant witness events are counted when they occur; these tests do not establish exhaustive special-move coverage. [Mirroring source][cha-utils], [Worker verifier][worker], [main evidence][main].

The 107 final-run records contain 49 accepted positive results and five deliberately stale positive responses. All 54 witnesses passed these local replays. The Worker discarded the actual move sequences before posting results to the page. Saved evidence contains lengths, event counts and verification flags, never witness moves. No model or provider received solver output, evaluation, a witness or a legal-move list. [Verification][verification], [Worker code][worker].

The raw Rust parser rejected garbage, a missing king and adjacent kings. It accepted a control with a negative halfmove counter and zero fullmove number, extra trailing text and missing counters, then rendered counters as `0 1`. It preserved sampled castling rights. An en-passant input of `d6` rendered as `d5`. The crate documents its en-passant square as the capturable pawn's square, and its formatter uses that representation. Do not copy this display string into the application's canonical FEN. This probe observed parser/formatter behavior, not a complete validation contract or a full en-passant legality test. [Raw parser controls][main], [chess board representation][chess-board], [builder parser and formatter][chess-builder].

The application therefore needs a strict current-state validator and an adapter that preserves the original six FEN fields and the application repetition ledger. Passing the Rust parser is insufficient. Setup drafts must remain editable when invalid. Validation may check structure, kings, pawn ranks, side/check consistency and rights without requiring historical reachability. Neither this report nor a resource budget authorizes narrowing custom boards to a small material set or historically reachable positions. [Accepted custom-position scope][canonical], [baseline](chess-dependencies.md).

## A real policy ambiguity to reconcile

The halfmove-99 bare-king/rook fixture was `4k3/8/8/8/8/8/8/R3K3 b - - 99 41`. CHA-Solver returned the same 20-ply white mating witness as at halfmove zero. All three move replayers accepted the moves, but the witness crosses the application's automatic 100-halfmove threshold before mate. The Rust state and formatter discarded the imported counters. This establishes that a positive orthodox mating witness does not itself enforce the application draw policy. [Counter control][main], [verifier][worker].

KHA-11 promises both automatic third repetition/100-halfmove draws and possible mate through any legal sequence, with checkmate precedence on the accepted final move. It does not explicitly say whether the hypothetical sequence for deadness/timeout possibility ignores future repetition/move-count draws or must end before them. In this particular fixture Black has only a king and no pawn or capture available on its next move. If future automatic endings constrain that hypothetical sequence, the first move reaches halfmove 100 before White can mate. If only orthodox move legality defines the hypothetical sequence, the returned witness answers that different question. This report does not choose an interpretation or alter the accepted policy. The parent must reconcile the exact meaning with KHA-25 before accepting solver positives as product adjudication evidence. [Exact lifecycle wording][canonical].

Even under the latter interpretation, the application must preserve counters and repetition for actual play and give checkmate precedence. A longer witness rejected under an application policy does not prove unwinnability; another witness might exist. An exact fallback would need the appropriate state, including repetition history where relevant. The browser probe only flags an earlier draw in a replay using chess.js's existing predicates. It is not an independently proven policy-aware search, and the baseline documents repetition-identity limitations in that library. [Worker checks][worker], [baseline](chess-dependencies.md).

## Latency, memory and genuine unknowns

The final main suite recorded 41 queries and controls. The stress suite recorded 64 deterministic samples from the 3,414-position upstream corpus. Two extended queries followed. The 87 conclusive analyses accepted by the probe took 0.2 to 533.4 ms inside the Worker, with a 3.8 ms median. This measurement includes input encoding, Rust parsing, the fast helper, full search, Rust witness replay and output decoding. It does not isolate upstream search time. End-to-end time also includes fresh Worker startup, fetch/instantiation, JavaScript replay and messaging. That time was 33.2 to 735.2 ms, with a 63.7 ms median. Every query used a fresh Worker, while the browser could reuse compiled code and caches. These are single-device observations under an evolving JIT state, not a benchmark distribution or worst-case guarantee. Earlier exploratory runs are retained separately and excluded from these totals. [Verification summary][verification], [initial run][initial], [main][main], [stress][stress], [extended][extended].

Stress fixture line 756, White intended to mate, was `kb6/b1p2p1p/1pP5/1P6/8/8/5P1P/5K2 w - - 0 1`. It exceeded the one-second query budget and remained unresolved at five seconds. The extended run terminated it after 5,002 ms of observed execution, 5,054.5 ms including startup. Its result is unknown. This is an actual resource-exhaustion path, not the solver returning `None`, and it says nothing about whether mate exists. No natural upstream `None` was observed in a completed call. Both JavaScript libraries accepted this input, along with all 87 analysis inputs in the main/stress fixture files. That is a library input check, not certification of the full application validator. [Stress fixture selection][stress-fixtures], [raw one-second result][stress], [raw five-second result][extended], [input checks][input-validation].

The module starts with 31 pages, 2,031,616 bytes, and permits at most 2,048 pages, 134,217,728 bytes. The largest completed query, line 3353 for Black, ended with 46,727,168 bytes of linear memory, 44.5625 MiB. Its extended repeat took 533.4 ms for the wrapped calculation described above. Linear memory capacity includes static data, stack, allocator storage and freed allocations; it is not live-heap use or browser resident memory. The probe did not observe memory during a blocked call that was terminated. It did not measure JavaScript/JIT overhead, total process memory, reclamation latency or mobile limits. [Module limits][artifact], [extended observation][extended].

A deliberate `memory.grow(2048)` control failed with `RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded` and returned unknown through the Worker error path. This checks the module's declared limit and transport behavior. It is not an observed solver allocation failure. A memory cap can cause a query to trap; it cannot supply a chess verdict. Rust panics, traps, failed loads and unexpected missing results likewise need an unknown/error state. [Control evidence][main], [Worker code][worker].

## Cancellation, stale results and clocks

The public synchronous solver API has no caller-provided deadline, cancellation token or resumable checkpoint. The inspected orchestration contains phase limits, including a final `1 << 24` node limit, but does not expose an external wall-clock bound. This probe therefore gives each query a disposable dedicated Worker. Main query budgets are two seconds, three seconds for the six upstream samples, one second for stress, and five seconds for the two follow-ups. Startup has a separate ten-second limit. The stress loop stops starting queries after 55 seconds. Timer scheduling and termination are not hard real-time guarantees. [API][cha-api], [orchestration][cha-full], [page coordinator][coordinator].

The main page terminates a Worker on budget exhaustion or explicit cancellation. It also checks the current deadline when receiving a response, so a delayed timer callback cannot accept a result already observed beyond its budget. The HTML Worker specification requires termination to abort running script and discard queued Worker tasks. The 80 ms synthetic busy-loop controls returned unknown for budget exhaustion and explicit cancellation while timer ticks and animation callbacks continued. The real five-second blocked solver call also left 424 timer ticks and 304 frame callbacks in the extended record. This establishes isolation in the tested foreground environment. It does not establish browser scheduling behavior during suspension, tab closure or mobile backgrounding. [Pinned Worker specification][worker-spec], [main controls][main], [extended][extended], [coordinator][coordinator].

Every response carries game, segment, position revision, request generation and ownership epoch. Five controls each changed exactly one field while a real verified positive response waited for delayed delivery. All five were discarded. An unchanged FEN does not authorize accepting an old response. These controls test a local comparison and disposal mechanism; they do not test hosted CAS, cross-device ownership or a production match reducer. [Stale-result code][coordinator], [saved controls][main].

The synthetic clock control used a 30 ms anchor-derived deadline while a Worker stayed busy. A move attempt at 109 ms was rejected as expired, and the bank remained zero when the query ended. This only tests an illustrative deadline and move gate. No production clock or match transition was implemented. The final main and stress suites observed maximum timer gaps of 22 and 22.3 ms respectively, with zero tracked Workers remaining. Those figures cannot certify closed-tab, sleep, clock-source-change, Undo or recovery behavior. [Clock control and observations][main], [stress observations][stress].

An integration must keep the original deadline and expiry position, stop actionable generation at expiry, and fence any later model response before accepting another move. An adjudication request is independent of model move choice. It must not give either player new time, move the expiry timestamp, offer a provisional win, or reinterpret unknown as mating possibility. Any pending-decision state must preserve the authoritative event order and immutable accepted result. This Worker mechanism can enforce disposal and honest outcomes; it does not provide the complete exact answer or the application transition design. [Accepted lifecycle][canonical], [owner's retained exact requirement][requirements].

## Deployment and browser coverage

The tested build used same-origin external module Workers, `fetch`, `WebAssembly.instantiateStreaming` and `application/wasm`. The local server supplied `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'` and `connect-src 'self'`. The pinned CSP specification gates WASM compilation/instantiation on `wasm-unsafe-eval` or the broader `unsafe-eval`. No inline script or broad JavaScript evaluation allowance was needed. Production hosting must serve the actual assets and compatible headers; this localhost result does not verify a hosting vendor's MIME, caching or CSP behavior. [Server][server], [observed headers][policy], [pinned CSP specification][csp-spec].

`crossOriginIsolated` was false and SharedArrayBuffer was unavailable. The module has unshared memory and no thread imports, so COOP/COEP and shared-memory deployment were unnecessary in this tested variant. This is not evidence for a future threaded port. The current probe does not justify adding cross-origin isolation to the product. [Browser policy observation][policy], [module inspection][artifact].

T3 preview ran the installed Helium executable. Its binary reports product version `155.0.8059.39` and file version `0.19.2.1`; page JavaScript reported a Chrome/154 user-agent string. Record that discrepancy rather than calling it a verified stock Chrome version. Native Windows Chrome, Edge and Firefox were not tested. Native macOS Safari, iOS Safari and Android Chrome were not available or tested. No emulation, viewport preset or Playwright WebKit result substitutes for those required targets. [Host binary metadata][host], [recorded browser environment][main].

The later native matrix must test actual Worker startup, WASM features, MIME/CSP, both colors and special moves, cancellation during the real hard fixture, stale replies, memory failure/recovery, and low-memory/background behavior. Preserve exact OS/browser/device versions and actual observations. This is proposed acceptance work, not a compatibility claim. Full screen-reader/input acceptance belongs to the interface work and was not attempted here.

## Licenses and distribution

CHA-Solver and `chess` are MIT. `rustc-hash` offers Apache-2.0 or MIT. The Cargo inventory records resolved lock packages' declared licenses and local license-file hashes without filtering out host-conditional packages. The target tree separately records ordinary dependencies, host build dependencies and procedural macros for this build. This does not mean every listed crate's code ships in the WASM. `unicode-ident` declares `(MIT OR Apache-2.0) AND Unicode-3.0`, which the inventory preserves. Rust standard-library/compiler-runtime contents and the final application's distributed notices still need a final artifact review. No complete production bill of materials was certified. [CHA license][cha-license], [Cargo inventory][cargo-licenses], [target graph][cargo-tree], [Rust target allocator information][rust-target].

The research Worker additionally bundles chess.js under BSD-2-Clause, chessops under GPL-3.0-or-later and `@badrap/result` under MIT. esbuild is an MIT build tool. The GPL replay dependency is part of this verification experiment, not a required solver dependency or an approved production selection. Do not distribute the generated combined Worker under an MIT-only description. Keep applicable notices and source obligations if distributing it, or deliberately choose the production verification dependencies and their compatible distribution plan. A Worker/WASM boundary does not itself create a license exception. [npm inventory][npm-licenses], [npm lock][npm-lock], [baseline license analysis](chess-dependencies.md).

## Parent handoff and remaining constraints

The browser portability question has a positive, bounded answer for this one environment. The exact architecture question remains open. The parent must reconcile these specific assumptions with KHA-25 before integration:

1. Confirm the solver's soundness and accepted input domain against every permitted current-state-valid custom board. This browser success does not establish those facts or authorize historical-reachability/material restrictions.
2. Define the hypothetical mating-sequence semantics alongside the already accepted automatic draw policy. Preserve imported counters and repetition history regardless of that interpretation. The halfmove-99 witness is a concrete reconciliation case.
3. Provide an exact browser-local path when the specialized solver returns `None`, a Worker is terminated, a witness is missing/rejected, or a memory/error path occurs. The five-second line-756 case is a concrete resource test for that path. No exact fallback was implemented or certified here.
4. Specify how that path serializes deadness checks, accepted moves, clock expiry and ownership changes without adding time, accepting stale moves or rewriting an accepted result. The probe provides local response fencing only.
5. Establish acceptable latency/memory and failure recovery on all six native browser targets. A 128 MiB WASM cap and one Windows Chromium-derived run do not meet that acceptance matrix.

These are precise remaining constraints, not a new owner question or a proposal for rare exceptions. No backend chess authority, AI advice, hosted credential storage or provider relay is part of the result.

## Checks, worktree and cleanup

Worktree is `C:\Users\Lenovo\.t3\worktrees\kamkmchess\t3-faf7b892`, branch `t3/browser-solver-portability`, based on parent commit `27a53c187ad324ee91cf3aa5cb525931d5f87256`. Intended deliverables are this report and `experiments/browser-adjudication-solver/` only. The parent owns integration, tracker updates and publication.

Checks actually run were the locked release WASM build, browser main/stress/extended probes, all 54 local mating-witness replays, `python verify.py`, `node verify_inputs.mjs`, Node syntax checks for the browser sources, Python compilation checks, report link/checksum checks and `git diff --cached --check`. Saved assertions cover original verdict agreement, sampled upstream-label agreement, five stale-field rejections, unknown controls, deadline gating, promotion replays, module imports/limits and the actual WASM hash. They do not prove negative verdict soundness, general completeness or native acceptance. [Verification script][verify-script], [verification output][verification], [input checks][input-validation].

The owned preview tab, all probe Workers and the loopback server are closed at handoff. Downloads, generated WASM/bundles, Cargo output and npm dependencies remain ignored inside the assigned experiment directory. Rust's WASM target was installed into the existing rustup toolchain for this research; no global service configuration changed. No production code, other worker paths, provider calls, credentials, accounts, paid usage, public messages, tracker mutations or pushes were involved. Source/spec downloads use bounded requests; all query and build bounds are recorded above. [Reproduction and bounds][readme].

[requirements]: ../experiments/browser-adjudication-solver/requirements-snapshot.json
[source-manifest]: ../experiments/browser-adjudication-solver/source-manifest.json
[canonical]: ../experiments/browser-adjudication-solver/canonical-input-requirements.json
[build]: ../experiments/browser-adjudication-solver/build-result.json
[build-script]: ../experiments/browser-adjudication-solver/build.py
[build-log]: ../experiments/browser-adjudication-solver/build.log
[first-build]: ../experiments/browser-adjudication-solver/build-attempt-1.log
[cargo-manifest]: ../experiments/browser-adjudication-solver/wasm-probe/Cargo.toml
[cargo-lock]: ../experiments/browser-adjudication-solver/wasm-probe/Cargo.lock
[abi]: ../experiments/browser-adjudication-solver/wasm-probe/src/lib.rs
[artifact]: ../experiments/browser-adjudication-solver/artifact-inspection.json
[versions]: ../experiments/browser-adjudication-solver/tool-versions.txt
[os]: ../experiments/browser-adjudication-solver/os.json
[cpu]: ../experiments/browser-adjudication-solver/cpu.json
[host]: ../experiments/browser-adjudication-solver/browser-host.json
[main]: ../experiments/browser-adjudication-solver/browser-results.json
[initial]: ../experiments/browser-adjudication-solver/browser-results-initial.json
[stress]: ../experiments/browser-adjudication-solver/browser-stress-results.json
[extended]: ../experiments/browser-adjudication-solver/browser-extended-results.json
[fixtures]: ../experiments/browser-adjudication-solver/fixtures.json
[stress-fixtures]: ../experiments/browser-adjudication-solver/stress-fixtures.json
[make-fixtures]: ../experiments/browser-adjudication-solver/make_fixtures.py
[verification]: ../experiments/browser-adjudication-solver/verification.json
[input-validation]: ../experiments/browser-adjudication-solver/input-validation.json
[verify-script]: ../experiments/browser-adjudication-solver/verify.py
[cargo-tree]: ../experiments/browser-adjudication-solver/cargo-tree.txt
[cargo-licenses]: ../experiments/browser-adjudication-solver/cargo-license-inventory.json
[npm-licenses]: ../experiments/browser-adjudication-solver/npm-license-inventory.json
[npm-lock]: ../experiments/browser-adjudication-solver/package-lock.json
[worker]: ../experiments/browser-adjudication-solver/worker-source.mjs
[coordinator]: ../experiments/browser-adjudication-solver/probe.mjs
[server]: ../experiments/browser-adjudication-solver/serve.py
[policy]: ../experiments/browser-adjudication-solver/browser-policy.json
[readme]: ../experiments/browser-adjudication-solver/README.md
[cha-api]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/lib.rs
[cha-full]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/winnability/full.rs
[cha-utils]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/utils.rs
[cha-readme]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/README.md
[cha-manifest]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/Cargo.toml
[cha-tests]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/tests/positions.txt
[cha-ci]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/.github/workflows/ci.yml
[cha-license]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/LICENSE
[chess-board]: https://github.com/jordanbray/chess/blob/0b0f7f02d1bd9d9a4eda672bc61cd020543ba047/src/board.rs
[chess-builder]: https://github.com/jordanbray/chess/blob/0b0f7f02d1bd9d9a4eda672bc61cd020543ba047/src/board_builder.rs
[chess-build]: https://github.com/jordanbray/chess/blob/0b0f7f02d1bd9d9a4eda672bc61cd020543ba047/src/build.rs
[worker-spec]: https://github.com/whatwg/html/blob/790ce89a0b95f3f6caed7fc2d1e3f352364e2791/source
[csp-spec]: https://github.com/w3c/webappsec-csp/blob/b1bad631b091cdca904138d6947a16b89edfd2b4/index.bs
[rust-target]: https://github.com/rust-lang/rust/blob/48a229ceaefd4985c50990b14116b6d856af0985/src/doc/rustc/src/platform-support/wasm32-unknown-unknown.md
