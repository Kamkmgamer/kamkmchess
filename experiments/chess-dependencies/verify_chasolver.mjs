import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Chess as ChessJs } from 'chess.js';
import { Chess as ChessOps } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';

const rows = fs.readFileSync(new URL('./chasolver-results.jsonl',import.meta.url),'utf8').trim().split(/\r?\n/).map(JSON.parse);
assert.equal(rows.length,8);
const expected = {
  lockedWall:['unwinnable','unwinnable'],
  asymmetricWall:['winnable','unwinnable'],
  bareKingVsRook:['winnable','unwinnable'],
  knightVsRook:['winnable','winnable'],
};
const results=[];
for(const r of rows){
  assert.equal(r.verdict,expected[r.id][r.intendedWinner==='White'?0:1]);
  if(r.verdict!=='winnable')continue;
  const js=new ChessJs(r.fen),ops=ChessOps.fromSetup(parseFen(r.fen).unwrap()).unwrap();
  for(const uci of r.helpmate){
    js.move({from:uci.slice(0,2),to:uci.slice(2,4),...(uci[4]?{promotion:uci[4]}:{})});
    const m=parseUci(uci);assert(ops.isLegal(m));ops.play(m);
  }
  assert(js.isCheckmate());assert(ops.isCheckmate());
  assert.equal(js.turn(),r.intendedWinner==='White'?'b':'w');
  results.push({id:r.id,intendedWinner:r.intendedWinner,plies:r.helpmate.length,legalInChessJs:true,legalInChessops:true,checkmateInBoth:true});
}
const report={verdictsChecked:8,winnableWitnessesChecked:results.length,results,note:'Unwinnable proof internals are not independently verified here. Locked-wall closure is independently enumerated in results.json.'};
fs.writeFileSync(new URL('./chasolver-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
