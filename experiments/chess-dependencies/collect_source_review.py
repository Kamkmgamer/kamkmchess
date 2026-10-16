"""Record inspected primary-source files, hashes, and bounded source excerpts."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
manifest = json.loads((root / "source-manifest.json").read_text())
files = {
    "chess.js": {"src/chess.ts": [(472,603),(817,917),(947,955),(1306,1387),(1635,1703)], "LICENSE": [(1,26)]},
    "chessops": {"src/chess.ts": [(98,123),(178,190),(251,271),(334,419),(510,534),(596,622)], "src/fen.ts": [(30,33),(171,210),(290,306)], "LICENSE.txt": [(1,22)]},
    "cm-chessboard": {"src/extensions/accessibility/Accessibility.js": [(60,72),(327,377)], "src/extensions/promotion-dialog/PromotionDialog.js": [(39,73),(211,250),(325,365)], "assets/pieces/standard.svg": [(1,21)], "assets/pieces/staunty.svg": [(1,11)], "assets/extensions/markers/markers.svg": [(1,8)], "LICENSE": [(1,22)]},
    "@lichess-org/chessground": {"README.md": [(12,20),(33,58)], "src/events.ts": [(14,35)], "LICENSE": [(1,20)]},
    "react-chessboard": {"src/ChessboardProvider.tsx": [(689,699)], "src/Draggable.tsx": [(20,50)], "src/pieces.tsx": [(1,5)], "LICENSE": [(1,22)]},
    "gchessboard": {"README.md": [(1,11),(85,94)], "src/utils/munkres.ts": [(1,28)], "src/components/BoardSquare.ts": [(80,99),(324,342)], "playwright.config.ts": [(1,24)], "LICENSE": [(1,22)]},
}
records = []
for name, items in files.items():
    key = name.replace("/", "_").replace("@", "")
    source_dir = next((root / ".cache" / (key + "-source")).iterdir())
    info = manifest[name]
    repo = info["repository"]["url"].removeprefix("git+").removesuffix(".git")
    commit = info.get("sourceCommit") or info["gitHead"]
    for path, spans in items.items():
        data = (source_dir / path).read_bytes()
        lines = data.decode("utf-8").splitlines()
        records.append(dict(name=name, path=path, url=f"{repo}/blob/{commit}/{path}", sha256=hashlib.sha256(data).hexdigest(), excerpts=[dict(first=a,last=b,text="\n".join(lines[a-1:b])) for a,b in spans]))

extra=json.loads((root / "extra-source-manifest.json").read_text())
for name, paths in {"chasolver":["Cargo.toml","LICENSE","src/lib.rs","src/winnability/full.rs"], "scalachess":["LICENSE","core/src/main/scala/InsufficientMatingMaterial.scala"]}.items():
    source_dir=next((root / ".cache" / name).iterdir())
    for path in paths:
        data=(source_dir/path).read_bytes()
        records.append(dict(name=name,path=path,url=f"https://github.com/{extra[name]['repository']}/blob/{extra[name]['commit']}/{path}",sha256=hashlib.sha256(data).hexdigest(),text=data.decode("utf-8")))

for path,info in extra.items():
    if path in ["chasolver","scalachess"] or "error" in info:continue
    data=(root/".cache"/"lila"/path).read_bytes()
    records.append(dict(name="lila",path=path,**info))

result_license=root / "node_modules" / "@badrap" / "result" / "LICENSE"
records.append(dict(name="@badrap/result",version="0.3.1",path="LICENSE",text=result_license.read_text(encoding="utf-8")))
(root / "source-review.json").write_text(json.dumps(records,indent=2)+"\n",encoding="utf-8")
print(f"Recorded {len(records)} primary-source file entries")
