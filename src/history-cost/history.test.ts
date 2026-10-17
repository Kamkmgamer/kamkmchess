import { describe, expect, it } from 'vitest';
import {
  encodeAnthropicMessagesRequest,
  encodeChatCompletionsRequest,
  encodeResponsesRequest,
  type ProviderProtocol,
} from '../providers/protocols';
import type { HistoryCheckpointV1 } from '../storage';
import { checkReplayCapacity, composeHistoryReplay } from './history';

const protocols: ProviderProtocol[] = ['chat-completions', 'responses', 'anthropic-messages'];

function fixtureHistory(source: ProviderProtocol = 'chat-completions'): HistoryCheckpointV1 {
  const sourceSegmentId = `seg-${protocols.indexOf(source) + 1}`;
  return {
    currentSegmentId: sourceSegmentId,
    segments: protocols.map((_, index) => ({
      segmentId: `seg-${index + 1}`,
      providerId: protocols[index] ?? `provider-${index + 1}`,
      modelRoutingId: `route-${protocols[index] ?? index + 1}`,
      connectionRevision: index + 1,
      startedAtMs: index,
      messageIds: [`msg-${index + 1}`],
    })),
    messages: [
      { messageId: 'msg-1', segmentId: sourceSegmentId, lineId: 'line-a', role: 'system', content: 'old instruction\n```json\n{"x":"quoted"}', eventIds: ['evt-1'], disposition: 'retained' },
      { messageId: 'msg-2', segmentId: sourceSegmentId, lineId: 'line-a', role: 'assistant', content: 'Plan: keep the center.\nReasoning received: caf\u00e9 \u265f', eventIds: ['evt-2'], disposition: 'retained' },
      { messageId: 'msg-3', segmentId: sourceSegmentId, lineId: 'line-a', role: 'tool', content: '{"opaque":[1,2],"future":"kept"}', eventIds: ['evt-3'], disposition: 'retained' },
      { messageId: 'discarded-msg', segmentId: sourceSegmentId, lineId: 'line-old', role: 'assistant', content: 'discarded continuation', eventIds: ['evt-old'], disposition: 'discarded' },
    ],
  };
}

function position(snapshotId: string, sampledAtMs: number) {
  return {
    snapshotId,
    fen: `fen-${snapshotId}`,
    pieces: [{ square: 'e1', piece: 'king', color: 'white' as const }],
    sideToMove: 'black' as const,
    colors: { white: 'human', black: 'model' },
    clock: {
      sampledAtMs,
      whiteMs: 12_000,
      blackMs: 8_000,
      activeSide: 'black' as const,
      startingTimeMs: 60_000,
      incrementMs: 1_000,
    },
  };
}

function encode(protocol: ProviderProtocol, history: ReturnType<typeof composeHistoryReplay>['history']) {
  const config = { model: 'exact-model-id', maxOutputTokens: 120, cache: { promptCacheKey: 'selected-model-key', anthropicEphemeral: true } };
  if (protocol === 'chat-completions') return encodeChatCompletionsRequest(history, config).body;
  if (protocol === 'responses') return encodeResponsesRequest(history, config).body;
  return encodeAnthropicMessagesRequest(history, config).body;
}

describe('retained history replay composition', () => {
  it('[HIS-01, HIS-02] preserves every ordered source/destination protocol pair as attributed text', () => {
    for (const source of protocols) {
      for (const destination of protocols) {
        const history = fixtureHistory(source);
        const composed = composeHistoryReplay(history, 'Choose a legal chess move.', position('fresh', 1234));
        const body = encode(destination, composed.history);
        const wire = JSON.stringify(body);

        expect(wire).toContain('msg-1');
        expect(wire).toContain('system');
        expect(wire).toContain(source);
        expect(wire).toContain('caf\u00e9 \u265f');
        expect(wire).toContain('opaque');
        expect(wire).not.toContain('discarded continuation');
        expect(wire).not.toContain('discarded-msg');
        expect(wire).toContain('fen-fresh');
        expect(wire).toContain('1234');
        expect(composed.retainedMessageIds).toEqual(['msg-1', 'msg-2', 'msg-3']);
      }
    }
  });

  it('[CST-01, CLK-02] keeps the instruction/history prefix stable and refreshes only the position suffix', () => {
    const before = composeHistoryReplay(fixtureHistory(), 'Current rules and output contract.', position('snapshot-a', 500));
    const after = composeHistoryReplay(fixtureHistory(), 'Current rules and output contract.', position('snapshot-b', 900));
    expect(after.history.instructions).toBe(before.history.instructions);
    expect(after.history.records.slice(0, -1)).toEqual(before.history.records.slice(0, -1));
    expect(after.history.records.at(-1)?.text).not.toBe(before.history.records.at(-1)?.text);
    expect(after.history.records.at(-1)?.text).toContain('"whiteMs":12000');
    expect(after.history.cachePrefixRecordCount).toBe(3);
  });

  it('[HIS-02] rejects capacity without shortening replay and reserves output plus reasoning headroom', () => {
    const replay = composeHistoryReplay(fixtureHistory(), 'Instructions', position('snapshot', 10));
    const body = encodeResponsesRequest(replay.history, { model: 'm', maxOutputTokens: 100 }).body;
    const bytesRejected = checkReplayCapacity(body, { maxRequestBytes: 1, maxOutputTokens: 100 });
    const tokensRejected = checkReplayCapacity(body, {
      maxContextTokens: 150,
      maxOutputTokens: 100,
      reasoningHeadroomTokens: 20,
      countInputTokens: () => 31,
    });
    const unverifiable = checkReplayCapacity(body, { maxContextTokens: 500, maxOutputTokens: 100 });

    expect(bytesRejected).toMatchObject({ status: 'rejected', reason: 'request-bytes' });
    expect(tokensRejected).toMatchObject({ status: 'rejected', reason: 'context-tokens', reservedTokens: 120 });
    expect(unverifiable).toMatchObject({ status: 'rejected', reason: 'capacity-unverifiable' });
    expect(replay.history.records).toHaveLength(4);
  });

  it('[CST-01] emits provider-specific cache body controls only when explicitly selected', () => {
    const replay = composeHistoryReplay(fixtureHistory(), 'Instructions', position('snapshot', 10));
    const chat = encodeChatCompletionsRequest(replay.history, { model: 'm', maxOutputTokens: 10, cache: { promptCacheKey: 'key', promptCacheRetention: '24h' } }).body;
    const openRouter = encodeChatCompletionsRequest(replay.history, { model: 'm', maxOutputTokens: 10, cache: { openRouterSessionId: 'session-1' } }).body;
    const responses = encodeResponsesRequest(replay.history, { model: 'm', maxOutputTokens: 10, cache: { promptCacheKey: 'responses-key', promptCacheRetention: 'in_memory' } }).body;
    const anthropicHistory = { ...replay.history, cachePrefixTokenCount: 1024 };
    const anthropic = encodeAnthropicMessagesRequest(anthropicHistory, { model: 'claude-sonnet-4-5', maxOutputTokens: 10, cache: { anthropicEphemeral: true, anthropicCacheMinimumTokens: 1024 } }).body;
    const noCache = encodeChatCompletionsRequest(replay.history, { model: 'm', maxOutputTokens: 10 }).body;

    expect(chat).toMatchObject({ prompt_cache_key: 'key', prompt_cache_retention: '24h' });
    expect(chat).not.toHaveProperty('session_id');
    expect(openRouter).toHaveProperty('session_id', 'session-1');
    expect(responses).toMatchObject({ prompt_cache_key: 'responses-key', prompt_cache_retention: 'in_memory' });
    expect(anthropic.system).toBe(replay.history.instructions);
    expect((anthropic.messages as Array<{ content: unknown }>)[2]?.content).toEqual([
      { type: 'text', text: replay.history.records[2]?.text, cache_control: { type: 'ephemeral' } },
    ]);
    expect(noCache).not.toHaveProperty('prompt_cache_key');
  });
});
