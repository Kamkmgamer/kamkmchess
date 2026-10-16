import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Chess as ChessJs } from 'chess.js';
import { Chess as ChessOps } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url),'utf8'));
const fixtures=[...read('fixtures.json').queries,...read('stress-fixtures.json').queries].filter(f=>!f.parseOnly);
const rows=fixtures.map(f=>{
  let jsAccepted=false,opsAccepted=false,jsError,opsError;
  try{new ChessJs(f.fen);jsAccepted=true;}catch(e){jsError=String(e);}
  try{ChessOps.fromSetup(parseFen(f.fen).unwrap()).unwrap();opsAccepted=true;}catch(e){opsError=String(e);}
  return {id:f.id,color:f.color,fen:f.fen,jsAccepted,opsAccepted,...(jsError?{jsError}:{}),...(opsError?{opsError}:{})};
});
const hard=rows.find(r=>r.id==='stress-line-756');
assert(hard.jsAccepted&&hard.opsAccepted);
const result={count:rows.length,bothAccepted:rows.filter(r=>r.jsAccepted&&r.opsAccepted).length,rows,note:'Acceptance by these two libraries is an observed input check, not proof of the full application current-state validator or historical reachability.'};
fs.writeFileSync(new URL('input-validation.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({count:result.count,bothAccepted:result.bothAccepted,hardFixtureAcceptedByBoth:true,rejections:rows.filter(r=>!r.jsAccepted||!r.opsAccepted)},null,2));
