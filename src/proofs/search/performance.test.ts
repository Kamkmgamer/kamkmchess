import { Chess } from 'chess.js';
import { afterEach, expect, it, vi } from 'vitest';
import { checkProofEvidence, createDeadnessQuery, runProofSearchPass } from '../index.js';

const positions = [
  { name: 'Ruy Lopez, move 3', moves: 'e4 e5 Nf3 Nc6 Bb5' },
  { name: 'Ruy Lopez, move 15', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 Nbd2 Bb7 Bc2 Re8 Nf1 Bf8 Ng3 g6 a4 c5' },
];

afterEach(() => vi.restoreAllMocks());

it.each(positions)('checks $name without rebuilding every speculative board', async ({ moves }) => {
  const chess = new Chess();
  for (const move of moves.split(' ')) chess.move(move);
  const query = createDeadnessQuery({
    gameId: 'performance', segmentId: '1', positionRevision: '1',
    analysisGeneration: '1', ownershipEpoch: '1', positionFen: chess.fen(),
  });
  const notation = vi.spyOn(Chess.prototype as unknown as { _moveToSan: (...args: unknown[]) => string }, '_moveToSan');
  const loads = vi.spyOn(Chess.prototype, 'load');
  const result = await runProofSearchPass(query, { timeBudgetMs: 3_000 });
  expect(result.status).toBe('accepted');
  // Catch the original repeated work without tying CI to machine load or JIT
  // warm-up. The standalone benchmark measures wall time separately.
  expect(notation.mock.calls.length).toBeLessThan(100);
  expect(loads.mock.calls.length).toBeLessThan(128);
  if (result.status === 'accepted') {
    expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
  }
}, 5_000);
