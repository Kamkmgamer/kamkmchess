import { applyCoordinateMove, parsePosition, sanToCoordinateMove } from '../../src/rules/index.js';
import { captureReplay } from '../../src/review/replay.js';
import type { GameReview, ReviewedMove } from '../../src/review/review.js';

export const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export function recapCheckpoint(sans: readonly string[] = ['f3', 'e5', 'g4', 'Qh4#'], fen = START): Parameters<typeof captureReplay>[0] {
  let position = parsePosition(fen);
  const moves = sans.map((san, index) => {
    const move = sanToCoordinateMove(position, san);
    if (!move) throw new Error(`Bad fixture SAN ${san}`);
    const next = applyCoordinateMove(position, move);
    const saved = { moveId: `m${index}`, eventId: `e${index}`, from: move.from, to: move.to,
      promotion: move.promotion ?? null, san: next.san, fenBefore: position.fen, fenAfter: next.position.fen };
    position = next.position; return saved;
  });
  return { gameId: 'recap-fixture', namespace: { kind: 'guest' }, extensions: {},
    result: { kind: 'final', winner: 'black', reason: sans.at(-1)?.endsWith('#') ? 'checkmate' : 'resignation', eventId: 'final', decidedAtMs: 1 },
    archive: { egressStatus: 'eligible', currentLine: { lineId: 'main', eventIds: [] }, discardedLines: [] },
    rules: { variant: 'orthodox', startingFen: fen, currentFen: position.fen, moves, sideToMove: position.sideToMove === 'w' ? 'white' : 'black',
      castlingRights: position.castlingRights, enPassantSquare: position.enPassantSquare, halfmoveClock: position.halfmoveClock,
      fullmoveNumber: position.fullmoveNumber, repetitionLedger: { version: 1, positions: [] } },
  };
}
export function reviewedGame(sans?: readonly string[], fen?: string): GameReview {
  const replay = captureReplay(recapCheckpoint(sans, fen), { white: 'White', black: 'Black' });
  const moves: ReviewedMove[] = replay.moves.map((move, index) => ({ ...move, ply: index + 1, grade: 'good',
    playedScore: { kind: 'cp', value: 0 }, loss: 0, depth: 14, bestMove: move.uci, bestSan: move.san, explanation: 'Keeps the position on track.' }));
  return { replay, engineId: 'stockfish-lite', moves };
}
