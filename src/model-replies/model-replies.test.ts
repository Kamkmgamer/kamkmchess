import { describe, expect, it } from 'vitest';
import {
  createChatCompletionsDecoder,
  type ProtocolStreamResult,
} from '../providers/protocols/index.js';
import { parsePosition } from '../rules/index.js';
import {
  classifyCompletedReply,
  createInitialRecoveryBudgetState,
  decideRecoveryPolicy,
} from './index.js';

const INITIAL_POSITION = parsePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

function protocolReply(overrides: Partial<ProtocolStreamResult> = {}): ProtocolStreamResult {
  return {
    protocol: 'chat-completions',
    terminal: 'complete',
    content: 'answer',
    answerText: '{"move":"E2 E4","plan":"develop the pieces"}',
    reasoningText: '',
    planText: '',
    refusalText: '',
    usage: null,
    usageRecords: [],
    errors: [],
    incompleteDetails: [],
    toolRecords: [],
    otherChoices: [],
    unknownEvents: [],
    raw: { chunks: [], events: [] },
    ...overrides,
  };
}

describe('completed model reply classification', () => {
  it('normalizes a completed choice-zero JSON coordinate and retains its protocol source', () => {
    const source = protocolReply();

    const classification = classifyCompletedReply(source, INITIAL_POSITION);

    expect(classification).toMatchObject({
      version: 1,
      kind: 'move-proposal',
      move: { from: 'e2', to: 'e4' },
      notation: 'coordinate-json',
      source: {
        channel: 'answer',
        text: '{"move":"E2 E4","plan":"develop the pieces"}',
        protocolResult: source,
      },
    });
  });

  it('classifies the actual public Chat decoder result without re-reading other channels', () => {
    const decoder = createChatCompletionsDecoder({ httpStatus: 200 });
    decoder.push(new TextEncoder().encode([
      'data: {"choices":[{"index":0,"delta":{"content":"{\\"move\\":\\"e2e4\\"}"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')));
    const source = decoder.finish();

    expect(source.terminal).toBe('complete');
    const classification = classifyCompletedReply(source, INITIAL_POSITION);

    expect(classification).toMatchObject({
      kind: 'move-proposal',
      move: { from: 'e2', to: 'e4' },
      source: { protocolResult: source, answerText: '{"move":"e2e4"}' },
    });
  });

  it('does not treat an unterminated actual decoder result as a complete refusal', () => {
    const decoder = createChatCompletionsDecoder({ httpStatus: 200 });
    decoder.push(new TextEncoder().encode([
      'data: {"choices":[{"index":0,"delta":{"content":"I resign."},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    ].join('')));
    const source = decoder.finish();

    expect(source.terminal).toBe('truncated');
    expect(classifyCompletedReply(source, INITIAL_POSITION)).toMatchObject({
      kind: 'protocol-ineligible',
      cause: 'not-complete',
    });
  });

  it.each([
    ['castling is the king coordinate', 'e1g1', { from: 'e1', to: 'g1' }],
    ['en passant is the pawn coordinate', 'e5d6', { from: 'e5', to: 'd6' }],
    ['queen promotion suffix', 'a7a8q', { from: 'a7', to: 'a8', promotion: 'q' }],
    ['rook promotion suffix', 'a7a8r', { from: 'a7', to: 'a8', promotion: 'r' }],
    ['bishop promotion suffix', 'a7a8b', { from: 'a7', to: 'a8', promotion: 'b' }],
    ['underpromotion keeps its requested suffix', 'a7a8n', { from: 'a7', to: 'a8', promotion: 'n' }],
  ] as const)('keeps coordinate notation literal: %s', (_label, coordinate, move) => {
    const classification = classifyCompletedReply(
      protocolReply({ answerText: JSON.stringify({ move: coordinate }) }),
      INITIAL_POSITION,
    );

    expect(classification).toMatchObject({ kind: 'move-proposal', move, notation: 'coordinate-json' });
  });

  it('accepts one fenced JSON object and harmless extra fields', () => {
    const classification = classifyCompletedReply(
      protocolReply({ answerText: '```json\n{"move":"d2 d4","plan":"hold the center","extra":9}\n```' }),
      INITIAL_POSITION,
    );

    expect(classification).toMatchObject({
      kind: 'move-proposal',
      move: { from: 'd2', to: 'd4' },
      notation: 'fenced-coordinate-json',
    });
  });

  it('keeps code-fence text inside a harmless plan field out of fence detection', () => {
    const classification = classifyCompletedReply(
      protocolReply({ answerText: '{"move":"e2e4","plan":"```text``` is quoted notation"}' }),
      INITIAL_POSITION,
    );

    expect(classification).toMatchObject({ kind: 'move-proposal', move: { from: 'e2', to: 'e4' } });
  });

  it.each([
    ['final Move line', 'I have considered the position.\nFinal Move: `e2e4`.\n'],
    ['standalone coordinate', '`E2 E4`.'],
    ['parenthesized standalone coordinate', '(e2e4)!'],
    ['fenced standalone coordinate', '```\ne2e4\n```'],
  ])('accepts the documented fallback: %s', (_label, answerText) => {
    const classification = classifyCompletedReply(protocolReply({ answerText }), INITIAL_POSITION);

    expect(classification).toMatchObject({
      kind: 'move-proposal',
      move: { from: 'e2', to: 'e4' },
    });
  });

  it.each([
    ['conflicting duplicate move keys', '{"move":"e2e4","move":"d2d4"}', 'duplicate-json-key'],
    ['conflicting duplicate nested keys', '{"move":"e2e4","extra":{"value":1,"value":2}}', 'duplicate-json-key'],
    ['move and resignation together', '{"move":"e2e4","resign":true}', 'ambiguous-answer'],
    ['malformed JSON with a visible move', '{"move": "e2e4"', 'invalid-json'],
    ['competing explicit final moves', 'Final Move: e2e4\nFinal Move: d2d4', 'ambiguous-answer'],
    ['two choices after the final Move label', 'Final Move: e2e4 or d2d4', 'ambiguous-answer'],
    ['trailing comma in otherwise visible JSON', '{"move":"e2e4",}', 'invalid-json'],
    ['multiple code fences', '```json\n{"move":"e2e4"}\n```\n```\nextra\n```', 'invalid-code-fence'],
    ['duplicate key with identical spelling and value', '{"move":"e2e4","move":"e2e4"}', 'duplicate-json-key'],
    ['non-string plan', '{"move":"e2e4","plan":[]}', 'invalid-plan'],
    ['non-boolean resign flag', '{"resign":"true"}', 'invalid-resign-flag'],
    ['missing move field', '{"plan":"I could play e2e4"}', 'missing-move'],
  ] as const)('rejects ambiguous or malformed answers: %s', (_label, answerText, category) => {
    const classification = classifyCompletedReply(protocolReply({ answerText }), INITIAL_POSITION);

    expect(classification).toMatchObject({ kind: 'format-rejection', category });
  });

  it('asks for formatting correction when a current-side pawn promotion omits its suffix', () => {
    const promotionPosition = parsePosition('k7/4P3/8/8/8/8/8/7K w - - 0 1');
    const classification = classifyCompletedReply(
      protocolReply({ answerText: '{"move":"e7e8"}' }),
      promotionPosition,
    );

    expect(classification).toMatchObject({ kind: 'format-rejection', category: 'missing-promotion' });
  });

  it.each(['e7e5', 'e7f8'])('leaves other coordinate errors for controller legality validation: %s', (coordinate) => {
    const promotionPosition = parsePosition('k7/4P3/8/8/8/8/8/7K w - - 0 1');
    const classification = classifyCompletedReply(
      protocolReply({ answerText: JSON.stringify({ move: coordinate }) }),
      promotionPosition,
    );

    expect(classification).toMatchObject({ kind: 'move-proposal' });
  });

  it('requires a promotion suffix for a pawn capture onto the last rank', () => {
    const capturePromotionPosition = parsePosition('k4r2/4P3/8/8/8/8/8/7K w - - 0 1');
    const classification = classifyCompletedReply(
      protocolReply({ answerText: '{"move":"e7f8"}' }),
      capturePromotionPosition,
    );

    expect(classification).toMatchObject({ kind: 'format-rejection', category: 'missing-promotion' });
  });

  it('does not read plan, reasoning, or other choices as commands', () => {
    const source = protocolReply({
      answerText: 'The text here does not choose a coordinate move.',
      planText: '{"move":"e2e4"}',
      reasoningText: 'I resign.',
      refusalText: 'I resign.',
      otherChoices: [{ text: '{"move":"d2d4","resign":true}' }],
    });

    const classification = classifyCompletedReply(source, INITIAL_POSITION);

    expect(classification).toMatchObject({ kind: 'format-rejection', category: 'missing-move' });
    expect(classification.source.protocolResult).toBe(source);
  });

  it('does not treat quoted refusal text as resignation', () => {
    const classification = classifyCompletedReply(
      protocolReply({ answerText: 'The quoted line was "I refuse to make a move."' }),
      INITIAL_POSITION,
    );

    expect(classification).toMatchObject({ kind: 'format-rejection', category: 'missing-move' });
  });

  it.each([
    ['history', 'The previous reply was:\nI resign.'],
    ['a historical final-answer marker', 'The previous reply was:\nFinal Answer: I resign.'],
    ['a quoted transcript', 'The transcript contained this line:\nI refuse to make a move.'],
    ['a hypothetical answer', 'If I chose to resign, my answer would be:\nI resign.'],
  ] as const)('does not resign from multiline %s', (_label, answerText) => {
    const classification = classifyCompletedReply(protocolReply({ answerText }), INITIAL_POSITION);

    expect(classification).toMatchObject({ kind: 'format-rejection', category: 'ambiguous-answer' });
    if (classification.kind !== 'format-rejection') {
      throw new Error('Multiline refusal must be rejected as ambiguous formatting.');
    }

    const recovery = decideRecoveryPolicy({
      version: 1,
      state: createInitialRecoveryBudgetState(),
      eligibility: eligibleDecision(`multiline-refusal-${_label}`),
      event: { kind: 'model-reply', reply: classification },
    });
    expect(recovery.decision.kind).toBe('automatic-format-correction');
    expect(recovery.next).toEqual({ version: 1, illegalAttemptsUsed: 0, automaticFormatCorrectionsUsed: 1 });
  });

  it.each([
    ['history with Final Move colon', 'The previous reply was:\nFinal Move: I resign.'],
    ['quote with Final Move equals', 'The quoted transcript was:\nFinal Move=I refuse to make a move.'],
    ['hypothetical with Final Move colon', 'If I chose to resign, my answer would be:\nFinal Move: I resign.'],
    ['hypothetical with Final Move equals', 'If I chose to refuse, my answer would be:\nFinal Move=I refuse to make a move.'],
  ] as const)('does not resign from multiline %s', (_label, answerText) => {
    const classification = classifyCompletedReply(protocolReply({ answerText }), INITIAL_POSITION);

    expect(classification).toMatchObject({ kind: 'format-rejection', category: 'ambiguous-answer' });
    if (classification.kind !== 'format-rejection') {
      throw new Error('Multiline Final Move refusal must be rejected as ambiguous formatting.');
    }

    const recovery = decideRecoveryPolicy({
      version: 1,
      state: createInitialRecoveryBudgetState(),
      eligibility: eligibleDecision(`multiline-final-move-refusal-${_label}`),
      event: { kind: 'model-reply', reply: classification },
    });
    expect(recovery.decision.kind).toBe('automatic-format-correction');
    expect(recovery.next).toEqual({ version: 1, illegalAttemptsUsed: 0, automaticFormatCorrectionsUsed: 1 });
  });

  it.each([
    ['LF', 'I resign.\n'],
    ['CRLF with trailing spaces', 'I refuse to make a move.\r\n  '],
  ] as const)('keeps a standalone refusal with trailing %s boundary whitespace as resignation', (_label, answerText) => {
    const classification = classifyCompletedReply(protocolReply({ answerText }), INITIAL_POSITION);

    expect(classification).toMatchObject({ kind: 'resignation', reason: 'final-refusal' });
  });

  it('retains the refusal channel when an incomplete refusal is ineligible', () => {
    const source = protocolReply({
      terminal: 'truncated',
      content: 'refusal',
      answerText: '',
      refusalText: 'I resign.',
    });
    const classification = classifyCompletedReply(source, INITIAL_POSITION);

    expect(classification).toMatchObject({
      kind: 'protocol-ineligible',
      source: { channel: 'refusal', text: 'I resign.', protocolResult: source },
    });
  });

  it('does not infer an answer from a natural-language discussion of candidate coordinates', () => {
    const classification = classifyCompletedReply(
      protocolReply({ answerText: 'I am considering e2e4, but I have not selected a move.' }),
      INITIAL_POSITION,
    );

    expect(classification).toMatchObject({ kind: 'format-rejection', category: 'missing-move' });
  });

  it.each([
    ['protocol refusal content', { content: 'refusal', answerText: '', refusalText: 'I cannot provide a move.' }, 'protocol-refusal'],
    ['explicit JSON resignation', { answerText: '{"resign":true}' }, 'json-resign'],
    ['final explicit refusal', { answerText: 'Final Answer: I resign.' }, 'final-refusal'],
    ['final decision refusal', { answerText: 'Final Decision: I resign.' }, 'final-refusal'],
    ['standalone Final Move colon refusal', { answerText: 'Final Move: I resign.' }, 'final-refusal'],
    ['standalone Final Move equals refusal', { answerText: 'Final Move=I refuse to make a move.' }, 'final-refusal'],
    ['explicit refusal to move', { answerText: 'I refuse to make a move.' }, 'final-refusal'],
    ['explicit refusal without an object', { answerText: 'I refuse to move.' }, 'final-refusal'],
    ['explicit inability to move', { answerText: 'I cannot move.' }, 'final-refusal'],
  ] as const)('classifies a complete explicit refusal as resignation: %s', (_label, overrides, reason) => {
    const classification = classifyCompletedReply(protocolReply(overrides), INITIAL_POSITION);

    expect(classification).toMatchObject({ kind: 'resignation', reason });
  });

  it.each([
    ['truncated refusal', { terminal: 'truncated', content: 'refusal', refusalText: 'I resign.' }, 'not-complete'],
    ['filtered answer', { terminal: 'incomplete', content: 'empty', refusalText: '' }, 'not-complete'],
    ['tool-only text', { content: 'tool-only', refusalText: 'I resign.' }, 'content-not-actionable'],
    ['empty content with refusal-looking text', { content: 'empty', answerText: 'I resign.' }, 'content-not-actionable'],
    ['provider error', { content: 'refusal', refusalText: 'I resign.', errors: [{ message: 'provider failed' }] }, 'protocol-error'],
    ['HTTP failure', { httpStatus: 503, content: 'refusal', refusalText: 'I resign.' }, 'http-error'],
  ] as const)('does not convert a non-actionable protocol outcome into resignation: %s', (_label, overrides, cause) => {
    const classification = classifyCompletedReply(protocolReply(overrides), INITIAL_POSITION);

    expect(classification).toMatchObject({ kind: 'protocol-ineligible', cause });
  });
});

describe('independent recovery budgets', () => {
  it('keeps illegal, format, technical, switch, and manual-retry outcomes separate', () => {
    const initial = createInitialRecoveryBudgetState();
    const illegalReply = classifyCompletedReply(
      protocolReply({ answerText: '{"move":"e2e5"}' }),
      INITIAL_POSITION,
    );
    const formatReply = classifyCompletedReply(
      protocolReply({ answerText: 'No chosen coordinate move.' }),
      INITIAL_POSITION,
    );
    const legalReply = classifyCompletedReply(
      protocolReply({ answerText: '{"move":"e2e4"}' }),
      INITIAL_POSITION,
    );
    const eligibility = {
      status: 'eligible',
      decisionId: 'turn-7-request-1',
      currentFenceId: 'game-7-revision-12',
      checkedBy: 'controller',
      fence: 'current',
      deadline: 'before',
      unique: true,
    } as const;

    if (illegalReply.kind !== 'move-proposal' || legalReply.kind !== 'move-proposal') {
      throw new Error('Coordinate fixture must produce move proposals.');
    }
    if (formatReply.kind !== 'format-rejection') throw new Error('Formatting fixture must be rejected.');

    const illegal = decideRecoveryPolicy({
      version: 1,
      state: initial,
      eligibility,
      event: {
        kind: 'model-reply',
        reply: illegalReply,
        moveValidation: { status: 'illegal', reason: 'piece-movement-not-allowed' },
      },
    });
    expect(illegal).toMatchObject({
      version: 1,
      next: { illegalAttemptsUsed: 1, automaticFormatCorrectionsUsed: 0 },
      decision: { kind: 'automatic-illegal-correction', attemptNumber: 1, request: { logicalRequests: 1 } },
      event: { reply: { source: { protocolResult: illegalReply.source.protocolResult } } },
    });

    const format = decideRecoveryPolicy({
      version: 1,
      state: illegal.next,
      eligibility: { ...eligibility, decisionId: 'turn-7-request-2' },
      event: { kind: 'model-reply', reply: formatReply },
    });
    expect(format).toMatchObject({
      next: { illegalAttemptsUsed: 1, automaticFormatCorrectionsUsed: 1 },
      decision: { kind: 'automatic-format-correction', correctionNumber: 1, request: { logicalRequests: 1 } },
    });

    const technical = decideRecoveryPolicy({
      version: 1,
      state: format.next,
      eligibility: { ...eligibility, decisionId: 'turn-7-request-3' },
      event: { kind: 'technical-failure', code: 'provider-error' },
    });
    expect(technical).toMatchObject({
      next: { illegalAttemptsUsed: 1, automaticFormatCorrectionsUsed: 1 },
      decision: { kind: 'technical-failure-preserved' },
    });

    const switched = decideRecoveryPolicy({
      version: 1,
      state: technical.next,
      eligibility: { ...eligibility, decisionId: 'turn-7-switch-1' },
      event: { kind: 'ordinary-switch' },
    });
    expect(switched.next).toEqual({ version: 1, illegalAttemptsUsed: 1, automaticFormatCorrectionsUsed: 1 });

    const manual = decideRecoveryPolicy({
      version: 1,
      state: switched.next,
      eligibility: { ...eligibility, decisionId: 'turn-7-manual-retry-1' },
      event: { kind: 'manual-retry' },
    });
    expect(manual).toMatchObject({
      next: { illegalAttemptsUsed: 1, automaticFormatCorrectionsUsed: 1 },
      decision: { kind: 'manual-retry-authorized', request: { logicalRequests: 1 } },
    });

    const accepted = decideRecoveryPolicy({
      version: 1,
      state: manual.next,
      eligibility: { ...eligibility, decisionId: 'turn-7-request-4' },
      event: { kind: 'model-reply', reply: legalReply, moveValidation: { status: 'legal' } },
    });
    expect(accepted).toMatchObject({
      next: { version: 1, illegalAttemptsUsed: 0, automaticFormatCorrectionsUsed: 0 },
      decision: { kind: 'legal-move-accepted', budgetsReset: true },
    });
  });

  it('authorizes three illegal correction requests and loses on the fourth illegal move', () => {
    const reply = classifyCompletedReply(protocolReply({ answerText: '{"move":"e2e5"}' }), INITIAL_POSITION);
    if (reply.kind !== 'move-proposal') throw new Error('Illegal-move fixture must parse as a move proposal.');
    let state = createInitialRecoveryBudgetState();
    const outcomes = [];

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = decideRecoveryPolicy({
        version: 1,
        state,
        eligibility: eligibleDecision(`illegal-${attempt}`),
        event: {
          kind: 'model-reply',
          reply,
          moveValidation: { status: 'illegal', reason: 'not-legal-in-position' },
        },
      });
      outcomes.push(result.decision.kind);
      expect(result.next.illegalAttemptsUsed).toBe(attempt);
      expect(result.next.automaticFormatCorrectionsUsed).toBe(0);
      state = result.next;
    }

    expect(outcomes).toEqual([
      'automatic-illegal-correction',
      'automatic-illegal-correction',
      'automatic-illegal-correction',
      'illegal-attempt-limit-loss',
    ]);

    const afterLoss = decideRecoveryPolicy({
      version: 1,
      state,
      eligibility: eligibleDecision('manual-after-model-loss'),
      event: { kind: 'manual-retry' },
    });
    expect(afterLoss).toMatchObject({
      next: state,
      decision: { kind: 'ignored', reason: 'terminal' },
    });
  });

  it('allows three independent format corrections, then pauses without a chess loss', () => {
    const position = parsePosition('k7/4P3/8/8/8/8/8/7K w - - 0 1');
    const reply = classifyCompletedReply(protocolReply({ answerText: '{"move":"e7e8"}' }), position);
    if (reply.kind !== 'format-rejection') throw new Error('Missing-promotion fixture must be a format rejection.');
    let state = { version: 1 as const, illegalAttemptsUsed: 2, automaticFormatCorrectionsUsed: 0 };
    const decisions = [];

    for (let correction = 1; correction <= 4; correction += 1) {
      const result = decideRecoveryPolicy({
        version: 1,
        state,
        eligibility: eligibleDecision(`format-${correction}`),
        event: { kind: 'model-reply', reply },
      });
      decisions.push(result.decision);
      expect(result.next.illegalAttemptsUsed).toBe(2);
      state = result.next;
    }

    expect(decisions.slice(0, 3)).toMatchObject([
      { kind: 'automatic-format-correction', correctionNumber: 1, request: { logicalRequests: 1 } },
      { kind: 'automatic-format-correction', correctionNumber: 2, request: { logicalRequests: 1 } },
      { kind: 'automatic-format-correction', correctionNumber: 3, request: { logicalRequests: 1 } },
    ]);
    expect(decisions[3]).toEqual({
      kind: 'format-corrections-exhausted',
      chessLoss: false,
      manualRetryAllowed: true,
    });
    expect(state).toEqual({ version: 1, illegalAttemptsUsed: 2, automaticFormatCorrectionsUsed: 3 });
  });

  it('does not spend either budget for stale, stopped, expired, duplicate, superseded, or terminal work', () => {
    const reply = classifyCompletedReply(protocolReply({ answerText: '{"move":"e2e5"}' }), INITIAL_POSITION);
    if (reply.kind !== 'move-proposal') throw new Error('Move fixture must parse as a proposal.');
    const formatReply = classifyCompletedReply(protocolReply({ answerText: 'No selected move.' }), INITIAL_POSITION);
    if (formatReply.kind !== 'format-rejection') throw new Error('Format fixture must be rejected.');
    const state = { version: 1 as const, illegalAttemptsUsed: 2, automaticFormatCorrectionsUsed: 1 };

    for (const reason of ['stale', 'stopped', 'expired', 'duplicate', 'superseded', 'terminal'] as const) {
      const result = decideRecoveryPolicy({
        version: 1,
        state,
        eligibility: { status: 'ineligible', decisionId: `ineligible-${reason}`, reason },
        event: {
          kind: 'model-reply',
          reply,
          moveValidation: { status: 'illegal', reason: 'piece-movement-not-allowed' },
        },
      });

      expect(result).toMatchObject({
        next: state,
        decision: { kind: 'ignored', reason },
      });

      const formatResult = decideRecoveryPolicy({
        version: 1,
        state,
        eligibility: { status: 'ineligible', decisionId: `format-ineligible-${reason}`, reason },
        event: { kind: 'model-reply', reply: formatReply },
      });
      expect(formatResult.next).toEqual(state);
      expect(formatResult.decision).toEqual({ kind: 'ignored', reason });
    }
  });

  it('authorizes one manual request after format exhaustion without refilling either budget', () => {
    const state = { version: 1 as const, illegalAttemptsUsed: 3, automaticFormatCorrectionsUsed: 3 };
    const result = decideRecoveryPolicy({
      version: 1,
      state,
      eligibility: eligibleDecision('manual-retry-after-exhaustion'),
      event: { kind: 'manual-retry' },
    });

    expect(result).toMatchObject({
      next: state,
      decision: { kind: 'manual-retry-authorized', request: { logicalRequests: 1 } },
    });
  });

  it('resigns on a complete explicit resignation without using either recovery budget', () => {
    const reply = classifyCompletedReply(protocolReply({ answerText: '{"resign":true}' }), INITIAL_POSITION);
    if (reply.kind !== 'resignation') throw new Error('Explicit resignation fixture must resign.');
    const state = { version: 1 as const, illegalAttemptsUsed: 3, automaticFormatCorrectionsUsed: 3 };
    const result = decideRecoveryPolicy({
      version: 1,
      state,
      eligibility: eligibleDecision('explicit-resignation'),
      event: { kind: 'model-reply', reply },
    });

    expect(result).toMatchObject({ next: state, decision: { kind: 'model-resigned' } });
  });

  it('uses fixed category templates with no move choice or legal-move list', () => {
    const position = parsePosition('k7/4P3/8/8/8/8/8/7K w - - 0 1');
    const reply = classifyCompletedReply(protocolReply({ answerText: '{"move":"e7e8"}' }), position);
    if (reply.kind !== 'format-rejection') throw new Error('Fixture must be a format rejection.');
    const result = decideRecoveryPolicy({
      version: 1,
      state: createInitialRecoveryBudgetState(),
      eligibility: eligibleDecision('format-template'),
      event: { kind: 'model-reply', reply },
    });
    if (result.decision.kind !== 'automatic-format-correction') {
      throw new Error('Expected the first automatic formatting correction.');
    }

    expect(result.decision.request.instruction).toContain('promotion suffix');
    expect(result.decision.request.instruction).not.toMatch(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/i);
    expect(result.event).toEqual({ kind: 'model-reply', reply });
    if (result.event.kind !== 'model-reply') throw new Error('Formatting decision must retain its reply event.');
    expect(result.event.reply.source.protocolResult).toBe(reply.source.protocolResult);
  });

  it('uses the controller-validated chess-rule category for illegal-move corrections', () => {
    const reply = classifyCompletedReply(protocolReply({ answerText: '{"move":"e2e5"}' }), INITIAL_POSITION);
    if (reply.kind !== 'move-proposal') throw new Error('Move fixture must parse as a proposal.');
    const result = decideRecoveryPolicy({
      version: 1,
      state: createInitialRecoveryBudgetState(),
      eligibility: eligibleDecision('king-safety-correction'),
      event: {
        kind: 'model-reply',
        reply,
        moveValidation: { status: 'illegal', reason: 'king-left-in-check' },
      },
    });
    if (result.decision.kind !== 'automatic-illegal-correction') {
      throw new Error('Expected one automatic illegal-move correction.');
    }

    expect(result.decision.request.instruction).toContain('leaves your king in check');
    expect(result.decision.request.instruction).not.toMatch(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/i);
    expect(result.decision.request.instruction).not.toMatch(/legal moves?:\s*\[/i);
  });

  it('rejects an eligible attestation whose current-fence deadline check did not pass', () => {
    const invalidEligibility = { ...eligibleDecision('after-deadline'), deadline: 'after' as 'before' };
    const unknownEligibility = { ...eligibleDecision('unknown-status'), status: 'maybe' as 'eligible' };

    expect(() => decideRecoveryPolicy({
      version: 1,
      state: createInitialRecoveryBudgetState(),
      eligibility: invalidEligibility,
      event: { kind: 'manual-retry' },
    })).toThrow('current, unique, pre-deadline controller fence');
    expect(() => decideRecoveryPolicy({
      version: 1,
      state: createInitialRecoveryBudgetState(),
      eligibility: unknownEligibility,
      event: { kind: 'manual-retry' },
    })).toThrow('Unknown controller eligibility status');
    expect(() => decideRecoveryPolicy({
      version: 1,
      state: createInitialRecoveryBudgetState(),
      eligibility: eligibleDecision('unknown-event'),
      event: { kind: 'model-text' as 'manual-retry' },
    })).toThrow('Unknown recovery policy event');
  });
});

function eligibleDecision(decisionId: string) {
  return {
    status: 'eligible' as const,
    decisionId,
    currentFenceId: 'game-7-revision-12',
    checkedBy: 'controller' as const,
    fence: 'current' as const,
    deadline: 'before' as const,
    unique: true as const,
  };
}
