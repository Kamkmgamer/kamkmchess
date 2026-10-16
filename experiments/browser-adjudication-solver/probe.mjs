const keys=['game','segment','positionRevision','requestGeneration','ownershipEpoch'];
const sameToken=(a,b)=>keys.every(k=>a[k]===b[k]);
let next=0, current, active=new Set();
let beats=0, frames=0, lastBeat=performance.now(), maxBeatGapMs=0;
setInterval(()=>{const now=performance.now();maxBeatGapMs=Math.max(maxBeatGapMs,now-lastBeat);lastBeat=now;beats++;document.querySelector('#heartbeat').textContent=`Timer ticks ${beats}. Frame callbacks ${frames}.`;},10);
function frame(){frames++;requestAnimationFrame(frame);}requestAnimationFrame(frame);
function token(){return {game:'synthetic-game',segment:1,positionRevision:1,requestGeneration:++next,ownershipEpoch:1};}
export function stopAll(){for(const w of active)w.terminate();active.clear();}
async function query(fixture,{budgetMs=2000,mode='analyze',invalidate,cancelMs,deliveryDelayMs=0}={}){
  const tag=token();current={...tag};
  const start=performance.now(),startBeats=beats,startFrames=frames;
  const w=new Worker('./.cache/worker.mjs',{type:'module'});active.add(w);
  return await new Promise(resolve=>{
    let done=false,readyAt,solveStart,deadline,cancelTimer,invalidateTimer,budgetDeadline;
    const startup=setTimeout(()=>finish({kind:'unknown',reason:'startup-budget'}),10000);
    function finish(result){
      if(done)return;done=true;clearTimeout(startup);clearTimeout(deadline);clearTimeout(cancelTimer);clearTimeout(invalidateTimer);
      w.terminate();active.delete(w);
      const accepted=sameToken(tag,current);
      const row={id:fixture.id,fen:fixture.fen,color:fixture.color,mode,budgetMs,kind:accepted?result.kind:'discarded-stale',result,...(invalidate?{invalidatedField:invalidate}:{}),token:tag,currentToken:{...current},accepted,elapsedMs:performance.now()-start,startupMs:readyAt===undefined?null:readyAt-start,observedSolveMs:solveStart===undefined?null:performance.now()-solveStart,timerTicks:beats-startBeats,frameCallbacks:frames-startFrames,clockElapsedMs:Date.now()-wallStart,clockRemainingMs:Math.max(0,50-(Date.now()-wallStart))};
      resolve(row);
    }
    const wallStart=Date.now();
    w.onerror=e=>finish({kind:'unknown',reason:'worker-onerror',error:e.message});
    w.onmessage=({data})=>{
      if(data.type==='ready'){
        readyAt=performance.now();clearTimeout(startup);
        budgetDeadline=readyAt+budgetMs;
        deadline=setTimeout(()=>finish({kind:'unknown',reason:'budget-termination'}),budgetMs);
        if(cancelMs!==undefined)cancelTimer=setTimeout(()=>finish({kind:'unknown',reason:'explicit-cancellation'}),cancelMs);
        if(invalidate)invalidateTimer=setTimeout(()=>{current={...current,[invalidate]:typeof current[invalidate]==='number'?current[invalidate]+1:'other-game'};},20);
        w.postMessage({token:tag,fen:fixture.fen,color:fixture.color,mode,deliveryDelayMs});
      }else if(data.type==='started'){solveStart=performance.now();}
      else if(data.type==='result'){
        if(!sameToken(tag,data.token))finish({kind:'unknown',reason:'response-token-mismatch'});
        else if(performance.now()>budgetDeadline)finish({kind:'unknown',reason:'result-after-budget'});
        else finish(data);
      }
    };
    w.postMessage({initialize:true});
  });
}
async function suite(){
  maxBeatGapMs=0;lastBeat=performance.now();
  const status=document.querySelector('#status');status.textContent='Running';
  const fixtures=await(await fetch('./fixtures.json')).json();
  const rows=[];
  for(const fixture of fixtures.queries){
    status.textContent=`Running ${fixture.id}, ${fixture.color}`;
    rows.push(await query(fixture,{mode:fixture.parseOnly?'parse':'analyze',budgetMs:fixture.budgetMs||2000}));
  }
  const basic=fixtures.queries.find(x=>x.id==='bareKingVsRook'&&x.color==='white');
  rows.push(await query({...basic,id:'unknown-injected-none'},{mode:'none-control'}));
  rows.push(await query({...basic,id:'unknown-budget-control'},{mode:'burn-control',budgetMs:80}));
  rows.push(await query({...basic,id:'unknown-cancel-control'},{mode:'burn-control',budgetMs:2000,cancelMs:80}));
  rows.push(await query({...basic,id:'unknown-memory-limit-control'},{mode:'memory-limit-control'}));
  for(const field of keys)rows.push(await query({...basic,id:`stale-${field}`},{invalidate:field,deliveryDelayMs:180}));
  const clockStart=Date.now(),clockDeadline=clockStart+30;
  const pending=query({...basic,id:'clock-pending-control'},{mode:'burn-control',budgetMs:180});
  await new Promise(resolve=>setTimeout(resolve,100));
  const moveAttempt={atElapsedMs:Date.now()-clockStart,accepted:Date.now()<clockDeadline,reason:Date.now()<clockDeadline?'before-deadline':'clock-expired'};
  rows.push(await pending);
  const clockControl={initialMs:30,elapsedMs:Date.now()-clockStart,remainingMs:Math.max(0,clockDeadline-Date.now()),moveAttempt,note:'Synthetic anchor-derived deadline and move gate only; no production clocks or match transitions.'};
  const result={recordedAt:new Date().toISOString(),environment:environment(),observations:{maxBeatGapMs,activeWorkers:active.size,totalTicks:beats,totalFrames:frames},clockControl,rows};
  window.probeResult=result;
  const response=await fetch('/evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result,null,2)});
  if(!response.ok)throw new Error('evidence-write-failed');
  status.textContent=`Complete, ${rows.length} queries. Evidence saved.`;
  return {queries:rows.length,counts:rows.reduce((a,r)=>(a[r.kind]=(a[r.kind]||0)+1,a),{}),environment:result.environment,observations:result.observations};
}
function environment(){return {userAgent:navigator.userAgent,platform:navigator.platform,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemoryGiB:navigator.deviceMemory??null,crossOriginIsolated,secureContext:isSecureContext,sharedArrayBuffer:typeof SharedArrayBuffer,visibility:document.visibilityState,wasm:true};}
async function stress(){
  maxBeatGapMs=0;lastBeat=performance.now();
  const fixtures=await(await fetch('./stress-fixtures.json')).json(),rows=[];
  const start=performance.now();
  for(const fixture of fixtures.queries){
    if(performance.now()-start>55000)break;
    document.querySelector('#status').textContent=`Stress ${fixture.id}, ${fixture.color}`;
    rows.push(await query(fixture,{budgetMs:1000}));
  }
  const result={recordedAt:new Date().toISOString(),environment:environment(),observations:{elapsedMs:performance.now()-start,maxBeatGapMs,activeWorkers:active.size},rows};
  window.stressResult=result;
  await fetch('/evidence/stress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result,null,2)});
  document.querySelector('#status').textContent=`Stress complete, ${rows.length} queries`;
  return {queries:rows.length,counts:rows.reduce((a,r)=>(a[r.kind]=(a[r.kind]||0)+1,a),{}),observations:result.observations};
}
window.runStress=stress;
window.runExtended=async()=>{
  const fixtures=await(await fetch('./stress-fixtures.json')).json();
  const selected=fixtures.queries.filter(x=>x.id==='stress-line-756'||x.id==='stress-line-3353');
  const rows=[];
  for(const fixture of selected)rows.push(await query(fixture,{budgetMs:5000}));
  return {recordedAt:new Date().toISOString(),environment:environment(),budgetMs:5000,rows};
};
window.runProbe=suite;window.stopProbe=stopAll;
document.querySelector('#run').onclick=()=>suite().catch(e=>{document.querySelector('#status').textContent=String(e);stopAll();});
