import {readFile,writeFile} from 'node:fs/promises';
const client=await readFile(new URL('./client.js',import.meta.url),'utf8');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const [browser,port] of [['chrome',19232],['edge',19233]]){
  const row={browser,sourceOrigin:'https://example.com',base:'http://127.0.0.1:18775',startedAt:new Date().toISOString(),fixtures:[],permissions:[],diagnostics:[]};
  let ws,context;const pending=new Map();let next=0;
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},20000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  try{
    let version;for(let i=0;i<75;i++){try{version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();break;}catch{await pause(200);}}
    if(!version)throw new Error('Owned browser not ready');row.version=version;
    ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}else if(m.method==='Network.loadingFailed')row.diagnostics.push(m);});
    context=(await send('Target.createBrowserContext',{disposeOnDetach:true})).browserContextId;
    const {targetId}=await send('Target.createTarget',{url:'about:blank',browserContextId:context});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    for(const domain of ['Page','Runtime','Network'])await send(`${domain}.enable`,{},sessionId);
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    for(const name of ['local-network-access','local-network','loopback-network']){
      try{await send('Browser.setPermission',{permission:{name},setting:'granted',origin:row.sourceOrigin,browserContextId:context});row.permissions.push({name,applied:true});}
      catch(error){row.permissions.push({name,applied:false,error:String(error)});}
    }
    await send('Page.navigate',{url:row.sourceOrigin+'/'},sessionId);
    let state;for(let i=0;i<75;i++){state=await evaluate('({url:location.href,title:document.title,ready:document.readyState})');if(state.title==='Example Domain'&&state.ready==='complete')break;await pause(200);}
    if(state?.title!=='Example Domain')throw new Error('Source navigation did not settle');row.page=state;
    row.queriedPermissions=await evaluate('(async()=>{const out=[];for(const name of ["local-network-access","local-network","loopback-network"]){try{out.push({name,state:(await navigator.permissions.query({name})).state});}catch(e){out.push({name,error:String(e)});}}return out;})()');
    await evaluate(client);
    for(const protocol of ['chat','responses','messages']){
      const result=await evaluate(`window.kha21.fixture(${JSON.stringify(row.base)},${JSON.stringify(protocol)},"normal",${JSON.stringify(browser+'-fragmented-'+protocol)},null)`);
      row.fixtures.push(result);console.log(JSON.stringify({id:result.id,outcome:result.outcome,reads:result.reads.length}));
    }
    row.completedAt=new Date().toISOString();
  }catch(error){row.error=String(error);process.exitCode=1;}
  finally{
    if(ws){if(context)try{await send('Target.disposeBrowserContext',{browserContextId:context});}catch{}
      try{await send('Browser.close');}catch{}ws.close();}
    await writeFile(new URL(`./evidence/fragments-${browser}.json`,import.meta.url),JSON.stringify(row,null,2)+'\n');
  }
}
