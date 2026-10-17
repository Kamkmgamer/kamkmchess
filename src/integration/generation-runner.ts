import type { ControllerFenceV1, ControllerSnapshotV1, GameController, ModelTurnInterruptionReasonV1 } from '../controller/index.js';
import { composeHistoryReplay, checkReplayCapacity, accountUsage } from '../history-cost/index.js';
import type { ReplayCapacityLimitsV1 } from '../history-cost/index.js';
import { createTurnBudgets, decideCompletedAnswer } from '../moves/index.js';
import type { TurnBudgetsV1 } from '../moves/index.js';
import type { UsageAccountingV1 } from '../history-cost/usage.js';
import {
  createAnthropicMessagesDecoder,
  createChatCompletionsDecoder,
  createResponsesDecoder,
  encodeAnthropicMessagesRequest,
  encodeChatCompletionsRequest,
  encodeResponsesRequest,
} from '../providers/protocols/index.js';
import type { ProtocolGenerationConfig, ProtocolStreamDecoder, ProtocolStreamResult, ProviderProtocol } from '../providers/protocols/index.js';
import { classifyConnectionRoute, createManualModelReference, hasCurrentDisclosureConsent, prepareGenerationRequest } from '../providers/connections/index.js';
import type { ConnectionNamespace, ConnectionProfile, ConnectionStore, ConnectionProtocol } from '../providers/connections/index.js';

export interface GenerationRunnerOptions {
  readonly controller: GameController;
  readonly connections: ConnectionStore;
  readonly namespace: ConnectionNamespace;
  readonly instructions: string;
  readonly generation: Omit<ProtocolGenerationConfig, 'model'>;
  readonly capacity: ReplayCapacityLimitsV1;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly idFactory?: () => string;
  readonly now?: () => number;
  readonly createDecoder?: (protocol: ProviderProtocol, status: number) => ProtocolStreamDecoder;
}

export type GenerationRunResult =
  | { readonly kind: 'not-started'; readonly snapshot: ControllerSnapshotV1 }
  | {
      readonly kind: 'completed'; readonly requestId: string; readonly protocol: ProtocolStreamResult;
      readonly usage: UsageAccountingV1; readonly dispatch: 'accepted' | 'rejected';
      readonly persistence: 'EPHEMERAL NOT PERSISTED';
    }
  | {
      readonly kind: 'interrupted'; readonly requestId: string; readonly reason: ModelTurnInterruptionReasonV1;
      readonly protocol: ProtocolStreamResult | null; readonly usage: UsageAccountingV1;
      readonly dispatch: 'accepted' | 'rejected'; readonly persistence: 'EPHEMERAL NOT PERSISTED';
      readonly detail?: string;
    }
  | {
      readonly kind: 'capacity-rejected'; readonly requestId: string; readonly capacity: ReturnType<typeof checkReplayCapacity>;
      readonly dispatch: 'accepted' | 'rejected'; readonly usage: UsageAccountingV1;
      readonly persistence: 'EPHEMERAL NOT PERSISTED';
    };

const defaultIdFactory = (): string => globalThis.crypto.randomUUID();
const defaultNow = (): number => Date.now();

/** Runs exactly one fenced model request. It never retries or persists usage. */
export async function runGenerationTurn(options: GenerationRunnerOptions): Promise<GenerationRunResult> {
  const requestId = (options.idFactory ?? defaultIdFactory)();
  const started = await options.controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: options.controller.snapshot().fence });
  if (started.kind !== 'model-turn-started') return { kind: 'not-started', snapshot: started.snapshot };

  const fence = started.request.fence;
  const now = options.now ?? defaultNow;
  let protocolResult: ProtocolStreamResult | null = null;
  let activeDecoder: ProtocolStreamDecoder | null = null;
  let activeProtocol: ProviderProtocol = 'chat-completions';
  let dispatch: 'accepted' | 'rejected';
  try {
    if (options.signal?.aborted) throw abortError();
    const selection = started.snapshot.checkpoint.selections.players[fence.side];
    if (selection.kind !== 'model') throw new Error('The active side has no model selection.');
    const profile = await options.connections.getProfile(options.namespace, selection.connectionId);
    if (!profile) throw new Error('The selected connection profile is unavailable.');
    const protocol = protocolForSelection(profile, selection.protocol);
    activeProtocol = protocol;
    if (profile.provider !== selection.providerId) throw new Error('The selected provider does not match the saved connection.');
    const route = classifyConnectionRoute(profile);
    if (route.evidence === 'unverified') throw new Error(`The configured route is unverified: ${route.statement}`);
    const disclosure = await options.connections.getDisclosureChoice(options.namespace, profile);
    if (!hasCurrentDisclosureConsent(profile, disclosure)) throw new Error('Current first-request disclosure consent is required.');
    const resolution = await options.connections.resolveCredentials(options.namespace, profile);
    if (resolution.status !== 'bound') throw new Error(`Connection credentials are not bound (${resolution.status}).`);
    const credentials = resolution.credentials;
    const model = createManualModelReference(profile, selection.modelRoutingId).requestedModelId;
    const clock = started.request.clockReading;
    if (clock.status !== 'running') throw new Error('The model turn has no running clock reading.');
    const position = started.request.position;
    const replay = composeHistoryReplay(started.snapshot.checkpoint.history, options.instructions, {
      snapshotId: requestId,
      fen: position.fen,
      pieces: position.pieces.map((piece) => ({
        square: piece.square,
        piece: `${piece.color === 'w' ? 'white' : 'black'}-${piece.type}`,
        color: piece.color === 'w' ? 'white' : 'black',
      })),
      sideToMove: position.sideToMove === 'w' ? 'white' : 'black',
      colors: { white: 'white', black: 'black' },
      clock: {
        sampledAtMs: clock.evidence.observedAt.wallTimeMs,
        whiteMs: clock.remaining.whiteMs,
        blackMs: clock.remaining.blackMs,
        activeSide: clock.activeSide,
        startingTimeMs: started.snapshot.checkpoint.clocks.timeControl.startingTimeMs,
        incrementMs: started.snapshot.checkpoint.clocks.timeControl.incrementMs,
      },
    });
    const config: ProtocolGenerationConfig = { ...options.generation, model };
    const encoded = encode(protocol, replay.history, config);
    const capacity = checkReplayCapacity(encoded.body, { ...options.capacity, maxOutputTokens: config.maxOutputTokens });
    if (capacity.status === 'rejected') {
      dispatch = await interrupt(options.controller, fence, 'failed');
      return {
        kind: 'capacity-rejected', requestId, capacity, dispatch,
        usage: usage(requestId, 'failed', protocol, null, now()), persistence: 'EPHEMERAL NOT PERSISTED',
      };
    }
    const prepared = prepareGenerationRequest(profile, credentials, JSON.stringify(encoded.body), config);
    const response = await options.fetch(prepared.url, {
      ...prepared.init,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const responseDecoder = (options.createDecoder ?? defaultDecoder)(protocol, response.status);
    activeDecoder = responseDecoder;
    if (!response.ok) {
      if (response.body) await readBody(response.body, responseDecoder);
      protocolResult = responseDecoder.finish();
      dispatch = await interrupt(options.controller, fence, 'failed');
      return resultInterrupted(requestId, 'failed', protocolResult, dispatch, now(), 'Provider returned a non-success HTTP status.', protocol);
    }
    if (!response.body) {
      protocolResult = responseDecoder.finish();
    } else {
      await readBody(response.body, responseDecoder, options.signal);
      if (options.signal?.aborted) responseDecoder.abort();
      protocolResult = responseDecoder.finish();
    }
    const reason = terminalReason(protocolResult);
    if (reason !== null) {
      dispatch = await interrupt(options.controller, fence, reason);
      return resultInterrupted(requestId, reason, protocolResult, dispatch, now(), undefined, protocol);
    }
    const currentBudgets = persistedBudgets(started.snapshot, fence.side);
    const effect = decideCompletedAnswer({
      budgets: currentBudgets,
      position,
      answer: { answerText: protocolResult.answerText, position },
      modelConfigurationIdentity: fence.modelConfigurationIdentity,
    });
    const applied = await options.controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence, effect });
    dispatch = applied.kind === 'accepted' ? 'accepted' : 'rejected';
    return {
      kind: 'completed', requestId, protocol: protocolResult,
      usage: usage(requestId, 'complete', protocol, protocolResult.usage, now()), dispatch,
      persistence: 'EPHEMERAL NOT PERSISTED',
    };
  } catch (error) {
    const reason: ModelTurnInterruptionReasonV1 = isAbort(error, options.signal) ? 'aborted' : 'failed';
    if (protocolResult === null && activeDecoder !== null) {
      if (reason === 'aborted') activeDecoder.abort();
      try { protocolResult = activeDecoder.finish(); } catch { protocolResult = null; }
    }
    dispatch = await interrupt(options.controller, fence, reason);
    return resultInterrupted(requestId, reason, protocolResult, dispatch, now(), error instanceof Error ? error.message : 'Generation request failed.', activeProtocol);
  }
}

async function readBody(body: ReadableStream<Uint8Array>, decoder: ProtocolStreamDecoder, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) { decoder.abort(); return; }
      const { done, value } = await reader.read();
      if (done) return;
      decoder.push(value);
    }
  } finally { reader.releaseLock(); }
}

function encode(protocol: ProviderProtocol, history: ReturnType<typeof composeHistoryReplay>['history'], config: ProtocolGenerationConfig) {
  switch (protocol) {
    case 'chat-completions': return encodeChatCompletionsRequest(history, config);
    case 'responses': return encodeResponsesRequest(history, config);
    case 'anthropic-messages': return encodeAnthropicMessagesRequest(history, config);
  }
}

function defaultDecoder(protocol: ProviderProtocol, status: number): ProtocolStreamDecoder {
  const metadata = { httpStatus: status };
  switch (protocol) {
    case 'chat-completions': return createChatCompletionsDecoder(metadata);
    case 'responses': return createResponsesDecoder(metadata);
    case 'anthropic-messages': return createAnthropicMessagesDecoder(metadata);
  }
}

function protocolForSelection(profile: ConnectionProfile, selected: string): ProviderProtocol {
  const selectedProtocol: ConnectionProtocol = selected === 'custom' ? profile.protocol : selected as ConnectionProtocol;
  if (selectedProtocol !== profile.protocol) throw new Error('The selected protocol does not match the connection profile.');
  switch (profile.protocol) {
    case 'chat-completions': return 'chat-completions';
    case 'responses': return 'responses';
    case 'messages': return 'anthropic-messages';
  }
}

function persistedBudgets(snapshot: ControllerSnapshotV1, side: 'white' | 'black'): TurnBudgetsV1 {
  const checkpoint = snapshot.checkpoint;
  const attempts = 4 - checkpoint.budgets.illegalMoveAttemptsRemaining[side];
  const section = checkpoint.extensions['move-attempts'];
  const data = section?.version === 1 && section.data !== null && typeof section.data === 'object'
    ? section.data as Record<string, unknown> : {};
  const rawRecords = data[side];
  const attemptRecords = Array.isArray(rawRecords) ? rawRecords as TurnBudgetsV1['attemptRecords'] : [];
  return {
    ...createTurnBudgets(),
    illegalMoveAttempts: attempts,
    formatCorrections: 3 - checkpoint.budgets.formattingCorrectionsRemaining,
    manualRetries: checkpoint.budgets.manualRetriesBySide[side],
    attemptRecords,
  };
}

async function interrupt(controller: GameController, fence: ControllerFenceV1, reason: ModelTurnInterruptionReasonV1): Promise<'accepted' | 'rejected'> {
  const result = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-interrupted', fence, reason });
  return result.kind === 'accepted' ? 'accepted' : 'rejected';
}

function terminalReason(result: ProtocolStreamResult): ModelTurnInterruptionReasonV1 | null {
  // Provider-level refusal metadata is not an authored chess resignation.
  if (result.terminal === 'complete' && result.content === 'answer') return null;
  if (result.content === 'refusal') return 'failed';
  if (result.terminal === 'aborted') return 'aborted';
  if (result.terminal === 'failed') return 'failed';
  return 'incomplete';
}

function usage(requestId: string, outcome: UsageAccountingV1['outcome'], protocol: ProviderProtocol, rawUsage: unknown | null, recordedAtMs: number): UsageAccountingV1 {
  return accountUsage({
    requestId, purpose: 'move', outcome,
    recordedAt: new Date(recordedAtMs).toISOString(), protocol, rawUsage,
  });
}

function resultInterrupted(requestId: string, reason: ModelTurnInterruptionReasonV1, protocol: ProtocolStreamResult | null, dispatch: 'accepted' | 'rejected', now: number, detail?: string, fallbackProtocol: ProviderProtocol = 'chat-completions'): GenerationRunResult {
  return {
    kind: 'interrupted', requestId, reason, protocol, dispatch,
    usage: usage(requestId, reason, protocol?.protocol ?? fallbackProtocol, protocol?.usage ?? null, now),
    persistence: 'EPHEMERAL NOT PERSISTED', ...(detail === undefined ? {} : { detail }),
  };
}

function abortError(): Error { const error = new Error('Generation request was aborted.'); error.name = 'AbortError'; return error; }
function isAbort(error: unknown, signal?: AbortSignal): boolean { return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError'); }
