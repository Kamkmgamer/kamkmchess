import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Chess as ChessJs, validateFen } from 'chess.js';
import { Chess as ChessOps, equalsIgnoreMoves } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseUci, makeUci, makeSquare } from 'chessops/util';

// Research observations. The application does not import this script.
const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const output = {
  environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release() },
  versions: { 'chess.js': '1.4.0', chessops: '0.15.1' },
  validation: [], moves: [], endings: [], repetition: [],
};
const checked = [];
function check(name, fn) { fn(); checked.push(name); }
const capture = fn => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: e.message }; } };
const ops = fen => ChessOps.fromSetup(parseFen(fen).unwrap()).unwrap();
const opsSnapshot = p => ({ fen: makeFen(p.toSetup()), rawEpSquare: p.epSquare === undefined ? null : makeSquare(p.epSquare), halfmoves: p.halfmoves, fullmoves: p.fullmoves });
const jsSnapshot = p => ({ fen: p.fen(), forcedEpFen: p.fen({forceEnpassantSquare:true}), checkmate: p.isCheckmate(), stalemate: p.isStalemate(), insufficientMaterial: p.isInsufficientMaterial(), fiftyMoves: p.isDrawByFiftyMoves(), threefold: p.isThreefoldRepetition(), draw: p.isDraw(), gameOver: p.isGameOver() });

const fens = {
  standard: start,
  missingKing: '4k3/8/8/8/8/8/8/8 w - - 0 1',
  adjacentKings: '8/8/8/8/8/8/4k3/4K3 w - - 0 1',
  nonmovingKingInCheck: '4k3/8/8/8/8/8/4R3/4K3 w - - 0 1',
  pawnOnBackrank: '4k3/8/8/8/8/8/8/P3K3 w - - 0 1',
  missingCastlingRook: '4k3/8/8/8/8/8/8/4K3 w K - 7 12',
  offHomeCastlingKing: '4k3/8/8/8/8/8/8/3K3R w K - 7 12',
  duplicateCastling: '4k3/8/8/8/8/8/8/4K2R w KK - 7 12',
  epMissingPawn: '4k3/8/8/8/8/8/8/4K3 w - e6 7 12',
  epNoCapturer: '4k3/8/8/4p3/8/8/8/R3K1N1 w - e6 0 9',
  epPinnedCapturer: 'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
  epOccupiedTarget: '7k/8/3N4/3pP3/8/8/8/4K3 w - d6 0 9',
  zeroFullmove: '4k3/8/8/8/8/8/8/R3K3 w - - 7 0',
  countersWithJunk: '4k3/8/8/8/8/8/8/R3K3 w - - 12x 7.5',
  largeHalfmove: '4k3/8/8/8/8/8/8/R3K3 w - - 9999 12',
  largeFullmove: '4k3/8/8/8/8/8/8/R3K3 w - - 7 10000',
  missingCounters: '4k3/8/8/8/8/8/8/R3K3 w - -',
};
for (const [id, fen] of Object.entries(fens)) {
  const parsed = parseFen(fen);
  output.validation.push({id, input:fen, chessJsValidateFen:validateFen(fen),
    chessJsLoad:capture(()=>jsSnapshot(new ChessJs(fen))),
    chessopsParse:capture(()=>({ fen:makeFen(parsed.unwrap()), halfmoves:parsed.unwrap().halfmoves, fullmoves:parsed.unwrap().fullmoves })),
    chessopsPosition:capture(()=>opsSnapshot(ops(fen))) });
}
const moveCases = [
  ['ordinary',start,'e2e4'], ['badPawnGeometry',start,'e2e5'],
  ['blockedBishop',start,'c1h6'], ['emptyOrigin',start,'e3e4'], ['wrongColor',start,'e7e5'],
  ['kingExposure','k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1','e2f2'],
  ['castling','r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','e1g1'],
  ['castlingThroughCheck','k4r2/8/8/8/8/8/8/4K2R w K - 0 1','e1g1'],
  ['ghostCastling',fens.missingCastlingRook,'e1g1'],
  ['enPassant','4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1','e5d6'],
  ['pinnedEnPassant',fens.epPinnedCapturer,'e5d6'],
  ['promotionMissing','4k3/P7/8/8/8/8/8/4K3 w - - 0 1','a7a8'],
  ...'qrbn'.split('').map(p=>['promotion'+p,'4k3/P7/8/8/8/8/8/4K3 w - - 0 1','a7a8'+p]),
];
for (const [id,fen,uci] of moveCases) {
  const p=new ChessJs(fen), q=ops(fen), m=parseUci(uci);
  const js=capture(()=>{const r=p.move({from:uci.slice(0,2),to:uci.slice(2,4),...(uci[4]?{promotion:uci[4]}:{})});return {move:r.lan,fen:p.fen()};});
  const legal=q.isLegal(m);
  output.moves.push({id,fen,uci,chessJs:js,chessops:{legal,...(legal?capture(()=>{q.play(m);return opsSnapshot(q)}):{})}});
}

const endFens = {
  checkmate:'7k/6Q1/5K2/8/8/8/8/8 b - - 100 42',
  stalemate:'7k/5K2/6Q1/8/8/8/8/8 b - - 0 1',
  hundredHalfmoves:'4k3/8/8/8/8/8/8/R3K3 w - - 100 42',
  bareKingVsRook:'4k3/8/8/8/8/8/8/R3K3 b - - 0 1',
  twoKnights:'4k3/8/8/8/8/8/8/1NN1K3 w - - 0 1',
  knightVsRookBeforeMate:'6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
  lockedPawnWall:'4k3/8/8/p1p1p1p1/PpPpPpPp/1P1P1P1P/8/4K3 w - - 0 1',
  asymmetricWallFromChasolver:'5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1',
};
for(const [id,fen] of Object.entries(endFens)) {
  const p=new ChessJs(fen),q=ops(fen);
  output.endings.push({id,fen,chessJs:jsSnapshot(p),chessops:{...opsSnapshot(q),checkmate:q.isCheckmate(),stalemate:q.isStalemate(),insufficientMaterial:q.isInsufficientMaterial(),whiteInsufficient:q.hasInsufficientMaterial('white'),blackInsufficient:q.hasInsufficientMaterial('black'),isEnd:q.isEnd(),outcome:q.outcome()??null}});
}
const mate=new ChessJs('7k/8/5KQ1/8/8/8/8/8 w - - 99 42');mate.move({from:'g6',to:'g7'});
output.mateAt100=jsSnapshot(mate);
const afterThreshold=new ChessJs(endFens.hundredHalfmoves);
output.moveAfterDrawThreshold=capture(()=>{afterThreshold.move({from:'a1',to:'a2'});return jsSnapshot(afterThreshold)});
const knightMate=new ChessJs(endFens.knightVsRookBeforeMate);knightMate.move({from:'d6',to:'f7'});
output.knightVsRookMate=jsSnapshot(knightMate);

function repetition(id,fen,cycle){
  const p=new ChessJs(fen),q=ops(fen),history=[q.clone()];
  const rows=[];
  rows.push({ply:0,jsThreefold:p.isThreefoldRepetition(),equalPositions:1,fen:p.fen(),hash:p.hash()});
  for(let i=0;i<12;i++){
    const u=cycle[i%cycle.length],m=parseUci(u);
    assert(q.isLegal(m));q.play(m);history.push(q.clone());
    p.move({from:u.slice(0,2),to:u.slice(2,4)});
    if((i+1)%4===0) rows.push({ply:i+1,jsThreefold:p.isThreefoldRepetition(),equalPositions:history.filter(h=>equalsIgnoreMoves(q,h)).length,fen:p.fen(),hash:p.hash()});
  }
  output.repetition.push({id,initialFen:fen,cycle,rows});
  return {p,q,history};
}
const rep=repetition('customStart','4k1n1/8/8/8/8/8/8/R3K1N1 w - - 7 23',['g1f3','g8f6','f3g1','f6g8']);
repetition('customStartNonCapturableEp',fens.epNoCapturer,['g1f3','e8f8','f3g1','f8e8']);
repetition('customStartPinnedEp',fens.epPinnedCapturer,['e1f1','a8b8','f1e1','b8a8']);
rep.p.undo();output.undo={threefoldAfterUndo:rep.p.isThreefoldRepetition(),current:rep.p.fen(),reloadThreefold:new ChessJs(rep.p.fen()).isThreefoldRepetition()};
const rawIllegal=ops(start);rawIllegal.play(parseUci('e2e5'));
output.chessopsUncheckedPlay=opsSnapshot(rawIllegal);
const occupiedEp=new ChessJs(fens.epOccupiedTarget);
output.occupiedEpSerialization={before:occupiedEp.get('d6'),fen:occupiedEp.fen(),after:occupiedEp.get('d6')??null};

// Exhaustively explore a closed king-only component, ignoring move-count draws.
// A full closure without a single check proves no checkmate is reachable here.
const root=ops(endFens.lockedPawnWall);
const key=p=>makeFen({...p.toSetup(),halfmoves:0,fullmoves:1});
const queue=[root],seen=new Set([key(root)]);
let edges=0,nonKingMoves=0,checks=0,mates=0,crosscheckDisagreements=0;
for(let index=0;index<queue.length;index++){
  assert(queue.length<=20000,'finite-state evidence bound exceeded');
  const p=queue[index];
  if(p.isCheck())checks++;
  if(p.isCheckmate())mates++;
  const js=new ChessJs(key(p));
  const jsMoves=js.moves({verbose:true}).map(m=>m.lan).sort();
  const legal=[];
  for(const [from,dests] of p.allDests())for(const to of dests){
    const m={from,to};assert(p.isLegal(m));legal.push(makeUci(m));
    if(p.board.get(from).role!=='king')nonKingMoves++;
    const q=p.clone();q.play(m);q.halfmoves=0;q.fullmoves=1;
    const k=key(q);if(!seen.has(k)){seen.add(k);queue.push(q);}edges++;
  }
  if(JSON.stringify(jsMoves)!==JSON.stringify(legal.sort()))crosscheckDisagreements++;
}
output.lockedWallClosure={initialFen:endFens.lockedPawnWall,states:seen.size,edges,nonKingMoves,checks,mates,crosscheckDisagreements,fullyExhausted:true,identity:'piece placement + turn + castling + effective ep, counters ignored; no material helper used as stopping condition'};
check('ordinary move and all four promotions accepted',()=>{for(const id of ['ordinary','promotionq','promotionr','promotionb','promotionn']){const r=output.moves.find(r=>r.id===id);assert(r.chessJs.ok&&r.chessops.legal)}});
check('specific illegal moves rejected',()=>{for(const id of ['badPawnGeometry','blockedBishop','emptyOrigin','wrongColor','kingExposure','castlingThroughCheck','pinnedEnPassant','promotionMissing']){const r=output.moves.find(r=>r.id===id);assert(!r.chessJs.ok&&!r.chessops.legal)}});
check('checkmate and halfmove threshold simultaneously true in chess.js',()=>assert(output.mateAt100.checkmate&&output.mateAt100.fiftyMoves&&output.mateAt100.draw));
check('knight can mate with an opposing rook self-blocker',()=>assert(output.knightVsRookMate.checkmate));
check('custom-start initial position participates in repetition',()=>assert(output.repetition[0].rows[2].jsThreefold));
check('ineffective imported ep delays chess.js third repetition',()=>{for(const row of output.repetition.slice(1)){assert.equal(row.rows[2].equalPositions,3);assert.equal(row.rows[2].jsThreefold,false)}});
check('locked wall closure contains no check or pawn move',()=>{assert.equal(nonKingMoves+checks+mates+crosscheckDisagreements,0);assert(seen.size>0)});
check('material helpers miss the proved dead wall',()=>{const r=output.endings.find(r=>r.id==='lockedPawnWall');assert(!r.chessJs.insufficientMaterial&&!r.chessops.insufficientMaterial&&!r.chessops.whiteInsufficient&&!r.chessops.blackInsufficient)});
check('setup validators differ on adjacent kings and nonmoving king in check',()=>{for(const id of ['adjacentKings','nonmovingKingInCheck']){const r=output.validation.find(r=>r.id===id);assert(r.chessJsValidateFen.ok&&r.chessJsLoad.ok&&!r.chessopsPosition.ok)}});
check('inconsistent castling is accepted by chess.js and silently removed by chessops',()=>{const r=output.moves.find(r=>r.id==='ghostCastling');assert(r.chessJs.ok&&!r.chessops.legal);const v=output.validation.find(r=>r.id==='missingCastlingRook');assert.equal(v.chessopsPosition.value.fen.split(' ')[2],'-')});
check('counter normalization must not be mistaken for preservation',()=>{const large=output.validation.find(r=>r.id==='largeHalfmove');assert.equal(large.chessopsPosition.value.halfmoves,9999);assert.equal(large.chessopsPosition.value.fen.split(' ')[4],'150');const junk=output.validation.find(r=>r.id==='countersWithJunk');assert(junk.chessJsLoad.ok&&!junk.chessopsPosition.ok)});
check('invalid occupied ep target causes chess.js serialization mutation',()=>{assert.equal(output.occupiedEpSerialization.before.type,'n');assert.equal(output.occupiedEpSerialization.after,null)});
output.checks={passed:checked.length,names:checked};
fs.writeFileSync(new URL('./results.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({checks:output.checks,closure:output.lockedWallClosure,repetition:output.repetition,mateAt100:output.mateAt100},null,2));
