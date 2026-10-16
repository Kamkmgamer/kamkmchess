"""Bounded native candidate probe. This does not establish browser/WASM support."""
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
env = os.environ.copy()
env["CARGO_TARGET_DIR"] = str(root / ".cache" / "cargo-target")
try:
    run = subprocess.run(["cargo", "run", "--locked", "--release", "--manifest-path", str(root / "chasolver-probe" / "Cargo.toml")], env=env, capture_output=True, text=True, timeout=180)
    (root / "chasolver-build.log").write_text(run.stderr, encoding="utf-8")
    (root / "chasolver-results.jsonl").write_text(run.stdout, encoding="utf-8")
    print(run.stderr[-3000:])
    print(run.stdout)
    raise SystemExit(run.returncode)
except subprocess.TimeoutExpired as exc:
    (root / "chasolver-build.log").write_bytes((exc.stderr or b"") + b"\nResearch probe exceeded 180-second bound.\n")
    raise
