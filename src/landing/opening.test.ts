import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { createOpeningFrames, openingMoves } from './opening';

describe('landing opening preview', () => {
  it('replays a legal Italian opening without mutating earlier positions', () => {
    const frames = createOpeningFrames();
    expect(frames).toHaveLength(7);
    expect(frames[0]?.fen).toBe(new Chess().fen());
    expect(frames[0]?.board.flat().filter(Boolean)).toHaveLength(32);

    const replay = new Chess();
    for (const [index, san] of openingMoves.entries()) {
      const move = replay.move(san);
      expect(frames[index + 1]?.fen).toBe(replay.fen());
      expect(frames[index + 1]?.move?.san).toBe(move.san);
      expect(frames[index + 1]?.turn).toBe(replay.turn());
    }

    expect(frames[6]?.fen).toBe('r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
    expect(frames[0]?.board[6]?.[4]?.type).toBe('p');
    expect(frames[0]?.board[4]?.[4]).toBeNull();
  });
});
