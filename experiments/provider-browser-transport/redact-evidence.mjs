import {readFile,writeFile,readdir} from 'node:fs/promises';
// These cookies were never sent as provider credentials. Preserve header names,
// but omit unused request/response cookie values from publication.
function redact(value,key=''){
  if(Array.isArray(value)){
    if(key==='rawHeaders')return value.map((entry,index)=>index%2&&/^(set-cookie|cookie)$/i.test(value[index-1])?'[omitted unused cookie]':entry);
    return value.map(entry=>redact(entry));
  }
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,entry])=>
    [/^(set-cookie|cookie)$/i.test(name)?name:name,/^(set-cookie|cookie)$/i.test(name)?'[omitted unused cookie]':redact(entry,name)]));
  return value;
}
async function walk(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const url=new URL(entry.name+(entry.isDirectory()?'/':''),directory);
    if(entry.isDirectory())await walk(url);
    else if(entry.name.endsWith('.json')&&entry.name!=='file-manifest.json'&&entry.name!=='summary.json'){
      const value=JSON.parse((await readFile(url,'utf8')).replace(/^\uFEFF/,''));
      await writeFile(url,JSON.stringify(redact(value),null,2)+'\n');
    }else if(entry.name.endsWith('.ndjson')){
      const rows=(await readFile(url,'utf8')).trim().split('\n').map(line=>JSON.stringify(redact(JSON.parse(line))));
      await writeFile(url,rows.join('\n')+'\n');
    }
  }
}
await walk(new URL('./evidence/',import.meta.url));
