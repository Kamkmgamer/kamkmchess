"""Record direct UI dependency licenses and runtime metadata from public npm."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

root=Path(__file__).resolve().parent
packages={"@dnd-kit/core":"6.3.1", "@dnd-kit/modifiers":"9.0.0", "vite-plugin-bundlesize":"0.2.0"}
records={}
for name,version in packages.items():
    url=f"https://registry.npmjs.org/{name}/{version}"
    with urllib.request.urlopen(url,timeout=30) as response:
        metadata=json.load(response)
    with urllib.request.urlopen(metadata["dist"]["tarball"],timeout=30) as response:
        data=response.read()
    record={k:metadata.get(k) for k in ["version","gitHead","license","dependencies","peerDependencies","repository"]}
    record.update(metadataUrl=url,dist=metadata["dist"],sha256=hashlib.sha256(data).hexdigest())
    with tarfile.open(fileobj=io.BytesIO(data),mode="r:gz") as archive:
        notices={member.name:archive.extractfile(member).read().decode("utf-8") for member in archive.getmembers() if member.isfile() and member.name.lower().split('/')[-1] in ['license','license.txt','license.md']}
    record['licenseTexts']=notices
    records[name]=record
(root/'ui-dependency-metadata.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
print(json.dumps({n:{k:v[k] for k in ['version','license','dependencies']} for n,v in records.items()},indent=2))
