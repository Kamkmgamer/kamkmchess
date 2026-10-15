import {readFile,writeFile} from 'node:fs/promises';
import {catalogProfiles} from './profiles.mjs';
const publicOrigin=new URL(process.argv[2]).origin;
const client=await readFile(new URL('./client.js',import.meta.url),'utf8');
const output=new URL('./evidence/',import.meta.url);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
class CDP{
  constructor(socket){
    this.socket=socket;this.next=0;this.pending=new Map();this.events=[];
    socket.addEventListener('message',event=>{
      const msg=JSON.parse(String(event.data));
      if(msg.id){const entry=this.pending.get(msg.id);if(!entry)return;this.pending.delete(msg.id);clearTimeout(entry.timer);msg.error?entry.reject(new Error(JSON.stringify(msg.error))):entry.resolve(msg.result);}
      else if(msg.method==='Network.requestWillBeSent'){
        const {request,requestId}=msg.params;this.events.push({method:msg.method,requestId,url:request.url,httpMethod:request.method});
      }else if(msg.method==='Network.responseReceived'){
        const {response,requestId}=msg.params;this.events.push({method:msg.method,requestId,url:response.url,status:response.status,protocol:response.protocol});
      }else if(msg.method==='Network.loadingFailed'||msg.method==='Log.entryAdded')this.events.push(msg);
    });
    socket.addEventListener('close',()=>{for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Browser closed'));}this.pending.clear();});
  }
  static async connect(port){
    const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket=new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    const cdp=new CDP(socket);cdp.version=version;return cdp;
  }
  send(method,params={},sessionId){
    const id=++this.next;return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout ${method}`));},30000);
      this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
  }
  async eval(expression,sessionId){
    const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;
  }
}
for(const [browser,port] of [['chrome',19232],['edge',19233]]){
  const record={browser,publicOrigin,startedAt:new Date().toISOString(),pages:[],catalogs:[],fixtures:[]};let cdp,context;
  const save=async()=>writeFile(new URL(`${browser}.json`,output),JSON.stringify({...record,diagnostics:cdp?.events},null,2)+'\n');
  try{
    cdp=await CDP.connect(port);record.version=cdp.version;
    context=(await cdp.send('Target.createBrowserContext',{disposeOnDetach:true})).browserContextId;
    const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank',browserContextId:context});
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
    for(const domain of ['Page','Runtime','Network','Log'])await cdp.send(`${domain}.enable`,{},sessionId);
    async function navigate(url,expected){
      const navigation=await cdp.send('Page.navigate',{url},sessionId);if(navigation.errorText)throw new Error(navigation.errorText);
      const deadline=Date.now()+20000;let page;
      while(Date.now()<deadline){
        page=await cdp.eval('({url:location.href,origin:location.origin,title:document.title,text:document.body?.innerText||"",ready:document.readyState,ua:navigator.userAgent})',sessionId);
        if(page.origin===new URL(url).origin&&page.ready!=='loading'&&page.text.includes(expected))break;
        if(page.text&&/visit site/i.test(page.text))await cdp.eval('(() => {const el=[...document.querySelectorAll("button,a")].find(e=>/visit site/i.test(e.textContent));if(el)el.click();})()',sessionId);
        await pause(200);
      }
      record.pages.push(page);if(!page?.text.includes(expected))throw new Error(`Unexpected page ${JSON.stringify(page)}`);
      await cdp.eval(client,sessionId);
    }
    await navigate(`${publicOrigin}/harness`,'KHA21 synthetic transport');
    for(const profile of catalogProfiles){
      const result=await cdp.eval(`window.kha21.catalog(${JSON.stringify(profile)})`,sessionId);record.catalogs.push(result);await save();
      console.log(JSON.stringify({browser,catalog:result.id,status:result.status,readable:result.readable,error:result.error}));
    }
    const kinds=['normal','error','first-error','http-error','eof','disconnect','abort','stale','incomplete','malformed'];
    async function runFixture(protocol,kind,phase,cors){
      const id=`${browser}-${phase}-${protocol}-${kind}${cors?`-${cors}`:''}`;
      const result=await cdp.eval(`window.kha21.fixture(${JSON.stringify(publicOrigin)},${JSON.stringify(protocol)},${JSON.stringify(kind)},${JSON.stringify(id)},${JSON.stringify(cors||null)})`,sessionId);
      record.fixtures.push({...result,phase});await save();
      console.log(JSON.stringify({id,outcome:result.outcome,text:result.fullText,reads:result.reads.length,elapsedMs:Math.round(result.elapsedMs)}));
    }
    for(const protocol of ['chat','responses','messages'])for(const kind of kinds)await runFixture(protocol,kind,'controlled-origin');
    await runFixture('responses','alias','controlled-origin');
    await navigate('https://example.com/','Example Domain');
    for(const protocol of ['chat','responses','messages'])for(const kind of ['normal','abort'])await runFixture(protocol,kind,'cross-origin');
    await runFixture('chat','normal','cross-origin','missing-auth');
    await runFixture('chat','normal','cross-origin','wrong-origin');
    record.completedAt=new Date().toISOString();
  }catch(error){record.error=String(error);process.exitCode=1;console.log(JSON.stringify({browser,error:record.error}));}
  finally{
    if(cdp){if(context)try{await cdp.send('Target.disposeBrowserContext',{browserContextId:context});}catch{}
      try{await cdp.send('Browser.close');}catch{}cdp.socket.close();}
    await save();
  }
}
