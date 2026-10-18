import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { createTurnBudgets } from '../moves';
import type { RulesCheckpointV1 } from '../storage';
import {
  encodeAnthropicMessagesRequest,
  encodeChatCompletionsRequest,
  encodeResponsesRequest,
  type ProviderProtocol,
} from '../providers/protocols';
import { checkReplayCapacity, composeMoveInput, type MoveTurnSnapshotV1 } from './history';

function rulesFixture(): RulesCheckpointV1 {
  const chess = new Chess();
  const startingFen = chess.fen();
  const moves = ['e4', 'e5'].map((san, index) => {
    const move = chess.move(san);
    return { moveId: `move-${index}`, eventId: `event-${index}`, from: move.from, to: move.to,
      promotion: move.promotion ?? null, san: move.san, fenBefore: move.before, fenAfter: move.after };
  });
  return { variant: 'orthodox', startingFen, currentFen: chess.fen(), sideToMove: 'white',
    castlingRights: 'KQkq', enPassantSquare: null, halfmoveClock: '0', fullmoveNumber: '2',
    repetitionLedger: { version: 1, positions: [] }, moves };
}

function turn(): MoveTurnSnapshotV1 {
  return { snapshotId: 'fresh-turn', clock: { whiteMs: 12_000, blackMs: 8_000, incrementMs: 1_000 }, budgets: createTurnBudgets() };
}

const protocols: ProviderProtocol[] = ['chat-completions', 'responses', 'anthropic-messages'];

function encode(protocol: ProviderProtocol, history: ReturnType<typeof composeMoveInput>['history']) {
  const config = { model: 'exact-model-id', maxOutputTokens: 120 };
  if (protocol === 'chat-completions') return encodeChatCompletionsRequest(history, config).body;
  if (protocol === 'responses') return encodeResponsesRequest(history, config).body;
  return encodeAnthropicMessagesRequest(history, config).body;
}

describe('compact chess move input', () => {
  it.each(protocols)('sends only the current chess state through %s', (protocol) => {
    const rules = rulesFixture();
    const composed = composeMoveInput(rules, 'Choose one legal move.', turn());
    expect(composed.history.records).toHaveLength(1);
    expect(JSON.parse(composed.history.records[0]!.text)).toEqual({
      kind: 'current-match-input', fen: rules.currentFen, sideToMove: 'white',
      startingFen: rules.startingFen, moves: 'e4 e5', clock: turn().clock,
    });
    const body = encode(protocol, composed.history);
    expect(JSON.stringify(body)).toContain('e4 e5');
    expect(JSON.stringify(body)).not.toContain('retained-match-record');
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(1_000);
  });

  it('refreshes clocks without making the changing position a cache prefix', () => {
    const before = composeMoveInput(rulesFixture(), 'Choose one move.', turn());
    const after = composeMoveInput(rulesFixture(), 'Choose one move.', {
      ...turn(), snapshotId: 'new-request', clock: { ...turn().clock, whiteMs: 9_000 },
    });
    expect(after.history.instructions).toBe(before.history.instructions);
    expect(after.history.records[0]?.id).toBe('new-request');
    expect(JSON.parse(after.history.records[0]!.text).clock.whiteMs).toBe(9_000);
    expect(after.history.cachePrefixRecordCount).toBe(0);
  });

  it.each(protocols)('carries the latest plan and returned reasoning through %s as historical data', (protocol) => {
    const previousThinking = { fen: rulesFixture().startingFen, move: 'e2e4',
      plan: 'Develop the kingside and castle.', reasoning: 'The bishop needs an open diagonal.' };
    const composed = composeMoveInput(rulesFixture(), 'Choose one move.', { ...turn(), previousThinking });
    expect(JSON.parse(composed.history.records[0]!.text).previousThinking).toEqual(previousThinking);
    const body = encode(protocol, composed.history);
    expect(JSON.stringify(body)).toContain(previousThinking.plan);
    expect(JSON.stringify(body)).toContain(previousThinking.reasoning);
    expect(composed.history.instructions).toBe('Choose one move.');
    expect(composed.history.records).toHaveLength(1);
  });

  it('includes current-turn rejected moves and format guidance, then drops them on a fresh turn', () => {
    const retry = turn();
    retry.budgets = { ...retry.budgets, illegalMoveAttempts: 1, formatCorrections: 1, attemptRecords: [{
      attempt: 1, modelConfigurationIdentity: 'private-routing-id', move: { from: 'e2', to: 'e5' },
      violation: { code: 'not-legal-in-position', message: 'e2e5 is not legal in this position. Please choose a legal move yourself.' },
    }] };
    const input = JSON.parse(composeMoveInput(rulesFixture(), 'Choose one move.', retry).history.records[0]!.text);
    expect(input.rejectedMoves).toEqual([{ move: 'e2e5', reason: retry.budgets.attemptRecords[0]!.violation.message }]);
    expect(input.formatCorrection).toContain('promotion');
    expect(JSON.stringify(input)).not.toContain('private-routing-id');
    const fresh = JSON.parse(composeMoveInput(rulesFixture(), 'Choose one move.', turn()).history.records[0]!.text);
    expect(fresh).not.toHaveProperty('rejectedMoves');
    expect(fresh).not.toHaveProperty('formatCorrection');
    const laterTurn = { ...turn(), budgets: { ...createTurnBudgets(), attemptRecords: retry.budgets.attemptRecords } };
    expect(JSON.parse(composeMoveInput(rulesFixture(), 'Choose one move.', laterTurn).history.records[0]!.text))
      .not.toHaveProperty('rejectedMoves');
    const currentRetry = { ...retry, budgets: { ...retry.budgets, attemptRecords: [
      { ...retry.budgets.attemptRecords[0]!, move: { from: 'a1' as const, to: 'a8' as const } },
      ...retry.budgets.attemptRecords,
    ] } };
    expect(JSON.parse(composeMoveInput(rulesFixture(), 'Choose one move.', currentRetry).history.records[0]!.text).rejectedMoves)
      .toEqual(input.rejectedMoves);
  });

  it('preserves custom starting positions, special-move state and repetition warnings', () => {
    const rules = rulesFixture();
    rules.startingFen = '4k3/P7/8/8/3pP3/8/8/4K3 b - e3 0 37';
    rules.currentFen = rules.startingFen;
    rules.sideToMove = 'black';
    rules.moves = [];
    rules.repetitionLedger.positions = [
      { identity: '4k3/P7/8/8/3pP3/8/8/4K3 b - e3', occurrences: '1' },
      { identity: '4k3/P7/8/8/3pP3/8/8/4K3 w - -', occurrences: '2' },
    ];
    const input = JSON.parse(composeMoveInput(rules, 'Choose one move.', turn()).history.records[0]!.text);
    expect(input.fen).toBe(rules.currentFen);
    expect(input.startingFen).toBe(rules.startingFen);
    expect(input.sideToMove).toBe('black');
    expect(input.moves).toBe('');
    expect(input.repeatedPositions).toEqual([rules.repetitionLedger.positions[1]]);
  });

  it('still checks exact request bytes and reserves output/reasoning token headroom', () => {
    const input = composeMoveInput(rulesFixture(), 'Instructions', turn());
    const body = encodeResponsesRequest(input.history, { model: 'm', maxOutputTokens: 100 }).body;
    expect(checkReplayCapacity(body, { maxRequestBytes: 1, maxOutputTokens: 100 }))
      .toMatchObject({ status: 'rejected', reason: 'request-bytes' });
    expect(checkReplayCapacity(body, { maxContextTokens: 150, maxOutputTokens: 100,
      reasoningHeadroomTokens: 20, countInputTokens: () => 31 }))
      .toMatchObject({ status: 'rejected', reason: 'context-tokens', reservedTokens: 120 });
    expect(checkReplayCapacity(body, { maxContextTokens: 500, maxOutputTokens: 100 }))
      .toMatchObject({ status: 'rejected', reason: 'capacity-unverifiable' });
  });
});
