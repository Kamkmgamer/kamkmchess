import { describe, expect, it } from 'vitest';
import { applyCoordinateMove, parsePosition } from '../rules/index.js';
import {
  MAX_FORMAT_CORRECTIONS,
  MAX_ILLEGAL_MOVE_ATTEMPTS,
  acceptsReply,
  applyTurnRecoveryEvent,
  classifyCompletedAnswer,
  createFencedReply,
  createTurnBudgets,
  decideCompletedAnswer,
  decideModelTurn,
  explainIllegalMove,
  markReplyHandled,
} from './index.js';
import type { TurnBudgetsV1, TurnReplyFence } from './index.js';

const INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const WHITE_KING_IN_CHECK = '4k3/8/8/8/8/8/r7/4K3 w - - 0 1';
const CASTLING_READY = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
const EN_PASSANT_READY = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2';
const PROMOTION_READY = '4k3/6P1/8/8/8/8/8/4K3 w - - 0 1';

function answer(text: string, fen: string) {
  return { answerText: text, position: parsePosition(fen) };
}

function decide(budgets: TurnBudgetsV1, text: string, fen: string, modelConfigurationIdentity: string | null = 'model-a') {
  return decideCompletedAnswer({
    budgets,
    answer: answer(text, fen),
    position: parsePosition(fen),
    modelConfigurationIdentity,
  });
}

describe('model turn budgets', () => {
  it('[MOV-04, RUL-01] accepts a legal move and resets the next turn budgets', () => {
    const spent: TurnBudgetsV1 = {
      ...createTurnBudgets(),
      illegalMoveAttempts: 2,
      formatCorrections: 1,
      manualRetries: 1,
    };
    const decision = decide(spent, '{"move":"e2e4"}', INITIAL);

    expect(decision.kind).toBe('accepted-move');
    if (decision.kind !== 'accepted-move') throw new Error('expected an accepted move');
    expect(decision.transition.position.fen).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    );
    expect(decision.budgets).toEqual(createTurnBudgets());
  });

  it('[MOV-04] applies castling, en passant and underpromotion through the rules adapter', () => {
    const castling = decide(createTurnBudgets(), '{"move":"e1g1"}', CASTLING_READY);
    const enPassant = decide(createTurnBudgets(), '{"move":"e5d6"}', EN_PASSANT_READY);
    const underpromotion = decide(createTurnBudgets(), '{"move":"g7g8n"}', PROMOTION_READY);

    expect(castling).toMatchObject({ kind: 'accepted-move', move: { from: 'e1', to: 'g1' } });
    expect(enPassant).toMatchObject({ kind: 'accepted-move', move: { from: 'e5', to: 'd6' } });
    expect(underpromotion).toMatchObject({ kind: 'accepted-move', move: { promotion: 'n' } });
    expect(
      applyCoordinateMove(parsePosition(PROMOTION_READY), { from: 'g7', to: 'g8', promotion: 'n' }).position.pieces,
    ).toContainEqual(expect.objectContaining({ square: 'g8', type: 'n' }));
  });

  it('[MOV-04] explains the specific violation without listing legal moves', () => {
    const decision = decide(createTurnBudgets(), '{"move":"e1e2"}', WHITE_KING_IN_CHECK);

    expect(decision.kind).toBe('illegal-attempt');
    if (decision.kind !== 'illegal-attempt') throw new Error('expected an illegal attempt');
    expect(decision.correction).toBe('e1e2 leaves your king in check. Please choose a legal move yourself.');
    expect(decision.record.violation.code).toBe('king-move-into-check');
    expect(explainIllegalMove(parsePosition(INITIAL), { from: 'e2', to: 'e5' }).code).toBe('not-legal-in-position');
    expect(explainIllegalMove(parsePosition(INITIAL), { from: 'e7', to: 'e5' }).code).toBe('wrong-side-piece');
    expect(explainIllegalMove(parsePosition(INITIAL), { from: 'd1', to: 'd1' }).code).toBe('same-square');
    expect(explainIllegalMove(parsePosition(INITIAL), { from: 'd2', to: 'd1' }).code).toBe('own-piece-on-target');
    expect(explainIllegalMove(parsePosition(INITIAL), { from: 'h8', to: 'h8' }).code).toBe('same-square');
    expect(explainIllegalMove(parsePosition('4k3/8/8/8/8/8/8/3RK3 w - - 0 1'), { from: 'a5', to: 'a6' }).code).toBe(
      'no-piece-at-origin',
    );
    expect(explainIllegalMove(parsePosition('4k3/8/8/8/8/8/8/4K2R w K - 0 1'), { from: 'e1', to: 'c1' }).code).toBe(
      'castling-not-allowed',
    );
  });

  it('[MOV-04] loses on exactly the fourth illegal attempt and keeps every record', () => {
    let budgets = createTurnBudgets();
    const identities = ['model-a', 'model-a', 'model-b', 'model-c'];
    for (let attempt = 0; attempt < MAX_ILLEGAL_MOVE_ATTEMPTS; attempt += 1) {
      const decision = decide(budgets, '{"move":"e2e5"}', INITIAL, identities[attempt] ?? null);
      expect(decision.kind).toBe('illegal-attempt');
      if (decision.kind !== 'illegal-attempt') throw new Error('expected an illegal attempt');
      expect(decision.attempt).toBe(attempt + 1);
      expect(decision.loss).toStrictEqual(attempt + 1 === MAX_ILLEGAL_MOVE_ATTEMPTS ? { winner: 'human', reason: 'illegal-move' } : null);
      budgets = decision.budgets;
    }

    expect(budgets.illegalMoveAttempts).toBe(MAX_ILLEGAL_MOVE_ATTEMPTS);
    expect(budgets.attemptRecords.map((record) => record.modelConfigurationIdentity)).toEqual(identities);
    const fifth = decide(budgets, '{"move":"e2e5"}', INITIAL);
    expect(fifth).toMatchObject({ kind: 'illegal-attempt', loss: { winner: 'human', reason: 'illegal-move' } });
  });

  it('[MOV-05] spends at most three automatic formatting corrections and then pauses', () => {
    let budgets = createTurnBudgets();
    for (let spent = 1; spent <= MAX_FORMAT_CORRECTIONS; spent += 1) {
      const decision = decide(budgets, 'I think about the position.', INITIAL);
      expect(decision).toMatchObject({ kind: 'format-correction', automatic: true, pause: null });
      if (decision.kind !== 'format-correction') throw new Error('expected a format correction');
      expect(decision.formatCorrectionsRemaining).toBe(MAX_FORMAT_CORRECTIONS - spent);
      budgets = decision.budgets;
    }

    const exhausted = decide(budgets, 'Still no move.', INITIAL);
    expect(exhausted).toMatchObject({
      kind: 'format-correction',
      automatic: false,
      pause: 'retry-or-switch',
      formatCorrectionsRemaining: 0,
    });
    if (exhausted.kind !== 'format-correction') throw new Error('expected a format correction');
    expect(exhausted.budgets.formatCorrections).toBe(MAX_FORMAT_CORRECTIONS);
    expect(exhausted.budgets.illegalMoveAttempts).toBe(0);
  });

  it('[MOV-05, MOV-04] keeps formatting and chess budgets independent', () => {
    const firstIllegal = decide(createTurnBudgets(), '{"move":"e2e5"}', INITIAL);
    if (firstIllegal.kind !== 'illegal-attempt') throw new Error('expected an illegal attempt');

    const formatting = decide(firstIllegal.budgets, 'no command here', INITIAL);
    if (formatting.kind !== 'format-correction') throw new Error('expected a format correction');
    expect(formatting.budgets.illegalMoveAttempts).toBe(1);
    expect(formatting.budgets.formatCorrections).toBe(1);

    const recovered = decide(formatting.budgets, '{"move":"e2e4"}', INITIAL);
    if (recovered.kind !== 'accepted-move') throw new Error('expected an accepted move');
    expect(recovered.budgets).toEqual(createTurnBudgets());
  });

  it('[MOV-05, MOV-07] classifies a recovered illegal move as a chess attempt only', () => {
    const formatting = decide(createTurnBudgets(), 'no command here', INITIAL);
    if (formatting.kind !== 'format-correction') throw new Error('expected a format correction');
    const illegal = decide(formatting.budgets, '{"move":"e2e5"}', INITIAL);

    expect(illegal.kind).toBe('illegal-attempt');
    if (illegal.kind !== 'illegal-attempt') throw new Error('expected an illegal attempt');
    expect(illegal.budgets.formatCorrections).toBe(1);
    expect(illegal.budgets.illegalMoveAttempts).toBe(1);
  });

  it('[MOV-05] answers a missing promotion with a clarification, not an illegal attempt', () => {
    const decision = decide(createTurnBudgets(), '{"move":"g7g8"}', PROMOTION_READY);

    expect(decision).toMatchObject({ kind: 'format-correction', reason: 'missing-promotion' });
    if (decision.kind !== 'format-correction') throw new Error('expected a format correction');
    expect(decision.correction).toContain('q, r, b or n');
    expect(decision.budgets.illegalMoveAttempts).toBe(0);
    expect(decision.budgets.formatCorrections).toBe(1);
  });

  it('[MOV-06] turns an explicit refusal into an immediate model loss', () => {
    const budgets: TurnBudgetsV1 = { ...createTurnBudgets(), illegalMoveAttempts: 3, formatCorrections: 3 };
    const jsonResignation = decide(budgets, '{"resign":true}', INITIAL);
    const textResignation = decide(budgets, 'I resign.', INITIAL);

    expect(jsonResignation).toMatchObject({
      kind: 'model-resignation',
      loss: { winner: 'human', reason: 'resignation' },
    });
    expect(textResignation).toMatchObject({ kind: 'model-resignation' });
    if (jsonResignation.kind !== 'model-resignation') throw new Error('expected a resignation');
    expect(jsonResignation.budgets).toEqual(budgets);
  });

  it('[MOV-06] spends no correction trying to reverse a refusal', () => {
    const refusal = decide(createTurnBudgets(), '{"resign":true}', INITIAL);
    if (refusal.kind !== 'model-resignation') throw new Error('expected a resignation');
    expect(refusal.budgets.formatCorrections).toBe(0);
    expect(refusal.budgets.illegalMoveAttempts).toBe(0);
  });

  it('[MOV-07] spends no attempt on a technical interruption and keeps the clock running', () => {
    const spent: TurnBudgetsV1 = { ...createTurnBudgets(), illegalMoveAttempts: 2, formatCorrections: 1 };
    const outcome = applyTurnRecoveryEvent(spent, { kind: 'technical-interruption', retryAfterSeconds: 30 });

    expect(outcome).toEqual({
      kind: 'technical-interruption',
      budgets: spent,
      clearsPause: true,
      retryAfterSeconds: 30,
    });
  });

  it('[MOV-05, MOV-07] authorizes exactly one manual retry without refilling the budget', () => {
    const spent: TurnBudgetsV1 = { ...createTurnBudgets(), formatCorrections: 3, illegalMoveAttempts: 2 };
    const retry = applyTurnRecoveryEvent(spent, { kind: 'manual-retry' });

    if (retry.kind !== 'manual-retry') throw new Error('expected a manual retry');
    expect(retry.budgets.manualRetries).toBe(1);
    expect(retry.budgets.formatCorrections).toBe(3);
    expect(retry.budgets.illegalMoveAttempts).toBe(2);

    const afterRetry = decide(retry.budgets, '{"move":"e2e5"}', INITIAL);
    if (afterRetry.kind !== 'illegal-attempt') throw new Error('expected an illegal attempt');
    expect(afterRetry.attempt).toBe(3);
    const stillPaused = decide(afterRetry.budgets, 'no command here', INITIAL);
    expect(stillPaused).toMatchObject({ automatic: false, pause: 'retry-or-switch' });
  });

  it('[MOV-05] preserves spent turn budgets across an ordinary model switch', () => {
    const spent: TurnBudgetsV1 = { ...createTurnBudgets(), illegalMoveAttempts: 3, formatCorrections: 2 };
    const switched = applyTurnRecoveryEvent(spent, { kind: 'model-switch', modelConfigurationIdentity: 'model-b' });

    expect(switched).toEqual({
      kind: 'model-switch',
      modelConfigurationIdentity: 'model-b',
      budgets: spent,
      clearsPause: true,
    });
    const fourth = decide(switched.budgets, '{"move":"e2e5"}', INITIAL, 'model-b');
    expect(fourth).toMatchObject({ kind: 'illegal-attempt', attempt: 4, loss: { winner: 'human', reason: 'illegal-move' } });
    if (fourth.kind !== 'illegal-attempt') throw new Error('expected an illegal attempt');
    expect(fourth.record.modelConfigurationIdentity).toBe('model-b');
  });

  it('[MOV-07] spends no attempt when Stop, expiry, or a stale reply fences a turn', () => {
    const spent: TurnBudgetsV1 = { ...createTurnBudgets(), illegalMoveAttempts: 1, formatCorrections: 1, manualRetries: 1 };

    for (const event of [
      { kind: 'stop-request' },
      { kind: 'clock-expired' },
      { kind: 'stale-reply' },
    ] as const) {
      const outcome = applyTurnRecoveryEvent(spent, event);
      expect(outcome).toEqual({ kind: 'fenced', budgets: spent, clearsPause: false });
    }
  });

  it('[MOV-04, MOV-07] interleaves illegal, format, technical and switch events without leaking counts', () => {
    let budgets = createTurnBudgets();
    budgets = decide(budgets, 'no command', INITIAL).budgets;
    budgets = decide(budgets, '{"move":"e2e5"}', INITIAL).budgets;
    budgets = applyTurnRecoveryEvent(budgets, { kind: 'technical-interruption' }).budgets;
    budgets = decide(budgets, 'still nothing', INITIAL).budgets;
    budgets = applyTurnRecoveryEvent(budgets, { kind: 'model-switch', modelConfigurationIdentity: 'model-b' }).budgets;
    budgets = applyTurnRecoveryEvent(budgets, { kind: 'manual-retry' }).budgets;

    expect(budgets).toMatchObject({
      illegalMoveAttempts: 1,
      formatCorrections: 2,
      manualRetries: 1,
    });
    const accepted = decide(budgets, '{"move":"e2e4","plan":"develop"}', INITIAL, 'model-b');
    if (accepted.kind !== 'accepted-move') throw new Error('expected an accepted move');
    expect(accepted.transition.movingPiece).toMatchObject({ square: 'e2', type: 'p' });
  });

  it('[MOV-04] never reclassifies a move as legal after the position advanced', () => {
    const classification = classifyCompletedAnswer(answer('{"move":"e2e4"}', INITIAL));
    if (classification.kind !== 'move') throw new Error('expected a move declaration');
    const advanced = parsePosition('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    const decision = decideModelTurn({
      budgets: createTurnBudgets(),
      position: advanced,
      classification,
      modelConfigurationIdentity: 'model-a',
    });

    expect(decision).toMatchObject({
      kind: 'illegal-attempt',
      record: { violation: { code: 'no-piece-at-origin' } },
    });
  });
});

describe('turn reply fencing', () => {
  const turn: TurnReplyFence = {
    gameId: 'game-1',
    segmentId: 'segment-1',
    side: 'black',
    positionRevision: 4,
    requestGeneration: 7,
    ownershipEpoch: 2,
  };

  it('[MOV-08] accepts an unhandled reply once and refuses it afterwards', () => {
    const reply = createFencedReply(turn);

    expect(acceptsReply(turn, reply)).toBe(true);
    expect(acceptsReply(turn, markReplyHandled(reply))).toBe(false);
  });

  it('[MOV-08] refuses a superseded, stale, or foreign-ownership reply', () => {
    const samePositionLaterGeneration = createFencedReply({ ...turn, requestGeneration: 8 });
    const earlierPosition = createFencedReply({ ...turn, positionRevision: 3 });
    const otherSegment = createFencedReply({ ...turn, segmentId: 'segment-2' });
    const newOwner = createFencedReply({ ...turn, ownershipEpoch: 3 });
    const otherGame = createFencedReply({ ...turn, gameId: 'game-2' });

    expect(acceptsReply(turn, samePositionLaterGeneration)).toBe(false);
    expect(acceptsReply(turn, earlierPosition)).toBe(false);
    expect(acceptsReply(turn, otherSegment)).toBe(false);
    expect(acceptsReply(turn, newOwner)).toBe(false);
    expect(acceptsReply(turn, otherGame)).toBe(false);
  });

  it('[MOV-08] refuses a duplicate reply of an accepted position', () => {
    const reply = createFencedReply(turn);
    const handled = markReplyHandled(reply);

    expect(acceptsReply(turn, handled)).toBe(false);
    expect(acceptsReply(turn, createFencedReply(turn))).toBe(true);
  });
});