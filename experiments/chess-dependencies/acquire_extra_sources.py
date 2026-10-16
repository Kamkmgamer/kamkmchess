"""Fetch pinned alternative-adjudicator and accessibility sources for inspection."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "KHA-22-public-source-research"}), timeout=45) as res:
        return res.read()

sources = {
    "chasolver": ("miguel-ambrona/chasolver", "3484c7e65247003fac8705a9290dc2b5d0978b94"),
    "scalachess": ("lichess-org/scalachess", "e3f7eb8f73a268f668d70e594e8f2426d8614881"),
}
manifest = {}
for name, (repo, commit) in sources.items():
    url = f"https://codeload.github.com/{repo}/tar.gz/{commit}"
    data = get(url)
    target = CACHE / name
    target.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        archive.extractall(target, filter="data")
    manifest[name] = dict(repository=repo, commit=commit, url=url, sha256=hashlib.sha256(data).hexdigest())

repo, commit = "lichess-org/lila", "e4de08fdf77453ff7ab2d039113b931730826af5"
for path in ["ui/round/src/round.nvui.ts", "ui/round/src/view/nvuiView.ts", "ui/lib/src/nvui/chess.ts", "ui/lib/src/nvui/command.ts", "COPYING.md"]:
    url = f"https://raw.githubusercontent.com/{repo}/{commit}/{path}"
    try:
        data = get(url)
    except Exception as exc:
        manifest[path] = dict(url=url, error=str(exc))
        continue
    target = CACHE / "lila" / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    manifest[path] = dict(url=url, sha256=hashlib.sha256(data).hexdigest())
(ROOT / "extra-source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest, indent=2))
