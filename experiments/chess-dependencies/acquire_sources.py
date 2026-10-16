"""Download pinned public research inputs. Does not run third-party code."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)
PACKAGES = {
    "chess.js": "1.4.0",
    "chessops": "0.15.1",
    "cm-chessboard": "8.15.3",
    "@lichess-org/chessground": "10.4.2",
    "react-chessboard": "5.12.1",
    "gchessboard": "1.4.0",
}

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "KHA-22-public-source-research"})
    with urllib.request.urlopen(req, timeout=45) as res:
        return res.read()

def extract(data, target):
    target.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        archive.extractall(target, filter="data")

manifest = {}
for name, version in PACKAGES.items():
    key = name.replace("/", "_").replace("@", "")
    metadata_url = f"https://registry.npmjs.org/{name}/{version}"
    info = json.loads(get(metadata_url))
    tarball = get(info["dist"]["tarball"])
    sha = hashlib.sha512(tarball).digest()
    import base64
    integrity = "sha512-" + base64.b64encode(sha).decode()
    assert integrity == info["dist"]["integrity"], name
    extract(tarball, CACHE / key)
    manifest[name] = {k: info.get(k) for k in ["version", "gitHead", "license", "repository", "dependencies", "peerDependencies"]}
    manifest[name].update(metadataUrl=metadata_url, dist=info["dist"], sha256=hashlib.sha256(tarball).hexdigest())
    print(name, version, manifest[name]["gitHead"])
    commit = info.get("gitHead")
    repo = info["repository"]["url"].removeprefix("git+").removesuffix(".git")
    if name == "@lichess-org/chessground":
        commit = "ddb6deff5546c76c82b7a61c4581b4122f01551d"
        manifest[name]["sourceCommit"] = commit
    if commit:
        source_url = repo.replace("https://github.com/", "https://codeload.github.com/") + "/tar.gz/" + commit
        source = get(source_url)
        extract(source, CACHE / (key + "-source"))
        manifest[name].update(sourceUrl=source_url, sourceSha256=hashlib.sha256(source).hexdigest())
(ROOT / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
