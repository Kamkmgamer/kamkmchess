import { describe, expect, it } from 'vitest';
import { parsePosition } from '../rules/index.js';
import { classifyCompletedAnswer, detectExplicitRefusal } from './index.js';

const INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const PROMOTION_READY = '4k3/6P1/8/8/8/8/8/4K3 w - - 0 1';

function classify(answerText: string, fen: string = INITIAL) {
  return classifyCompletedAnswer({ answerText, position: parsePosition(fen) });
}

describe('completed answer classification', () => {
  it('[MOV-01] reads one fenced JSON object with a plan and extra fields', () => {
    const result = classify(
      '```json\n{"move":"e2e4","plan":"Control the center.","confidence":"high","tokens":42}\n```',
    );

    expect(result).toMatchObject({
      kind: 'move',
      move: { from: 'e2', to: 'e4' },
      text: 'e2e4',
      origin: 'json-move',
      plan: 'Control the center.',
    });
    if (result.kind !== 'move') throw new Error('expected a move declaration');
    expect(result.retainedFields).toEqual([
      { key: 'confidence', value: 'high' },
      { key: 'tokens', value: 42 },
    ]);
  });

  it('[MOV-01] normalizes coordinate whitespace and case', () => {
    expect(classify('{"move":"  E2 e4 "}')).toMatchObject({
      kind: 'move',
      text: 'e2e4',
      move: { from: 'e2', to: 'e4' },
    });
    expect(classify('`E2E4`')).toMatchObject({ kind: 'move', text: 'e2e4', origin: 'fallback-standalone' });
    expect(classify('e2e4.')).toMatchObject({ kind: 'move', text: 'e2e4', origin: 'fallback-standalone' });
  });

  it('[MOV-01, RUL-01] uses king squares for castling and pawn squares for en passant', () => {
    const castling = parsePosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(classifyCompletedAnswer({ answerText: '{"move":"e1g1"}', position: castling })).toMatchObject({
      kind: 'move',
      move: { from: 'e1', to: 'g1' },
    });
    const enPassant = parsePosition('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    expect(classifyCompletedAnswer({ answerText: '{"move":"e5d6"}', position: enPassant })).toMatchObject({
      kind: 'move',
      move: { from: 'e5', to: 'd6' },
    });
  });

  it('[MOV-01, RUL-01] requires an explicit promotion piece', () => {
    const position = parsePosition(PROMOTION_READY);
    const chosen = classifyCompletedAnswer({ answerText: '{"move":"g7g8q"}', position });
    const missing = classifyCompletedAnswer({ answerText: '{"move":"g7g8"}', position });
    const underpromotion = classifyCompletedAnswer({ answerText: '{"move":"g7g8n"}', position });

    expect(chosen).toMatchObject({ kind: 'move', move: { from: 'g7', to: 'g8', promotion: 'q' } });
    expect(missing).toMatchObject({ kind: 'format-failure', reason: 'missing-promotion', fragment: 'g7g8' });
    expect(underpromotion).toMatchObject({ kind: 'move', move: { from: 'g7', to: 'g8', promotion: 'n' } });
  });

  it('[MOV-01] does not require a promotion suffix for an ordinary last-rank push', () => {
    expect(classify('{"move":"g1h1"}', AFTER_E4)).toMatchObject({ kind: 'move', move: { to: 'h1' } });
  });

  it('[MOV-02] rejects conflicting duplicate move keys', () => {
    expect(classify('{"move":"e2e4","move":"d2d4","plan":"two ideas"}')).toMatchObject({
      kind: 'format-failure',
      reason: 'conflicting-duplicate-keys',
      fragment: 'move',
    });
  });

  it('[MOV-02] keeps one declaration from identical duplicate action keys', () => {
    expect(classify('{"move":"e2e4","move":"e2e4"}')).toMatchObject({ kind: 'move', text: 'e2e4' });
  });

  it('[MOV-02] rejects a move declared together with a resignation', () => {
    expect(classify('{"move":"e2e4","resign":true}')).toMatchObject({
      kind: 'format-failure',
      reason: 'move-and-resignation',
    });
  });

  it('[MOV-02] accepts a move beside an explicit non-resignation flag', () => {
    expect(classify('{"move":"e2e4","resign":false}')).toMatchObject({ kind: 'move', text: 'e2e4' });
  });

  it('[MOV-02] rejects competing explicit answers', () => {
    expect(classify('Move: e2e4\nMove: d2d4')).toMatchObject({
      kind: 'format-failure',
      reason: 'competing-answers',
      fragment: 'e2e4 d2d4',
    });
    expect(classify('e2e4\n\nMove: d2d4')).toMatchObject({ kind: 'format-failure', reason: 'competing-answers' });
  });

  it('[MOV-02] reads a single final Move line with harmless decoration', () => {
    expect(classify('Thinking about the centre.\n\n**Move:** `e2e4`.')).toMatchObject({
      kind: 'move',
      text: 'e2e4',
      origin: 'fallback-final-move-line',
    });
  });

  it('[MOV-02] never repairs broken JSON', () => {
    expect(classify('{"move":"e2e4",}')).toMatchObject({ kind: 'format-failure' });
    expect(classify('{move: "e2e4"}')).toMatchObject({ kind: 'format-failure', reason: 'no-action' });
    expect(classify('{"move":"e2e4"} {"move":"d2d4"}')).toMatchObject({ kind: 'format-failure' });
    expect(classify('{"move":"e2e4')).toMatchObject({ kind: 'format-failure', reason: 'no-action' });
    expect(classify('[{"move":"e2e4"}]')).toMatchObject({ kind: 'format-failure', reason: 'no-action' });
    expect(classify('"e2e4"')).toMatchObject({ kind: 'move', origin: 'fallback-standalone' });
    expect(classify('{"move":"e2e4"}\n')).toMatchObject({ kind: 'move', text: 'e2e4' });
  });

  it('[MOV-02] rejects out-of-shape coordinates instead of trimming them into shape', () => {
    for (const answerText of ['{"move":"e2e44"}', '{"move":"i2i4"}', '{"move":"e2e9"}', '{"move":"e7e8k"}']) {
      expect(classify(answerText), answerText).toMatchObject({
        kind: 'format-failure',
        reason: 'unreadable-move',
      });
    }
  });

  it('[MOV-02] treats a second code fence as unreadable', () => {
    expect(classify('```\n{"move":"e2e4"}\n```\n```\n{"move":"d2d4"}\n```')).toMatchObject({
      kind: 'format-failure',
      reason: 'unreadable-move',
    });
  });

  it('[MOV-02, MOV-04] never reads a command from a narrative, plan, or reasoning', () => {
    expect(classify('I considered e2e4 or d2d4 but will think more.')).toMatchObject({
      kind: 'format-failure',
      reason: 'no-action',
    });
    expect(classify('{"plan":"I will play e2e4 to claim the centre."}')).toMatchObject({
      kind: 'format-failure',
      reason: 'no-action',
    });
    expect(classify('{"reasoning":"e2e4 is best","move":42}')).toMatchObject({
      kind: 'format-failure',
      reason: 'unreadable-move',
      fragment: 'number',
    });
  });

  it('[MOV-02] requires the move key to be a string', () => {
    expect(classify('{"move":["e2","e4"]}')).toMatchObject({ kind: 'format-failure', reason: 'unreadable-move' });
  });

  it('[MOV-06] treats an explicit refusal as a model resignation', () => {
    expect(classify('{"resign":true}')).toMatchObject({ kind: 'resignation', origin: 'json-resignation' });
    expect(classify('I resign.')).toMatchObject({ kind: 'resignation', origin: 'explicit-refusal', statement: 'I resign.' });
    expect(classify('I refuse to move.')).toMatchObject({ kind: 'resignation' });
    expect(classify('Resign.')).toMatchObject({ kind: 'resignation' });
    expect(classify('**I resign the game.**')).toMatchObject({ kind: 'resignation' });
  });

  it('[MOV-06] never resigns on quoted, hypothetical, historical, or attributed text', () => {
    const corpus = [
      '"I resign."',
      '> I resign.',
      'If I resign here you will win.',
      'You resign because you are losing.',
      'Earlier I said "I resign", but I changed my mind and will play on.',
      'Earlier in this conversation the assistant said it would resign.',
      'I would resign if the clock expired.',
    ];

    for (const answerText of corpus) {
      expect(detectExplicitRefusal(answerText).kind, answerText).toBe('not-refusal');
      expect(classify(answerText).kind, answerText).toBe('format-failure');
    }
  });

  it('[MOV-06] never resigns on provider error, filter, or interruption text', () => {
    for (const answerText of [
      'The request was blocked by our content filter.',
      'Error: this model cannot continue this conversation.',
      'I am unable to continue generating a response.',
    ]) {
      expect(detectExplicitRefusal(answerText).kind, answerText).toBe('not-refusal');
    }
  });

  it('[MOV-06] asks for clarification when one reply both moves and refuses', () => {
    expect(classify('I choose e2e4, although I resign.')).toMatchObject({
      kind: 'format-failure',
      reason: 'competing-answers',
    });
    expect(classify('I resign.\nMove: e2e4')).toMatchObject({ kind: 'format-failure', reason: 'competing-answers' });
  });

  it('[MOV-06] asks for clarification when a move and a refusal share one JSON object', () => {
    expect(classify('{"move":"e2e4","plan":"I resign"}')).toMatchObject({ kind: 'move', plan: 'I resign' });
  });
});