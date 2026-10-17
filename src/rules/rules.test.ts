import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  applyCoordinateMove,
  createRepetitionLedger,
  IllegalMoveError,
  legalMoves,
  observeEndingFacts,
  parsePosition,
  PositionValidationError,
  recordPosition,
  repetitionCount,
  repetitionIdentity,
  RepetitionLedgerValidationError,
  restoreRepetitionLedger,
} from './index.js';

function issueFor(fen: string): PositionValidationError['issues'][number] {
  try {
    parsePosition(fen);
  } catch (error) {
    if (error instanceof PositionValidationError) {
      const issue = error.issues[0];
      if (issue !== undefined) return issue;
    }
    throw error;
  }
  throw new Error('Expected the FEN to be rejected.');
}

describe('[RUL-02, RUL-03] parsePosition', () => {
  it('accepts the orthodox initial position', () => {
    const position = parsePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

    expect(position.pieces).toHaveLength(32);
    expect(position.castlingRights).toBe('KQkq');
  });

  it('keeps large decimal counters and custom material without narrowing the position', () => {
    const fen =
      '1k6/8/8/8/NNNNNNNN/8/NNNNNNNN/4K3 w - - 999999999999999999999 900719925474099312345';

    const position = parsePosition(fen);

    expect(position.halfmoveClock).toBe('999999999999999999999');
    expect(position.fullmoveNumber).toBe('900719925474099312345');
    expect(position.pieces).toHaveLength(18);
    expect(position.fen).toBe(fen);
    expect(Object.isFrozen(position)).toBe(true);
    expect(Object.isFrozen(position.pieces)).toBe(true);
  });

  it('preserves declared valid castling rights and an ineffective en-passant target', () => {
    const fen = '4k3/8/8/4p3/8/8/8/4K2R w K e6 0 2';

    const position = parsePosition(fen);

    expect(position.fen).toBe(fen);
    expect(position.castlingRights).toBe('K');
    expect(position.enPassantSquare).toBe('e6');
  });

  it('preserves the imported decimal spelling as well as its exact value', () => {
    const fen = '4k3/8/8/8/8/8/8/4K3 w - - 0000 0001';
    const position = parsePosition(fen);

    expect(position.halfmoveClock).toBe('0000');
    expect(position.fullmoveNumber).toBe('0001');
    expect(position.fen).toBe(fen);
  });

  it('keeps authoritative FEN apart from chess.js counter rounding and EP normalization', () => {
    const counters = '4k3/8/8/8/8/8/8/R3K2R w KQ - 99999999999999999999 12345678901234567890';
    const ineffectiveEp = '4k3/8/8/4p3/8/8/8/R3K1N1 w - e6 0 9';

    expect(new Chess(counters).fen()).toBe(
      '4k3/8/8/8/8/8/8/R3K2R w KQ - 100000000000000000000 12345678901234567000',
    );
    expect(parsePosition(counters).fen).toBe(counters);
    expect(new Chess(ineffectiveEp).fen()).toBe('4k3/8/8/4p3/8/8/8/R3K1N1 w - - 0 9');
    expect(parsePosition(ineffectiveEp).fen).toBe(ineffectiveEp);
  });

  it('rejects malformed fields with a field-specific issue', () => {
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 w - - 0').field).toBe('fen');
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 w - - 1.5 1').field).toBe('halfmoveClock');
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 w K - 0 1')).toMatchObject({
      field: 'castlingRights',
      square: 'h1',
    });
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 w - e6 0 2')).toMatchObject({
      field: 'enPassantSquare',
      square: 'e5',
    });
    expect(issueFor('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1')).toMatchObject({
      field: 'consistency',
      code: 'nonmoving-king-in-check',
      square: 'e8',
    });
    expect(issueFor('8/8/8/8/8/8/4k3/4K3 w - - 0 1').code).toBe('adjacent-kings');
  });

  it('validates each FEN setting and current en-passant consistency', () => {
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 x - - 0 1').field).toBe('sideToMove');
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 w KK - 0 1').field).toBe('castlingRights');
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 w - e3 0 2').field).toBe('enPassantSquare');
    expect(issueFor('4k3/8/4N3/4p3/8/8/8/4K3 w - e6 0 2').code).toBe('occupied-target');
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 w - e6 0 2').code).toBe('missing-pushed-pawn');
    expect(issueFor('4k3/4n3/8/4p3/8/8/8/4K3 w - e6 0 2').code).toBe('occupied-origin');
    expect(issueFor('4k3/8/8/4p3/8/8/8/4K3 w - e6 1 2').field).toBe('halfmoveClock');
    expect(issueFor('4k3/8/8/4p3/8/8/8/4K3 w - e6 0 1').field).toBe('fullmoveNumber');
    expect(issueFor('4k3/8/8/8/8/8/8/4K3 w - - 0 0').field).toBe('fullmoveNumber');
    expect(issueFor('4k3/8/8/8/8/8/8/P3K3 w - - 0 1').code).toBe('pawn-back-rank');
    expect(issueFor('4k3/8/8/8/8/8/8/K3K3 w - - 0 1').code).toBe('white-king-count');
    expect(issueFor('8/8/8/8/8/8/8/4K3 w - - 0 1').code).toBe('black-king-count');
    expect(issueFor('4k3/8/8/8/8/8/8/3K3R w K - 0 1').code).toBe('king-not-home');
  });

  it('accepts a side-to-move check without requiring normal-start reachability', () => {
    const position = parsePosition('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1');

    expect(position.sideToMove).toBe('w');
  });
});

describe('[RUL-01, RUL-03] applyCoordinateMove', () => {
  it('applies castling and preserves the remaining opponent rights', () => {
    const position = parsePosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');

    const transition = applyCoordinateMove(position, { from: 'e1', to: 'g1' });

    expect(transition.position.fen).toBe('r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
    expect(transition.isCapture).toBe(false);
  });

  it('supports queenside castling and both black castling directions', () => {
    const whiteQueenside = parsePosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const blackKingside = parsePosition('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');

    expect(applyCoordinateMove(whiteQueenside, { from: 'e1', to: 'c1' }).position.fen).toBe(
      'r3k2r/8/8/8/8/8/8/2KR3R b kq - 1 1',
    );
    expect(applyCoordinateMove(blackKingside, { from: 'e8', to: 'g8' }).position.fen).toBe(
      'r4rk1/8/8/8/8/8/8/R3K2R w KQ - 1 2',
    );
    expect(applyCoordinateMove(blackKingside, { from: 'e8', to: 'c8' }).position.fen).toBe(
      '2kr3r/8/8/8/8/8/8/R3K2R w KQ - 1 2',
    );
  });

  it('rejects castling through check and moves that expose the moving side king', () => {
    const throughCheck = parsePosition('r3kr1r/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    const pinnedRook = parsePosition('4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1');
    const wrongSide = parsePosition('4k1n1/8/8/8/8/8/8/R3K1N1 w - - 0 1');

    expect(() => applyCoordinateMove(throughCheck, { from: 'e1', to: 'g1' })).toThrow(IllegalMoveError);
    expect(() => applyCoordinateMove(pinnedRook, { from: 'e2', to: 'f2' })).toThrow(IllegalMoveError);
    expect(() => applyCoordinateMove(wrongSide, { from: 'g8', to: 'f6' })).toThrow(IllegalMoveError);
  });

  it('applies en passant as a capture and clears the target', () => {
    const position = parsePosition('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');

    const transition = applyCoordinateMove(position, { from: 'e5', to: 'd6' });

    expect(transition.position.fen).toBe('4k3/8/3P4/8/8/8/8/4K3 b - - 0 2');
    expect(transition.isCapture).toBe(true);
    expect(transition.capturedPiece).toMatchObject({ square: 'd5', type: 'p', color: 'b' });
  });

  it('rejects pinned en passant and removes a captured rook right', () => {
    const pinnedEnPassant = parsePosition('k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    const rookCapture = parsePosition('r3k2r/8/8/8/8/8/8/4K2R w k - 0 1');

    expect(() => applyCoordinateMove(pinnedEnPassant, { from: 'e5', to: 'd6' })).toThrow(IllegalMoveError);
    expect(legalMoves(pinnedEnPassant).some((move) => move.from === 'e5' && move.to === 'd6')).toBe(false);
    expect(applyCoordinateMove(rookCapture, { from: 'h1', to: 'h8' }).position.fen).toBe(
      'r3k2R/8/8/8/8/8/8/4K3 b - - 0 1',
    );
  });

  it('records an en-passant target after a double pawn move', () => {
    const position = parsePosition('4k3/8/8/8/8/8/P7/4K3 w - - 0 1');

    const transition = applyCoordinateMove(position, { from: 'a2', to: 'a4' });

    expect(transition.position.fen).toBe('4k3/8/8/8/P7/8/8/4K3 b - a3 0 1');
  });

  it.each(['q', 'r', 'b', 'n'] as const)('applies %s promotion', (promotion) => {
    const position = parsePosition('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');

    const transition = applyCoordinateMove(position, { from: 'a7', to: 'a8', promotion });

    expect(transition.position.fen).toBe(`${promotion.toUpperCase()}3k3/8/8/8/8/8/8/4K3 b - - 0 1`);
  });

  it('increments decimal counters exactly and updates only the rights that changed', () => {
    const position = parsePosition(
      '4k3/8/8/8/8/8/8/R3K2R w KQ - 99999999999999999999 12345678901234567890',
    );

    const transition = applyCoordinateMove(position, { from: 'a1', to: 'a2' });

    expect(transition.position.fen).toBe(
      '4k3/8/8/8/8/8/R7/4K2R b K - 100000000000000000000 12345678901234567890',
    );
  });

  it('increments the fullmove number exactly after Black moves', () => {
    const position = parsePosition('4k3/8/8/8/8/8/8/4K3 b - - 0000 900719925474099312345');

    const transition = applyCoordinateMove(position, { from: 'e8', to: 'e7' });

    expect(transition.position.fen).toBe('8/4k3/8/8/8/8/8/4K3 w - - 1 900719925474099312346');
  });

  it('resets the halfmove counter on pawn moves and captures', () => {
    const pawnMove = parsePosition('4k3/8/8/8/8/8/P7/4K3 w - - 99 7');
    const capture = parsePosition('4k3/8/8/8/8/8/r7/R3K3 w - - 99 7');

    expect(applyCoordinateMove(pawnMove, { from: 'a2', to: 'a3' }).position.halfmoveClock).toBe('0');
    expect(applyCoordinateMove(capture, { from: 'a1', to: 'a2' }).position.halfmoveClock).toBe('0');
  });

  it('requires an explicit promotion piece and never proposes a replacement move', () => {
    const position = parsePosition('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');

    expect(() => applyCoordinateMove(position, { from: 'a7', to: 'a8' })).toThrow(IllegalMoveError);
  });

  it('enumerates all four legal promotion choices for local proof analysis', () => {
    const position = parsePosition('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const promotions = legalMoves(position)
      .filter((move) => move.from === 'a7' && move.to === 'a8')
      .map((move) => move.promotion)
      .sort();

    expect(promotions).toEqual(['b', 'n', 'q', 'r']);
  });
});

describe('[RUL-05, RUL-06] repetition state', () => {
  it('uses exact placement, turn, castling rights, and only legally usable en passant', () => {
    const noEp = parsePosition('4k3/8/8/3pP3/8/8/8/4K3 w - - 0 2');
    const legalEp = parsePosition('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    const ineffectiveEp = parsePosition('4k3/8/8/4p3/8/8/8/R3K1N1 w - e6 0 9');
    const ineffectiveEpExpired = parsePosition('4k3/8/8/4p3/8/8/8/R3K1N1 w - - 0 9');
    const pinnedEp = parsePosition('k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    const pinnedEpExpired = parsePosition('k3r3/8/8/3pP3/8/8/8/4K3 w - - 0 2');

    expect(repetitionIdentity(legalEp)).not.toBe(repetitionIdentity(noEp));
    expect(repetitionIdentity(ineffectiveEp)).toBe(repetitionIdentity(ineffectiveEpExpired));
    expect(repetitionIdentity(pinnedEp)).toBe(repetitionIdentity(pinnedEpExpired));
  });

  it('includes castling rights and ignores counters in repetition identity', () => {
    const withRights = parsePosition('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    const withoutRights = parsePosition('4k3/8/8/8/8/8/8/R3K2R w - - 99 88');
    const changedCounters = parsePosition('4k3/8/8/8/8/8/8/R3K2R w KQ - 71 32');

    expect(repetitionIdentity(withRights)).not.toBe(repetitionIdentity(withoutRights));
    expect(repetitionIdentity(withRights)).toBe(repetitionIdentity(changedCounters));
  });

  it('counts the starting position and repeated positions, and restores the full ledger', () => {
    let position = parsePosition('4k1n1/8/8/8/8/8/8/R3K1N1 w - - 7 23');
    let ledger = createRepetitionLedger(position);
    let afterOneCycle: typeof ledger | undefined;
    const cycle = [
      { from: 'g1', to: 'f3' },
      { from: 'g8', to: 'f6' },
      { from: 'f3', to: 'g1' },
      { from: 'f6', to: 'g8' },
    ] as const;

    expect(repetitionCount(ledger, position)).toBe('1');
    for (let index = 0; index < 8; index += 1) {
      const move = cycle[index % cycle.length];
      if (move === undefined) throw new Error('Cycle move was not found.');
      position = applyCoordinateMove(position, move).position;
      ledger = recordPosition(ledger, position);
      if (index === 3) afterOneCycle = ledger;
    }

    expect(repetitionCount(ledger, position)).toBe('3');
    expect(afterOneCycle).toBeDefined();
    expect(afterOneCycle === undefined ? '0' : repetitionCount(afterOneCycle, position)).toBe('2');
    expect(observeEndingFacts(position, ledger).ending).toBe('threefold-repetition');
    const restored = restoreRepetitionLedger(JSON.parse(JSON.stringify(ledger)) as unknown);
    expect(repetitionCount(restored, position)).toBe('3');
    expect(restored.entries).toHaveLength(4);
  });

  it('counts imported ineffective en-passant positions as the same third occurrence', () => {
    let position = parsePosition('4k3/8/8/4p3/8/8/8/R3K1N1 w - e6 0 9');
    let ledger = createRepetitionLedger(position);
    const cycle = [
      { from: 'g1', to: 'f3' },
      { from: 'e8', to: 'f8' },
      { from: 'f3', to: 'g1' },
      { from: 'f8', to: 'e8' },
    ] as const;

    for (let index = 0; index < 8; index += 1) {
      const move = cycle[index % cycle.length];
      if (move === undefined) throw new Error('Cycle move was not found.');
      position = applyCoordinateMove(position, move).position;
      ledger = recordPosition(ledger, position);
    }

    expect(repetitionCount(ledger, position)).toBe('3');
    expect(observeEndingFacts(position, ledger).ending).toBe('threefold-repetition');
  });

  it('rejects a restored ledger with duplicate state identities', () => {
    const position = parsePosition('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    const identity = repetitionIdentity(position);

    expect(() =>
      restoreRepetitionLedger({
        version: 1,
        entries: [
          { identity, occurrences: '1' },
          { identity, occurrences: '2' },
        ],
      }),
    ).toThrow(RepetitionLedgerValidationError);
  });
});

describe('[RUL-05, RUL-07] observeEndingFacts', () => {
  it('gives checkmate precedence over the 100-halfmove threshold', () => {
    const position = parsePosition('7k/8/5KQ1/8/8/8/8/8 w - - 99 42');
    const ledger = createRepetitionLedger(position);
    const transition = applyCoordinateMove(position, { from: 'g6', to: 'g7' });
    const nextLedger = recordPosition(ledger, transition.position);

    expect(transition.position.fen).toBe('7k/6Q1/5K2/8/8/8/8/8 b - - 100 42');
    expect(observeEndingFacts(transition.position, nextLedger)).toMatchObject({
      checkmate: true,
      stalemate: false,
      hundredHalfmoves: true,
      ending: 'checkmate',
    });
  });

  it('reports 99 and 100 halfmove controls without generic deadness', () => {
    const at99 = parsePosition('4k3/8/8/8/8/8/8/R3K3 w - - 98 1');
    const at100 = parsePosition('4k3/8/8/8/8/8/8/R3K3 w - - 99 1');
    const after99 = applyCoordinateMove(at99, { from: 'a1', to: 'a2' }).position;
    const after100 = applyCoordinateMove(at100, { from: 'a1', to: 'a2' }).position;

    expect(observeEndingFacts(after99, recordPosition(createRepetitionLedger(at99), after99)).ending).toBe('none');
    const facts = observeEndingFacts(after100, recordPosition(createRepetitionLedger(at100), after100));
    expect(facts).toMatchObject({
      hundredHalfmoves: true,
      deadness: 'not-assessed',
      ending: 'hundred-halfmoves',
    });
    expect(legalMoves(after100).length).toBeGreaterThan(0);
    expect(applyCoordinateMove(after100, { from: 'e8', to: 'e7' }).position.fullmoveNumber).toBe('2');
  });

  it('distinguishes checkmate from stalemate', () => {
    const checkmate = parsePosition('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1');
    const stalemate = parsePosition('7k/5K2/6Q1/8/8/8/8/8 b - - 0 1');

    expect(observeEndingFacts(checkmate, createRepetitionLedger(checkmate)).ending).toBe('checkmate');
    expect(observeEndingFacts(stalemate, createRepetitionLedger(stalemate)).ending).toBe('stalemate');
  });
});
