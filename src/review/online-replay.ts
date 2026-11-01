import type { OnlineMatchView } from '../online/updates.js';
import type { ResultReason } from '../online/contracts.js';
import { parsePosition } from '../rules/index.js';
import { captureReplay } from './replay.js';
import type { GameReplay, RecapResult } from './replay.js';

const REASONS: Record<Exclude<ResultReason, 'abort'>, RecapResult['reason']> = {
  checkmate: 'checkmate', resignation: 'resignation', timeout: 'timeout', abandonment: 'abandonment',
  stalemate: 'stalemate', repetition: 'threefold-repetition', fifty_move: 'fifty-move-rule',
  insufficient_material: 'dead-position', agreement: 'draw-agreement', opening_reply_timeout: 'opening-reply-timeout', illegal_move: 'illegal-move',
};

/** Maps public chess data only. Match participants and credential references are excluded. */
export function captureOnlineReplay(view: Pick<OnlineMatchView, 'matchId' | 'startingFen' | 'positionFen' | 'moves' | 'result' | 'seats'>, scope: string): GameReplay {
  if (!view.result || view.result.kind === 'abort' || view.result.reason === 'abort') throw new Error('A completed, scored game is needed for a video.');
  const position = parsePosition(view.positionFen);
  const winner = view.result.kind === 'draw' ? 'draw' : view.result.winner;
  if (!winner) throw new Error('This game has no final winner.');
  let previous = view.startingFen;
  const moves = view.moves.map((move, index) => {
    const saved = { moveId: `online-${index}`, eventId: `online-${move.version}`, from: move.uci.slice(0, 2), to: move.uci.slice(2, 4),
      promotion: move.uci.slice(4) || null, san: move.san, fenBefore: previous, fenAfter: move.resultingFen };
    previous = move.resultingFen; return saved;
  });
  const replay = captureReplay({
    gameId: view.matchId, namespace: { kind: 'guest' }, extensions: {},
    archive: { egressStatus: 'eligible', currentLine: { lineId: 'online', eventIds: [] }, discardedLines: [] },
    rules: { variant: 'orthodox', startingFen: view.startingFen, currentFen: view.positionFen, moves,
      sideToMove: position.sideToMove === 'w' ? 'white' : 'black', castlingRights: position.castlingRights,
      enPassantSquare: position.enPassantSquare, halfmoveClock: position.halfmoveClock, fullmoveNumber: position.fullmoveNumber,
      repetitionLedger: { version: 1, positions: [] } },
    result: { kind: 'final', winner, reason: REASONS[view.result.reason], eventId: 'online-final', decidedAtMs: 0 },
  }, { white: view.seats.find(seat => seat.seat === 'white')?.publicLabel ?? 'White',
    black: view.seats.find(seat => seat.seat === 'black')?.publicLabel ?? 'Black' });
  return Object.freeze({ ...replay, scope: `online:${scope}` });
}
