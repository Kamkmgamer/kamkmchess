"""Download pinned public source and build a bounded, single-threaded WASM probe."""
import hashlib, json, os, pathlib, shutil, subprocess, tarfile, time, urllib.request
ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / '.cache'
REV = '3484c7e65247003fac8705a9290dc2b5d0978b94'
CACHE.mkdir(exist_ok=True)
def command(args, name, timeout=240, env=None):
    start = time.monotonic()
    p = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True)
        out, _ = p.communicate()
        (ROOT / name).write_text(out + '\nBUILD TIMEOUT\n', encoding='utf8')
        raise
    (ROOT / name).write_text(out, encoding='utf8')
    if p.returncode: raise RuntimeError(f'{name}: exit {p.returncode}; see log')
    return {'command': args, 'seconds': time.monotonic()-start, 'exit': p.returncode}
if not (CACHE / f'chasolver-{REV}').exists():
    with urllib.request.urlopen(f'https://codeload.github.com/miguel-ambrona/chasolver/tar.gz/{REV}', timeout=40) as response:
        (CACHE / 'chasolver.tar.gz').write_bytes(response.read())
    with tarfile.open(CACHE / 'chasolver.tar.gz') as archive: archive.extractall(CACHE, filter='data')
env = os.environ.copy()
env['CARGO_TARGET_DIR'] = str(CACHE / 'target')
env['RUSTFLAGS'] = '-C link-arg=--max-memory=134217728'
lock = ROOT / 'wasm-probe/Cargo.lock'
if not lock.exists():
    baseline = ROOT.parent / 'chess-dependencies/chasolver-probe/Cargo.lock'
    lock.write_text(baseline.read_text().replace('kha22-chasolver-probe', 'kha24-browser-solver-probe'), encoding='utf8')
result = command(['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', 'wasm-probe/Cargo.toml'], 'build.log', env=env)
wasm = CACHE / 'target/wasm32-unknown-unknown/release/kha24_browser_solver_probe.wasm'
shutil.copy2(wasm, CACHE / 'solver.wasm')
import gzip, brotli
data = wasm.read_bytes()
result.update({'sourceCommit':REV,'sourceArchiveSha256':hashlib.sha256((CACHE/'chasolver.tar.gz').read_bytes()).hexdigest(),'wasmBytes':len(data),'gzipBytes':len(gzip.compress(data,mtime=0)),'brotliBytes':len(brotli.compress(data)),'wasmSha256':hashlib.sha256(data).hexdigest(),'rustflags':env['RUSTFLAGS']})
(ROOT/'build-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
