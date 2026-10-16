# Exact adjudication evidence

This directory belongs to KHA-25. The report is [exact-adjudication-coverage.md](../../research/exact-adjudication-coverage.md). It extends the committed KHA-22 evidence without modifying or re-running that directory. All data is synthetic or from public upstream test FENs. No provider, production application, account or browser-port work is involved.

## Reproduce

From the repository root on Windows with Python 3.13, pypdf and Rust/Cargo available:

```powershell
python experiments/exact-adjudication-coverage/acquire_sources.py
python experiments/exact-adjudication-coverage/run_evidence.py
python experiments/exact-adjudication-coverage/exact_closure.py
python experiments/exact-adjudication-coverage/run_upstream_units.py
python experiments/exact-adjudication-coverage/audit_sources.py
python experiments/exact-adjudication-coverage/verify_evidence.py
```

The raw timing fields and compiler output change between runs, so the final command checks structure, conclusions, references and the recorded normalized checksums. After an intentional rerun, inspect the new results before regenerating checksums with `python experiments/exact-adjudication-coverage/verify_evidence.py --write-checksums`. Run ordinary verification again afterward. A checksum mismatch after a fresh run is expected until reviewed evidence replaces the recording.

All public sources, Cargo home and build outputs for these scripts live under ignored `.cache/`. The first setup used the standard existing Cargo cache and fetched Rayon test dependencies there before the reproducible scripts were changed to a local Cargo home. No global service, Rust target or toolchain was changed. Do not recursively delete shared Cargo caches to clean this experiment.

Acquisition uses verified TLS with a 45-second Python request limit. Windows curl with Schannel is a verified-certificate fallback with a 45-second total limit. A Popeye archive request timed out in both bounded transports, so the final script fetches only its pinned README and manual. Paper extraction requires pypdf; it creates no authored PDF artifact. Original download byte hashes are in `source-manifest.json`.

## Bounds and what each output means

- Native release build has a 180-second outer bound. `run_evidence.py` starts a separate native executable for each query. Named cases and parse probes each get five seconds; the deterministic community sample gets three seconds per color. Its loop stops starting fixtures after 150 seconds, with at most two final three-second calls after that check. Every completed query records its own bound and outcome. Timeout is an unresolved computation, never a chess verdict.
- The final recording has 23 parse cases, 38 named color queries and 110 queries from 55 deterministically selected entries in upstream `positions.txt`. This is a sample of its 3,414 entries. The 65,536-entry `lichess.txt` integration corpus was inspected but not executed. `native-results.json` records 86 positive paths, 62 negative results, no None and no outer timeout. Both replay implementations accept every recorded positive path.
- `probe/src/main.rs` never invokes stock move generation on the 21-piece custom fixture. Its solve guard at 16 pieces per side is a research safety guard, not a proposed domain restriction. The independent Python origin count and inspected unchecked 18-entry Rust array establish the mismatch without executing undefined behavior.
- `run_upstream_units.py` runs the eight unmodified library unit tests, with a 180-second combined build/test bound. It does not run the full integration corpora. `upstream-Cargo.lock` records the dev dependency graph separately from the probe graph.
- `exact_closure.py` gives the forced cycle at most 10,000 states and three seconds. It closed at four states/four edges and writes every state and legal edge. Its verifier independently regenerates all successors and checks the absence of any checkmate. The queen cutoff control has 200 states/two seconds and reports unresolved at 201 seen states. The halfmove-99 control enumerates every initial legal move and proves all 22 successors end at the product threshold without mate.
- `audit_sources.py` records pinned file hashes, excerpts and primary paper/rules passages. Source-level findings are separate from executed behavior. In particular, the phase-7 empty-witness path was found in source but was not reached by a sampled public API call.

The independent chess implementation is downloaded python-chess 1.11.2 code, loaded explicitly from its verified source bytes. Its whole `is_valid()` predicate is not used as the product input policy because it includes material/reachability restrictions. Its material helper is not an exact oracle. It supplies local legal-move replay and the small certificate graph.

The experiment is native Windows x64 MSVC. It measures no browser memory, WASM portability, cancellation or native mobile behavior. Solver paths remain research evidence and must never be sent as model move advice.

## Files to integrate

Integrate this directory and the assigned report only. `.cache/`, `target/` and `__pycache__/` are ignored. No helper server, watcher or background task needs stopping. No push, tracker mutation or production change is part of this work.
