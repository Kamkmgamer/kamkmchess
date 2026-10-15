import https from 'node:https';
import {writeFile} from 'node:fs/promises';
import {profiles} from './profiles.mjs';
const origin = new URL(process.argv[2]).origin;
if (!origin.startsWith('https://')) throw new Error('A public HTTPS test origin is required');
const output = new URL('./evidence/options.json', import.meta.url);
const results = {kind:'raw HTTP OPTIONS, not browser execution',origin,startedAt:new Date().toISOString(),rows:[]};
for (const profile of profiles) {
  const headerNames=Object.keys(profile.headers).sort();
  const requestHeaders={origin,'access-control-request-method':profile.method,
    ...(headerNames.length ? {'access-control-request-headers':headerNames.join(', ')} : {})};
  const row={id:profile.id,url:profile.url,proposedMethod:profile.method,requestHeaders,startedAt:new Date().toISOString()};
  await new Promise(resolve=>{
    const req=https.request(profile.url,{method:'OPTIONS',headers:requestHeaders,timeout:15000},res=>{
      row.status=res.statusCode;row.responseHeaders={...res.headers};row.rawHeaders=[...res.rawHeaders];
      // Response cookies are unused with this probe; keep them out of publication.
      if(row.responseHeaders['set-cookie'])row.responseHeaders['set-cookie']=['[omitted unused response cookie]'];
      for(let i=0;i<row.rawHeaders.length;i+=2)if(row.rawHeaders[i].toLowerCase()==='set-cookie')row.rawHeaders[i+1]='[omitted unused response cookie]';
      let body='';res.setEncoding('utf8');res.on('data',chunk=>{if(body.length<32768)body+=chunk;});
      res.on('end',()=>{row.body=body;resolve();});res.on('error',e=>{row.error=String(e);resolve();});
    });
    req.on('timeout',()=>req.destroy(new Error('OPTIONS timeout')));
    req.on('error',e=>{row.error=String(e);resolve();});req.end();
  });
  row.finishedAt=new Date().toISOString();results.rows.push(row);
  await writeFile(output,JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify({id:row.id,status:row.status,error:row.error,allowOrigin:row.responseHeaders?.['access-control-allow-origin']}));
}
results.completedAt=new Date().toISOString();await writeFile(output,JSON.stringify(results,null,2)+'\n');
