import http from 'node:http';
import {readFileSync,appendFileSync} from 'node:fs';
import {profiles,catalogProfiles} from './profiles.mjs';
const port=18775, controlPort=18776;
const logPath=process.env.KHA21_LOG_FILE;
if(!logPath)throw new Error('Set KHA21_LOG_FILE outside the repository');
const log=(entry)=>appendFileSync(logPath,JSON.stringify({at:new Date().toISOString(),...entry})+'\n');
const text='fixture café ♞';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const sse=(event,data)=>`${event ? `event: ${event}\r\n` : ''}data: ${typeof data==='string'?data:JSON.stringify(data)}\r\n\r\n`;
function events(protocol,kind){
  let sequence=0;
  const typed=(type,fields={})=>sse(type,{type,...fields,...(protocol==='responses'?{sequence_number:sequence++}:{})});
  let start,first,second,terminal,error,incomplete;
  if(protocol==='chat'){
    const chunk=(delta,finish_reason=null)=>sse('',{id:'synthetic-chat',object:'chat.completion.chunk',created:0,model:'synthetic-only',choices:[{index:0,delta,finish_reason}]});
    start=chunk({role:'assistant',content:''});first=chunk({content:'fixture '});second=chunk({content:'café ♞'});
    terminal=chunk({},'stop')+sse('','[DONE]');error=sse('',{error:{message:'synthetic stream error',code:'synthetic_overload'}});
    incomplete=chunk({},'length')+sse('','[DONE]');
  }else if(protocol==='responses'){
    start=typed('response.created',{response:{id:'synthetic-response',status:'in_progress',output:[]}});
    first=typed('response.output_text.delta',{item_id:'synthetic-item',output_index:0,content_index:0,delta:'fixture ',logprobs:[]});
    second=typed('response.output_text.delta',{item_id:'synthetic-item',output_index:0,content_index:0,delta:'café ♞',logprobs:[]});
    terminal=typed('response.output_text.done',{item_id:'synthetic-item',output_index:0,content_index:0,text})+typed('response.completed',{response:{id:'synthetic-response',status:'completed',output:[{id:'synthetic-item',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}]}});
    error=typed('response.failed',{response:{id:'synthetic-response',status:'failed',error:{code:'server_error',message:'synthetic stream error'}}});
    incomplete=typed('response.incomplete',{response:{id:'synthetic-response',status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}});
  }else if(protocol==='messages'){
    start=typed('message_start',{message:{id:'synthetic-message',type:'message',role:'assistant',model:'synthetic-only',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}})+typed('content_block_start',{index:0,content_block:{type:'text',text:''}})+typed('ping');
    first=typed('content_block_delta',{index:0,delta:{type:'text_delta',text:'fixture '}});
    second=typed('content_block_delta',{index:0,delta:{type:'text_delta',text:'café ♞'}});
    terminal=typed('content_block_stop',{index:0})+typed('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}})+typed('message_stop');
    error=typed('error',{error:{type:'overloaded_error',message:'synthetic stream error'}});
    incomplete=typed('content_block_stop',{index:0})+typed('message_delta',{delta:{stop_reason:'max_tokens',stop_sequence:null},usage:{output_tokens:3}})+typed('message_stop');
  }else throw new Error('Unknown protocol');
  if(kind==='first-error')return [protocol==='responses'?typed('error',{code:'server_error',message:'synthetic first-event error',param:null}):error];
  if(kind==='error')return [start,first,error];
  if(kind==='incomplete')return [start,first,incomplete];
  if(kind==='eof'||kind==='disconnect')return [start,first];
  if(kind==='malformed')return [start,first,'data: {not-json}\r\n\r\n'];
  if(kind==='alias')return [typed('response.content_part.delta',{delta:{text:'fixture '}}),typed('response.done',{response:{status:'completed'}})];
  return [start,first,second,terminal];
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://synthetic.invalid');
  const id=url.searchParams.get('id');
  const record={type:'request',id,method:req.method,path:url.pathname,headers:req.headers};log(record);
  const origin=req.headers.origin;
  if(url.searchParams.get('cors')==='wrong-origin')res.setHeader('Access-Control-Allow-Origin','https://wrong-origin.invalid');
  else res.setHeader('Access-Control-Allow-Origin',origin||'*');
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',url.searchParams.get('cors')==='missing-auth'?'content-type,ngrok-skip-browser-warning':'authorization,content-type,ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Expose-Headers','x-synthetic-fixture');
  res.setHeader('Access-Control-Max-Age','0');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(url.pathname==='/harness'){
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>KHA21 synthetic transport</title><h1>KHA21 synthetic transport</h1><p>Disposable test page. No real credentials or models.</p><script src="/client.js"></script>');return;
  }
  if(url.pathname==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(new URL('./client.js',import.meta.url)));return;}
  if(url.pathname==='/profiles'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({profiles,catalogProfiles}));return;}
  if(!url.pathname.startsWith('/fixture/')){res.writeHead(404);res.end('not found');return;}
  const [, ,protocol,kind]=url.pathname.split('/');
  if(!['chat','responses','messages'].includes(protocol)||!['normal','error','first-error','http-error','eof','disconnect','abort','stale','incomplete','malformed','alias'].includes(kind)){res.writeHead(404);res.end();return;}
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  let body='';for await(const chunk of req)body+=chunk;
  if(body!==JSON.stringify({synthetic:true})){res.writeHead(400);res.end('synthetic body required');return;}
  res.setHeader('X-Synthetic-Fixture',`${protocol}/${kind}`);
  if(kind==='http-error'){res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'synthetic_rate_limit',message:'synthetic HTTP error'}}));log({type:'http-error',id,status:429});return;}
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no'});res.flushHeaders();
  let ended=false;res.on('close',()=>log({type:'close',id,ended,writableFinished:res.writableFinished}));
  try{
    const frames=events(protocol,kind);
    // Include comments and multiline data, then split writes inside UTF-8 and CRLF.
    for(let index=0;index<frames.length;index++){
      if(res.destroyed)break;
      const frame=frames[index];
      if(index===1)res.write(': synthetic keepalive\r\n\r\n');
      const comma=frame.indexOf(',');
      const multiline=index===0&&comma>0?frame.slice(0,comma+1)+'\r\ndata: '+frame.slice(comma+1):frame;
      const bytes=Buffer.from(multiline);const accent=bytes.indexOf(Buffer.from('é'));
      const cuts=accent>=0?[accent+1]:[Math.min(7,bytes.length)];let offset=0;
      for(const cut of [...cuts,bytes.length]){
        const part=bytes.subarray(offset,cut);if(part.length){res.write(part);log({type:'write',id,frame:index,bytes:part.length,base64:part.toString('base64')});}
        offset=cut;await delay(35);
      }
      if(index<frames.length-1)await delay(220);
    }
    if(kind==='disconnect'){res.destroy();log({type:'disconnect',id});return;}
    if(!res.destroyed){ended=true;res.end();log({type:'end',id});}
  }catch(error){log({type:'server-error',id,error:String(error)});res.destroy();}
});
server.listen(port,'127.0.0.1',()=>console.log(`KHA21_READY ${port}`));
const control=http.createServer((req,res)=>{
  if(req.method==='POST'&&req.url==='/shutdown'){res.end('stopping');server.close();server.closeAllConnections();control.close();clearTimeout(guard);}
  else{res.writeHead(404);res.end();}
});
control.listen(controlPort,'127.0.0.1');
const guard=setTimeout(()=>{server.closeAllConnections();server.close();control.close();},45*60*1000);
