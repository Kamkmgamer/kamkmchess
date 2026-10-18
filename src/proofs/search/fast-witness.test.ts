import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { applyCoordinateMove, legalMoves, parsePosition } from '../../rules/index.js';
import { checkProofEvidence, createDeadnessQuery, createMatingReachabilityQuery, createTimeoutMatingQuery, runProofSearchPass, tryFastMatingWitness } from '../index.js';

const scope = {
  gameId: 'fast-witness-game',
  segmentId: 'segment-1',
  positionRevision: '1',
  analysisGeneration: '1',
  ownershipEpoch: '1',
};

describe('fast mating witness discovery', () => {
  it('resolves the post-b5 and castled Ruy Lopez positions before exhaustive expansion', async () => {
    const chess = new Chess();
    const opening = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O'.split(' ');
    for (const [index, move] of opening.entries()) {
      chess.move(move);
      if (index !== 11 && index !== 15) continue;
      const query = createDeadnessQuery({ ...scope, positionFen: chess.fen() });
      const result = await runProofSearchPass(query, { timeBudgetMs: 3_000, maxDiscoveredStates: 1 });
      expect(result.status).toBe('accepted');
      if (result.status === 'accepted') {
        expect(result.evidence.kind).toBe('mate-witness');
        expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
      }
    }
  }, 10_000);

  it('finds checked motif witnesses through the authoritative pass within 500 ms', async () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const lines = [
      ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'],
      ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6'],
      ['d2d4', 'd7d5', 'c2c4', 'e7e6'],
    ];
    for (const line of lines) {
      let position = parsePosition(start);
      for (const uci of line) {
        const move = legalMoves(position).find((candidate) => candidate.from + candidate.to + (candidate.promotion ?? '') === uci);
        if (!move) throw new Error(`Illegal opening move ${uci}`);
        position = applyCoordinateMove(position, move).position;
      }
      const query = createDeadnessQuery({ ...scope, positionFen: position.fen });
      const result = await runProofSearchPass(query, { timeBudgetMs: 500 });
      expect(result.status, `Position after ${line.join(' ')}: ${position.fen}`).toBe('accepted');
      if (result.status === 'accepted') expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
    }
  }, 30_000);

  it('finds the exact post-Nf3 position through the authoritative pass within 500 ms', async () => {
    let position = parsePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    for (const uci of ['e2e4', 'e7e5', 'g1f3']) {
      const move = legalMoves(position).find((candidate) => candidate.from + candidate.to === uci);
      if (!move) throw new Error(`Illegal regression move ${uci}`);
      position = applyCoordinateMove(position, move).position;
    }
    const query = createDeadnessQuery({ ...scope, positionFen: position.fen });
    const result = await runProofSearchPass(query, { timeBudgetMs: 500 });
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.evidence.kind).toBe('mate-witness');
      expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
    }
  }, 2_000);

  it('resolves every position through a normal knight-development opening', async () => {
    let position = parsePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    for (const uci of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6']) {
      const move = legalMoves(position).find((candidate) => candidate.from + candidate.to === uci);
      if (!move) throw new Error(`Illegal regression move ${uci}`);
      position = applyCoordinateMove(position, move).position;
      const query = createDeadnessQuery({ ...scope, positionFen: position.fen });
      const result = await runProofSearchPass(query, { timeBudgetMs: 3_000 });
      expect(result.status, `Position after ${uci}: ${position.fen}`).toBe('accepted');
      if (result.status === 'accepted') expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
    }
  }, 30_000);
  it('measures checked witness discovery from common non-Scholar and middlegame positions', async () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const probes = [
      { name: 'Ruy Lopez after e4 e5 Nf3 Nc6 Bb5', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'] },
      { name: 'Queen pawn after d4 d5 c4', moves: ['d2d4', 'd7d5', 'c2c4'] },
      { name: 'middlegame after e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Qf3', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5', 'f6d5', 'd1f3'] },
    ];
    let checkedWitnesses = 0;
    for (const probe of probes) {
      let position = parsePosition(start);
      for (const uci of probe.moves) {
        const move = legalMoves(position).find((candidate) => candidate.from + candidate.to + (candidate.promotion ?? '') === uci);
        if (!move) throw new Error(`Illegal probe move ${uci} in ${probe.name}.`);
        position = applyCoordinateMove(position, move).position;
      }
      const query = createDeadnessQuery({ ...scope, positionFen: position.fen });
      const before = Date.now();
      const result = await tryFastMatingWitness(query);
      const elapsedMs = Date.now() - before;
      if (result) {
        checkedWitnesses += 1;
        expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
      }
      expect(elapsedMs).toBeLessThanOrEqual(3_100);
    }
    expect(checkedWitnesses).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('independently checks every playable position along complete opening witnesses', async () => {
    for (const line of [
      ['f2f3', 'e7e5', 'g2g4', 'd8h4'],
      ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'],
    ]) {
      let position = parsePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      for (const uci of line) {
        const query = createDeadnessQuery({ ...scope, positionFen: position.fen });
        const result = await tryFastMatingWitness(query);
        expect(result?.status).toBe('accepted');
        if (result) expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
        const move = legalMoves(position).find((candidate) => candidate.from + candidate.to + (candidate.promotion ?? '') === uci);
        if (!move) throw new Error('The witness fixture contains an illegal move.');
        position = applyCoordinateMove(position, move).position;
      }
    }
  });
  it('finds and independently checks a witness from the standard start and common opening positions', async () => {
    const positions = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
    ];
    for (const positionFen of positions) {
      const query = createDeadnessQuery({ ...scope, positionFen });
      const result = await tryFastMatingWitness(query);
      expect(result?.status).toBe('accepted');
      if (!result || result.status !== 'accepted') throw new Error('Expected a checked mating witness.');
      expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
    }
  });

  it('respects the queried mating color for cooperative and timeout queries', async () => {
    const positionFen = '6rk/8/3N3K/8/8/8/8/8 w - - 0 1';
    const white = createMatingReachabilityQuery({ ...scope, positionFen, intendedColor: 'w' });
    const black = createMatingReachabilityQuery({ ...scope, positionFen, intendedColor: 'b' });
    const timeout = createTimeoutMatingQuery({ ...scope, positionFen, expiredColor: 'w' });
    const whiteResult = await tryFastMatingWitness(white);
    expect(whiteResult).toMatchObject({ status: 'accepted', conclusion: 'mate-reachable' });
    const blackResult = await tryFastMatingWitness(black);
    if (blackResult) expect(checkProofEvidence(black, blackResult.evidence)).toMatchObject({ status: 'accepted', conclusion: 'mate-reachable' });
    const timeoutResult = await tryFastMatingWitness(timeout);
    if (timeoutResult) expect(checkProofEvidence(timeout, timeoutResult.evidence)).toMatchObject({ status: 'accepted', conclusion: 'opponent-can-mate' });
  }, 10_000); // Three independent passes can each use their 3-second bound.

  it('leaves a locked position unresolved instead of inferring deadness or nondeadness', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: '4k3/8/8/p1p1p1p1/PpPpPpPp/1P1P1P1P/8/4K3 w - - 0 1',
    });
    const before = Date.now();
    const result = await tryFastMatingWitness(query);
    expect(result).toBeNull();
    expect(Date.now() - before).toBeLessThanOrEqual(3_100);
  });

  it('keeps random legal middlegame probes positive-only', async () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    for (let sample = 0; sample < 3; sample += 1) {
      let position = parsePosition(start);
      let random = 0x51f15e + sample * 7919;
      for (let ply = 0; ply < 36; ply += 1) {
        const moves = legalMoves(position);
        if (moves.length === 0) break;
        random = (random * 1664525 + 1013904223) >>> 0;
        const move = moves[random % moves.length];
        if (!move) break;
        position = applyCoordinateMove(position, move).position;
      }
      const query = createMatingReachabilityQuery({
        ...scope,
        positionFen: position.fen,
        intendedColor: position.sideToMove,
      });
      const result = await tryFastMatingWitness(query);
      if (result) {
        expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'mate-reachable' });
      }
    }
  }, 30_000);

  it('runs before the complete search on ordinary opening queries', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    });
    const { runProofSearchPass } = await import('../index.js');
    const result = await runProofSearchPass(query, { timeBudgetMs: 3_000 });
    if (result.status !== 'accepted') throw new Error(`Post-e4 runner result: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ status: 'accepted', conclusion: 'not-dead', evidence: { kind: 'mate-witness' } });
  });

  it('does not let positive discovery exceed the caller time budget', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    });
    const { runProofSearchPass } = await import('../index.js');
    const result = await runProofSearchPass(query, { timeBudgetMs: 1 });
    expect(result).toMatchObject({ status: 'non-result', reason: 'time-budget' });
  });
});
