"""Run only the unmodified upstream library unit suite with an outer build/test bound."""
import os
import shutil
import subprocess
from run_evidence import ROOT, CACHE, CHA

env=os.environ.copy()
env['CARGO_HOME']=str(CACHE/'cargo-home')
env['CARGO_TARGET_DIR']=str(CACHE/'target')
shutil.copyfile(ROOT/'upstream-Cargo.lock', CHA/'Cargo.lock')
try:
    result=subprocess.run(['cargo','test','--release','--lib','--locked','--manifest-path',str(CHA/'Cargo.toml')],env=env,capture_output=True,text=True,timeout=180)
    (ROOT/'upstream-unit-tests.log').write_text(result.stdout+result.stderr,encoding='utf-8')
    print(result.stdout+result.stderr)
    raise SystemExit(result.returncode)
except subprocess.TimeoutExpired as exc:
    (ROOT/'upstream-unit-tests.log').write_bytes((exc.stdout or b'')+(exc.stderr or b'')+b'\nOuter 180-second test/build bound exceeded. No conclusion.\n')
    raise
