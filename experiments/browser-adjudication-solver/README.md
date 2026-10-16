# Browser adjudication solver research

Disposable evidence for KHA-24. Read [the report](../../research/browser-adjudication-solver.md) before using the results. This is not application code.

The exact CHA-Solver source is commit `3484c7e65247003fac8705a9290dc2b5d0978b94`. `build.py` downloads it without changes, then builds the small research ABI in `wasm-probe/`. Cargo uses the checked-in lock. Browser verification uses the checked-in npm lock. Downloads, generated binaries, bundled verification code and installed npm packages stay ignored.

Reproduce in this directory with Rust/Cargo 1.98.1, Node 24.22.0, npm 11.19.1, Python 3.13.5 and Python Brotli 1.2.0 available. Install the `wasm32-unknown-unknown` Rust target if absent. Compression uses Python gzip level 9 and Brotli default quality 11. Those are measurements, not HTTP compression tests.

```powershell
rustup target add wasm32-unknown-unknown
npm ci --ignore-scripts --no-audit --no-fund
python build.py
npm run bundle
python make_fixtures.py
python serve.py
```

Open `http://localhost:8769/` in the browser being tested. The page's button runs the main suite and saves `browser-results.json` to this loopback research server. `window.runStress()` runs the 64-query stress sample and saves `browser-stress-results.json`. Run them sequentially. `await window.runExtended()` returns sanitized evidence for the two five-second follow-ups; save that JSON as `browser-extended-results.json`. Results never include mating moves. The Worker replays witnesses internally with the Rust move generator, chess.js and chessops, then releases only verification flags, lengths and event counts.

`python collect_evidence.py` records pinned primary-source hashes, the Cargo target graph, package license metadata and artifact information. `python verify.py` checks the saved final-run evidence. `node verify_inputs.mjs` records both JavaScript libraries' acceptance of analysis inputs, including the hard fixture. Timings will change on another device. `browser-results-initial.json` preserves the first exploratory run with fewer controls and is excluded from final-run totals. `build-attempt-1.log` preserves an initial ABI compiler error, fixed before the successful build.

Each Worker has a ten-second startup budget. Main query budgets are two seconds, or three seconds for the six upstream samples. Stress queries have one second and an aggregate 55-second start bound. Extended queries each have five seconds. Synchronous Rust work runs in the Worker. A termination, Worker error, memory error, missing result or injected `None` returns unknown. The page also rejects results observed after the budget and discards revision mismatches. Timer scheduling is not a real-time guarantee.

The WASM link flag caps linear memory at 128 MiB. It does not cap Worker JavaScript/JIT memory or certify mobile safety. A forced `memory.grow` error is a synthetic transport control. A synthetic busy loop tests cancellation independently of solver speed. Neither control is a naturally exhausted upstream search.

The server binds only `127.0.0.1:8769`, serves static local assets and accepts synthetic evidence JSON. It has no chess endpoint or production role. Stop it with Ctrl+C after research, terminate any active probe Workers, and close the owned preview tab. No account or provider is involved.
