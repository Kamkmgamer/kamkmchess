// Disposable fixture client, not a production provider adapter or chess controller.
window.kha21 = (() => {
  const expectedText='fixture café ♞';
  function parser(protocol, onText, onEvent) {
    let input='', data=[], event='', fullText='', finish=null, outcome=null;
    const unknown=[];
    function dispatch(){
      if(!data.length){event='';return;}
      const raw=data.join('\n');data=[];const name=event;event='';
      onEvent({event:name,data:raw});
      if(protocol==='chat'&&raw==='[DONE]'){
        if(!finish)throw new Error('DONE without a finish reason');
        outcome=finish==='stop'?'complete':'incomplete';return;
      }
      const value=JSON.parse(raw);
      if(protocol!=='chat'&&name&&name!==value.type)throw new Error('SSE event/type mismatch');
      if(protocol==='chat'){
        if(value.error){outcome='stream-error';return;}
        const choice=value.choices?.[0];
        if(typeof choice?.delta?.content==='string'){fullText+=choice.delta.content;onText(choice.delta.content);}
        if(choice?.finish_reason)finish=choice.finish_reason;
      }else if(protocol==='responses'){
        if(value.type==='response.output_text.delta'){fullText+=value.delta;onText(value.delta);}
        else if(value.type==='response.completed'){
          if(value.response?.status!=='completed')throw new Error('Wrong completed status');outcome='complete';
        }else if(value.type==='response.incomplete')outcome='incomplete';
        else if(value.type==='response.failed'||value.type==='error')outcome='stream-error';
        else if(!['response.created','response.output_text.done'].includes(value.type))unknown.push(value.type);
      }else{
        if(value.type==='content_block_delta'&&value.delta?.type==='text_delta'){fullText+=value.delta.text;onText(value.delta.text);}
        else if(value.type==='message_delta')finish=value.delta?.stop_reason;
        else if(value.type==='message_stop'){
          if(!finish)throw new Error('message_stop without stop_reason');outcome=finish==='end_turn'?'complete':'incomplete';
        }else if(value.type==='error')outcome='stream-error';
        else if(!['message_start','content_block_start','content_block_stop','ping'].includes(value.type))unknown.push(value.type);
      }
    }
    function line(value){
      if(value===''){dispatch();return;}
      if(value.startsWith(':'))return;
      const colon=value.indexOf(':');const field=colon<0?value:value.slice(0,colon);
      let content=colon<0?'':value.slice(colon+1);if(content.startsWith(' '))content=content.slice(1);
      if(field==='data')data.push(content);if(field==='event')event=content;
    }
    function push(value,flush=false){
      input+=value;
      while(true){const match=/[\r\n]/.exec(input);if(!match)break;
        const at=match.index;if(input[at]==='\r'&&at===input.length-1&&!flush)break;
        const length=input[at]==='\r'&&input[at+1]==='\n'?2:1;
        const current=input.slice(0,at);input=input.slice(at+length);line(current);
      }
      // SSE does not dispatch a partial event at EOF.
    }
    return {push,result:()=>({outcome:outcome||'truncated',fullText,finish,unknown,pendingCharacters:input.length,pendingDataLines:data.length})};
  }
  async function fixture(base,protocol,kind,id,cors){
    const began=performance.now(),controller=new AbortController();let timedOut=false;
    const row={id,protocol,kind,cors:cors||null,sourceOrigin:location.origin,startedAt:new Date().toISOString(),reads:[],events:[],deltas:[],dropped:[]};
    let version=1,appliedText='',reader;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},12000);
    const decode=new TextDecoder('utf-8',{fatal:true});
    const consume=parser(protocol,delta=>{
      const entry={atMs:performance.now()-began,text:delta,version};row.deltas.push(entry);
      if(version===1)appliedText+=delta;else row.dropped.push({kind:'text',...entry});
      if(delta&&kind==='abort')controller.abort();
      if(delta&&kind==='stale'&&version===1){version=2;row.invalidatedAtMs=performance.now()-began;}
    },entry=>{
      const stamped={...entry,atMs:performance.now()-began};row.events.push(stamped);
      if(version!==1)row.dropped.push({kind:'event',...stamped});
    });
    const url=new URL(`/fixture/${protocol}/${kind}`,base);url.searchParams.set('id',id);if(cors)url.searchParams.set('cors',cors);
    row.url=url.href;
    try{
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer kha21-fixture-only','ngrok-skip-browser-warning':'kha21'},body:JSON.stringify({synthetic:true}),credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
      row.httpStatus=response.status;row.headersAtMs=performance.now()-began;row.responseHeaders=Object.fromEntries(response.headers);
      if(!response.ok){row.outcome='http-error';row.body=await response.text();return row;}
      if(!response.headers.get('content-type')?.startsWith('text/event-stream'))throw new Error('Unexpected fixture MIME type');
      reader=response.body.getReader();
      while(true){
        const {value,done}=await reader.read();if(done)break;
        row.reads.push({atMs:performance.now()-began,bytes:value.length,base64:btoa(String.fromCharCode(...value))});
        consume.push(decode.decode(value,{stream:true}));
      }
      consume.push(decode.decode(),true);Object.assign(row,consume.result());
    }catch(error){
      Object.assign(row,consume.result());row.error={name:error.name,message:error.message};
      row.outcome=controller.signal.aborted?(timedOut?'timeout':'aborted'):(error instanceof SyntaxError?'protocol-error':(row.httpStatus?'read-error':'fetch-error'));
    }finally{
      clearTimeout(timer);if(reader){try{await reader.cancel();}catch{}}
      row.appliedText=appliedText;row.version=version;row.finishedAt=new Date().toISOString();row.elapsedMs=performance.now()-began;
    }
    return row;
  }
  async function catalog(profile){
    if(profile.method!=='GET'||!profile.url.endsWith('/models'))throw new Error('Only catalog GETs allowed');
    const began=performance.now(),row={id:profile.id,url:profile.url,requestHeaders:profile.headers,sourceOrigin:location.origin,startedAt:new Date().toISOString()};
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch(profile.url,{method:'GET',headers:profile.headers,mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
      row.status=response.status;row.readable=true;row.responseHeaders=Object.fromEntries(response.headers);
      const reader=response.body.getReader(),decoder=new TextDecoder();let sample='',bytes=0,done=false;
      while(bytes<8192){const part=await reader.read();done=part.done;if(done)break;bytes+=part.value.length;sample+=decoder.decode(part.value,{stream:true});}
      row.sample=sample.slice(0,8192);row.sampleTruncated=!done||sample.length>8192;row.bytesRead=bytes;await reader.cancel();
    }catch(error){row.readable=false;row.error={name:error.name,message:error.message};}
    finally{clearTimeout(timer);row.elapsedMs=performance.now()-began;row.finishedAt=new Date().toISOString();}
    return row;
  }
  return {fixture,catalog,expectedText};
})();
