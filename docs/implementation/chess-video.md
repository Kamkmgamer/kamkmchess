# Game videos

The finished-game result card opens a local recap screen. The same action is available in completed peer online games. It works with local games and complete hosted game replays. Online identity changes close the recap and cancel its work. No LLM, provider request, hosted analysis, screen capture, microphone permission, or external music service participates in review or export.

## Review

`src/review/replay.ts` verifies the saved move sequence through the rules module and copies only chess facts, public player labels, and the actual final result. An explicit hosted-history marker rejects incomplete replays. The live game, its canonical result, provider configuration, and conversation archive are never mutated or sent to the video pipeline.

`BrowserUciEngine.review` retains root-relative WDL, scores, principal variations, bounds, and depth. It waits for `bestmove`, keeps complete exact candidate sets at the same depth, sets unrestricted strength, resets the hash between searches, and preserves the starting FEN with its coordinate-move prefix. It supports a restricted search of the played legal move.

The review automatically prefers this site's cached full Stockfish 19.0.1 assets. If absent or unusable, it uses Lite. A full failure restarts under a separate Lite review identity. Workers belong to the review and close on completion or cancellation. Asset downloads remain in the existing engine cache.

Each move receives a 100,000-node, top-two-candidate search. A played move outside those candidates gets its own restricted search. Errors, large alternative gaps, shallow results, and inconsistent final candidates receive a 300,000-node confirmation. Grades require exact validated lines, at least depth eight, and consistent expected scores. Uncertain results retain neutral captions. This is bounded analysis, not a claim of perfect chess judgment.

Expected score is `(W + D / 2) / 1000` from the mover's perspective. Loss below 0.02 is sound; losses below 0.05 and 0.10 are slight inaccuracies and inaccuracies; losses below 0.20 are mistakes; larger losses are blunders. A stable best move with an alternative gap of at least 0.10 may receive Great. Only legal moves are Forced. Mate distance does not turn an already lost position into a fresh blunder. These are versioned application rules, not Stockfish-supplied labels or human win probabilities. They still need calibration across a broader reviewed-game set.

Completed positions checkpoint to `kamkmchess.recaps.v1` IndexedDB. Keys include the account/guest scope, game and line, full move sequence and starting FEN, result, engine build, budgets, and review version. The store keeps the twelve most recently written review records. Storage denial leaves the job usable in memory. Reopening resumes saved review positions; interrupted video encoding restarts from the timeline.

## Recap and music

`src/recap/timeline.ts` constructs a deterministic timeline. Full replay shows every move. Highlights retain the opening, selected important sequences with context, and the actual finish. Skips fade into the correct source position and show a skip caption. Times align with a 120 BPM beat grid. Captions report move quality, engine preference, or the stored result. No speculative narration or hypothetical game moves are inserted.

`src/video/render.ts` draws the selected board and piece style onto a 720 by 1280 canvas at 30 fps. Preview seeking and export call the same renderer. Castling moves the rook, en passant removes the captured pawn, and promotion replaces the pawn. Captions, evaluation, move badges, arrows, and piece-art credits form part of the exported frames.

`src/recap/music.ts` creates an authored chord, bass, arpeggio, percussive-note, and ending pattern seeded by the game. Preview schedules the notes through Web Audio. Export renders two-second PCM segments through OfflineAudioContext. Absolute note phase and envelopes keep independently rendered segments continuous. Both tracks use the recap timebase. The Music slider can mute the soundtrack explicitly.

## Export and recovery

The recap screen is lazy-loaded. Mediabunny 1.65.0 supplies encoding integration and muxing. The app independently probes concrete video and audio configurations and finalizes a short actual encode before creating the full output. It prefers AVC/AAC in MP4, followed by VP9/Opus or VP8/Opus in WebM. A muted export does not require an audio encoder.

Frames have timestamps derived from their frame index. Audio and video are interleaved in bounded segments, and source-add promises apply encoder/muxer backpressure. OPFS output writes honor muxer byte offsets and avoid MP4's in-memory fast-start mode. The temporary file is removed when the recap closes or the export is replaced or canceled. A bounded-duration memory target is available when OPFS is denied. A successful download has an actual playable container, not a renamed stream of encoded chunks.

When a native encoder combination is unavailable or the initial encode probe fails, canvas capture and MediaRecorder provide a real-time foreground fallback. The initiating click starts a silent output AudioContext for this path; music goes to a MediaStream destination without microphone input. Hiding the page, suspending audio, or a long frame stall fails the recording visibly. A wake lock is requested when supported. Neither path promises survival after page discard or phone lock. Failed exports preserve the review and preview.

Cancel closes the active engine or exporter and removes incomplete output. Download URLs and completed temporary files are released when replaced or closed. File sharing appears only when the browser supports sharing the resulting file type. Provider and seat credentials never enter file names, metadata, captions, or music seeds.

Mediabunny is MPL-2.0 and ships with the generated dependency notices. Piece credits are visible in exported frames and also embedded as file metadata on the frame-by-frame export path. The app keeps TypeScript's existing browser declaration-file checking policy in its Node tooling project too, because the media tests import Mediabunny's WebCodecs declarations alongside TypeScript's newer DOM library. Application and test source still receive strict type checks.

## Verification

Unit fixtures cover replay integrity, custom Black starts and promotion, WDL perspective and thresholds, mate handling, coherent UCI iterations, restricted search commands, worker ownership, Lite fallback, cancellation, cached-review reuse, highlight skips, final results, and repeatable music events.

`tests/e2e/recap.spec.ts` exercises a finished hosted-game fixture with the real browser WASM engine. It checks preview controls, desktop and mobile layout, an actual downloaded media container with video and music, track durations, cancellation, and cached review reopening. The backend payload is an offline fixture; analysis and media encoding run in the actual browser. This is not a cross-browser or phone-performance certification.

On 2026-11-01, the full unit suite passed 1,668 tests across 135 files. Two additional renderer fixtures passed after correcting the post-move mate counter. Strict typechecking, lint, the production build, generated license notices, and the design detector passed. The three recap browser scenarios and four result-control scenarios passed in Chromium. The related engine and compact-interface scenarios also passed after correcting an old test to select Human seats explicitly instead of assuming New Game resets its retained setup.

The native sample exported H.264 video at 720 by 1280 and AAC stereo audio at 48 kHz. Its video track lasted 14.000 seconds and audio track 14.016 seconds. An independent ffmpeg decode found nonzero soundtrack audio. The foreground recording fallback also produced a container with both tracks. Desktop and 390-pixel-wide layouts were inspected. Firefox, Safari, real phone encoding, and background survival remain unverified.

The initial design and primary-source investigation remain in [the proposal](chess-video-design.md) and [platform research](chess-video-platform-research.md).
