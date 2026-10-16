"""Download only public pinned research sources into an ignored local cache."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request
import subprocess

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / '.cache'
CACHE.mkdir(exist_ok=True)
SOURCES = {
    'chasolver': 'https://codeload.github.com/miguel-ambrona/chasolver/tar.gz/3484c7e65247003fac8705a9290dc2b5d0978b94',
    'chess': 'https://static.crates.io/crates/chess/chess-3.2.0.crate',
    'paper': 'https://drops.dagstuhl.de/storage/00lipics/lipics-vol226-fun2022/LIPIcs.FUN.2022.2/LIPIcs.FUN.2022.2.pdf',
    'fide': 'https://handbook.fide.com/chapter/E012023',
    'python-chess': 'https://raw.githubusercontent.com/niklasf/python-chess/v1.11.2/chess/__init__.py',
    'syzygy': 'https://raw.githubusercontent.com/niklasf/python-chess/v1.11.2/chess/syzygy.py',
    'paper-full': 'https://chasolver.org/FUN22-full.pdf',
    'd3-2022': 'https://codeload.github.com/miguel-ambrona/chasolver/tar.gz/e53a24147cda65bec1f93e5c7cd1f5b10d67a4ef',
    'popeye-readme': 'https://raw.githubusercontent.com/thomas-maeder/popeye/006e480686bf167c2b79780984609aad746ce7a5/README.md',
    'popeye-manual': 'https://raw.githubusercontent.com/thomas-maeder/popeye/006e480686bf167c2b79780984609aad746ce7a5/py-engl.txt',
}

def main():
    manifest = {}
    for name, url in SOURCES.items():
        req = urllib.request.Request(url, headers={'User-Agent': 'KHA-25-public-source-audit'})
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                data = response.read()
            transport = 'Python TLS verification'
        except urllib.error.URLError:
            # Windows curl uses the OS certificate store. Do not disable TLS verification.
            download = CACHE / (name + '.download')
            subprocess.run(['curl.exe', '--fail', '--location', '--max-time', '45', '--output', str(download), url], check=True, capture_output=True, timeout=50)
            data = download.read_bytes()
            transport = 'Windows curl Schannel TLS verification'
        if name in ('chasolver', 'chess', 'd3-2022'):
            destination = CACHE / name
            destination.mkdir(exist_ok=True)
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
                archive.extractall(destination, filter='data')
        else:
            (CACHE / (name + ('.pdf' if name.startswith('paper') else '.txt'))).write_bytes(data)
        manifest[name] = {'url': url, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'transport': transport}
        print(name, len(data))
    (ROOT / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

if __name__ == '__main__':
    main()
