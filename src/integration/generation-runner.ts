import { modelConfigurationIdentity } from '../controller/index.js';
import type { ControllerFenceV1, ControllerSnapshotV1, GameController, ModelTurnInterruptionReasonV1 } from '../controller/index.js';
import { composeMoveInput, checkReplayCapacity, accountUsage, createThinkingRecord, latestThinking } from '../history-cost/index.js';
import type { ReplayCapacityLimitsV1 } from '../history-cost/index.js';
import { createTurnBudgets, decideCompletedAnswer } from '../moves/index.js';
import type { TurnBudgetsV1 } from '../moves/index.js';
import type { UsageAccountingV1 } from '../history-cost/usage.js';
import type { StoredGameV1 } from '../storage/index.js';
import type { ArchiveEventV1, HistoryMessageV1 } from '../storage/index.js';
import { readBoundCredentialValues } from '../providers/connections/credential-binding.js';
import {
  createAnthropicMessagesDecoder,
  createChatCompletionsDecoder,
  createResponsesDecoder,
  encodeAnthropicMessagesRequest,
  encodeChatCompletionsRequest,
  encodeResponsesRequest,
} from '../providers/protocols/index.js';
import type { ProtocolGenerationConfig, ProtocolStreamDecoder, ProtocolStreamResult, ProviderProtocol } from '../providers/protocols/index.js';
import { outputTokensForModel, reasoningEffortForModel } from '../providers/model-turn-config.js';
import { classifyConnectionRoute, createManualModelReference, hasCurrentDisclosureConsent, prepareGenerationRequest } from '../providers/connections/index.js';
import type { ConnectionNamespace, ConnectionProfile, ConnectionStore, ConnectionProtocol } from '../providers/connections/index.js';

export interface GenerationRunnerOptions {
  readonly controller: GameController;
  readonly connections: ConnectionStore;
  readonly namespace: ConnectionNamespace;
  /** Hash revision validated with the caller's model selection/diagnostic; never derive this from its numeric configurationRevision. */
  readonly expectedProfileConfigRevision: string | ((selection: import('../controller/index.js').ModelSelection) => string);
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
      readonly recovery: { readonly kind: 'automatic' | 'paused'; readonly detail: string } | null;
      readonly persistence: 'saved-locally' | 'saved-locally-quarantined' | 'not-saved';
    }
  | {
      readonly kind: 'interrupted'; readonly requestId: string; readonly reason: ModelTurnInterruptionReasonV1;
      readonly protocol: ProtocolStreamResult | null; readonly usage: UsageAccountingV1;
      readonly dispatch: 'accepted' | 'rejected'; readonly persistence: 'saved-locally' | 'saved-locally-quarantined' | 'not-saved';
      readonly detail?: string;
    }
  | {
      readonly kind: 'capacity-rejected'; readonly requestId: string; readonly capacity: ReturnType<typeof checkReplayCapacity>;
      readonly dispatch: 'accepted' | 'rejected'; readonly usage: UsageAccountingV1;
      readonly persistence: 'saved-locally' | 'saved-locally-quarantined' | 'not-saved';
    };

const defaultIdFactory = (): string => globalThis.crypto.randomUUID();
const defaultNow = (): number => Date.now();

/** Runs exactly one fenced model request and archives its exact request/received bytes. */
export async function runGenerationTurn(options: GenerationRunnerOptions): Promise<GenerationRunResult> {
  const requestId = (options.idFactory ?? defaultIdFactory)();
  const started = await options.controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: options.controller.snapshot().fence });
  if (started.kind !== 'model-turn-started') return { kind: 'not-started', snapshot: started.snapshot };

  let fence = started.request.fence;
  const now = options.now ?? defaultNow;
  let protocolResult: ProtocolStreamResult | null = null;
  let activeDecoder: ProtocolStreamDecoder | null = null;
  let activeProtocol: ProviderProtocol = 'chat-completions';
  let knownCredentials: readonly string[] = [];
  let persistence: 'saved-locally' | 'saved-locally-quarantined' | 'not-saved' = 'not-saved';
  let dispatch: 'accepted' | 'rejected';
  try {
    if (options.signal?.aborted) throw abortError();
    const selection = started.request.selection;
    const profile = await options.connections.getProfile(options.namespace, selection.connectionId);
    if (!profile) throw new Error('The selected connection profile is unavailable.');
    const expectedProfileConfigRevision = typeof options.expectedProfileConfigRevision === 'function'
      ? options.expectedProfileConfigRevision(selection) : options.expectedProfileConfigRevision;
    if (typeof expectedProfileConfigRevision !== 'string' || expectedProfileConfigRevision.length === 0) {
      throw new Error('A validated connection profile configuration revision is required.');
    }
    if (profile.configRevision !== expectedProfileConfigRevision) {
      throw new Error('The selected connection profile configuration has changed.');
    }
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
    const currentBudgets = persistedBudgets(started.snapshot, fence.side);
    const previousThinking = latestThinking(started.snapshot.checkpoint.history, started.snapshot.checkpoint.rules);
    const replay = composeMoveInput(started.snapshot.checkpoint.rules, options.instructions, {
      snapshotId: requestId,
      budgets: currentBudgets,
      ...(previousThinking === undefined ? {} : { previousThinking }),
      clock: {
        whiteMs: clock.remaining.whiteMs,
        blackMs: clock.remaining.blackMs,
        incrementMs: started.snapshot.checkpoint.clocks.timeControl.incrementMs,
      },
    });
    const reasoningEffort = reasoningEffortForModel(profile.provider, profile.protocol, model, selection.reasoningEffort);
    const config: ProtocolGenerationConfig = {
      ...options.generation,
      model,
      maxOutputTokens: outputTokensForModel(profile.provider, profile.protocol, model),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
    const encoded = encode(protocol, replay.history, config);
    const capacity = checkReplayCapacity(encoded.body, { ...options.capacity, maxOutputTokens: config.maxOutputTokens });
    if (capacity.status === 'rejected') {
      const savedFence = await options.controller.appendModelTurnArchive(fence, {
        kind: 'terminal', requestId, outcome: 'failed', details: { capacity }, messages: [],
      }).catch(() => null);
      if (savedFence !== null) { fence = savedFence; persistence = persistenceFor(options.controller); }
      dispatch = await interrupt(options.controller, fence, 'failed');
      return {
        kind: 'capacity-rejected', requestId, capacity, dispatch,
        usage: usage(requestId, 'failed', protocol, null, now()), persistence,
      };
    }
    const prepared = prepareGenerationRequest(profile, credentials, JSON.stringify(encoded.body), config);
    knownCredentials = credentialValueStrings(readBoundCredentialValues(credentials));
    const persistedRequestFence = await options.controller.appendModelTurnArchive(fence, {
      kind: 'request', requestId, protocol, modelId: model, body: new TextEncoder().encode(JSON.stringify(encoded.body)),
    }, knownCredentials);
    if (persistedRequestFence === null) {
      dispatch = await interrupt(options.controller, fence, 'failed');
      return resultInterrupted(requestId, 'failed', null, dispatch, now(), 'The request could not be saved locally, so it was not sent.', protocol, persistence);
    }
    fence = persistedRequestFence;
    persistence = persistenceFor(options.controller);
    const response = await options.fetch(prepared.url, {
      ...prepared.init,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const responseDecoder = (options.createDecoder ?? defaultDecoder)(protocol, response.status);
    activeDecoder = responseDecoder;
    if (!response.ok) {
      if (response.body) await readBody(response.body, responseDecoder, options.signal, async (bytes) => {
        const nextFence = await persistResponseChunk(options.controller, fence, requestId, bytes, knownCredentials);
        if (nextFence === null) { persistence = 'not-saved'; return; }
        fence = nextFence;
        persistence = persistenceFor(options.controller);
      });
      else if (options.signal?.aborted) responseDecoder.abort();
      protocolResult = responseDecoder.finish();
      const terminalFence = await persistTerminal(options.controller, fence, requestId, 'failed', protocolResult, options.instructions, knownCredentials, replay.history.records.at(-1)?.text ?? '');
      if (terminalFence !== null) { fence = terminalFence; persistence = persistenceFor(options.controller); }
      if (options.signal?.aborted) {
        dispatch = await interrupt(options.controller, fence, 'aborted');
        return resultInterrupted(requestId, 'aborted', protocolResult, dispatch, now(), undefined, protocol, persistence);
      }
      dispatch = await interrupt(options.controller, fence, 'failed');
      return resultInterrupted(requestId, 'failed', protocolResult, dispatch, now(), 'Provider returned a non-success HTTP status.', protocol, persistence);
    }
    if (!response.body) {
      if (options.signal?.aborted) responseDecoder.abort();
      protocolResult = responseDecoder.finish();
    } else {
      await readBody(response.body, responseDecoder, options.signal, async (bytes) => {
        const nextFence = await persistResponseChunk(options.controller, fence, requestId, bytes, knownCredentials);
        if (nextFence === null) throw new Error('The response stream was fenced before it could be saved.');
        fence = nextFence;
        persistence = persistenceFor(options.controller);
      });
      protocolResult = responseDecoder.finish();
    }
    const terminalFence = await persistTerminal(options.controller, fence, requestId,
      protocolResult.terminal === 'complete' ? 'complete' : protocolResult.terminal === 'aborted' ? 'aborted' : 'partial',
      protocolResult, options.instructions, knownCredentials, replay.history.records.at(-1)?.text ?? '');
    if (terminalFence !== null) { fence = terminalFence; persistence = persistenceFor(options.controller); }
    if (options.signal?.aborted) {
      dispatch = await interrupt(options.controller, fence, 'aborted');
      return resultInterrupted(requestId, 'aborted', protocolResult, dispatch, now(), undefined, protocol, persistence);
    }
    const reason = terminalReason(protocolResult);
    if (reason !== null) {
      dispatch = await interrupt(options.controller, fence, reason);
      return resultInterrupted(requestId, reason, protocolResult, dispatch, now(), undefined, protocol, persistence);
    }
    const effect = decideCompletedAnswer({
      budgets: currentBudgets,
      position,
      answer: { answerText: protocolResult.answerText, position },
      modelConfigurationIdentity: fence.modelConfigurationIdentity,
    });
    const applied = await options.controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence, effect });
    dispatch = applied.kind === 'accepted' ? 'accepted' : 'rejected';
    const recovery = dispatch === 'accepted' ? recoveryForEffect(effect, applied.snapshot, started.snapshot, started.request.selection) : null;
    return {
      kind: 'completed', requestId, protocol: protocolResult,
      usage: usage(requestId, 'complete', protocol, protocolResult.usage, now()), dispatch, recovery,
      persistence: persistenceFor(options.controller),
    };
  } catch (error) {
    const reason: ModelTurnInterruptionReasonV1 = isAbort(error, options.signal) ? 'aborted' : 'failed';
    if (protocolResult === null && activeDecoder !== null) {
      if (reason === 'aborted') activeDecoder.abort();
      try { protocolResult = activeDecoder.finish(); } catch { protocolResult = null; }
    }
    const savedFence = await persistTerminal(options.controller, fence, requestId, reason === 'aborted' ? 'aborted' : 'failed',
      protocolResult, options.instructions, knownCredentials, '').catch(() => null);
    if (savedFence !== null) { fence = savedFence; persistence = persistenceFor(options.controller); }
    dispatch = await interrupt(options.controller, fence, reason);
    return resultInterrupted(requestId, reason, protocolResult, dispatch, now(), error instanceof Error ? error.message : 'Generation request failed.', activeProtocol,
      persistence);
  }
}

function recoveryForEffect(
  effect: ReturnType<typeof decideCompletedAnswer>,
  finalSnapshot: ControllerSnapshotV1,
  startedSnapshot: ControllerSnapshotV1,
  selection: import('../controller/index.js').ModelSelection,
): { readonly kind: 'automatic' | 'paused'; readonly detail: string } | null {
  if (finalSnapshot.checkpoint.result.kind !== 'unresolved') return null;
  if (effect.kind === 'illegal-attempt') return { kind: 'automatic', detail: effect.correction };
  if (effect.kind !== 'format-correction') return null;
  const candidateAttempt = startedSnapshot.modelHandoff.queued?.state === 'awaiting-first-reply' &&
    startedSnapshot.modelHandoff.producing !== null &&
    modelConfigurationIdentity(startedSnapshot.modelHandoff.producing) !== modelConfigurationIdentity(startedSnapshot.modelHandoff.committed ?? selection);
  const candidateFailed = candidateAttempt && finalSnapshot.modelHandoff.queued?.state === 'failed';
  return effect.automatic && !candidateFailed
    ? { kind: 'automatic', detail: effect.correction }
    : { kind: 'paused', detail: effect.correction };
}

async function readBody(body: ReadableStream<Uint8Array>, decoder: ProtocolStreamDecoder, signal?: AbortSignal, onChunk?: (bytes: Uint8Array) => Promise<void>): Promise<void> {
  const reader = body.getReader();
  let buffered: Uint8Array[] = [];
  let bufferedLength = 0;
  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) return;
    const joined = new Uint8Array(bufferedLength);
    let offset = 0;
    for (const part of buffered) { joined.set(part, offset); offset += part.length; }
    buffered = [];
    bufferedLength = 0;
    await onChunk?.(joined);
  };
  const collect = async (bytes: Uint8Array): Promise<void> => {
    buffered.push(new Uint8Array(bytes));
    bufferedLength += bytes.length;
    if (bufferedLength >= 16 * 1024) await flush();
  };
  let aborted = false;
  const cancel = (): void => {
    if (aborted) return;
    aborted = true;
    decoder.abort();
    // Cancellation can race a pending read and can itself reject for custom streams.
    // The read loop observes the signal and remains the single completion path.
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) { cancel(); return; }
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch (error) {
        if (signal?.aborted) { cancel(); return; }
        throw error;
      }
      const { done, value } = item;
      if (signal?.aborted) {
        if (!done) { decoder.push(value); await collect(value); }
        cancel();
        await flush();
        return;
      }
      if (done) { await flush(); return; }
      decoder.push(value);
      await collect(value);
    }
  } finally {
    await flush();
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function encode(protocol: ProviderProtocol, history: ReturnType<typeof composeMoveInput>['history'], config: ProtocolGenerationConfig) {
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

/** Remaining recovery budgets of the side to move, restored from the durable checkpoint. */
export function persistedBudgets(snapshot: ControllerSnapshotV1, side: 'white' | 'black'): TurnBudgetsV1 {
  const checkpoint = snapshot.checkpoint;
  const producing = snapshot.modelHandoff.producing;
  const committed = checkpoint.selections.players[side];
  if (producing !== null && committed.kind === 'model' &&
      JSON.stringify([producing.providerId, producing.connectionId, producing.configurationRevision, producing.modelRoutingId, producing.protocol]) !==
      JSON.stringify([committed.providerId, committed.connectionId, committed.configurationRevision, committed.modelRoutingId, committed.protocol])) {
    return createTurnBudgets();
  }
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

async function persistResponseChunk(controller: GameController, fence: ControllerFenceV1, requestId: string, bytes: Uint8Array, credentials: readonly string[]) {
  return controller.appendModelTurnArchive(fence, { kind: 'response-chunk', requestId, bytes }, credentials);
}

async function persistTerminal(
  controller: GameController, fence: ControllerFenceV1, requestId: string,
  outcome: 'complete' | 'partial' | 'failed' | 'aborted', result: ProtocolStreamResult | null,
  instructions: string, credentials: readonly string[], currentInput: string,
) {
  const requestUsage = usage(requestId,
    outcome === 'complete' ? 'complete' : outcome === 'partial' ? 'incomplete' : outcome,
    result?.protocol ?? 'chat-completions', result?.usage ?? null, Date.now());
  return controller.appendModelTurnArchive(fence, {
    kind: 'terminal', requestId, outcome,
    details: { usage: requestUsage, protocolResult: result },
    messages: result === null ? (currentInput.length > 0 ? [{ role: 'user' as const, content: currentInput }] : []) : messagesFromResult(instructions, result, currentInput),
  }, credentials);
}

function messagesFromResult(_instructions: string, result: ProtocolStreamResult, currentInput: string): HistoryMessageV1[] {
  const messages: HistoryMessageV1[] = [{ role: 'user', content: currentInput } as HistoryMessageV1];
  for (const [role, content] of [
    ['assistant', result.answerText], ['assistant', result.reasoningText], ['assistant', result.planText], ['assistant', result.refusalText],
  ] as const) {
    if (content.length > 0) messages.push({ role, content } as HistoryMessageV1);
  }
  const thinking = createThinkingRecord(currentInput, result);
  if (thinking !== null) messages.push({ role: 'assistant', content: thinking } as HistoryMessageV1);
  const opaque = {
    protocol: result.protocol,
    unknownEvents: result.unknownEvents,
    otherChoices: result.otherChoices,
    toolRecords: result.toolRecords,
    errors: result.errors,
    incompleteDetails: result.incompleteDetails,
    raw: result.raw,
  };
  if (JSON.stringify(opaque) !== JSON.stringify({ protocol: result.protocol, unknownEvents: [], otherChoices: [], toolRecords: [], errors: [], incompleteDetails: [], raw: { chunks: [], events: [] } })) {
    messages.push({ role: 'assistant', content: JSON.stringify({ kind: 'opaque-provider-record', ...opaque }) } as HistoryMessageV1);
  }
  return messages;
}

function credentialValueStrings(credentials: ReturnType<typeof readBoundCredentialValues>): readonly string[] {
  return [...new Set([credentials.apiKey, ...Object.values(credentials.headers ?? {})]
    .filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function persistenceFor(controller: GameController): 'saved-locally' | 'saved-locally-quarantined' | 'not-saved' {
  return controller.snapshot().checkpoint?.archive?.egressStatus === 'credential-echo-quarantined'
    ? 'saved-locally-quarantined' : 'saved-locally';
}

export interface GenerationJournalV1 {
  retainedEvents: ArchiveEventV1[];
  discardedEvents: ArchiveEventV1[];
  retainedMessages: HistoryMessageV1[];
  discardedMessages: HistoryMessageV1[];
}

/** Returns archive-backed transcript rows without collapsing discarded Undo history. */
export function getGenerationJournal(snapshot: StoredGameV1): GenerationJournalV1 {
  const events = new Map(snapshot.events.map((event) => [event.eventId, event]));
  const currentIds = new Set(snapshot.checkpoint.archive.currentLine.eventIds);
  const discardedIds = new Set(snapshot.checkpoint.archive.discardedLines.flatMap((line) => line.eventIds));
  const retainedMessages = snapshot.checkpoint.history.messages.filter((message) => message.disposition === 'retained');
  const discardedMessages = snapshot.checkpoint.history.messages.filter((message) => message.disposition === 'discarded');
  return {
    retainedEvents: [...currentIds].map((id) => events.get(id)).filter((event): event is ArchiveEventV1 => event !== undefined),
    discardedEvents: [...discardedIds].map((id) => events.get(id)).filter((event): event is ArchiveEventV1 => event !== undefined),
    retainedMessages, discardedMessages,
  };
}

function resultInterrupted(requestId: string, reason: ModelTurnInterruptionReasonV1, protocol: ProtocolStreamResult | null, dispatch: 'accepted' | 'rejected', now: number, detail?: string, fallbackProtocol: ProviderProtocol = 'chat-completions', persistence: 'saved-locally' | 'saved-locally-quarantined' | 'not-saved' = 'not-saved'): GenerationRunResult {
  return {
    kind: 'interrupted', requestId, reason, protocol, dispatch,
    usage: usage(requestId, reason, protocol?.protocol ?? fallbackProtocol, protocol?.usage ?? null, now),
    persistence, ...(detail === undefined ? {} : { detail }),
  };
}

function abortError(): Error { const error = new Error('Generation request was aborted.'); error.name = 'AbortError'; return error; }
function isAbort(error: unknown, signal?: AbortSignal): boolean { return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError'); }
