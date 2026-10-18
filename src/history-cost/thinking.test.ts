import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { HistoryCheckpointV1, HistoryMessageV1, RulesCheckpointV1 } from '../storage';
import type { ProtocolStreamResult } from '../providers/protocols';
import { createThinkingRecord, latestThinking } from './thinking';

const initialFen = new Chess().fen();
const sourceInput = JSON.stringify({ kind: 'current-match-input', fen: initialFen, sideToMove: 'white' });

function result(overrides: Partial<ProtocolStreamResult> = {}): ProtocolStreamResult {
  return { protocol: 'chat-completions', terminal: 'complete', content: 'answer',
    answerText: '{"move":"e2e4","plan":"Develop the kingside and castle."}',
    reasoningText: 'Opening the center gives my bishop room.', planText: '', refusalText: '',
    usage: null, usageRecords: [], errors: [], incompleteDetails: [], toolRecords: [], otherChoices: [],
    unknownEvents: [], raw: { chunks: [], events: [] }, ...overrides };
}

function message(content: string, overrides: Partial<HistoryMessageV1> = {}): HistoryMessageV1 {
  return { messageId: crypto.randomUUID(), segmentId: 's', lineId: 'line', role: 'assistant', content,
    eventIds: [], disposition: 'retained', ...overrides };
}

function history(messages: HistoryMessageV1[]): HistoryCheckpointV1 {
  return { currentSegmentId: 's', segments: [], messages };
}

function rules(): RulesCheckpointV1 {
  const chess = new Chess();
  const move = chess.move('e4');
  chess.move('e5');
  return { variant: 'orthodox', startingFen: initialFen, currentFen: chess.fen(), sideToMove: 'white',
    castlingRights: 'KQkq', enPassantSquare: null, halfmoveClock: '0', fullmoveNumber: '2',
    repetitionLedger: { version: 1, positions: [] }, moves: [{ moveId: 'm', eventId: 'e', from: 'e2', to: 'e4',
      promotion: null, san: 'e4', fenBefore: move.before, fenAfter: move.after }] };
}

describe('rolling model thinking', () => {
  it('keeps authored plans and returned reasoning, excluding opaque provider data', () => {
    const record = createThinkingRecord(sourceInput, result({ raw: { chunks: [new Uint8Array([255])], events: [] } }));
    expect(record).not.toBeNull();
    expect(latestThinking(history([message(record!)]), rules())).toEqual({
      fen: initialFen, move: 'e2e4', plan: 'Develop the kingside and castle.',
      reasoning: 'Opening the center gives my bishop room.',
    });
    expect(record).not.toContain('chunks');
  });

  it('carries only the latest thinking for the playing side and follows Undo dispositions', () => {
    const older = message(createThinkingRecord(sourceInput, result())!);
    const newer = message(createThinkingRecord(sourceInput, result({ answerText: '{"move":"g1f3","plan":"Pressure the center."}', reasoningText: 'new reasoning' }))!);
    const opponent = message(createThinkingRecord(sourceInput.replace('"white"', '"black"'), result({ planText: 'opponent plan' }))!);
    const messages = [older, newer, opponent, message('{"kind":"opaque-provider-record","raw":"' + 'x'.repeat(1_100_000) + '"}')];
    expect(latestThinking(history(messages), rules())).toMatchObject({ plan: 'Pressure the center.', reasoning: 'new reasoning' });
    newer.disposition = 'discarded';
    expect(latestThinking(history(messages), rules())).toMatchObject({ plan: 'Develop the kingside and castle.' });
    older.disposition = 'discarded';
    expect(latestThinking(history(messages), rules())).toBeUndefined();
  });

  it('does not replace a usable plan with failed, partial, aborted or thought-free output', () => {
    for (const terminal of ['failed', 'incomplete', 'truncated', 'aborted', 'malformed'] as const) {
      expect(createThinkingRecord(sourceInput, result({ terminal }))).toBeNull();
    }
    expect(createThinkingRecord(sourceInput, result({ content: 'refusal' }))).toBeNull();
    expect(createThinkingRecord(sourceInput, result({ answerText: '{"move":"e2e4"}', reasoningText: '' }))).toBeNull();
    expect(createThinkingRecord('', result())).toBeNull();
  });

  it('recovers plans and normalized reasoning from existing saved turns without a schema migration', () => {
    const messages = [message(sourceInput, { role: 'user' }),
      message('{"move":"e2e4","plan":"Develop the kingside and castle."}'),
      message('legacy reasoning'), message('legacy native plan'),
      message('{"kind":"opaque-provider-record","raw":"never replay"}')];
    expect(latestThinking(history(messages), rules())).toEqual({ fen: initialFen, move: 'e2e4',
      plan: 'Develop the kingside and castle.', reasoning: 'legacy reasoning\n\nlegacy native plan' });
    messages.push(message(sourceInput, { role: 'user' }), message('partial reply'), message('partial reasoning'));
    expect(latestThinking(history(messages), rules())?.reasoning).toBe('legacy reasoning\n\nlegacy native plan');
  });

  it('preserves native plans and JSON reasoning without accumulating previous input snapshots', () => {
    const record = createThinkingRecord(JSON.stringify({ kind: 'current-match-input', fen: initialFen,
      sideToMove: 'white', previousThinking: { plan: 'old strategy' } }), result({
      answerText: '{"move":"e2e4","reasoning":"JSON reasoning"}', planText: 'native plan', reasoningText: '',
    }))!;
    expect(latestThinking(history([message(record)]), rules())).toEqual({
      fen: initialFen, move: 'e2e4', plan: 'native plan', reasoning: 'JSON reasoning',
    });
    expect(record).not.toContain('old strategy');
  });
});
