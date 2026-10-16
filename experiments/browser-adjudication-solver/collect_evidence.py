"""Collect target dependency metadata, pinned source hashes, module limits and sizes."""
import concurrent.futures, gzip, hashlib, json, pathlib, platform, subprocess, tomllib, urllib.request
import brotli
ROOT=pathlib.Path(__file__).resolve().parent
CACHE=ROOT/'.cache'
sha=lambda data:hashlib.sha256(data).hexdigest()
sources=[
 ('html-worker-spec','https://raw.githubusercontent.com/whatwg/html/790ce89a0b95f3f6caed7fc2d1e3f352364e2791/source'),
 ('csp-spec','https://raw.githubusercontent.com/w3c/webappsec-csp/b1bad631b091cdca904138d6947a16b89edfd2b4/index.bs'),
 ('rust-wasm-target','https://raw.githubusercontent.com/rust-lang/rust/48a229ceaefd4985c50990b14116b6d856af0985/src/doc/rustc/src/platform-support/wasm32-unknown-unknown.md'),
]
def fetch(item):
    name,url=item
    try:
        with urllib.request.urlopen(url,timeout=40) as response: data=response.read()
        (CACHE/(name+'.txt')).write_bytes(data)
        return {'name':name,'url':url,'bytes':len(data),'sha256':sha(data),'status':'downloaded'}
    except Exception as error: return {'name':name,'url':url,'status':'failed','error':str(error)}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor: manifest=list(executor.map(fetch,sources))
solver=CACHE/'chasolver-3484c7e65247003fac8705a9290dc2b5d0978b94'
for path in ['Cargo.toml','LICENSE','README.md','src/lib.rs','src/utils.rs','src/winnability/full.rs','src/search/engine.rs','tests/positions.txt','.github/workflows/ci.yml']:
    data=(solver/path).read_bytes()
    manifest.append({'name':'CHA-Solver '+path,'url':f'https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/{path}','bytes':len(data),'sha256':sha(data),'status':'inspected'})
(ROOT/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
metadata_run=subprocess.run(['cargo','metadata','--locked','--format-version','1','--manifest-path','wasm-probe/Cargo.toml'],cwd=ROOT,capture_output=True,text=True,timeout=45,check=True)
metadata=json.loads(metadata_run.stdout)
(CACHE/'cargo-metadata.json').write_text(metadata_run.stdout,encoding='utf8')
for name in ['cargo-tree.txt','tool-versions.txt','browser-host.json','os.json','cpu.json']:
    path=ROOT/name
    if path.exists() and path.read_bytes().startswith((b'\xff\xfe',b'\xfe\xff')):
        path.write_text(path.read_text(encoding='utf16'),encoding='utf8')
inventory=[]
for package in metadata['packages']:
    directory=pathlib.Path(package['manifest_path']).parent
    files=[]
    for path in sorted(directory.iterdir()):
        if path.is_file() and any(word in path.name.lower() for word in ['license','copying','notice']):
            files.append({'file':path.name,'sha256':sha(path.read_bytes())})
    vcs=directory/'.cargo_vcs_info.json'
    inventory.append({'name':package['name'],'version':package['version'],'license':package['license'],'source':package['source'],'repository':package['repository'],'vcs':json.loads(vcs.read_text()) if vcs.exists() else None,'licenseFiles':files,'dependencies':[{'name':d['name'],'kind':d['kind'],'target':d['target']} for d in package['dependencies']]})
(ROOT/'cargo-license-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
node=[]
for name in ['chess.js','chessops','@badrap/result','esbuild']:
    folder=ROOT/'node_modules'/name
    package=json.loads((folder/'package.json').read_text())
    node.append({'name':name,'version':package['version'],'license':package.get('license'),'purpose':'verification-only bundled worker' if name!='esbuild' else 'build tool','licenseFiles':[{'file':p.name,'sha256':sha(p.read_bytes())} for p in folder.iterdir() if p.is_file() and 'license' in p.name.lower()]})
(ROOT/'npm-license-inventory.json').write_text(json.dumps(node,indent=2)+'\n')
def leb(data,index):
    value=0;shift=0
    while True:
        byte=data[index];index+=1;value|=(byte&127)<<shift
        if byte<128:return value,index
        shift+=7
data=(CACHE/'solver.wasm').read_bytes();index=8;limits=[]
while index<len(data):
    section=data[index];length,index=leb(data,index+1);end=index+length
    if section==5:
        count,offset=leb(data,index)
        for _ in range(count):
            flags,offset=leb(data,offset);minimum,offset=leb(data,offset)
            maximum,offset=leb(data,offset) if flags&1 else (None,offset)
            limits.append({'flags':flags,'minimumPages':minimum,'maximumPages':maximum,'minimumBytes':minimum*65536,'maximumBytes':maximum*65536 if maximum else None,'shared':bool(flags&2)})
    index=end
sizes=[]
for name in ['solver.wasm','worker.mjs']:
    data=(CACHE/name).read_bytes()
    sizes.append({'artifact':name,'bytes':len(data),'gzipBytes':len(gzip.compress(data,mtime=0)),'brotliBytes':len(brotli.compress(data)),'sha256':sha(data)})
inspection=subprocess.run(['node','--input-type=module','-e',"import fs from 'node:fs';const m=new WebAssembly.Module(fs.readFileSync('.cache/solver.wasm'));console.log(JSON.stringify({imports:WebAssembly.Module.imports(m),exports:WebAssembly.Module.exports(m)}))"],cwd=ROOT,capture_output=True,text=True,timeout=20)
inspection.check_returncode()
(ROOT/'artifact-inspection.json').write_text(json.dumps({'memory':limits,'module':json.loads(inspection.stdout),'sizes':sizes,'compressionTools':{'python':platform.python_version(),'gzip':'stdlib default level 9, mtime 0','brotli':brotli.__version__+' default quality 11'},'note':'Memory limit covers WASM linear memory only. File compression is offline size measurement; server sends uncompressed responses.'},indent=2)+'\n')
print(json.dumps({'primarySources':[(x['name'],x['status']) for x in manifest[:3]],'cargoPackages':len(inventory),'npmPackages':len(node),'artifactSizes':sizes,'memory':limits},indent=2))
