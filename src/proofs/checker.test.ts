import { describe, expect, it } from 'vitest';
import lockedPawnWallCertificateRaw from './fixtures/locked-pawn-wall-certificate.json?raw';
import researchedPositiveWitnessesRaw from './fixtures/researched-positive-witnesses.json?raw';
import { applyCoordinateMove, legalMoves, parsePosition } from '../rules/index.js';
import {
  canonicalProofStateKey,
  checkProofEvidence,
  createDeadnessQuery,
  createMatingReachabilityQuery,
  createTimeoutMatingQuery,
  PROOF_CHECKER_VERSION,
  RULES_ADAPTER_VERSION,
  type ProofQuery,
} from './index.js';

const scope = {
  gameId: 'game-17',
  segmentId: 'segment-4',
  positionRevision: '28',
  analysisGeneration: '6',
  ownershipEpoch: '3',
};

function makeWitness(query: ProofQuery, intendedColor: 'w' | 'b', uci: readonly string[]) {
  return {
    schemaVersion: 1,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    kind: 'mate-witness',
    queryIdentity: query.queryIdentity,
    intendedColor,
    moves: uci.map((move) => ({
      from: move.slice(0, 2),
      to: move.slice(2, 4),
      ...(move.length === 5 ? { promotion: move[4] } : {}),
    })),
  };
}

const forcedCycleFen = 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1';
const forcedCycle = {
  root: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - -',
  nodes: [
    {
      state: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - -',
      successors: [{ move: { from: 'h1', to: 'g1' }, target: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5BK1 b - -' }],
    },
    {
      state: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5BK1 b - -',
      successors: [{ move: { from: 'a8', to: 'b8' }, target: '1kb5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5BK1 w - -' }],
    },
    {
      state: '1kb5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5BK1 w - -',
      successors: [{ move: { from: 'g1', to: 'h1' }, target: '1kb5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K b - -' }],
    },
    {
      state: '1kb5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K b - -',
      successors: [{ move: { from: 'b8', to: 'a8' }, target: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - -' }],
    },
  ],
};

function makeClosedSet(
  query: ProofQuery,
  certificate: { readonly root: string; readonly nodes: readonly unknown[] } = forcedCycle,
) {
  return {
    schemaVersion: 1,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    kind: 'closed-successor-set',
    queryIdentity: query.queryIdentity,
    ...certificate,
  };
}

interface ResearchedWitnessFixture {
  readonly fen: string;
  readonly intendedColor: 'w' | 'b';
  readonly moves: readonly string[];
}

const researchedPositiveWitnesses = JSON.parse(researchedPositiveWitnessesRaw) as Record<
  string,
  ResearchedWitnessFixture
>;

describe('[ADJ-01, ADJ-02, ADJ-03, ADJ-09] proof checker', () => {
  it('accepts a checked witness that finishes in intended-color checkmate', () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      intendedColor: 'w',
    });

    expect(checkProofEvidence(query, makeWitness(query, 'w', ['d6f7']))).toMatchObject({
      status: 'accepted',
      conclusion: 'mate-reachable',
    });
  });

  it('replays researched rook-support, bare-king/rook, asymmetric, two-knight, and promotion witnesses', () => {
    for (const [name, fixture] of Object.entries(researchedPositiveWitnesses)) {
      const query = createMatingReachabilityQuery({
        ...scope,
        positionFen: fixture.fen,
        intendedColor: fixture.intendedColor,
      });
      const result = checkProofEvidence(query, makeWitness(query, fixture.intendedColor, fixture.moves));

      expect(result, `${name}: ${JSON.stringify(result)}`).toMatchObject({ status: 'accepted', conclusion: 'mate-reachable' });
    }
  });

  it('maps asymmetric mirror witnesses to the opponent-only timeout query', () => {
    const original = researchedPositiveWitnesses.asymmetricWallWhite;
    const mirror = researchedPositiveWitnesses.mirroredAsymmetricWallBlack;
    if (original === undefined || mirror === undefined) throw new Error('A checked fixture is missing.');

    const whiteCanMate = createTimeoutMatingQuery({
      ...scope,
      positionFen: original.fen,
      expiredColor: 'b',
    });
    const blackCanMate = createTimeoutMatingQuery({
      ...scope,
      positionFen: mirror.fen,
      expiredColor: 'w',
    });

    expect(checkProofEvidence(whiteCanMate, makeWitness(whiteCanMate, 'w', original.moves)))
      .toMatchObject({ status: 'accepted', conclusion: 'opponent-can-mate' });
    expect(checkProofEvidence(blackCanMate, makeWitness(blackCanMate, 'b', mirror.moves)))
      .toMatchObject({ status: 'accepted', conclusion: 'opponent-can-mate' });
  });

  it('accepts an empty witness only when the root already is intended-color checkmate', () => {
    const checkmatedRoot = createMatingReachabilityQuery({
      ...scope,
      positionFen: '6rk/5N2/7K/8/8/8/8/8 b - - 1 1',
      intendedColor: 'w',
    });
    const liveRoot = createMatingReachabilityQuery({
      ...scope,
      positionFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      intendedColor: 'w',
    });

    expect(checkProofEvidence(checkmatedRoot, makeWitness(checkmatedRoot, 'w', []))).toMatchObject({
      status: 'accepted',
      conclusion: 'mate-reachable',
    });
    expect(checkProofEvidence(liveRoot, makeWitness(liveRoot, 'w', []))).toMatchObject({ status: 'rejected' });
  });

  it('rejects illegal, partial, wrong-color, and stale positive evidence', () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '4k3/8/8/8/8/8/8/R3K3 b - - 0 1',
      intendedColor: 'w',
    });
    const complete = makeWitness(query, 'w', [
      'e8d7', 'a1b1', 'd7c6', 'b1a1', 'c6b7', 'a1b1', 'b7a8', 'e1d2', 'a8a7', 'd2c3',
      'a7a6', 'c3b4', 'a6a7', 'b1c1', 'a7a8', 'b4a5', 'a8b8', 'a5a6', 'b8a8', 'c1c8',
    ]);

    expect(checkProofEvidence(query, makeWitness(query, 'w', ['a1a8']))).toMatchObject({ status: 'rejected' });
    expect(checkProofEvidence(query, makeWitness(query, 'w', ['e8d7']))).toMatchObject({ status: 'rejected' });
    expect(checkProofEvidence(query, makeWitness(query, 'b', complete.moves.map((move) => `${move.from}${move.to}`))))
      .toMatchObject({ status: 'rejected' });
    expect(checkProofEvidence(query, { ...complete, queryIdentity: 'stale-query-identity' })).toMatchObject({ status: 'rejected' });
  });

  it('accepts the reviewed four-state forced cycle only after exact edge regeneration', () => {
    const query = createDeadnessQuery({ ...scope, positionFen: forcedCycleFen });

    expect(checkProofEvidence(query, makeClosedSet(query))).toMatchObject({ status: 'accepted', conclusion: 'dead' });
    const omittedEdge = structuredClone(forcedCycle);
    omittedEdge.nodes[0]?.successors.pop();
    expect(checkProofEvidence(query, makeClosedSet(query, omittedEdge))).toMatchObject({ status: 'rejected' });

    const truncatedStates = { ...forcedCycle, nodes: forcedCycle.nodes.slice(0, 3) };
    expect(checkProofEvidence(query, makeClosedSet(query, truncatedStates))).toMatchObject({ status: 'rejected' });
    const noncanonicalState = structuredClone(forcedCycle);
    if (noncanonicalState.nodes[0] !== undefined) noncanonicalState.nodes[0].state += ' 0 1';
    expect(checkProofEvidence(query, makeClosedSet(query, noncanonicalState))).toMatchObject({ status: 'rejected' });
  });

  it('applies a closed set to global, intended-color, and opponent-only queries', () => {
    const global = createDeadnessQuery({ ...scope, positionFen: forcedCycleFen });
    const white = createMatingReachabilityQuery({
      ...scope,
      positionFen: forcedCycleFen,
      intendedColor: 'w',
    });
    const black = createMatingReachabilityQuery({
      ...scope,
      positionFen: forcedCycleFen,
      intendedColor: 'b',
    });
    const whiteTimeout = createTimeoutMatingQuery({
      ...scope,
      positionFen: forcedCycleFen,
      expiredColor: 'b',
    });
    const blackTimeout = createTimeoutMatingQuery({
      ...scope,
      positionFen: forcedCycleFen,
      expiredColor: 'w',
    });

    expect(checkProofEvidence(global, makeClosedSet(global)))
      .toMatchObject({ status: 'accepted', conclusion: 'dead' });
    expect(checkProofEvidence(white, makeClosedSet(white)))
      .toMatchObject({ status: 'accepted', conclusion: 'mate-unreachable' });
    expect(checkProofEvidence(black, makeClosedSet(black)))
      .toMatchObject({ status: 'accepted', conclusion: 'mate-unreachable' });
    expect(checkProofEvidence(whiteTimeout, makeClosedSet(whiteTimeout)))
      .toMatchObject({ status: 'accepted', conclusion: 'opponent-cannot-mate' });
    expect(checkProofEvidence(blackTimeout, makeClosedSet(blackTimeout)))
      .toMatchObject({ status: 'accepted', conclusion: 'opponent-cannot-mate' });
  });

  it('accepts the independently recorded 768-state dead pawn wall closure', () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: '4k3/8/8/p1p1p1p1/PpPpPpPp/1P1P1P1P/8/4K3 w - - 0 1',
    });
    const certificate = JSON.parse(lockedPawnWallCertificateRaw) as {
      readonly root: string;
      readonly nodes: readonly unknown[];
    };

    expect(certificate.nodes).toHaveLength(768);
    expect(checkProofEvidence(query, makeClosedSet(query, certificate))).toMatchObject({
      status: 'accepted',
      conclusion: 'dead',
    });
  });

  it('rejects closure entries that omit castling, en-passant, or a promotion successor', () => {
    const cases = [
      {
        fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
        omitted: 'e1g1',
      },
      {
        fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2',
        omitted: 'e5d6',
      },
      {
        fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
        omitted: 'a7a8n',
      },
    ];

    for (const fixture of cases) {
      const query = createDeadnessQuery({ ...scope, positionFen: fixture.fen });
      const position = parsePosition(fixture.fen);
      const key = canonicalProofStateKey(position);
      const legal = legalMoves(position);
      expect(legal.map((move) => `${move.from}${move.to}${move.promotion ?? ''}`)).toContain(fixture.omitted);
      const successors = legal
        .filter((move) => `${move.from}${move.to}${move.promotion ?? ''}` !== fixture.omitted)
        .map((move) => ({
          move,
          target: canonicalProofStateKey(applyCoordinateMove(position, move).position),
        }));
      const partial = { root: key, nodes: [{ state: key, successors }] };

      expect(checkProofEvidence(query, makeClosedSet(query, partial))).toMatchObject({
        status: 'rejected',
        reason: 'closed-set-successor-count-mismatch',
      });
    }
  });

  it('returns a non-result for missing or incomplete evidence and never infers a negative', () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: '5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1',
    });

    expect(checkProofEvidence(query, undefined)).toMatchObject({ status: 'non-result' });
    expect(checkProofEvidence(query, makeClosedSet(query, { ...forcedCycle, root: 'wrong-root' })))
      .toMatchObject({ status: 'rejected' });
  });

  it('uses a witness for one side to disprove global deadness', () => {
    const query = createDeadnessQuery({
      ...scope,
      positionFen: '5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1',
    });

    expect(checkProofEvidence(query, makeWitness(query, 'w', [
      'f5e6', 'f6e7', 'e6d5', 'e7d6', 'd5e6', 'd6c7', 'f3e2', 'c7b8', 'e2d1', 'b8a8',
      'd1c2', 'f8d6', 'c2b3', 'd6c7', 'b3a4', 'c7b8', 'e6d5',
    ]))).toMatchObject({ status: 'accepted', conclusion: 'not-dead' });
  });

  it('queries only the opponent of the expired player', () => {
    const witnessMoves = ['d6f7'];
    const opponentCanMate = createTimeoutMatingQuery({
      ...scope,
      positionFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      expiredColor: 'b',
    });
    const expiredSideWouldMate = createTimeoutMatingQuery({
      ...scope,
      positionFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      expiredColor: 'w',
    });

    expect(opponentCanMate.predicate).toBe('timeout-opponent-mating');
    expect(checkProofEvidence(opponentCanMate, makeWitness(opponentCanMate, 'w', witnessMoves)))
      .toMatchObject({ status: 'accepted', conclusion: 'opponent-can-mate' });
    expect(checkProofEvidence(expiredSideWouldMate, makeWitness(expiredSideWouldMate, 'w', witnessMoves)))
      .toMatchObject({ status: 'rejected' });
  });

  it('leaves unproved asymmetric and bare-king negative sides unresolved', () => {
    const asymmetricBlack = createTimeoutMatingQuery({
      ...scope,
      positionFen: '5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1',
      expiredColor: 'w',
    });
    const mirroredWhite = createTimeoutMatingQuery({
      ...scope,
      positionFen: '8/8/5k2/2p1p1p1/1pP1PbP1/pP3K2/P7/5B2 b - - 0 1',
      expiredColor: 'b',
    });
    const bareKing = createMatingReachabilityQuery({
      ...scope,
      positionFen: '4k3/8/8/8/8/8/8/R3K3 b - - 0 1',
      intendedColor: 'b',
    });
    const twoKnightsBlack = createMatingReachabilityQuery({
      ...scope,
      positionFen: '7k/8/5K2/4NN2/8/8/8/8 w - - 0 1',
      intendedColor: 'b',
    });

    expect(checkProofEvidence(asymmetricBlack, undefined)).toMatchObject({ status: 'non-result' });
    expect(checkProofEvidence(mirroredWhite, undefined)).toMatchObject({ status: 'non-result' });
    expect(checkProofEvidence(bareKing, undefined)).toMatchObject({ status: 'non-result' });
    expect(checkProofEvidence(twoKnightsBlack, undefined)).toMatchObject({ status: 'non-result' });
  });

  it('checks the researched counter-99 witness without applying a hypothetical draw cutoff', () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '7k/8/8/8/8/8/8/KQ6 w - - 99 1',
      intendedColor: 'w',
    });
    const queryAtBlackFlag = createTimeoutMatingQuery({
      ...scope,
      positionFen: '7k/8/8/8/8/8/8/KQ6 b - - 99 1',
      expiredColor: 'b',
    });
    const whiteCounter99 = [
      'a1a2', 'h8g7', 'b1a1', 'g7f7', 'a1b1', 'f7e6', 'b1a1', 'e6d5', 'a1b1', 'd5c6',
      'b1a1', 'c6b7', 'a1b1', 'b7a8', 'a2a3', 'a8a7', 'a3a4', 'a7a8', 'a4b5', 'a8a7',
      'b5c6', 'a7a6', 'b1a1',
    ];
    const whiteMateAfterBlackMoves = [
      'h8g7', 'b1c1', 'g7f6', 'c1b1', 'f6e5', 'b1c1', 'e5d5', 'c1b1', 'd5c6', 'b1c1',
      'c6b7', 'c1b1', 'b7a8', 'a1a2', 'a8a7', 'a2a3', 'a7a6', 'a3a4', 'a6a7', 'b1a1',
      'a7a8', 'a4a5', 'a8b8', 'a5a6', 'b8a8', 'a1h8',
    ];

    expect(checkProofEvidence(query, makeWitness(query, 'w', whiteCounter99))).toMatchObject({
      status: 'accepted',
      conclusion: 'mate-reachable',
    });
    expect(checkProofEvidence(queryAtBlackFlag, makeWitness(queryAtBlackFlag, 'w', whiteMateAfterBlackMoves)))
      .toMatchObject({ status: 'accepted', conclusion: 'opponent-can-mate' });
  });

  it('checks the actual-threshold mate before any later draw interpretation', () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '7k/8/6K1/5Q2/8/8/8/8 w - - 99 1',
      intendedColor: 'w',
    });

    expect(checkProofEvidence(query, makeWitness(query, 'w', ['f5c8']))).toMatchObject({
      status: 'accepted',
      conclusion: 'mate-reachable',
    });
  });

  it('keeps complete query identity separate from the counter-free board key', () => {
    const base = parsePosition('7k/8/8/8/8/8/8/KQ6 w - - 0 1');
    const counter99 = parsePosition('7k/8/8/8/8/8/8/KQ6 w - - 99 10000');
    const firstQuery = createMatingReachabilityQuery({ ...scope, positionFen: base.fen, intendedColor: 'w' });
    const secondQuery = createMatingReachabilityQuery({ ...scope, positionFen: counter99.fen, intendedColor: 'w' });

    expect(canonicalProofStateKey(base)).toBe(canonicalProofStateKey(counter99));
    expect(firstQuery.queryIdentity).not.toBe(secondQuery.queryIdentity);
  });

  it('keeps rights and legally usable en-passant in canonical board keys', () => {
    const rights = parsePosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const noRights = parsePosition('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1');
    const ineffectiveEp = parsePosition('4k3/8/8/4p3/8/8/8/4K2R w K e6 0 2');
    const noEp = parsePosition('4k3/8/8/4p3/8/8/8/4K2R w K - 0 2');
    const usableEp = parsePosition('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    const noUsableEp = parsePosition('4k3/8/8/3pP3/8/8/8/4K3 w - - 0 2');
    const pinnedEp = parsePosition('k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    const pinnedNoEp = parsePosition('k3r3/8/8/3pP3/8/8/8/4K3 w - - 0 2');

    expect(canonicalProofStateKey(rights)).not.toBe(canonicalProofStateKey(noRights));
    expect(canonicalProofStateKey(ineffectiveEp)).toBe(canonicalProofStateKey(noEp));
    expect(canonicalProofStateKey(usableEp)).not.toBe(canonicalProofStateKey(noUsableEp));
    expect(canonicalProofStateKey(pinnedEp)).toBe(canonicalProofStateKey(pinnedNoEp));
  });

  it('does not apply a piece-count or four-digit counter cutoff', () => {
    const twentyOneOrigins = parsePosition('7k/8/8/NNNNN3/8/NNNNNNNN/8/KNNNNNNN w - - 0 1');
    const highCounters = parsePosition('1k6/8/8/NNNNNNNN/8/NNNNNNNN/8/4K3 w - - 10000 10000');
    const hazardQuery = createMatingReachabilityQuery({
      ...scope,
      positionFen: twentyOneOrigins.fen,
      intendedColor: 'w',
    });
    const counterQuery = createMatingReachabilityQuery({
      ...scope,
      positionFen: highCounters.fen,
      intendedColor: 'w',
    });

    expect(twentyOneOrigins.pieces.filter((piece) => piece.color === 'w')).toHaveLength(21);
    expect(hazardQuery.positionFen).toBe(twentyOneOrigins.fen);
    expect(checkProofEvidence(hazardQuery, undefined)).toMatchObject({ status: 'non-result' });
    expect(counterQuery.positionFen).toContain('10000 10000');
    expect(checkProofEvidence(counterQuery, undefined)).toMatchObject({ status: 'non-result' });
  });

  it('returns a non-result when a witness exceeds the checker traversal bound', () => {
    const query = createMatingReachabilityQuery({
      ...scope,
      positionFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      intendedColor: 'w',
    });
    const tooLong = makeWitness(query, 'w', Array.from({ length: 100_001 }, () => 'd6f7'));

    expect(checkProofEvidence(query, tooLong)).toMatchObject({ status: 'non-result' });
  });

  it('returns a non-result when a certificate exceeds the checker state bound', () => {
    const query = createDeadnessQuery({ ...scope, positionFen: forcedCycleFen });
    const tooManyStates = {
      root: forcedCycle.root,
      nodes: Array.from({ length: 10_001 }, () => ({ state: forcedCycle.root, successors: [] })),
    };

    expect(checkProofEvidence(query, makeClosedSet(query, tooManyStates))).toMatchObject({ status: 'non-result' });
  });
});
