# Browser engines and match modes

New game supports human versus human, human versus AI, human versus engine, engine versus engine, engine versus AI, and AI versus AI. Each automated side has its own selection. The engine-versus-AI mode lets the engine play either color. In spectator modes the board accepts no human moves. Stop, Retry and move-history review remain available. Reloaded matches require explicit resume; LLMs still require current-session compatibility checks.

Engines calculate moves in a Web Worker on the player's device. They do not use a terminal, a native executable, a local server, or a provider API. AI means an LLM accessed through a configured provider connection, such as a GPT, Claude, Gemini or Grok model. Existing provider routing and diagnostics apply separately to each LLM.

## Spectator evaluation

AI versus AI, engine versus engine, and engine versus AI show an evaluation bar beside the board. Human versus human, human versus AI, and human versus engine do not start evaluation or show the bar. Scores use White's perspective in pawns, with `M` for mate distance. The white and black areas flip with board orientation. Reviewing move history analyzes the displayed position with its original FEN and preceding moves, preserving repetition context.

Analysis always uses Stockfish 19 Lite, about 2 MB, even when full Stockfish is downloaded for an opponent. This avoids loading a second full evaluation network just for the bar. A failed evaluation shows a retry action on the bar.

The evaluator owns a separate worker with a 16 MB hash and an 800 ms search budget per displayed position. It streams primary, exact UCI scores and cancels stale searches when navigating, changing games, or leaving the board. Opening setup or another full-page tool closes the evaluator until the board is visible again. Clock ticks do not restart analysis. Evaluation cannot submit moves, change controller state, or occupy an opponent's worker. Reduced-motion preferences disable bar animation.

See [Lichess evaluation research](implementation/evaluation-bar-research.md) for upstream sources and the reuse decision.

## Download and play

1. Choose a mode and a browser engine.
2. Click **Download and use engine**. The app downloads the engine from its own origin, caches it when browser storage permits, and runs a short test move.
3. Prepare the other opponent if needed and click **Start game**.

Stockfish 19 Lite downloads about 2 MB and is the default recommendation when memory information is unavailable or the browser reports limited resources. Stockfish 19 uses the full evaluation network and downloads about 100 MB. The app recommends it when the browser reports at least eight logical CPU cores and eight GB of memory. Browser hardware reports are approximate and may be restricted for privacy. Both builds use one background CPU thread, work without cross-origin isolation, and let users choose thinking time and hash memory. The hash setting excludes the runtime and evaluation network's memory. Lower thinking time reduces CPU use and battery consumption. The app reduces search time further as a match clock runs low.

Downloads have progress and cancellation. Failed or partial downloads can be retried. Cache storage is best-effort; private browsing, quota limits, eviction or clearing site data can require another download. Cached engine files can be reused without another network request while the app is open. The complete app is not an offline-installable PWA.

Leela Chess Zero is disabled as **Coming soon** until its browser runtime, network loading and hardware compatibility are integrated. AlphaZero and Torch are omitted at the owner's request. No documented public engine-play API was found in their official product documentation. [Chess.com's public API](https://support.chess.com/en/articles/9650547-what-is-the-pubapi-and-how-do-i-use-it) is read-only, and [Torch's documented access](https://www.chess.com/news/view/torch-engine-available-on-chesscom) is through Chess.com's analysis page. [DeepMind's AlphaZero page](https://deepmind.google/research/alphazero-and-muzero/) describes the research system.

## Implementation and distribution

The exact `stockfish@19.0.1` dependency contains browser builds maintained by [Stockfish.js](https://github.com/nmrugg/stockfish.js). `scripts/prepare-engines.mjs` copies only the two single-threaded JS/WASM pairs to a versioned directory under `public/engines/`. Development and production build commands run this preparation automatically. Generated files are ignored by Git. End users fetch only the build they choose. Keep the dependency version, browser catalog and preparation script in sync when upgrading.

The application fetches same-origin assets and creates versioned-cache-backed Blob URLs for the Worker and its WASM. CSP allows `worker-src 'self' blob:`, `connect-src blob:` and `script-src 'wasm-unsafe-eval'`. It does not enable JavaScript `unsafe-eval`. No cross-origin opener/embedder policy is required, preserving account and provider integrations.

`src/engines/browser.ts` owns downloads, caching and serialized UCI Workers. Setup checks use temporary workers that close after their test move. Opponent workers are reused within a match and released when their engine is no longer selected, the game ends, the game changes, or the app unmounts. Stop closes all opponent workers, including idle ones, and cancels pending starts; Retry creates them again as needed. Downloaded assets stay cached independently of worker lifetimes.

`src/engines/local.ts` adapts engine results to the existing fenced controller and archives UCI requests and results. The v1 archive's automated-player record is reused with reserved provider ID `browser-uci` and custom protocol, keeping actual engine requests out of the LLM connection system. The board's legal-move checks remain authoritative, and fenced replies cannot change a different or stopped position. Search passes the original FEN and complete coordinate move history to preserve repetition context.

Stockfish.js is GPL-3.0. The production notices include its `Copying.txt`; preserve the upstream copyright headers and provide the exact corresponding source and build instructions when distributing the combined application, as required by GPL. The pinned package's repository and upstream source are linked in `THIRD_PARTY_NOTICES.txt` and the dependency inventory. Do not distribute only the WASM files without their license and corresponding source obligations.
