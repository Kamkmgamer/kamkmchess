import { Chess as ChessJs } from 'chess.js';
import { Chess as ChessOps } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';

let instance;
onmessage = async ({data: message}) => {
  const {token, fen, color, mode = 'analyze'} = message;
  try {
    if (message.initialize) {
      const response = await fetch('./solver.wasm');
      const result = await WebAssembly.instantiateStreaming(response, {});
      instance = result.instance;
      postMessage({type:'ready', memoryBytes:instance.exports.memory.buffer.byteLength});
      return;
    }
    postMessage({type:'started', token});
    const start = performance.now();
    if (mode === 'burn-control') {
      // Deliberately busy synthetic control, bounded even if termination fails.
      while (performance.now() - start < 1500) { Math.sqrt(performance.now()); }
      postMessage({type:'result',token,kind:'unknown',reason:'synthetic-burn-finished'});
      return;
    }
    if (mode === 'none-control') {
      // Transport control only, not a naturally undecided upstream query.
      postMessage({type:'result',token,kind:'unknown',reason:'injected-upstream-none'});
      return;
    }
    const wasm = instance.exports;
    if (mode === 'memory-limit-control') wasm.memory.grow(2048);
    const encoded = new TextEncoder().encode(fen);
    if (encoded.length > 256) throw new Error('input-too-long');
    new Uint8Array(wasm.memory.buffer,wasm.input_ptr(),encoded.length).set(encoded);
    const before = wasm.memory.buffer.byteLength;
    wasm.solve(encoded.length, color === 'white' ? 0 : 1, mode === 'parse' ? 1 : 0);
    const raw = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer,wasm.output_ptr(),wasm.output_len())));
    const solveMs = performance.now()-start;
    const {witness,...safe} = raw;
    if (raw.kind === 'winnable') {
      const js = new ChessJs(fen);
      const ops = ChessOps.fromSetup(parseFen(fen).unwrap()).unwrap();
      let earlierPolicyDraw = false;
      let promotions=0,castles=0,enPassantCaptures=0;
      let maxHalfmoves = js.getComment ? Number(fen.split(/\s+/)[4] || 0) : 0;
      for (const uci of witness) {
        if (!js.isCheckmate() && (js.isDrawByFiftyMoves() || js.isThreefoldRepetition())) earlierPolicyDraw = true;
        const played=js.move({from:uci.slice(0,2),to:uci.slice(2,4),...(uci[4]?{promotion:uci[4]}:{})});
        if(played.isPromotion())promotions++;
        if(played.isKingsideCastle()||played.isQueensideCastle())castles++;
        if(played.isEnPassant())enPassantCaptures++;
        const move = parseUci(uci);
        if (!ops.isLegal(move)) throw new Error('chessops-illegal-witness');
        ops.play(move);
        maxHalfmoves = Math.max(maxHalfmoves, Number(js.fen().split(' ')[4]));
      }
      const verified = js.isCheckmate() && ops.isCheckmate() && js.turn() === (color === 'white'?'b':'w') && raw.rustWitnessVerified;
      if (!verified) throw new Error('witness-verification-failed');
      safe.witnessCheck = {plies:witness.length,rust:true,chessJs:true,chessops:true,expectedMatedColor:true,earlierPolicyDraw,maxHalfmoves,promotions,castles,enPassantCaptures};
    }
    // The witness stays inside this Worker. Neither the page nor saved evidence receives moves.
    const result = {type:'result',token,...safe,solveMs,memoryBeforeBytes:before,memoryAfterBytes:wasm.memory.buffer.byteLength};
    if (message.deliveryDelayMs) setTimeout(()=>postMessage(result),message.deliveryDelayMs);
    else postMessage(result);
  } catch (error) {
    postMessage({type:'result',token,kind:'unknown',reason:'worker-error',error:String(error)});
  }
};
