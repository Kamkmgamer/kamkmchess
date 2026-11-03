import { describe, expect, it } from 'vitest';
import { recapCheckpoint } from '../../tests/support/recap.js';
import { captureReplay } from './replay.js';

const players = { white: 'Ada', black: 'Turing' };
describe('recap replay input', () => {
  it('verifies and copies the played line without private archive data', () => {
    const checkpoint = recapCheckpoint();
    const replay = captureReplay(checkpoint, players);
    expect(replay.moves.map(move => move.label)).toEqual(['1.f3', '1...e5', '2.g4', '2...Qh4#']);
    checkpoint.rules.moves[0]!.san = 'altered'; players.white = 'Changed';
    expect(replay.moves[0]!.san).toBe('f3'); expect(replay.players.white).toBe('Ada');
    expect(Object.keys(replay)).not.toContain('archive');
  });
  it('preserves custom Black starts, promotion, and SAN move numbers', () => {
    const checkpoint = recapCheckpoint(['h1=Q'], '7k/8/6K1/8/8/8/7p/8 b - - 0 43');
    expect(captureReplay(checkpoint, players).moves[0]).toMatchObject({ label: '43...h1=Q', uci: 'h2h1q', side: 'black' });
  });
  it('rejects active games, missing hosted history, and mismatched FENs', () => {
    const checkpoint = recapCheckpoint();
    expect(() => captureReplay({ ...checkpoint, result: { kind: 'unresolved' } }, players)).toThrow('Finish');
    const incomplete = recapCheckpoint(); incomplete.extensions['hosted-replay'] = { version: 1, data: { complete: false } };
    expect(() => captureReplay(incomplete, players)).toThrow('full game history');
    const altered = recapCheckpoint(); altered.rules.moves[0]!.fenAfter = altered.rules.startingFen;
    expect(() => captureReplay(altered, players)).toThrow('verified');
  });
});
