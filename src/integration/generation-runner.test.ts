import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { parsePosition } from '../rules/index.js';
import type { GameController, ControllerSnapshotV1 } from '../controller/index.js';
import type { ProtocolStreamDecoder, ProtocolStreamResult, ProviderProtocol } from '../providers/protocols/index.js';
import { createConnectionProfile, openConnectionStore } from '../providers/connections/index.js';
import type { ConnectionStore } from '../providers/connections/index.js';
import { runGenerationTurn } from './generation-runner.js';

const fence = {
  schemaVersion: 1 as const, gameId: 'runner-game', segmentId: 'runner-segment', side: 'white' as const,
  revision: 4, positionRevision: 2, requestGeneration: 3, analysisGeneration: 0,
  ownershipEpoch: 0, modelConfigurationIdentity: '["openrouter","runner-connection",1,"fixture-model","chat-completions"]',
};

function protocolResult(overrides: Partial<ProtocolStreamResult> = {}): ProtocolStreamResult {
  return {
    protocol: 'chat-completions', terminal: 'complete', content: 'answer', answerText: '{"move":"e2e4"}',
    reasoningText: 'e7e5', planText: 'g1f3', refusalText: '', usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } },
    usageRecords: [], errors: [], incompleteDetails: [], toolRecords: [], otherChoices: [], unknownEvents: [],
    raw: { chunks: [], events: [] }, ...overrides,
  };
}

async function fixture(options: { capacityBytes?: number; staleEffect?: boolean } = {}) {
  const namespace = { kind: 'guest' as const };
  const profile = await createConnectionProfile({ id: 'runner-connection', name: 'Runner', provider: 'openrouter' });
  const connections = await openConnectionStore({ databaseName: `runner-connections-${crypto.randomUUID()}`, factory: new IDBFactory() });
  await connections.saveProfile(namespace, profile);
  await connections.assignCredential(namespace, profile.id, { apiKey: 'synthetic-key' });
  await connections.recordDisclosureChoice(namespace, profile, { decision: 'accepted', recordedAtMs: 1_000 });
  const position = parsePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const checkpoint = {
    gameId: 'runner-game', segmentId: 'runner-segment', history: { currentSegmentId: 'runner-segment', segments: [], messages: [] },
    selections: { players: { white: { kind: 'model' as const, providerId: 'openrouter', connectionId: profile.id,
      configurationRevision: 1, modelRoutingId: 'fixture-model', protocol: 'chat-completions' as const, diagnostic: 'passed-current-session' as const }, black: { kind: 'human' as const } } },
    clocks: { timeControl: { startingTimeMs: 60_000, incrementMs: 0 } },
    budgets: { illegalMoveAttemptsRemaining: { white: 4, black: 4 }, formattingCorrectionsRemaining: 3, manualRetriesBySide: { white: 0, black: 0 } },
    extensions: {},
  };
  const clockReading = {
    status: 'running' as const, activeSide: 'white' as const, remaining: { whiteMs: 60_000, blackMs: 60_000 }, elapsedMs: 0,
    deadline: { monotonicMs: null, wallTimeMs: 61_000, hostTimeMs: null },
    evidence: { basis: 'monotonic' as const, assurance: 'same-process-assumption' as const,
      anchor: { monotonicMs: 0, wallTimeMs: 1_000 }, observedAt: { monotonicMs: 0, wallTimeMs: 1_000 },
      elapsed: { monotonicMs: 0, wallMs: 0, hostAdjustedMs: null }, maxObservedDivergenceMs: 0 },
  };
  const snapshot = { checkpoint, position, clockReading, fence } as unknown as ControllerSnapshotV1;
  let stopped = false;
  const dispatch = vi.fn(async (intent: { kind: string }) => {
    if (intent.kind === 'begin-model-turn') return { kind: 'model-turn-started', snapshot, request: { fence, position, clockReading } } as never;
    if (intent.kind === 'stop-model-turn') { stopped = true; return { kind: 'accepted', snapshot } as never; }
    if (intent.kind === 'model-turn-effect' && (stopped || options.staleEffect)) return { kind: 'rejected', reason: 'not-actionable', snapshot } as never;
    return { kind: 'accepted', snapshot } as never;
  });
  const controller = { snapshot: () => snapshot, dispatch } as unknown as GameController;
  return {
    profile, connections, controller, dispatch,
    options: {
      controller, connections: connections as ConnectionStore, namespace, instructions: 'Play one legal move.',
      generation: { maxOutputTokens: 100 }, capacity: { maxRequestBytes: options.capacityBytes ?? 10_000, maxOutputTokens: 100 },
      idFactory: () => 'stable-runner-request', now: () => 2_000,
    },
  };
}

function decoder(result: ProtocolStreamResult): (protocol: ProviderProtocol, status: number) => ProtocolStreamDecoder {
  return (_protocol, status) => ({
    push: () => undefined,
    abort: () => undefined,
    finish: () => ({ ...result, httpStatus: status }),
  });
}

const response = (): Response => new Response(new Uint8Array([1]), { status: 200 });

describe('generation composition runner', () => {
  it('classifies only the completed answer and returns ephemeral usage attribution', async () => {
    const f = await fixture();
    const result = await runGenerationTurn({
      ...f.options, fetch: vi.fn(async () => response()), createDecoder: decoder(protocolResult()),
    });
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Expected completed request.');
    expect(result.requestId).toBe('stable-runner-request');
    expect(result.usage).toMatchObject({ requestId: result.requestId, rawUsage: { prompt_tokens: 20 }, status: 'unknown' });
    expect(result.persistence).toBe('EPHEMERAL NOT PERSISTED');
    expect(f.dispatch.mock.calls.map(([intent]) => intent.kind)).toEqual(['begin-model-turn', 'model-turn-effect']);
    expect(f.dispatch.mock.calls[1]?.[0]).toMatchObject({ fence, effect: { kind: 'accepted-move', move: { from: 'e2', to: 'e4' } } });
  });

  it.each([
    ['incomplete', protocolResult({ terminal: 'truncated', content: 'empty', answerText: '' }), undefined, 'incomplete'],
    ['provider failure', protocolResult({ terminal: 'failed', content: 'empty', answerText: '', errors: [{ message: 'fixture provider error' }] }), undefined, 'failed'],
    ['abort', null, Object.assign(new Error('aborted'), { name: 'AbortError' }), 'aborted'],
  ] as const)('interrupts %s without classifying provider content', async (_label, streamResult, fetchError, reason) => {
    const f = await fixture();
    const runFetch = fetchError
      ? vi.fn(async () => { throw fetchError; })
      : vi.fn(async () => response());
    const result = await runGenerationTurn({
      ...f.options, fetch: runFetch,
      ...(streamResult === null ? {} : { createDecoder: decoder(streamResult) }),
    });
    expect(result.kind).toBe('interrupted');
    if (result.kind !== 'interrupted') throw new Error('Expected interruption.');
    expect(result.reason).toBe(reason);
    expect(result.usage.requestId).toBe('stable-runner-request');
    expect(f.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'model-turn-interrupted', fence, reason });
    expect(f.dispatch.mock.calls.some(([intent]) => intent.kind === 'model-turn-effect')).toBe(false);
  });

  it('rejects excess request capacity before transport', async () => {
    const f = await fixture({ capacityBytes: 1 });
    const fetch = vi.fn(async () => response());
    const result = await runGenerationTurn({ ...f.options, fetch, createDecoder: decoder(protocolResult()) });
    expect(result.kind).toBe('capacity-rejected');
    expect(fetch).not.toHaveBeenCalled();
    expect(f.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'model-turn-interrupted', reason: 'failed', fence });
  });

  it('keeps a completed late response fenced after Stop wins the race', async () => {
    const f = await fixture();
    let releaseResponse: ((value: Response) => void) | undefined;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; }));
    const running = runGenerationTurn({ ...f.options, fetch, createDecoder: decoder(protocolResult()) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await f.controller.dispatch({ schemaVersion: 1, kind: 'stop-model-turn', fence });
    releaseResponse?.(response());
    const result = await running;
    expect(result).toMatchObject({ kind: 'completed', dispatch: 'rejected' });
    expect(f.dispatch.mock.calls.map(([intent]) => intent.kind)).toEqual(['begin-model-turn', 'stop-model-turn', 'model-turn-effect']);
    expect(f.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'model-turn-effect', fence });
  });
});
