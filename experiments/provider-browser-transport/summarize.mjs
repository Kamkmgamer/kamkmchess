import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {profiles,catalogProfiles} from './profiles.mjs';
const directory=new URL('./evidence/',import.meta.url);
const json=async path=>JSON.parse((await readFile(new URL(path,directory),'utf8')).replace(/^\uFEFF/,''));
const options=await json('options.json');const browsers=await Promise.all(['chrome.json','edge.json'].map(json));
const fragments=await Promise.all(['fragments-chrome.json','fragments-edge.json'].map(json));
const traces=(await readFile(new URL('server-requests.ndjson',directory),'utf8')).trim().split('\n').map(JSON.parse);
const text='fixture café ♞',prefix='fixture ';
const summary={checkedAt:new Date().toISOString(),origin:options.origin,options:[],browsers:[],fragmentation:[],assertions:[]};
assert.equal(options.rows.length,profiles.length);assert(options.completedAt);
for(const profile of profiles){
  const row=options.rows.find(r=>r.id===profile.id);assert(row,profile.id);assert(!row.error,JSON.stringify(row));
  assert.equal(row.requestHeaders.origin,options.origin);assert.equal(row.proposedMethod,profile.method);
  assert.deepEqual((row.requestHeaders['access-control-request-headers']||'').split(', ').filter(Boolean),Object.keys(profile.headers).sort());
  const allowed=(row.responseHeaders['access-control-allow-headers']||'').toLowerCase().split(',').map(s=>s.trim());
  const requested=Object.keys(profile.headers);
  summary.options.push({id:row.id,status:row.status,allowOrigin:row.responseHeaders['access-control-allow-origin'],
    allowMethods:row.responseHeaders['access-control-allow-methods'],allowHeaders:row.responseHeaders['access-control-allow-headers'],
    unlistedHeaderNames:requested.filter(h=>!allowed.includes(h)),wildcardHeaderList:allowed.includes('*')});
}
for(const browser of browsers){
  assert(!browser.error,browser.error);assert(browser.completedAt);assert.equal(browser.publicOrigin,options.origin);
  assert.equal(browser.catalogs.length,catalogProfiles.length);assert.equal(browser.fixtures.length,39);
  const counts={},timing=[];
  for(const catalog of browser.catalogs){
    const profile=catalogProfiles.find(p=>p.id===catalog.id);assert(profile);assert.equal(catalog.url,profile.url);
    assert.deepEqual(catalog.requestHeaders,profile.headers);
    if(catalog.id==='openrouter-models-attribution-cache'){
      assert.equal(catalog.readable,false);assert.equal(catalog.status,undefined);
      assert(browser.diagnostics.some(e=>e.method==='Network.loadingFailed'&&e.params.corsErrorStatus?.failedParameter==='x-openrouter-cache'));
    }else{assert(catalog.readable);assert([200,400,401].includes(catalog.status));}
  }
  const finalTrace=traces.filter(t=>Date.parse(t.at)>=Date.parse(browser.startedAt));
  for(const row of browser.fixtures){
    counts[row.outcome]=(counts[row.outcome]||0)+1;
    const trace=finalTrace.filter(t=>t.id===row.id),requests=trace.filter(t=>t.type==='request');
    const posts=requests.filter(t=>t.method==='POST');
    assert(row.elapsedMs<12000,row.id);
    if(row.cors){
      assert.equal(row.outcome,'fetch-error',row.id);assert.equal(row.httpStatus,undefined);assert.equal(posts.length,0,row.id);
      assert.equal(requests.filter(t=>t.method==='OPTIONS').length,1,row.id);continue;
    }
    assert.equal(posts.length,1,row.id);assert.equal(row.httpStatus,row.kind==='http-error'?429:200);
    if(row.kind==='normal'||row.kind==='stale'){
      assert.equal(row.outcome,'complete',row.id);assert.equal(row.fullText,text,row.id);
      const deltas=row.deltas.filter(d=>d.text);assert.equal(deltas.length,2,row.id);
      const terminal=row.events.at(-1);assert(terminal.atMs-deltas[0].atMs>100,`No demonstrated incremental arrival ${row.id}`);
      assert(deltas[1].atMs-deltas[0].atMs>100,`Deltas coalesced ${row.id}`);
      timing.push({id:row.id,firstTextMs:Math.round(deltas[0].atMs),secondTextMs:Math.round(deltas[1].atMs),terminalMs:Math.round(terminal.atMs),reads:row.reads.length});
      assert.equal(row.appliedText,row.kind==='stale'?prefix:text,row.id);
      if(row.kind==='stale'){assert.equal(row.version,2);assert(row.dropped.some(d=>d.kind==='text'));assert(row.dropped.some(d=>d.kind==='event'));}
    }else if(row.kind==='abort'){
      assert.equal(row.outcome,'aborted',row.id);assert.equal(row.appliedText,prefix,row.id);
      assert(trace.some(t=>t.type==='close'&&!t.ended),row.id);
      assert(!trace.some(t=>t.type==='end'),row.id);
    }else if(row.kind==='error'||row.kind==='first-error'){
      assert.equal(row.outcome,'stream-error',row.id);assert.equal(row.fullText,row.kind==='error'?prefix:'',row.id);
    }else if(row.kind==='http-error'){assert.equal(row.outcome,'http-error',row.id);assert(JSON.parse(row.body).error);}
    else if(row.kind==='eof'){assert.equal(row.outcome,'truncated',row.id);assert.equal(row.fullText,prefix,row.id);}
    else if(row.kind==='disconnect'){assert(['read-error','truncated'].includes(row.outcome),row.id);assert(trace.some(t=>t.type==='disconnect'),row.id);}
    else if(row.kind==='incomplete'){assert.equal(row.outcome,'incomplete',row.id);assert.equal(row.fullText,prefix,row.id);}
    else if(row.kind==='malformed'){assert.equal(row.outcome,'protocol-error',row.id);assert.equal(row.fullText,prefix,row.id);}
    else if(row.kind==='alias'){assert.equal(row.outcome,'truncated',row.id);assert.equal(row.fullText,'',row.id);assert.deepEqual(row.unknown,['response.content_part.delta','response.done']);}
  }
  const providerRequests=browser.diagnostics.filter(e=>e.method==='Network.requestWillBeSent'&&['api.openai.com','openrouter.ai','api.anthropic.com'].includes(new URL(e.url).hostname));
  assert(providerRequests.every(e=>['GET','OPTIONS'].includes(e.httpMethod)),'A provider generation request was attempted');
  assert(providerRequests.every(e=>new URL(e.url).pathname.endsWith('/models')),'A browser provider request targeted a generation route');
  summary.browsers.push({browser:browser.browser,version:browser.version.Browser,catalogs:browser.catalogs.map(c=>({id:c.id,status:c.status??null,readable:c.readable})),fixtures:browser.fixtures.length,outcomes:counts,incrementalTiming:timing,providerGenerationRequests:0});
}
for(const run of fragments){
  assert(!run.error,run.error);assert(run.completedAt);assert.equal(run.fixtures.length,3);
  assert(run.queriedPermissions.some(p=>p.state==='granted'));
  for(const row of run.fixtures){
    assert.equal(row.outcome,'complete',row.id);assert.equal(row.fullText,text);assert.equal(row.appliedText,text);
    const chunks=row.reads.map(r=>Buffer.from(r.base64,'base64'));
    assert(chunks.length>=8,row.id);
    assert(chunks.some((bytes,index)=>bytes.at(-1)===0xc3&&chunks[index+1]?.[0]===0xa9),`No split UTF-8 codepoint observed ${row.id}`);
    assert(chunks[0].length<20,`No partial SSE line observed ${row.id}`);
    assert.equal(traces.filter(t=>t.type==='request'&&t.method==='POST'&&t.id===row.id).length,1);
    summary.fragmentation.push({id:row.id,sourceOrigin:row.sourceOrigin,targetOrigin:run.base,reads:row.reads.length,splitUtf8Observed:true,outcome:row.outcome});
  }
}
const crlf=await json('transport-diagnostic.json'),lf=await json('transport-diagnostic-lf.json');
assert.equal((crlf[0].body.match(/event: /g)||[]).length,8);assert((crlf[1].body.match(/event: /g)||[]).length<8);
assert.equal((lf[0].body.match(/event: /g)||[]).length,8);assert.equal((lf[1].body.match(/event: /g)||[]).length,8);
const environment=await json('environment.json'),cleanup=await json('cleanup.json');
assert.equal(cleanup.listeners.length,0);assert.equal(cleanup.remainingOwnedBrowserProcesses.length,0);
const oldManifestUrl=new URL('../browser-proxy-transport/evidence/file-manifest.json',new URL('./',import.meta.url));
const oldManifestBytes=await readFile(oldManifestUrl);
assert.equal(createHash('sha256').update(oldManifestBytes).digest('hex'),environment.priorEvidenceManifest.toLowerCase());
const oldManifest=JSON.parse(oldManifestBytes);
for(const [path,entry] of Object.entries(oldManifest)){
  const bytes=await readFile(new URL('../../'+path,import.meta.url));
  assert.equal(bytes.length,entry.bytes,path);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,path);
}
summary.priorEvidenceFilesVerified=Object.keys(oldManifest).length;
summary.assertions=['Exact raw OPTIONS matrix matched source profiles.','Catalog results matched HTTP/CORS diagnostics.','All 78 final tunnel fixture outcomes matched their intended semantics.','Normal streams delivered two intact UTF-8 deltas before terminal completion.','Six loopback cases observed split UTF-8 codepoints and partial SSE lines.','Abort closed each controlled connection before normal completion.','Late events after invalidation were fenced in the disposable client.','Both CORS controls prevented the synthetic POST.','No browser provider generation request was attempted.','CRLF tunnel framing failure and LF correction retained independently.','Existing KHA-15 manifest and every covered file are unchanged.','Owned servers, browsers, and tunnel have no remaining listeners or processes.'];
await writeFile(new URL('summary.json',directory),JSON.stringify(summary,null,2)+'\n');
const manifests=[];
async function walk(base,prefix=''){
  for(const entry of await readdir(base,{withFileTypes:true})){
    const name=prefix+entry.name,url=new URL(entry.name+(entry.isDirectory()?'/':''),base);
    if(entry.isDirectory())await walk(url,name+'/');
    else if(name!=='evidence/file-manifest.json'){const bytes=await readFile(url);manifests.push({file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  }
}
await walk(new URL('./',import.meta.url));
await writeFile(new URL('file-manifest.json',directory),JSON.stringify(manifests.sort((a,b)=>a.file.localeCompare(b.file)),null,2)+'\n');
console.log(JSON.stringify({options:summary.options.length,browsers:summary.browsers.map(b=>({browser:b.browser,catalogs:b.catalogs.length,fixtures:b.fixtures,outcomes:b.outcomes})),fragmentation:summary.fragmentation.length,priorEvidenceFilesVerified:summary.priorEvidenceFilesVerified,assertions:summary.assertions.length},null,2));
