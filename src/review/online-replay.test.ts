import { describe, expect, it } from 'vitest';
import { recapCheckpoint } from '../../tests/support/recap.js';
import { captureOnlineReplay } from './online-replay.js';

function view(): Parameters<typeof captureOnlineReplay>[0] {
  const checkpoint = recapCheckpoint();
  return { matchId: 'online-recap', startingFen: checkpoint.rules.startingFen, positionFen: checkpoint.rules.currentFen,
    result: { kind: 'win', winner: 'black', reason: 'checkmate' },
    seats: ['white', 'black'].map(seat => ({ seat: seat === 'white' ? 'white' : 'black', publicLabel: seat === 'white' ? 'Alice' : 'Bob',
      control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 })),
    moves: checkpoint.rules.moves.map((move, index) => ({ version: index + 1, seat: index % 2 ? 'black' : 'white',
      uci: move.from + move.to + (move.promotion ?? ''), san: move.san, resultingFen: move.fenAfter })),
  };
}
describe('online recap adapter', () => {
  it('verifies public move data and excludes participant credentials', () => {
    const replay = captureOnlineReplay(view(), 'account:example');
    expect(replay.scope).toBe('online:account:example');
    expect(replay.moves.at(-1)!.san).toBe('Qh4#'); expect(replay.players.white).toBe('Alice');
    expect(replay).not.toHaveProperty('seats'); expect(replay).not.toHaveProperty('clock');
  });
  it('preserves abandonment and rejects aborted or incomplete games', () => {
    const original = view();
    expect(captureOnlineReplay({ ...original, result: { kind: 'win', winner: 'black', reason: 'abandonment' } }, 'guest').result.reason).toBe('abandonment');
    expect(() => captureOnlineReplay({ ...original, result: { kind: 'abort', winner: null, reason: 'abort' } }, 'guest')).toThrow('scored');
    expect(() => captureOnlineReplay({ ...original, moves: [] }, 'guest')).toThrow('match');
  });
  it('includes the public player and agent or engine controlling each seat', () => {
    const original = view();
    const white = original.seats[0]!;
    const black = original.seats[1]!;
    const agent = captureOnlineReplay({ ...original, seats: [white, { ...black, control: { kind: 'agent', modelLabel: 'Claude' } }] }, 'guest');
    expect(agent.players).toEqual({ white: 'Alice', black: 'Bob (agent: Claude)' });
    const engine = captureOnlineReplay({ ...original, seats: [white, { ...black, control: { kind: 'engine', modelLabel: 'Stockfish' } }] }, 'guest');
    expect(engine.players.black).toBe('Bob (engine: Stockfish)');
  });
});
