# Chess rules, board input, and dependency licenses

Research for [KHA-22](https://linear.app/kamkm/issue/KHA-22/verify-chess-rules-board-accessibility-and-dependency-licenses), read on 2026-10-16. This report supplies evidence for [the architecture decision](https://linear.app/kamkm/issue/KHA-13/choose-the-application-architecture-and-data-boundaries). It does not approve an architecture, project license, or launch.

## Findings

Neither chess.js 1.4.0 nor chessops 0.15.1 meets the whole accepted rules contract on its own. Both supply useful orthodox move legality, checkmate, and stalemate operations. Both need application work for specific illegal-move explanations and strict custom-position validation. Their material helpers do not cover all dead positions. chessops has a side-specific material helper, but it also misses position-dependent impossibility of mate. A deterministic locked-wall probe below proves a gap in both libraries. [Rules source][js-rules], [chessops source][ops-rules], [raw observations][results].

chess.js has built-in repetition and 100-halfmove predicates. Its repetition hash counts ineffective imported en-passant state differently from the same position after the right expires. The probe therefore misses the third occurrence in two custom-start cases. Its draw predicate also remains true when the 100th halfmove checkmates. An application must own correct repetition identity and adjudication order. chessops supplies useful position equality but no game repetition history or 100-halfmove adjudicator. [chess.js hashing and endings][js-rules], [chessops equality and endings][ops-rules], [observed repetition and mate cases][results].

CHA-Solver 3.0.0 is a credible additional adjudication candidate. The pinned Rust source explicitly distinguishes a found cooperative mating line, proven unwinnability, and an undecided search. Eight native Windows queries resolved the selected cases, including a position where only one side can ever mate. Its four returned mating lines replayed legally to checkmate in both JavaScript libraries. This is evidence for investigating a browser-local port, not evidence of WASM support, acceptable mobile resource use, or complete coverage of every allowed custom position. [API][cha-api], [algorithm][cha-full], [native results][cha-results], [witness verification][cha-verification].

For board input, cm-chessboard 8.15.3 has the most directly relevant inspected combination of keyboard navigation, readable board alternatives, and an explicit promotion dialog with focus handling. gchessboard 1.4.0 is another credible accessible-board starting point. react-chessboard 5.12.1 and Chessground 10.4.2 need more application-owned accessibility work. None has been established here to deliver complete screen-reader play. No browser or assistive-technology tests were performed in this research. All choices retain the approved Classic workspace. [cm accessibility][cm-a11y], [cm promotion][cm-promotion], [gchessboard][g-readme], [React input][react-provider], [Chessground input][cg-events].

## Accepted contract and evidence labels

The authoritative map is [KHA-5](https://linear.app/kamkm/issue/KHA-5/find-the-way-to-the-ai-chess-mvp). Native Linear reads retrieved these exact canonical comments. Their text and update timestamps are preserved in [canonical-resolutions.json][canonical].

- [Custom positions, KHA-19](https://linear.app/kamkm/issue/KHA-19/define-custom-starting-positions-and-position-editor), comment `549fc01e-8804-423d-a6f1-338981f2ae3d`. Allow visual editing and FEN import. Validate the current board and settings without proving a legal history from the normal start. Preserve counters. A new custom game starts a new repetition history. Terminal setups remain editable with Start disabled.
- [Move contract, KHA-10](https://linear.app/kamkm/issue/KHA-10/define-legal-move-selection-and-model-failure-behavior), comment `64c107b9-2653-44f4-8496-2de310dbcb81`. Models choose coordinate moves independently. Give specific rule corrections without legal alternatives. Apply only completed, current, validated proposals. Preserve the full received archive.
- [Lifecycle, KHA-11](https://linear.app/kamkm/issue/KHA-11/define-the-mvp-match-lifecycle), comment `084530f6-8495-4a8c-b5b8-bcc93f7b10ac`. Automatically draw at the third repetition or 100 halfmoves, with checkmate precedence. Detect every dead position and determine whether the opponent can possibly mate at flag fall. Clocks continue through errors, Undo, tab closure, and sleep. Only an accepted legal move transfers the clock and earns increment. Final results remain immutable. Undo rewinds the active line and separately archives discarded records.
- [Interface, KHA-12](https://linear.app/kamkm/issue/KHA-12/validate-the-connection-and-chess-match-interface), comment `d83e2c28-a5ba-48a4-a9b7-efee6228d228`. A, Classic workspace, is settled. The reference is `prototype/match-interface` at `6af7fa61aec5668b4e8b42c1f1ba4a89f37cda45`. Preserve its normal Chess.com structure and actual T3 themes. Complete screen-reader, keyboard, mouse, and touch play includes square/piece names, promotion, focus restoration, and concise announcements.

In this report, **Source** means inspected pinned code, official documentation, or a standard. **Observed** means a named local synthetic probe. **Proposal** means application work or a future experiment. **Unknown** means the evidence does not establish the claim. A source test file is evidence that the test exists, not that this research ran it.

The 2023 FIDE Laws provide the meanings of dead position, possible mate, and repetition identity. The product intentionally replaces FIDE's claim procedures for threefold and 50 moves with automatic endings. FIDE instead automatically ends at fivefold repetition or 75 moves, and its resignation rules also differ from the accepted immediate model-loss policy. This report does not replace the product decisions with the full tournament rules. [FIDE articles 5.1.2, 5.2.2, 6.9, 9.2, 9.3, 9.6][fide].

## Pins and reproducibility

These are inspected releases, not floating recommendations. [source-manifest.json][manifest] records npm metadata URLs, tarball integrity, SHA-256, repository commits, and source-archive SHA-256. [extra-source-manifest.json][extra-manifest] covers the adjudication alternatives and Lichess accessibility source. [source-review.json][source-review] preserves selected source excerpts and file hashes. [checksums.json][checksums] hashes the report and research evidence as LF-normalized text, matching Git's stored text independently of Windows checkout line endings. Downloaded tarball/source-file hashes retain their original byte semantics.

| Dependency | Release and exact source commit | Code license | Direct dependencies relevant to this research |
| --- | --- | --- | --- |
| chess.js | 1.4.0, `ce1ff9e9fc342984ff75ca475ab39f37888cb28a` | BSD-2-Clause | No runtime dependencies in its package metadata. |
| chessops | 0.15.1, `4a4cbd5ac6159adfb236a2616701253ae4c58b2d` | GPL-3.0-or-later | `@badrap/result ^0.3`, resolved to 0.3.1, MIT, in the probe lockfile. |
| cm-chessboard | 8.15.3, `be441fa1acc322c02cd6afae6ed99a51c8b93faa` | MIT | No runtime dependencies in its package metadata. Artwork has separate licenses below. |
| gchessboard | 1.4.0, `1b7c7dd9e3eca6c30c797b6b314777e8de273d5b` | MIT, with an Apache-2.0 source component | Published metadata lists `vite-plugin-bundlesize ^0.2.0` as a dependency despite the dependency-free description. Inspect actual bundled imports before adopting. |
| react-chessboard | 5.12.1, `5f99614dabadfcad6f78eaa5d7822e42b28179e6` | MIT | `@dnd-kit/core ^6.3.1`, `@dnd-kit/modifiers ^9.0.0`; React and React DOM `^19.0.0` peers. This report does not resolve a production React dependency tree. |
| Chessground | `@lichess-org/chessground` 10.4.2, tag commit `ddb6deff5546c76c82b7a61c4581b4122f01551d` | GPL-3.0-or-later | No runtime dependencies in its package metadata. npm has no `gitHead` here; the tag commit and npm tarball are separately pinned. |
| CHA-Solver | 3.0.0, `3484c7e65247003fac8705a9290dc2b5d0978b94` | MIT | Rust `chess =3.2.0`, MIT, and `rustc-hash` resolved to 2.1.3, Apache-2.0 OR MIT. Full native probe graph is locked and inventoried. |

License sources are the pinned [chess.js license][js-license], [chessops license][ops-license], [cm license][cm-license], [gchessboard license][g-license] and [embedded Apache header][g-munkres], [React license][react-license], [Chessground license notice][cg-readme], and [CHA-Solver license][cha-license]. Exact dependency metadata is in the manifests, [npm lockfile][npm-lock], [Cargo lockfile][cargo-lock], and [Cargo license inventory][cargo-licenses]. [Additional npm metadata and license files][ui-metadata] confirm MIT for dnd-kit core 6.3.1, modifiers 9.0.0, and vite-plugin-bundlesize 0.2.0. Their dependencies include utilities/accessibility/tslib and build-tool packages, respectively. Those inventories are not a complete legal review of a future browser bundle.

Observed environment was Windows `10.0.26300`, x64, Node `v24.22.0`, npm `11.19.1`, Python `3.13.5`, Rust `1.98.1`, Cargo `1.98.1`. The native Rust target was `x86_64-pc-windows-msvc`. No WASM target was installed or built. Source inspection supports browser suitability for the JavaScript libraries, but these executions were Node and native Rust experiments. In particular, Node exercises a different conditional export of `@badrap/result` from its browser default. Its Node engine requirement is not a browser compatibility certificate. [Recorded Node environment][results], [package metadata and native build][build-log].

To reproduce from the repository root:

```powershell
python experiments/chess-dependencies/acquire_sources.py
python experiments/chess-dependencies/acquire_extra_sources.py
Set-Location experiments/chess-dependencies
npm ci --ignore-scripts --no-audit --no-fund
npm run probe
python run_chasolver.py
node verify_chasolver.mjs
python collect_source_review.py
```

The rules probe includes 17 FEN cases, 16 move cases, eight ending cases, three repetition sequences, a complete finite-state wall exploration, and 12 grouped assertions. The Rust runner has a 180-second outer limit. Its first native build completed in 96 seconds after an ordinary crates.io connection retry. It did not run upstream test suites, live provider calls, or application tests. [Probe source][probe], [raw output][probe-output], [native build log][build-log].

## Rules comparison

### Legal moves and specific explanations

Source: chess.js `move({from,to,promotion})` matches a generated legal move and throws a generic `Invalid move` error if none matches. `moves()` can enumerate moves locally. chessops `isLegal()` returns a boolean, while `dests()`, `pseudoDests()`, attacks, and context expose lower-level facts. Crucially, chessops `play()` itself assumes a legal move. Calling it directly on `e2e5` mutates the start position, as the probe demonstrates. Its `parseUci()` is notation parsing, not legality validation. [chess.js move implementation][js-rules], [chessops legality and play][ops-rules], [observations][results].

Observed: both accepted ordinary moves, orthodox castling, en passant, and all four promotion choices in the selected legal fixtures. Both rejected blocked movement, wrong-side and empty origins, an exposed king, castling through check, pinned en passant, and promotion without a piece. These fixtures are bounded evidence, not exhaustive rule certification. The parser must classify a missing promotion suffix as formatting clarification before asking the rules component to validate it. Neither library supplies the accepted product's complete explanation vocabulary. [Move cases][results], [canonical move contract][canonical].

Proposal: use a small explanation adapter for the single submitted coordinate move. Check origin occupancy/color, target occupancy, piece geometry and blocked path, pawn capture/double-step state, promotion, castling rights/path/attacks, and the resulting king's safety. Return a reason and affected square or setting, such as an occupied intervening square or exposed king. Keep the library's legal predicate authoritative. Order overlapping failures deterministically and test that explanations agree with it. For chessops, `pseudoDests()` versus `dests()` helps isolate king-safety failures but is not a ready-made comprehensive reason API. For chess.js, public attack/board helpers and additional checked logic are needed. Never use a generic library exception as a rule-specific explanation, or send generated legal destinations, fallback moves, evaluations, or a solver witness to a model. Local human input assistance is separate from model request construction. [Available operations][ops-rules], [chess.js API/source][js-rules], [accepted independent-choice boundary][canonical].

### Custom-position validation and silent changes

Source and observed behavior:

| Input boundary | chess.js 1.4.0 | chessops 0.15.1 |
| --- | --- | --- |
| King count and pawns on a back rank | Rejects missing/extra kings and pawns on ranks 1 or 8. | `parseFen()` parses placement; `Chess.fromSetup()` rejects invalid king counts and back-rank pawns. |
| Adjacent kings or the nonmoving king in check | `validateFen()` and normal construction accepted the selected invalid boards. | `fromSetup()` rejected both with `ERR_OPPOSITE_CHECK`. It does not identify the square in that error. |
| Declared castling right without its rook | Accepted `K` without h1 rook. A direct move call even accepted `e1g1` on that inconsistent board. | Accepted setup creation but silently discarded the right. |
| King away from e1 with a declared white right | Accepted the selected input. | Accepted the selected d1 king/h1 rook setup under its Chess960-capable representation. Orthodox-only validation is additional work. |
| Invalid en-passant metadata | Checks field shape and side/rank, not all board consistency. Missing pushed pawn was accepted. | Position setup silently removes some inconsistent ep state. An occupied ep target was accepted in the selected otherwise consistent fixture. |
| Valid ep declaration with no legal ep capture | Default `fen()` omits it. `forceEnpassantSquare` exposes stored state, but does not repair invalid metadata or guarantee every past double push was retained. | Raw `epSquare` may retain it; `toSetup()` omits it when no legal capture exists. |
| Counters | Ordinary integers survive. `12x 7.5` was accepted and became `12 7`. `load()` supplies missing counters even though the strict standalone validator rejects missing fields. | Parser limits each numeric token to four digits and changes fullmove `0` to `1`. Position `halfmoves` retained `9999`, but `toSetup()` changed it to `150`; serialization also has caps. Fullmove `10000` was rejected. |

Every row above is backed by [validation and move observations][results] and the pinned [chess.js validation/serialization][js-rules], [chessops parsing][ops-fen], and [chessops setup/serialization][ops-rules]. Duplicate castling flags also collapse during serialization. These are reasons to validate the original fields before constructing the playable position, not reasons to accept silently rewritten settings.

Observed additional hazard: for `7k/8/3N4/3pP3/8/8/8/4K3 w - d6 0 9`, chess.js accepted the occupied ep target d6. Calling default `fen()` then removed the white knight on d6 from the instance during its speculative ep check. The raw `occupiedEpSerialization` record contains `get('d6')` before and after. This is an invalid setup, so it does not establish corruption on validated orthodox positions. It does establish why basic prevalidation must precede even serialization of user input. [Minimal probe and raw evidence][probe], [serialization implementation][js-rules].

Proposal: retain an editable draft independently of a rules-library position. A strict orthodox adapter should check six-field structure, exact integer syntax and supported numeric bounds, one king per side, nonadjacent kings, pawn ranks, and the nonmoving side's king not being attacked. A side to move may be in check. Validate claimed rights against the king and same-color rook on their orthodox home squares. Occupied castling paths or attacked transit squares temporarily prevent castling; they do not by themselves invalidate the right. For ep, check side/rank, an empty target, the correct opposing pawn after its double push, an empty origin square, and consistency with counters. Do not require an adjacent capturer. Identify the exact field/square on rejection. These are proposed local consistency checks, not a retrograde reachability test. [Custom-start boundary][canonical], [castling and ep rule definitions][fide].

Keep the imported counters and meaningful declared position state available to the board settings, save, piece list, and model FEN. Keep a separate effective ep value for repetition equality. A valid but uncapturable ep target and `-` are equivalent for repetition; that does not authorize silently changing the player's imported draft. For chessops, bypassing `toSetup()` counter caps and adding wider strict parsing requires a reviewed adapter or fork. Do not clamp large counters to permit Start. If an input exceeds a chosen implementation bound, report the limitation explicitly; the accepted contract has not approved an arbitrary four-digit limit. [Serialization source][ops-fen], [position equality][ops-rules], [canonical counter policy][canonical].

Unknown: neither selected library proves historical reachability, which is outside this setup contract. chessops also exports `isImpossibleCheck()` and `isStandardMaterial()` separately; `fromSetup()` does not call them. Do not call its successful setup validation proof of all conceivable local validity, or silently introduce a retrograde legality requirement through extra helpers. [Setup implementation and helpers][ops-rules].

### Endings, repetition, Undo, and counters

Source: both libraries expose check, checkmate, stalemate, and material predicates. chess.js also stores position counts and exposes `isThreefoldRepetition()` and `isDrawByFiftyMoves()`, the latter testing at least 100 halfmoves. chessops `isEnd()` and `outcome()` do not include repetition or the halfmove rule. It has `equalsIgnoreMoves()`, which compares board, turn, castling rights, and legally usable ep while ignoring counters. Its numeric position hash is not itself a saved repetition ledger or a collision-free equality proof. [chess.js endings and hashing][js-rules], [chessops endings and equality][ops-rules].

Observed: the custom start `4k1n1/8/8/8/8/8/8/R3K1N1 w - - 7 23`, followed by `g1f3 g8f6 f3g1 f6g8` twice, produced chess.js threefold at ply 8. The starting position counts once. A FEN reload of a repeated position loses that history. `undo()` updates library history, but restoring only a FEN does not restore the accepted lifecycle state. [Repetition and Undo observations][results].

Observed gap: `4k3/8/8/4p3/8/8/8/R3K1N1 w - e6 0 9`, with cycle `g1f3 e8f8 f3g1 f8e8` twice, had three equivalent positions according to legal ep equality, but chess.js reported no threefold until ply 12. The pinned-ep fixture `k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1` reproduced the same delay. chess.js hashes its stored ep square even when no ep capture is legal, including imported state. The report does not generalize these two cases into a claim that every chess.js repetition check fails. [Raw per-ply hashes and counts][results], [hash source][js-rules], [FIDE repetition identity, article 9.2.3][fide].

Observed precedence gap: starting at `7k/8/5KQ1/8/8/8/8/8 w - - 99 42`, `g6g7` checkmates at halfmove 100. chess.js simultaneously returns true for `isCheckmate()`, `isDrawByFiftyMoves()`, and `isDraw()`. A controller that checks draw first records the wrong result. chess.js also accepted `a1a2` after an already reached 100-halfmove threshold. Predicates do not enforce final-result immutability. [Raw `mateAt100` and `moveAfterDrawThreshold`][results].

Proposal: the application owns an explicit ordered adjudication operation, with the just-accepted move's checkmate before the move-count draw. Keep exact position identity or hash plus exact collision checking, starting with one occurrence of the custom start. Apply the automatic third/100 thresholds at terminal prechecks and after accepted moves. Persist the initial position, accepted moves, checkpoints, repetition ledger, counters, and adjudication version. Undo restores the retained ledger; discarded occurrences stay in the archive and do not participate. Fresh practice keeps the actual retained rules history. Separate custom editing starts a new ledger. Do not use a board component's FEN or a generic `gameOver` flag as the entire match state. [Accepted lifecycle and custom-start rules][canonical].

## Complete dead positions and flag-fall possibility of mate

### Reproduced material-test failures

Observed dead position:

```text
4k3/8/8/p1p1p1p1/PpPpPpPp/1P1P1P1P/8/4K3 w - - 0 1
```

The probe explores the complete reachable component while ignoring counters, so draws by move count do not artificially end the search. It reached 768 distinct positions and 3,808 legal transitions. Every move was a king move. No position contained check or checkmate. chess.js and chessops agreed on the legal move set at every reached state. The queue exhausted, so a longer cooperative line cannot escape this component. This finite closure proves deadness for this fixture without using either material helper as the proof. Both libraries nevertheless reported `isInsufficientMaterial() === false`; chessops reported false for each side separately. [Closure algorithm][probe], [raw closure and ending results][results].

This is not merely an inability to force mate. It is inability to reach any mate even with cooperation. Material counting also fails the side-specific requirement when a side still has pawns or bishops trapped behind a wall. Source: chessops immediately returns false from `hasInsufficientMaterial(color)` when that side has any pawn, rook, or queen. Its remaining cases consider limited minor-piece configurations. That is useful sufficient-case detection, not a complete position-sensitive decision procedure. chess.js has no equivalent side parameter. [Material implementations][ops-rules], [chess.js material implementation][js-rules], [FIDE articles 5.2.2 and 6.9][fide].

Observed and source-supported asymmetric case:

```text
5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1
```

Both generic helpers missed this distinction. The pinned CHA-Solver documentation identifies Black as unable to mate and White as able to mate. Our native probe returned the same verdicts and a 17-ply White helpmate; both JavaScript libraries accepted that full line and recognized the final checkmate. If White flags here, the required result is a draw because Black cannot mate. It is not a globally dead position. This experiment verifies the returned White witness, not the whole soundness proof of the solver's Black verdict. [Pinned example][cha-readme], [native results][cha-results], [independent witness replay][cha-verification].

Other observed controls prevent replacing possibility with common material slogans. A bare king cannot mate an opposing king and rook even though the whole position is not dead. A knight can mate when an enemy rook blocks an escape. `6rk/8/3N3K/8/8/8/8/8 w - - 0 1`, followed by `d6f7`, is checkmate. Two knights versus a bare king are also not covered by a rule saying that inability to force mate means inability to mate. [Controls and mating position][results], [side-specific material source][ops-rules].

### Alternatives and remaining conflict

Source: CHA-Solver's full `winnability()` returns `Some(Winnable { helpmate })`, `Some(Unwinnable)`, or `None`. Its fast boolean returns false for an inconclusive position, not proof that mate is possible. The final search phase is limited to `1 << 24` nodes and depth 128. The author's reported database coverage and performance are upstream claims, not measurements on the required browsers. The README explicitly does not prove theoretical completeness. [API semantics][cha-api], [search limits][cha-full], [upstream coverage qualification][cha-readme]. The related paper is Miguel Ambrona, *A Practical Algorithm for Chess Unwinnability*, FUN 2022, DOI `10.4230/LIPIcs.FUN.2022.2`. [Primary publication][paper].

Observed: the native probe made eight queries over four boards and two intended winners. It returned four unwinnable verdicts and four mating witnesses, with no unknowns in this sample. Witnesses had 17, 20, 41, and 44 plies and ended in checkmate in both chess.js and chessops. The locked-wall unwinnable result agrees with the separate complete closure. This is narrow evidence. The probe did not implement a WASM binding, cancellation, browser memory limits, arbitrary FEN import, or an immutable match result. [Native fixture code][rust-probe], [verification][cha-verification].

The pinned scalachess source is MIT and has side-specific material cases plus an immediate-successor check for forced insufficient material or stalemate. That is an interesting rules reference, not a demonstrated complete replacement or a ready-to-use browser dependency. Its global material predicate still checks restricted material classes. No Scala.js compilation or scalachess execution was attempted. [Material source][scala-material], [forced-successor logic][scala-position], [license][scala-license].

Proposal A, preserving the requirement: evaluate a browser-local adjudication worker around CHA-Solver or a reviewed equivalent, backed by sound proof rules and an exact fallback. Verify the returned witness locally; never reveal it as advice to the model. Run both colors for deadness and the prospective winner for timeout adjudication. Establish WASM portability, dependency licenses, soundness on the permitted current-state-valid custom boards, and worst-case resources. Some permitted custom boards may be unreachable historically, so evidence about real games or known legal compositions does not establish full input-domain coverage. Keep this as unresolved architecture work until the undecided path has a contract-compliant answer.

Proposal B, preserving the requirement but likely expensive: exact cooperative reachability over the finite chess-position graph, with reusable proved classifications and sound pruning. The small wall closure shows how a finite proof can work; it does not establish acceptable resource use on general positions. Ordinary optimal-play WDL tablebases are not an answer by themselves. A draw with best defense can still allow a cooperative mate, and a small-piece tablebase does not cover arbitrary custom boards. This research found no browser-ready, universally demonstrated solution with a guaranteed practical bound.

An owner-approved amendment to a documented subset of dead-position and flag-fall rules would be another product path. It would change the accepted contract and cannot be adopted by this report. In particular, treating `None` or fast false as proof of mating possibility, silently using a generic material test, adjudicating on a chess backend, or leaving time frozen while a solver works would not satisfy the current boundary. An undecided position at expiry also conflicts with the requirement to settle one immutable result. Architecture must resolve that case explicitly, without inventing a temporary win that can later be rewritten. The evidence does not warrant claiming this gap closed. [Accepted lifecycle][canonical], [solver's explicit unknown result][cha-api].

## Board and input approaches

All entries below concern a board within A's approved workspace, player rows/clocks, and detail panel. None reopens the layout or theme decision. Board dependencies should emit proposed input and render committed state. The browser match controller validates moves and owns turns, promotion completion, clocks, and results. Board-local movement or animation completion must not become clock authority.

| Approach | Source-supported input and accessibility | Application-owned work and unknowns |
| --- | --- | --- |
| cm-chessboard 8.15.3 | Mouse/touch input; SVG rendering; Accessibility extension with labeled from/to form, HTML table, piece lists, optional arrow navigation, Enter/Space selection, Escape cancellation, live square announcements. Keyboard board input defaults to false and must be enabled. PromotionDialog has four named choices, SVG dialog/button roles, keyboard handling, a focus trap, Escape, and previous-focus restoration. [Accessibility][cm-a11y], [promotion][cm-promotion], [view/input][cm-view]. | Wire every path to the same validator and promotion operation. Audit SVG focus and `role=application` with real screen readers. The form emits only from/to; it needs the same explicit promotion step. Add match turn/error/result/clock announcements and accessible editor controls. Its built-in de/en messages do not establish broader localization. No AT result is recorded here. |
| gchessboard 1.4.0 | Web component with table/grid cells, named square/piece buttons, one tab stop, arrow navigation, keyboard selection, pointer/touch state handling, and focus management. `moveend` is cancelable. Repository tests cover keyboard, focus, taps, clicks, and dragging, with Chromium/Firefox/WebKit projects configured. [Square semantics][g-square], [board handlers][g-board], [tests][g-tests], [tutorial][g-tutorial]. | README calls screen-reader support rudimentary. No inspected built-in explicit promotion chooser or complete position-editor workflow. Build named promotion controls and editor actions, turn/error announcements, state reconciliation, and Shadow DOM/AT tests. Existing Playwright test definitions are not recorded native Safari, mobile, or AT passes. |
| react-chessboard 5.12.1 | React renderer, click handlers, spare pieces, dnd-kit mouse/touch/keyboard sensors. Draggable spreads dnd-kit attributes and listeners. Promotion is demonstrated in an application story. [Sensors][react-provider], [draggable][react-draggable], [promotion example][react-promotion]. | Sensor presence does not establish named board navigation or complete screen-reader chess. Inspected squares are click/touch divs rather than a complete semantic chess grid. The promotion story uses piece-image buttons without the required explicit names/focus/dialog behavior. Supply a semantic board or full parallel input, accessible promotion, editor, and match announcements. React 19 is a version constraint, not a selected application stack. [Square rendering][react-square]. |
| Chessground 10.4.2 plus an application accessibility layer | Strong pointer/touch board and editor APIs, click/drag, configurable destinations, piece rendering and animation; no chess rules. Inspected core input binds touch/mouse events, not a complete keyboard/screen-reader board. [README][cg-readme], [events][cg-events], [rendering][cg-render]. | Build full keyboard/screen-reader interaction and explicit promotion. Lichess's separate NVUI contains a move form, board controls, square navigation, notifications, and clock readout. It is not included by importing Chessground. Porting that code brings Lila's separate AGPL-3.0-or-later terms and substantial application coupling. Never import its analysis/best-move commands into the model's independent move flow. [NVUI view][lila-view], [commands][lila-commands], [Lila licensing][lila-license]. |
| Application-owned semantic board, optionally paired with a visual renderer | Proposal: 64 semantic squares with roving focus, explicit from/to input, a position/piece list, named promotion controls, and a keyboard/touch piece palette for editing. Styling and pointer dragging can remain inside A. WAI's grid/dialog patterns provide interaction guidance. [Grid guidance][apg-grid], [dialog guidance][apg-dialog]. | More application work, but avoids assuming a visual board already supplies complete AT behavior. Avoid two conflicting accessible boards or duplicate announcements. Pick one accessible interaction model over the same committed state. Every behavior needs native browser and AT evidence. This proposal is not an implemented or tested component. |

### Required completion work and actual acceptance

Proposal: retain click/tap origin-then-destination and explicit coordinate input even when dragging is available. Keyboard-only and screen-reader users must inspect every square, identify empty squares and piece/color, know whose turn it is, select and cancel a move, castle and capture en passant, and choose all four promotions. A pending promotion keeps the original position and live clock until the controller accepts the completed move. Escape cancels the choice without choosing a queen, transferring the clock, or earning increment. An open dialog must close or become inactive on a final result, Undo, or a superseding revision. [Accepted interface/lifecycle][canonical], [WCAG 2.2 keyboard and dragging requirements][wcag].

Proposal: return focus to a meaningful square/control after promotion, rejection, Undo, theme/orientation changes, restore, and end-of-game dialogs. Do not move focus on each streamed token or clock tick. Provide concise live announcements for turn, accepted move/capture/check, invalid input, promotion, expiry, save/restore failure, and final result. Make clock readings available on demand and use tested warnings without a once-per-second speech stream. Board inspection and coordinate input must remain usable when it is the model's turn. [Accepted complete-play requirement][canonical], [WAI interaction guidance][apg-grid], [modal focus guidance][apg-dialog], [status-message criterion][wcag].

Proposal: the editor needs a named piece/color palette, place/replace/remove actions without dragging, square inspection, clear/reset, pasteable FEN, side-to-move, castling, ep, counters, and actionable errors. It must support incomplete invalid drafts with missing kings, rather than routing all edits through a rules class that rejects invalid playable positions. Do not auto-start a terminal setup or let a board's placement-only FEN overwrite the other five rules fields. [Custom-position resolution][canonical], [cm placement API][cm-board], [gchessboard position API][g-tutorial].

Unknown: complete screen-reader play in Windows Chrome/Edge/Firefox, macOS Safari, iOS Safari, and Android Chrome. None was exercised here. The later acceptance matrix should record exact OS, browser, device, AT version/settings, and input method. Test NVDA and a chosen additional Windows AT where supported; VoiceOver on native macOS/iOS Safari; TalkBack on an Android device with Chrome. Include ordinary play through a result, both orientations, all promotion choices, errors and recovery while time runs, custom editing, Undo, refresh, dialogs, and restored focus. Keyboard or automated accessibility-tree checks cannot substitute for those tasks. Playwright WebKit is not native Safari certification, and Windows Chromium evidence cannot certify Firefox, Safari, or mobile. [Accepted browser/interface requirements][canonical], [upstream configured browser projects only][g-tests].

## Code, artwork, and distribution

Source-backed distribution implications, pending the owner's project-license choice:

- chess.js BSD-2-Clause permits redistribution and modification with its notices and disclaimer retained. MIT code candidates likewise require preservation of copyright and permission notices. These allow a permissive application license if other included code/assets permit it; they do not themselves choose the project's license. [BSD text][js-license], [MIT examples][cm-license].
- chessops and Chessground are GPL-3.0-or-later. Serving their JavaScript to users conveys program copies. Plan for GPL-compatible distribution of a combined covered frontend, license/copyright notices, and corresponding source including relevant build scripts. Chessground's own README expressly states its combined-work/source expectation. Putting a dependency behind an import, a Web Worker, or WASM is not evidence of an exception. GPL coverage of a combined frontend does not automatically decide the license of every independent backend service. This is a distribution constraint to resolve, not a project-wide legal ruling. [GPL text, sections 0, 1, 4, 5, 6][ops-license], [Chessground's notice][cg-readme].
- Lichess accessibility code is a separate AGPL-3.0-or-later consideration. The Lila default license is not Chessground's GPL or scalachess's MIT. Reuse ideas and inspect interfaces without assuming every Lichess repository has the same license. [Lila copying rules][lila-license], [scalachess MIT][scala-license].
- cm-chessboard's actual default `pieces/standard.svg` is CC BY-SA 3.0 with Cburnett/Rfc1394 credits and shaack modifications. Its optional `pieces/staunty.svg` is CC BY-NC-SA 4.0. The marker SVG is separately CC BY-SA 3.0. The README still uses older sprite filenames; inspect the actual shipped paths. A zero-dollar website is not blanket permission to ignore NonCommercial terms, and open-source code does not remove asset restrictions. [Default asset configuration][cm-board], [standard sprite][cm-standard], [Staunty sprite][cm-staunty], [marker sprite][cm-markers].
- gchessboard's bundled pieces credit Cburnett under CC BY-SA 3.0. Its embedded `munkres.ts` is Apache-2.0 despite the package-level MIT label. react-chessboard's default `src/pieces.tsx` also credits Cburnett/CC BY-SA 3.0. Package-level MIT does not erase these notices. Audit any optional piece packs or demonstration images separately. [gchessboard attribution][g-readme], [Apache component][g-munkres], [React piece header][react-pieces].
- A supplied external Chessground piece set needs its own provenance/license review. The inspected board package is not permission to copy all Lichess art or assets. Lila's copying inventory contains multiple asset exceptions. [Lila asset inventory][lila-license].
- CC BY-SA artwork can be used commercially with attribution and the applicable share-alike obligations for adaptations. Keep asset credits, source links, license links, and modification notices. Do not describe the whole application as CC BY-SA solely because it displays a separately licensed piece set. CC BY-NC-SA adds a material commercial-use restriction. The code and artwork must each have an intentional distribution plan. [BY-SA deed and legal-code link][cc-sa], [BY-NC-SA deed and legal-code link][cc-nc].
- CHA-Solver is MIT, while its native probe graph includes additional MIT/Apache alternatives and `unicode-ident` with Unicode-3.0 obligations. [Exact native inventory][cargo-licenses] is a starting point, not a WASM bill of materials. A browser port must re-check the target-specific graph and required notices. [CHA license][cha-license], [Cargo lock][cargo-lock].

Actionable alternatives are a BSD/MIT rules-and-board combination with original or deliberately licensed art, or a GPL-compatible frontend that uses chessops and/or Chessground with the required source distribution. cm-chessboard can use its standard BY-SA set or an independently sourced replacement; adopting Staunty needs an explicit decision about its NonCommercial restriction. No dependency choice here approves the project license. Hosted vendor, budget, and hosting license choices remain outside this issue.

## Architecture handoff

Supported operations are usable building blocks. The missing work is concrete:

1. Select a code/art distribution path after the human license choice. chess.js offers the simpler permissive rules dependency, with extra validation and repetition work. chessops offers richer position operations and side-specific material cases, with GPL distribution, orthodox setup restrictions, counter preservation, and an application repetition ledger. Neither closes complete deadness or flag-fall rules.
2. Define and verify the strict FEN/current-state adapter before depending on library normalization. Keep editable drafts, validated rules state, effective repetition identity, and displayed/model position representations consistent.
3. Resolve complete position-sensitive adjudication, including unknown results on permitted custom boards and time expiry. CHA-Solver is a promising research path, with native evidence and explicit portability/completeness gaps. Do not certify a material helper as complete.
4. Prototype the selected board's full input and promotion/editor paths within the approved A workspace. Run actual AT and native browser acceptance. cm-chessboard and gchessboard are credible candidates, with different integration and license costs; this report does not select one.
5. Keep browser match authority separate from the renderer and rules library. Serialize legal move acceptance, result detection, expiry, and Undo. Preserve current-line rules/repetition state and the separate full archive. Clocks, stale-response fencing, increment removal on Undo, owner sync/CAS, and immutable results remain application work. Nothing tested here establishes closed-tab timing or cross-device ordering.

All rules, match transitions, clocks, discovery, and generation stay browser-owned under the assigned boundary. Hosted auth/database can support owner-only sync and ownership/CAS metadata. AI credentials stay device-local by default and never enter the chess backend or sync. Dependency selection does not authorize a server AI relay, legal-move suggestions to models, history truncation, model fallback, or extra paid compatibility checks. The existing new/practice and changed-selection compatibility policy remains unchanged.

## Handoff and cleanup

Worktree is `C:\Users\Lenovo\.t3\worktrees\kamkmchess\t3-b9017029`, branch `t3/chess-dependency-research`, based on parent `161622f`. The deliverables are this report and `experiments/chess-dependencies/`. Only those explicit paths are intended for integration. No application implementation, tracker edits, issue closure, push, public message, provider call, secret, or provisioning occurred.

Completed checks were the 12 grouped rules assertions, all 768 wall states/3,808 transitions with legal-set agreement, eight native solver queries, and all four cross-library mating-witness replays. The source manifests and report links received local consistency checks. Browser/AT, WASM, general solver completeness and resources, complete future dependency licensing, and production clock/storage behavior remain gaps.

All owned commands completed. No helper server, browser tab, listener, or recurring task was started. Downloaded sources, native build output, and Node dependencies are confined to ignored `.cache/` and `node_modules/` inside the evidence directory. They are reproducible and are not part of the commit. The build log retains its network retry. Evidence scripts and locks are research artifacts, not production dependencies.

[canonical]: ../experiments/chess-dependencies/canonical-resolutions.json
[manifest]: ../experiments/chess-dependencies/source-manifest.json
[extra-manifest]: ../experiments/chess-dependencies/extra-source-manifest.json
[source-review]: ../experiments/chess-dependencies/source-review.json
[npm-lock]: ../experiments/chess-dependencies/package-lock.json
[cargo-lock]: ../experiments/chess-dependencies/chasolver-probe/Cargo.lock
[cargo-licenses]: ../experiments/chess-dependencies/cargo-license-inventory.json
[ui-metadata]: ../experiments/chess-dependencies/ui-dependency-metadata.json
[checksums]: ../experiments/chess-dependencies/checksums.json
[probe]: ../experiments/chess-dependencies/probe.mjs
[results]: ../experiments/chess-dependencies/results.json
[probe-output]: ../experiments/chess-dependencies/probe-output.txt
[rust-probe]: ../experiments/chess-dependencies/chasolver-probe/src/main.rs
[build-log]: ../experiments/chess-dependencies/chasolver-build.log
[cha-results]: ../experiments/chess-dependencies/chasolver-results.jsonl
[cha-verification]: ../experiments/chess-dependencies/chasolver-verification.json
[fide]: https://handbook.fide.com/chapter/E012023
[paper]: https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.FUN.2022.2
[js-rules]: https://github.com/jhlywa/chess.js/blob/ce1ff9e9fc342984ff75ca475ab39f37888cb28a/src/chess.ts
[js-license]: https://github.com/jhlywa/chess.js/blob/ce1ff9e9fc342984ff75ca475ab39f37888cb28a/LICENSE
[ops-rules]: https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/chess.ts
[ops-fen]: https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/src/fen.ts
[ops-license]: https://github.com/niklasf/chessops/blob/4a4cbd5ac6159adfb236a2616701253ae4c58b2d/LICENSE.txt
[cm-license]: https://github.com/shaack/cm-chessboard/blob/be441fa1acc322c02cd6afae6ed99a51c8b93faa/LICENSE
[cm-board]: https://github.com/shaack/cm-chessboard/blob/be441fa1acc322c02cd6afae6ed99a51c8b93faa/src/Chessboard.js
[cm-view]: https://github.com/shaack/cm-chessboard/blob/be441fa1acc322c02cd6afae6ed99a51c8b93faa/src/view/ChessboardView.js
[cm-a11y]: https://github.com/shaack/cm-chessboard/blob/be441fa1acc322c02cd6afae6ed99a51c8b93faa/src/extensions/accessibility/Accessibility.js
[cm-promotion]: https://github.com/shaack/cm-chessboard/blob/be441fa1acc322c02cd6afae6ed99a51c8b93faa/src/extensions/promotion-dialog/PromotionDialog.js
[cm-standard]: https://github.com/shaack/cm-chessboard/blob/be441fa1acc322c02cd6afae6ed99a51c8b93faa/assets/pieces/standard.svg
[cm-staunty]: https://github.com/shaack/cm-chessboard/blob/be441fa1acc322c02cd6afae6ed99a51c8b93faa/assets/pieces/staunty.svg
[cm-markers]: https://github.com/shaack/cm-chessboard/blob/be441fa1acc322c02cd6afae6ed99a51c8b93faa/assets/extensions/markers/markers.svg
[g-readme]: https://github.com/mganjoo/gchessboard/blob/1b7c7dd9e3eca6c30c797b6b314777e8de273d5b/README.md
[g-license]: https://github.com/mganjoo/gchessboard/blob/1b7c7dd9e3eca6c30c797b6b314777e8de273d5b/LICENSE
[g-munkres]: https://github.com/mganjoo/gchessboard/blob/1b7c7dd9e3eca6c30c797b6b314777e8de273d5b/src/utils/munkres.ts
[g-square]: https://github.com/mganjoo/gchessboard/blob/1b7c7dd9e3eca6c30c797b6b314777e8de273d5b/src/components/BoardSquare.ts
[g-board]: https://github.com/mganjoo/gchessboard/blob/1b7c7dd9e3eca6c30c797b6b314777e8de273d5b/src/components/Board.ts
[g-tests]: https://github.com/mganjoo/gchessboard/blob/1b7c7dd9e3eca6c30c797b6b314777e8de273d5b/playwright.config.ts
[g-tutorial]: https://github.com/mganjoo/gchessboard/blob/1b7c7dd9e3eca6c30c797b6b314777e8de273d5b/docs/src/tutorial.md
[react-license]: https://github.com/Clariity/react-chessboard/blob/5f99614dabadfcad6f78eaa5d7822e42b28179e6/LICENSE
[react-provider]: https://github.com/Clariity/react-chessboard/blob/5f99614dabadfcad6f78eaa5d7822e42b28179e6/src/ChessboardProvider.tsx
[react-draggable]: https://github.com/Clariity/react-chessboard/blob/5f99614dabadfcad6f78eaa5d7822e42b28179e6/src/Draggable.tsx
[react-square]: https://github.com/Clariity/react-chessboard/blob/5f99614dabadfcad6f78eaa5d7822e42b28179e6/src/Square.tsx
[react-promotion]: https://github.com/Clariity/react-chessboard/blob/5f99614dabadfcad6f78eaa5d7822e42b28179e6/docs/stories/advanced-examples/PiecePromotion.stories.tsx
[react-pieces]: https://github.com/Clariity/react-chessboard/blob/5f99614dabadfcad6f78eaa5d7822e42b28179e6/src/pieces.tsx
[cg-readme]: https://github.com/lichess-org/chessground/blob/ddb6deff5546c76c82b7a61c4581b4122f01551d/README.md
[cg-events]: https://github.com/lichess-org/chessground/blob/ddb6deff5546c76c82b7a61c4581b4122f01551d/src/events.ts
[cg-render]: https://github.com/lichess-org/chessground/blob/ddb6deff5546c76c82b7a61c4581b4122f01551d/src/render.ts
[lila-view]: https://github.com/lichess-org/lila/blob/e4de08fdf77453ff7ab2d039113b931730826af5/ui/round/src/view/nvuiView.ts
[lila-commands]: https://github.com/lichess-org/lila/blob/e4de08fdf77453ff7ab2d039113b931730826af5/ui/lib/src/nvui/command.ts
[lila-license]: https://github.com/lichess-org/lila/blob/e4de08fdf77453ff7ab2d039113b931730826af5/COPYING.md
[cha-api]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/lib.rs
[cha-full]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/winnability/full.rs
[cha-readme]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/README.md
[cha-license]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/LICENSE
[scala-material]: https://github.com/lichess-org/scalachess/blob/e3f7eb8f73a268f668d70e594e8f2426d8614881/core/src/main/scala/InsufficientMatingMaterial.scala
[scala-position]: https://github.com/lichess-org/scalachess/blob/e3f7eb8f73a268f668d70e594e8f2426d8614881/core/src/main/scala/Position.scala
[scala-license]: https://github.com/lichess-org/scalachess/blob/e3f7eb8f73a268f668d70e594e8f2426d8614881/LICENSE
[apg-grid]: https://www.w3.org/WAI/ARIA/apg/patterns/grid/
[apg-dialog]: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
[wcag]: https://www.w3.org/TR/2024/REC-WCAG22-20241212/
[cc-sa]: https://creativecommons.org/licenses/by-sa/3.0/
[cc-nc]: https://creativecommons.org/licenses/by-nc-sa/4.0/
