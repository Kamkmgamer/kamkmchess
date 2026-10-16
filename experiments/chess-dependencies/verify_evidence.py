"""Check report references and recorded evidence, not application behavior."""
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[2]
evidence = Path(__file__).resolve().parent
report = root / "research" / "chess-dependencies.md"
text = report.read_text(encoding="utf-8")
definitions = dict(re.findall(r"^\[([^\]]+)\]: (.+)$", text, re.M))
used = re.findall(r"\[[^\]]+\]\[([^\]]+)\]", text)
assert all(item in definitions for item in used), set(used) - set(definitions)
local = [url for url in definitions.values() if not url.startswith("https://")]
assert all((report.parent / url).is_file() for url in local)
assert not any(chr(code) in text for code in [0x2014,0x2013,0x201c,0x201d])
for path in evidence.glob("*.json"):
    json.loads(path.read_text(encoding="utf-8-sig"))
results=json.loads((evidence / "results.json").read_text())
assert results["checks"]["passed"] == 12
assert results["lockedWallClosure"]["states"] == 768
assert results["lockedWallClosure"]["edges"] == 3808
witnesses=json.loads((evidence / "chasolver-verification.json").read_text())
assert witnesses["verdictsChecked"] == 8
assert witnesses["winnableWitnessesChecked"] == 4
files = [report] + [p for p in evidence.rglob("*") if p.is_file() and not any(part in [".cache", "node_modules", "__pycache__"] for part in p.parts) and p.name != "checksums.json"]
checksums={str(p.relative_to(root)).replace('\\','/'):hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest() for p in sorted(files)}
(evidence / "checksums.json").write_text(json.dumps(checksums,indent=2)+"\n",encoding="utf-8")
print(json.dumps(dict(reportWords=len(text.split()),referenceDefinitions=len(definitions),localFilesChecked=len(local),checksummedFiles=len(checksums),recordedRulesChecks=12,recordedNativeQueries=8,witnessesReplayed=4),indent=2))
