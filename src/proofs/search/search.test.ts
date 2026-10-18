import { describe, expect, it, vi } from 'vitest';
import {
  createDeadnessQuery,
  createMatingReachabilityQuery,
  runProofSearchPass,
  createTimeoutMatingQuery,
  checkProofEvidence,
  validateProofSearchCheckpoint,
} from '../index.js';

const scope = {
  gameId: 'search-cycle-game',
  segmentId: 'segment-1',
  positionRevision: '4',
  analysisGeneration: '2',
  ownershipEpoch: '1',
};

describe('cooperative proof search', () => {
  it('checks the reviewed four-state cycle before reporting deadness', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
    });

    const result = await runProofSearchPass(query);

    expect(result).toMatchObject({
      status: 'accepted',
      conclusion: 'dead',
      evidence: { kind: 'closed-successor-set' },
      pass: { totalDiscoveredStateCount: 4, totalDiscoveredEdgeCount: 4 },
    });
  });

  it('resumes a partial frontier without treating the cutoff as deadness', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
    });
    const firstPass = await runProofSearchPass(query, { maxDiscoveredStates: 1 });

    expect(firstPass).toMatchObject({ status: 'non-result', reason: 'state-budget', checkpoint: { frontier: expect.any(Array) } });
    if (firstPass.status !== 'non-result' || firstPass.checkpoint === null) {
      throw new Error('The state budget must return a resumable non-result.');
    }

    let result = await runProofSearchPass(query, { checkpoint: firstPass.checkpoint, maxDiscoveredStates: 1 });
    let passes = 2;
    while (result.status === 'non-result' && result.checkpoint !== null && passes < 8) {
      result = await runProofSearchPass(query, { checkpoint: result.checkpoint, maxDiscoveredStates: 1 });
      passes += 1;
    }

    expect(result).toMatchObject({
      status: 'accepted',
      conclusion: 'dead',
      checkpointDisposition: 'resumed',
      pass: { totalDiscoveredStateCount: 4, totalDiscoveredEdgeCount: 4 },
    });
    expect(passes).toBe(4);
  });

  it('restarts a structurally corrupt checkpoint from the current query', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
    });
    const partial = await runProofSearchPass(query, { maxDiscoveredStates: 1 });
    if (partial.status !== 'non-result' || partial.checkpoint === null) {
      throw new Error('The first pass must save its frontier.');
    }
    const corrupted: unknown = { ...structuredClone(partial.checkpoint), frontier: [] };

    expect(validateProofSearchCheckpoint(corrupted)).toMatchObject({ status: 'restart-required' });
    const result = await runProofSearchPass(query, { checkpoint: corrupted, maxDiscoveredStates: 1 });
    expect(result).toMatchObject({ status: 'non-result', reason: 'invalid-checkpoint', checkpointDisposition: 'restarted' });
    if (result.status !== 'non-result' || result.checkpoint === null) throw new Error('Restart must stay resumable.');
    expect(result.checkpoint.stateRecords).toHaveLength(1);
    expect(result.checkpoint.frontier).toHaveLength(1);
    const restarted = await runProofSearchPass(query, { checkpoint: result.checkpoint, maxDiscoveredStates: 1 });
    expect(restarted).toMatchObject({ status: 'non-result', reason: 'state-budget', checkpointDisposition: 'resumed' });
  });

  it('honors cancellation during fast discovery and returns a resumable non-result', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: '7k/8/8/NNNNN3/8/NNNNNNNN/8/KNNNNNNN w - - 0 1',
    });
    const controller = new AbortController();
    // Force fast discovery to yield before it can find a witness, regardless
    // of host speed, then deliver cancellation at that yield.
    let elapsedMs = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsedMs++);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let result;
    try {
      setTimeout(() => controller.abort(), 0);
      const pending = runProofSearchPass(query, { signal: controller.signal });
      expect(controller.signal.aborted).toBe(false);
      await vi.runAllTimersAsync();
      result = await pending;
    } finally {
      vi.useRealTimers();
      clock.mockRestore();
    }

    expect(result).toMatchObject({ status: 'non-result', reason: 'cancelled', checkpoint: { frontier: expect.any(Array) } });
    if (result.status !== 'non-result' || result.checkpoint === null) throw new Error('Cancellation must preserve progress.');
    expect(validateProofSearchCheckpoint(result.checkpoint).status).toBe('valid');
    expect(result.pass.processedEdgeCount).toBe(0);
    expect(result.pass.processedEdgeCount).toBeLessThan(1000);
  });

  it('returns a replay-checked positive witness for the queried winner', async () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      intendedColor: 'w',
    });

    const result = await runProofSearchPass(query);

    expect(result).toMatchObject({
      status: 'accepted',
      conclusion: 'mate-reachable',
      evidence: { kind: 'mate-witness', intendedColor: 'w', moves: [{ from: 'd6', to: 'f7' }] },
      pass: { maxDiscoveredStates: 10_000, timeBudgetMs: 5_000 },
    });
    if (result.status !== 'accepted') throw new Error('The known white witness must be accepted.');
    expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'mate-reachable' });
  });

  it('recognizes an already mated root for the black target winner', async () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '6RK/5n2/7k/8/8/8/8/8 w - - 1 1',
      intendedColor: 'b',
    });

    const result = await runProofSearchPass(query);

    expect(result).toMatchObject({
      status: 'accepted',
      conclusion: 'mate-reachable',
      evidence: { kind: 'mate-witness', intendedColor: 'b', moves: [] },
    });
  });

  it('queries only the opponent of the expired side for timeout mating', async () => {
    const positionFen = '6rk/5N2/7K/8/8/8/8/8 b - - 1 1';
    const whiteOpponent = createTimeoutMatingQuery({ ...scope, positionFen, expiredColor: 'b' });
    const blackOpponent = createTimeoutMatingQuery({ ...scope, positionFen, expiredColor: 'w' });

    expect(await runProofSearchPass(whiteOpponent)).toMatchObject({ status: 'accepted', conclusion: 'opponent-can-mate' });
    expect(await runProofSearchPass(blackOpponent)).toMatchObject({ status: 'accepted', conclusion: 'opponent-cannot-mate' });
  });

  it('finds the legal bishop promotion that immediately checkmates', async () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '8/P7/8/8/8/6K1/4N3/7k w - - 0 1',
      intendedColor: 'w',
    });

    const result = await runProofSearchPass(query);

    expect(result).toMatchObject({
      status: 'accepted',
      conclusion: 'mate-reachable',
      evidence: { kind: 'mate-witness', moves: [{ from: 'a7', to: 'a8', promotion: 'b' }] },
    });
  });

  it('finds a white mate when the root has a usable en-passant target', async () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '8/P7/8/3pP3/8/6K1/4N3/7k w - d6 0 2',
      intendedColor: 'w',
    });

    const result = await runProofSearchPass(query);

    expect(result).toMatchObject({
      status: 'accepted',
      conclusion: 'mate-reachable',
      evidence: { kind: 'mate-witness', intendedColor: 'w' },
    });
    if (result.status !== 'accepted') throw new Error('The known mate must be accepted.');
    expect(checkProofEvidence(query, result.evidence)).toMatchObject({ status: 'accepted', conclusion: 'mate-reachable' });
  });

  it('validates a usable en-passant state reached by a black double pawn push', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: '6k1/5ppp/8/3pP3/8/8/8/1K2R3 b - - 1 2',
    });

    const result = await runProofSearchPass(query, { maxDiscoveredStates: 32, timeBudgetMs: 10_000, fastWitness: false });

    expect(result.status).toBe('non-result');
    if (result.status !== 'non-result' || result.checkpoint === null) {
      throw new Error('The bounded graph pass must retain its frontier.');
    }
    const enPassantState = result.checkpoint.stateRecords.find(
      (state) => state.stateKey === '6k1/6pp/8/3pPp2/8/8/8/1K2R3 w - f6',
    );
    expect(enPassantState?.positionFen).toBe('6k1/6pp/8/3pPp2/8/8/8/1K2R3 w - f6 0 2');
    expect(validateProofSearchCheckpoint(result.checkpoint)).toMatchObject({ status: 'valid' });
    expect(await runProofSearchPass(query, {
      checkpoint: result.checkpoint,
      maxDiscoveredStates: 1,
      timeBudgetMs: 10_000,
      fastWitness: false,
    })).toMatchObject({ status: 'non-result', checkpointDisposition: 'resumed' });
  });

  it('restarts when a checkpoint edge and its parent are changed to an illegal move', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
    });
    const partial = await runProofSearchPass(query, { maxDiscoveredStates: 2 });
    if (partial.status !== 'non-result' || partial.checkpoint === null) {
      throw new Error('The bounded cycle pass must retain a checkpoint.');
    }

    const tampered = structuredClone(partial.checkpoint) as unknown as {
      stateRecords: Array<{ successors: Array<{ move: { from: string; to: string }; target: string }> }>;
      parentRecords: Array<{ stateKey: string; move: { from: string; to: string } | null }>;
    };
    const edge = tampered.stateRecords[0]?.successors[0];
    if (!edge) throw new Error('The cycle root must have a recorded successor.');
    edge.move = { from: 'a1', to: 'a2' };
    const parent = tampered.parentRecords.find((record) => record.stateKey === edge.target);
    if (!parent) throw new Error('The cycle successor must have a parent record.');
    parent.move = { from: 'a1', to: 'a2' };

    expect(validateProofSearchCheckpoint(tampered)).toMatchObject({ status: 'restart-required', reason: 'corrupt-checkpoint' });
    expect(await runProofSearchPass(query, { checkpoint: tampered })).toMatchObject({
      status: 'non-result',
      reason: 'invalid-checkpoint',
      checkpointDisposition: 'restarted',
    });
  });

  it('[ADJ-03, ADJ-09] closes the researched 768-state locked pawn wall', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: '4k3/8/8/p1p1p1p1/PpPpPpPp/1P1P1P1P/8/4K3 w - - 0 1',
    });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);

    try {
      const result = await runProofSearchPass(query);
      expect(result).toMatchObject({
        status: 'accepted',
        conclusion: 'dead',
        evidence: { kind: 'closed-successor-set' },
        pass: { totalDiscoveredStateCount: 768, totalDiscoveredEdgeCount: 3808 },
      });
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  it('[ADJ-05] preserves resumable progress when the five-second graph budget expires', async () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: 'kb6/b1p2p1p/1pP5/1P6/8/8/5P1P/5K2 w - - 0 1',
      intendedColor: 'w',
    });
    // Faster machines can find a checked witness for this historical unknown.
    // Exercise graph exhaustion with a controlled clock instead of requiring
    // positive discovery to fail for five seconds on every machine.
    let elapsedMs = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      const current = elapsedMs;
      elapsedMs += 250;
      return current;
    });

    let result;
    try {
      result = await runProofSearchPass(query, {
        maxDiscoveredStates: 100_000,
        timeBudgetMs: 5_000,
        fastWitness: false,
      });
    } finally {
      clock.mockRestore();
    }

    expect(result).toMatchObject({ status: 'non-result', reason: 'time-budget', pass: { timeBudgetMs: 5000 } });
    if (result.status !== 'non-result' || result.checkpoint === null) throw new Error('A time cutoff must preserve a non-result checkpoint.');
    expect(result.pass.elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(result.pass.processedEdgeCount).toBeGreaterThan(0);
    expect(result.pass.totalDiscoveredStateCount).toBeGreaterThan(1);
    expect(result.pass.totalDiscoveredStateCount).toBeLessThan(100_000);
    expect(validateProofSearchCheckpoint(result.checkpoint)).toMatchObject({ status: 'valid' });
    expect(await runProofSearchPass(query, {
      checkpoint: result.checkpoint,
      maxDiscoveredStates: 1,
      fastWitness: false,
    })).toMatchObject({ status: 'non-result', reason: 'state-budget', checkpointDisposition: 'resumed' });
  });

  it('keeps the searched winner independent from counter-99 draw thresholds', async () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '7k/8/6K1/5Q2/8/8/8/8 w - - 99 1',
      intendedColor: 'w',
    });

    const result = await runProofSearchPass(query);

    expect(result).toMatchObject({ status: 'accepted', conclusion: 'mate-reachable', evidence: { kind: 'mate-witness' } });
  });

  it('rejects stale identity, parent, edge, and version checkpoint data before resuming', async () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
    });
    const partial = await runProofSearchPass(query, { maxDiscoveredStates: 3 });
    if (partial.status !== 'non-result' || partial.checkpoint === null) throw new Error('The fixture must be partial.');
    const checkpoint = partial.checkpoint;
    const invalidIdentity: unknown = { ...structuredClone(checkpoint), queryIdentity: 'stale-query-identity' };
    const invalidVersion: unknown = {
      ...structuredClone(checkpoint),
      searchVersion: 'kha31-cooperative-search/1',
      versions: { ...checkpoint.versions, searchVersion: 'kha31-cooperative-search/1' },
    };
    const invalidParent = structuredClone(checkpoint) as unknown as {
      parentRecords: Array<{ parentStateKey: string | null }>;
    };
    const rootParent = invalidParent.parentRecords[0];
    if (!rootParent) throw new Error('The checkpoint root parent is missing.');
    rootParent.parentStateKey = 'orphan-state';
    const invalidEdge = structuredClone(checkpoint) as unknown as {
      stateRecords: Array<{ successors: unknown[] }>;
    };
    invalidEdge.stateRecords[0]?.successors.pop();
    const duplicateState = {
      ...structuredClone(checkpoint),
      stateRecords: [...checkpoint.stateRecords, structuredClone(checkpoint.stateRecords[0])],
    };
    const missingState = {
      ...structuredClone(checkpoint),
      stateRecords: checkpoint.stateRecords.slice(0, -1),
    };
    const changedQuery = createDeadnessQuery({
      ...scope,
      positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K b - - 0 1',
    });

    expect(validateProofSearchCheckpoint(invalidIdentity)).toMatchObject({ status: 'restart-required' });
    expect(validateProofSearchCheckpoint(invalidVersion)).toMatchObject({ status: 'restart-required', reason: 'incompatible-checkpoint' });
    expect(validateProofSearchCheckpoint(invalidParent)).toMatchObject({ status: 'restart-required', reason: 'corrupt-checkpoint' });
    expect(validateProofSearchCheckpoint(invalidEdge)).toMatchObject({ status: 'restart-required', reason: 'corrupt-checkpoint' });
    expect(validateProofSearchCheckpoint(duplicateState)).toMatchObject({ status: 'restart-required', reason: 'corrupt-checkpoint' });
    expect(validateProofSearchCheckpoint(missingState)).toMatchObject({ status: 'restart-required', reason: 'corrupt-checkpoint' });
    const mismatch = await runProofSearchPass(changedQuery, { checkpoint });
    expect(mismatch).toMatchObject({ status: 'non-result', reason: 'invalid-checkpoint', checkpointDisposition: 'restarted' });
  });
});
