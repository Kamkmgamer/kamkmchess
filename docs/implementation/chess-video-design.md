# Browser chess recap videos

Proposed design, investigated 2026-11-01. This is an implementation proposal, not a shipped feature or a browser export acceptance result.

The user presses **Make a video about it** after a completed game. The browser reviews the game's moves with Stockfish, constructs a timed sequence using rules and caption templates, synthesizes background music, and exports a video locally. No LLM, hosted analysis, video generation model, or music generation model is required. Stockfish's existing NNUE evaluation remains part of the chess engine.

## What the app already provides

- The root package pins `stockfish@19.0.1`. The build copies the full and Lite single-threaded JS/WASM pairs. Both run without cross-origin isolation. [Preparation script](../../scripts/prepare-engines.mjs), [engine documentation](../browser-engines.md), [upstream package documentation](https://github.com/nmrugg/stockfish.js/tree/v19.0.1).
- `isEngineDownloaded`, `downloadBrowserEngine`, and `BrowserUciEngine` already cover versioned, same-origin assets, cache checks, downloads, cancellation, and worker lifecycle. Cache availability is best-effort and belongs to this site and browser profile. The app cannot discover an engine installed by an unrelated site or desktop application. [Browser engine module](../../src/engines/browser.ts).
- The existing evaluator owns an independent worker, but always selects Lite. Its public result contains only a White-relative score and depth. It discards non-primary variations and bounded scores. It is suitable for the evaluation bar, but does not yet expose everything a game review needs. [Evaluator](../../src/engines/evaluation.ts), [score parser](../../src/engines/uci-score.ts).
- Saved rules contain the starting FEN and ordered moves with SAN, coordinates, promotion, and FEN before and after each move. History navigation already reads this data without changing the game. [Storage types](../../src/storage/types.ts), [history hook](../../src/ui/use-board-history.ts).
- Hosted games adapt their public SAN history into the same move records. The adapter can fall back to an incomplete history anchored on the current position. A recap must check completeness before claiming to cover the whole game. Hosted payloads currently provide current clock banks rather than historical banks for every move. [Hosted session](../../src/agents/hosted-session.ts).
- The result card is a natural entry point. The app already synthesizes short result sounds with Web Audio, but has no music score, video timeline, or video exporter. [Result card](../../src/ui/GameResultCard.tsx), [sounds](../../src/ui/sounds.ts).

## User flow

1. Offer the action when `checkpoint.result.kind === 'final'`. Support local and hosted games through the common snapshot shape. Do not offer a full recap for an unresolved or partially recovered game.
2. Copy an immutable, minimal replay snapshot. Include the starting FEN, moves, actual result, display names, and selected board and piece styles. Exclude provider conversations, connection configuration, credentials, and seat tokens. Give the job a game identity, line identity, content hash, and generation so late results cannot update another game's export.
3. Automatically choose full Stockfish if its assets are already available to this site and it starts successfully. Otherwise use Lite, downloading Lite with progress if needed. Do not automatically fetch the large full build. Let a person explicitly choose it later as an optional quality setting.
4. Show analysis progress, followed by an editable recap preview. Default to a vertical video with captions and music. Offer mute, orientation, and full replay versus highlights without requiring configuration before the first result.
5. Export on an explicit click, then offer a download and a share action when file sharing is supported. Keep the review and timeline when export fails so a lower export preset does not require another engine run.

The exact example-video style is unverified. The referenced thread contains a game, but no example video asset. The design assumes animated chess pieces, move badges, arrows, short captions, an evaluation bar, and instrumental music.

## Engine review

Add a game-review API beside the position evaluator. Reuse its worker transport and downloaded assets, while keeping a dedicated review worker. Do not borrow an opponent's worker or send analysis through the LLM provider layer. Close idle opponent and evaluation workers when the finished-game recap owns the screen.

Select one engine build for the review and record its exact version, build identity, analysis settings, and grading-rule version. If full Stockfish fails and Lite takes over, restart the review under a new analysis identity. Do not silently compare results produced by different builds.

Use unrestricted engine strength, the chosen hash limit, `UCI_ShowWDL=true`, and a bounded search budget. Prefer fixed node budgets for repeatability, with a wall-time watchdog and cancellation. A node limit is a search budget, not a confidence guarantee. Record the reached depth and actual nodes, and define a consistent hash-reset policy. Benchmark budgets on real devices before choosing production defaults.

For every search, send the starting FEN and the complete coordinate-move prefix. A current FEN alone loses repetition history. Preserve halfmove counters, custom starts, Black-to-move starts, promotion, and castling context. Treat game-ending rules and the saved result as authoritative; an engine forecast must not rewrite a timeout or resignation as checkmate. [Position/history contract](../../src/engines/browser.ts), [result types](../../src/storage/types.ts).

Extend analysis results to retain:

```ts
interface ReviewLine {
  depth: number;
  nodes: number;
  multipv: number;
  bound: 'exact' | 'lower' | 'upper';
  score: { kind: 'cp' | 'mate'; value: number };
  wdl?: { win: number; draw: number; loss: number };
  pv: string[];
}
```

Keep these values relative to the searched root's side to move. Convert to White-relative values only at presentation boundaries. Parse complete `info` lines, retain the last complete exact iteration, and collect candidate lines at the same depth. Do not construct a comparison from unrelated depths or a mixture of bounds and exact scores. Validate every displayed principal variation through the existing rules module. Validate the played root move before sending `searchmoves`, and put that argument last in the command. Wait for `bestmove` before starting the next search; `readyok` alone does not mean a search has finished. [Stockfish source and protocol findings](chess-video-platform-research.md#stockfish-19-and-uci-grading).

Use two analysis passes:

1. Analyze the positions along the played line to locate likely errors, turning points, checks, captures, promotions, and mate forecasts. Neighboring positions give a preliminary assessment after reversing the side-to-move perspective. Cache these results and show progress by completed positions.
2. Confirm candidate annotations at greater search effort. At the position before a move, compare unrestricted best play with a search restricted to the played move using `searchmoves`. Request `MultiPV=2` or more when testing whether a strong move had reasonable alternatives. Compare exact results from the same root and engine settings. Recheck close grade thresholds or unstable scores. Low-confidence moves remain unannotated rather than receiving dramatic labels.

The initial scan is a candidate finder. Confirm every error or exceptional-move badge that will appear in the video. Unconfirmed moves may be shown as ordinary moves, but must not receive an invented positive grade. A detailed review that promises a grade for every move needs the confirmation work for every move.

### Move quality

When WDL is available, calculate expected game score for the mover:

```text
expectedScore = (win + 0.5 * draw) / 1000
loss = max(0, bestExpectedScore - playedExpectedScore)
```

This is expected points under the engine's WDL model, not a personalized probability that this player will win. Calibrate full and Lite separately; a shared UCI output format does not establish identical statistical calibration. If comparing a child position during the scan, swap its wins and losses first. Confirmed comparisons use the same pre-move root and avoid that sign ambiguity. If a played-move search scores materially above the supposedly best search, increase search effort or mark the assessment uncertain before clamping the final loss.

Proposed initial error bands are less than 0.02 for a sound move, 0.02 to less than 0.05 for a small inaccuracy, 0.05 to less than 0.10 for an inaccuracy, 0.10 to less than 0.20 for a mistake, and 0.20 or more for a blunder. These are tunable product rules, not Stockfish judgments or a copy of Chess.com's proprietary classification. Calibrate them against a curated set of reviewed games before release.

Positive annotations need additional evidence:

- **Best** means the move matches the stable primary engine choice. A near-equivalent alternative can still be sound.
- **Great** requires a sound primary choice, a meaningful gap to the second-best choice, a stable deeper confirmation, and an important consequence such as preserving a draw or finding a winning tactic. A starting candidate rule is loss below 0.02 and an alternative gap of at least 0.10, subject to calibration. A position with one legal move receives a forced-move label instead.
- **Sacrifice** describes a validated material sequence. A capture or a temporarily attacked piece alone does not prove a sound sacrifice. Confirm material given up and the continuation before using that caption.
- Keep **Brilliant** out of the first version. A convincing programmatic definition requires a separately tested policy for alternatives, material investment, forced recaptures, difficulty, and compensation.

Handle mate scores separately. Do not convert `mate` to an arbitrary centipawn value. Distinguish delivering checkmate, allowing a newly confirmed forced mate, losing a mating continuation, and merely choosing a longer forced mate. Do not mark a move as a blunder just because an already lost position has a shorter mate distance. Give terminal draw positions their known result rather than requiring an engine to supply a playable move.

If WDL is unavailable, a versioned centipawn-to-score mapping can support a clearly identified fallback. The existing sigmoid is appropriate for drawing the bar; do not present it as an objective personalized win probability. Record which scoring model produced each review. [Existing mapping and its source](evaluation-bar-research.md).

## Programmatic storytelling

Create a plain JSON timeline from the validated review. Render the preview and export from that same timeline. Caption templates receive facts, never guesses about a player's thoughts.

Useful verified events include a material-winning capture, a confirmed fork or pin, a missed mate, a lost winning position, a confirmed only good defense, promotion, and the actual ending. A principal variation demonstrates one predicted continuation. It does not prove that all replies are forced. Only describe a line as forced when the alternatives support that claim.

Examples of templates are `{move} allows a forced mate`, `{side} wins a rook`, `Only drawing move found`, and `{side} wins by {resultReason}`. Each template must have a corresponding fact predicate. Claims about forecast tactics remain Stockfish assessments, and the review identifies the engine used. Use neutral `Stockfish prefers {SAN}` when the evidence supports only an engine preference. No narration is required. Browser `speechSynthesis` is not a dependable source of an exportable audio track; prerecorded phrases would be a separate optional feature.

Choose important events using severity, confidence, tactical interest, and distance from another selected event. Merge adjacent mistakes and punishments into one sequence. Keep their order. Include enough preceding moves to establish the position. When skipping part of a game, fade into the new position with its real move number and a short skip label; never animate a move that would be illegal from the displayed board.

In a full replay, give ordinary moves short durations and important sequences longer holds. If every move would be unreadable inside the selected duration, extend the video or switch to an explicitly labeled highlights recap. Do not squeeze a 200-move game into the same timing as a short game.

Hypothetical engine lines must visibly say **Suggested line** and return to the actual game position. Never insert them into the played history. Derive the final card from the saved game result, including draws, resignations, illegal-move losses, and timeouts. Omit historical clocks unless the source actually records them.

## Procedural background music

Represent music as a deterministic list of notes and percussion events. Seed the variation from the game-content hash and music-style version, with an optional shuffle choice. Use authored chord progressions, bass patterns, arpeggios, simple synthesized instruments, and seeded noise percussion. This requires no samples, external music service, or inference.

Use one musical tempo for the export and schedule scene starts and major move impacts against its beat grid. Change arrangement density at scene boundaries instead of changing tempo unpredictably. Quiet positions use fewer notes; confirmed turning points add percussion or a brief accent; the actual result chooses an ending phrase. Keep these choices subtle enough that a sequence of bad moves does not produce a continuous alarm soundtrack. A later music option can use bundled human-composed loops with explicit video-export rights, selected and cut on their documented beat boundaries by the same program.

Render the complete score with `OfflineAudioContext`, including move clicks, gains, fades, and peak limiting, then encode the resulting PCM into the selected audio format. The same event schedule drives the audible preview. Provide mute and music-volume controls. Reuse or adapt the existing result motif as an authored cue, with an export-specific audio graph. Do not route preview speakers into the export or depend on desktop audio capture.

Use a shared timeline clock for music and video. Derive each video frame's timestamp from its integer frame index, not accumulated timer deltas. Derive audio sample positions from that same rational timebase. Beat positions convert once into timestamps. Trim both tracks to the planned duration and test their alignment at the beginning, middle, and end.

## Video rendering and encoding

Render the board and overlays directly to a canvas. Use the app's same-origin piece SVGs, board colors, and fonts after explicitly preloading them. Support castling, en passant, promotion, captures, board flipping, and FEN jumps. The current board is DOM-based Chessground, so reusing its animation by taking repeated DOM screenshots would make export harder to control. Share chess data, assets, and styling rather than trying to encode the live board DOM. [Board implementation](../../src/ui/ChessBoard.tsx).

Use a pure `renderFrame(timeline, timestamp, canvas)` function for preview seeking and encoding. A worker with `OffscreenCanvas` is an optimization when available; it must not become a prerequisite for export. Prevent external assets from tainting the canvas.

Prefer explicit, frame-by-frame encoding through WebCodecs and Mediabunny for MP4/WebM muxing. The researched Mediabunny core uses MPL-2.0. It is a recommended dependency candidate, not an installed or runtime-verified package. Pin and check the chosen npm release during implementation. WebCodecs produces encoded chunks, not a finished playable container. Its encoder interfaces require a secure context, normally HTTPS or a trustworthy local development origin, but do not themselves require cross-origin isolation.

Probe video and audio encoders for the exact selected resolution, frame rate, codec, and channel settings. Prefer a supported MP4 H.264/AAC combination for sharing, then a supported WebM VP9/Opus or VP8/Opus combination. Capability checks and a short actual encode are required. A browser name or presence of `VideoEncoder` alone is insufficient. Handle encode and finalization failures even after a successful probe. Do not silently export without the requested soundtrack when no supported audio encoder is available.

Feed timestamped frames and audio to the encoder with bounded queues, release `VideoFrame` and `AudioData` resources promptly, and apply backpressure. Mediabunny source timestamps use seconds; raw WebCodecs timestamps use integer microseconds. Convert explicitly at that boundary. Interleave audio and video rather than submitting a whole video track before audio. A stream destination alone does not prevent the muxer from buffering an unmatched track.

Write muxed output progressively to a supported file target or OPFS, with a bounded in-memory fallback for small exports. Honor the muxer's write offsets and use a container layout compatible with the destination. Avoid MP4's in-memory fast-start mode when the goal is bounded memory; verify playback and seeking for the chosen layout. An OPFS file can still require a later download step. Do not keep every raw frame or all encoded chunks in JavaScript arrays. Account separately for the PCM music buffer, engine heap, canvas, encoder, and output file. For long soundtracks, use bounded audio segments with an explicitly continuous event schedule instead of one unrestricted PCM allocation.

If using `showSaveFilePicker`, request the file handle during the export click while user activation is available. Do not wait until a lengthy export finishes and assume the picker can still open. OPFS staging followed by a later Save action avoids that timing dependency.

The fallback is canvas `captureStream()` plus an audio `MediaStreamDestination` recorded by `MediaRecorder`, using a runtime-supported MIME type. This path records in real time and needs user activation for audible audio operations. It is susceptible to rendering throttles, page hiding, device sleep, and audio-context suspension. Treat it as a foreground-only export and fail clearly if an interruption prevents a reliable recording. Do not advertise it as a fast offline encoder. Do not put a large ffmpeg.wasm runtime into the default path solely to obtain MP4.

Platform sources, muxer licensing, API constraints, and unresolved support questions belong in [the platform research note](chess-video-platform-research.md). Browser exports still require practical acceptance tests. This proposal has not verified an encoded video in a browser.

## Suggested implementation boundaries

```text
src/review/          Immutable replay input, analysis jobs, grades, tactical facts
src/recap/           Event selection, caption templates, timed scenes, music score
src/video/           Canvas frames, audio rendering, codec negotiation, file output
src/ui/             Result action, progress, preview controls, export state
```

These are proposed folders, not existing modules. Keep engine transport in `src/engines/` and legality in `src/rules/`. Neither review nor export can submit moves or change results. Follow the existing [module authority and asynchronous fencing rules](../architecture/modules.md).

Public operations can remain small: `reviewGame(replay, options, signal)`, `planRecap(review, preferences)`, and `exportRecap(timeline, target, signal)`. Store versioned review JSON separately from the game checkpoint so reviewing a game does not mutate its canonical record. Export encoding settings must not invalidate completed engine analysis.

Cache keys must include the starting FEN and move sequence, line identity, result, engine version/build, search settings, and grading version. Do not cache only by final FEN or game ID. Include caption, timeline, music, asset, and renderer versions in the recap identity. Reusing a saved timeline makes the composition repeatable. Wall-time searches and hardware encoders do not promise byte-identical outputs across devices.

Cancellation terminates the review worker or encoder, closes frames and audio contexts, aborts file writes, and removes incomplete output. Completed review records survive. Save a compact checkpoint after each analyzed position. Offer resumable analysis, but initially restart interrupted encoding from the saved timeline rather than claiming a partially written movie is resumable.

For long jobs, show progress by analyzed positions and encoded frames and offer cancellation. Request a screen wake lock only where supported. Browsers may throttle, freeze, or discard a page; persistent background export is not a product promise. Check storage and quota where possible, and recover cleanly from denial or exhaustion. Music can use an offline render even when audible playback is muted or blocked.

## Delivery and verification

1. Implement immutable replay extraction, completeness validation, the dedicated review API, and richer UCI parsing. Verify perspective reversal, repetition context, terminal positions, bounded scores, inconsistent MultiPV depths, cancellation, and stale job results.
2. Implement and calibrate grades and factual events with reviewed fixtures. Cover equivalent best moves, only legal moves, forced mates for either side, already lost positions, missed mates, draws, sacrifices, and full/Lite differences. Keep uncertain judgments neutral.
3. Implement the shared timeline, canvas renderer, caption templates, and preview. Check special moves, flipped boards, variable game lengths, scene jumps, hypothetical variations, and text layout at export dimensions.
4. Add deterministic music, a first frame-by-frame export, capability negotiation, and progressive file output. Start with a conservative 720-pixel-wide, 30 fps preset, then offer larger output when the device supports it. Choose the initial muxer only after verifying its runtime and distribution license requirements.
5. Add the foreground recorder fallback, download/share controls, persistence, and recovery. Test actual exported files with sound on target desktop and mobile browsers, including low memory, no cached engine, denied storage, cancellation, reload, and a hidden page. Verify duration, seeking, audio synchronization, successful finalization, and intelligible annotations in a media player. Fullscreen, microphone, and screen-capture permissions are unnecessary.

Keep art attribution with exported media where the chosen piece set requires it. The app contains several differently licensed sets; its website notices are not automatically a complete media-export attribution strategy. Preserve Stockfish and muxer distribution notices separately. Original procedural music removes the need to acquire recording rights for a commercial backing track. [Piece provenance](../../src/ui/pieces/UPSTREAM.md), [dependency notices](../dependency-notices.md).

## Checks performed during this investigation

The public watch payload for `m01562d63cfd7457b2bc8f029ef1308c` was fetched read-only. All 51 SAN half-moves replayed legally with the installed `chess.js` package. The computed final FEN matched the payload, and the final position was checkmate after `26.Qxe8#`. No engine grades were computed for that game. [Public game payload](https://chess-api.agent.soft-magic.com/v1/mcp?watch=m01562d63cfd7457b2bc8f029ef1308c).

Both installed single-threaded WASM builds were run under Node through their documented UCI command interface. Each advertised `MultiPV` and `UCI_ShowWDL`. At the position after `1.f3 e5`, each returned WDL and principal variations for an unrestricted 20,000-node search. Restricting the same root to `g2g4` returned `score mate -1 wdl 0 0 1000` with `pv g2g4 d8h4`. That verifies the packaged engines can expose the proposed review data. [Installed package interface documented upstream](https://github.com/nmrugg/stockfish.js/tree/v19.0.1).

The probe also exposed a useful failure case. Lite's latest primary and secondary lines had different depths, and full Stockfish's latest secondary line carried `upperbound`. A reviewer must use a coherent exact iteration rather than blindly comparing the most recent line for each candidate. These were Node protocol checks, not browser performance or end-to-end video checks. An initial attempt to drive commands reentrantly through the package callback timed out; the successful probes used separate engine subprocesses and asynchronous line input. The browser worker path already uses asynchronous messages.
