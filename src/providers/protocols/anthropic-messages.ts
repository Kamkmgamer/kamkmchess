import {
  createProtocolState,
  createSseProtocolDecoder,
  type ProtocolDecoderState,
} from './decoder-base';
import { validateGenerationConfig } from './request-config';
import type {
  EncodedProtocolRequest,
  ProtocolGenerationConfig,
  ProtocolHistory,
  ProtocolRawEvent,
  ProtocolStreamMetadata,
  ProtocolStreamDecoder,
} from './types';

interface AnthropicBlock {
  type: string;
  startData: string;
  text: string;
  thinking: string;
  stopped: boolean;
  unsupported: boolean;
}

interface AnthropicState extends ProtocolDecoderState {
  blocks: Map<number, AnthropicBlock>;
  messageStartSeen: boolean;
  messageStartData: string | undefined;
  messageDeltaSeen: boolean;
  messageStopSeen: boolean;
  stopReason: string | undefined;
  terminalData: string | undefined;
  failed: boolean;
  unsupportedRepresentation: boolean;
}

const knownEvents = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
]);

export function createAnthropicMessagesDecoder(
  metadata?: ProtocolStreamMetadata,
): ProtocolStreamDecoder {
  const state: AnthropicState = {
    ...createProtocolState(),
    blocks: new Map(),
    messageStartSeen: false,
    messageStartData: undefined,
    messageDeltaSeen: false,
    messageStopSeen: false,
    stopReason: undefined,
    terminalData: undefined,
    failed: false,
    unsupportedRepresentation: false,
  };

  return createSseProtocolDecoder(
    'anthropic-messages',
    state,
    consumeAnthropicEvent,
    finalizeAnthropic,
    metadata,
  );
}

export function encodeAnthropicMessagesRequest(
  history: ProtocolHistory,
  config: ProtocolGenerationConfig,
): EncodedProtocolRequest {
  validateGenerationConfig(config);
  const body: Record<string, unknown> = {
    model: config.model,
    system: history.instructions,
    messages: history.records.map((record) => ({
      role: record.role,
      content: record.text,
    })),
    stream: true,
    max_tokens: config.maxOutputTokens,
  };
  const prefixTokenCount = history.cachePrefixTokenCount;
  const minimumCacheTokens = config.cache?.anthropicCacheMinimumTokens;
  const prefixRecordCount = history.cachePrefixRecordCount;
  if (
    config.cache?.anthropicEphemeral === true &&
    typeof prefixTokenCount === 'number' &&
    typeof minimumCacheTokens === 'number' &&
    typeof prefixRecordCount === 'number' &&
    Number.isSafeInteger(prefixTokenCount) &&
    Number.isSafeInteger(minimumCacheTokens) &&
    Number.isSafeInteger(prefixRecordCount) &&
    minimumCacheTokens > 0 &&
    prefixTokenCount >= minimumCacheTokens &&
    prefixRecordCount > 0 &&
    prefixRecordCount <= history.records.length
  ) {
    const cacheControl = { type: 'ephemeral' };
    const prefixEnd = prefixRecordCount - 1;
    if (prefixEnd >= 0) {
      body.messages = history.records.map((record, index) => ({
        role: record.role,
        content: index === prefixEnd
          ? [{ type: 'text', text: record.text, cache_control: cacheControl }]
          : record.text,
      }));
    }
  }
  if (config.temperature !== undefined) {
    body.temperature = config.temperature;
  }
  if (config.topP !== undefined) {
    body.top_p = config.topP;
  }

  return {
    body,
    sourceRecordIds: history.records.map((record) => record.id),
  };
}

function consumeAnthropicEvent(
  event: ProtocolRawEvent,
  base: ProtocolDecoderState,
): void {
  const state = base as AnthropicState;

  if (event.parseError !== undefined) {
    state.malformed = true;
    return;
  }
  if (event.data.length === 0) {
    return;
  }
  if (!isRecord(event.payload)) {
    state.malformed = true;
    return;
  }

  const payload = event.payload;
  const type = payload.type;
  if (typeof type !== 'string') {
    if (knownEvents.has(event.event)) {
      state.malformed = true;
    } else {
      state.unknownEvents.push(event);
    }
    return;
  }
  if (event.event !== type) {
    state.malformed = true;
    return;
  }
  if (state.messageStopSeen) {
    if (type === 'message_stop' && event.data === state.terminalData) {
      return;
    }
    state.malformed = true;
    return;
  }
  if (!knownEvents.has(type)) {
    state.unknownEvents.push(event);
    return;
  }
  if (
    state.messageDeltaSeen &&
    (type === 'content_block_start' ||
      type === 'content_block_delta' ||
      type === 'content_block_stop')
  ) {
    state.malformed = true;
    return;
  }

  switch (type) {
    case 'error':
      state.errors.push(payload);
      state.failed = true;
      return;
    case 'ping':
      return;
    case 'message_start':
      startMessage(event, payload, state);
      return;
    case 'content_block_start':
      startBlock(event, payload, state);
      return;
    case 'content_block_delta':
      updateBlock(event, payload, state);
      return;
    case 'content_block_stop':
      stopBlock(payload, state);
      return;
    case 'message_delta':
      updateMessage(payload, state);
      return;
    case 'message_stop':
      state.messageStopSeen = true;
      state.terminalData = event.data;
      return;
    default:
      state.unknownEvents.push(event);
  }
}

function startMessage(
  event: ProtocolRawEvent,
  payload: Record<string, unknown>,
  state: AnthropicState,
): void {
  if (state.messageStartSeen) {
    if (state.messageStartData !== event.data) {
      state.malformed = true;
    }
    return;
  }
  if (
    !isRecord(payload.message) ||
    payload.message.type !== 'message' ||
    payload.message.role !== 'assistant'
  ) {
    state.malformed = true;
    return;
  }

  state.messageStartSeen = true;
  state.messageStartData = event.data;
  if (isRecord(payload.message.usage)) {
    state.usage = payload.message.usage;
    state.usageRecords.push(payload.message.usage);
  }
}

function startBlock(
  event: ProtocolRawEvent,
  payload: Record<string, unknown>,
  state: AnthropicState,
): void {
  if (
    !state.messageStartSeen ||
    !Number.isInteger(payload.index) ||
    (payload.index as number) < 0
  ) {
    state.malformed = true;
    return;
  }
  if (!isRecord(payload.content_block) || typeof payload.content_block.type !== 'string') {
    state.malformed = true;
    return;
  }

  const index = payload.index as number;
  const existing = state.blocks.get(index);
  if (existing !== undefined) {
    if (existing.startData !== event.data) {
      state.malformed = true;
    }
    return;
  }

  const block: AnthropicBlock = {
    type: payload.content_block.type,
    startData: event.data,
    text: typeof payload.content_block.text === 'string' ? payload.content_block.text : '',
    thinking:
      typeof payload.content_block.thinking === 'string'
        ? payload.content_block.thinking
        : '',
    stopped: false,
    unsupported: !isKnownBlockType(payload.content_block.type),
  };
  state.blocks.set(index, block);
  if (block.unsupported) {
    state.unsupportedRepresentation = true;
    state.incompleteDetails.push({
      reason: 'unsupported_content_block',
      type: block.type,
    });
  }
  if (isToolType(block.type)) {
    state.toolRecords.push({ index, block: payload.content_block });
  }
  refreshBlocks(state);
}

function updateBlock(
  event: ProtocolRawEvent,
  payload: Record<string, unknown>,
  state: AnthropicState,
): void {
  if (
    !Number.isInteger(payload.index) ||
    (payload.index as number) < 0 ||
    !isRecord(payload.delta)
  ) {
    state.malformed = true;
    return;
  }
  const block = state.blocks.get(payload.index as number);
  if (block === undefined || block.stopped) {
    state.malformed = true;
    return;
  }

  const delta = payload.delta;
  if (delta.type === 'text_delta' && block.type === 'text') {
    if (typeof delta.text !== 'string') {
      state.malformed = true;
      return;
    }
    block.text += delta.text;
  } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
    if (typeof delta.thinking !== 'string') {
      state.malformed = true;
      return;
    }
    block.thinking += delta.thinking;
  } else if (delta.type === 'input_json_delta' && isToolType(block.type)) {
    state.toolRecords.push({
      index: payload.index,
      partial_json: delta.partial_json,
    });
  } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
    state.otherChoices.push({
      index: payload.index,
      signature: delta.signature,
    });
  } else {
    state.unknownEvents.push(event);
    state.unsupportedRepresentation = true;
    state.incompleteDetails.push({
      reason: 'unsupported_content_delta',
      type: delta.type,
    });
  }
  refreshBlocks(state);
}

function stopBlock(
  payload: Record<string, unknown>,
  state: AnthropicState,
): void {
  if (!Number.isInteger(payload.index) || (payload.index as number) < 0) {
    state.malformed = true;
    return;
  }
  const block = state.blocks.get(payload.index as number);
  if (block === undefined) {
    state.malformed = true;
    return;
  }
  if (block.stopped) {
    state.malformed = true;
    return;
  }
  block.stopped = true;
}

function updateMessage(
  payload: Record<string, unknown>,
  state: AnthropicState,
): void {
  if (
    !state.messageStartSeen ||
    !isRecord(payload.delta) ||
    !allBlocksStopped(state)
  ) {
    state.malformed = true;
    return;
  }

  state.messageDeltaSeen = true;
  if (isRecord(payload.usage)) {
    state.usage = {
      ...(isRecord(state.usage) ? state.usage : {}),
      ...payload.usage,
    };
    state.usageRecords.push(payload.usage);
  }
  const reason = payload.delta.stop_reason;
  if (typeof reason === 'string') {
    if (state.stopReason !== undefined && state.stopReason !== reason) {
      state.malformed = true;
    } else {
      state.stopReason = reason;
    }
  } else if (reason !== undefined && reason !== null) {
    state.malformed = true;
  }

  if (payload.delta.stop_sequence !== undefined && payload.delta.stop_sequence !== null) {
    state.otherChoices.push({ stop_sequence: payload.delta.stop_sequence });
  }

}

function refreshBlocks(state: AnthropicState): void {
  const blocks = [...state.blocks.entries()].sort(([left], [right]) => left - right);
  state.answerText = blocks
    .filter(([, block]) => block.type === 'text')
    .map(([, block]) => block.text)
    .join('');
  state.reasoningText = blocks
    .filter(([, block]) => block.type === 'thinking')
    .map(([, block]) => block.thinking)
    .join('');
  state.refusalText = blocks
    .filter(([, block]) => block.type === 'refusal')
    .map(([, block]) => block.text)
    .join('');
}

function finalizeAnthropic(state: ProtocolDecoderState): void {
  const anthropic = state as AnthropicState;

  if (anthropic.failed) {
    anthropic.terminal = 'failed';
  } else if (anthropic.malformed) {
    anthropic.terminal = 'malformed';
  } else if (!anthropic.messageStartSeen) {
    anthropic.terminal = 'malformed';
  } else if (
    anthropic.messageStopSeen &&
    anthropic.messageDeltaSeen &&
    !anthropic.unsupportedRepresentation &&
    (anthropic.stopReason === 'end_turn' ||
      anthropic.stopReason === 'stop_sequence' ||
      anthropic.stopReason === 'refusal')
  ) {
    if (anthropic.toolRecords.length > 0) {
      anthropic.terminal = 'incomplete';
      anthropic.incompleteDetails.push({ reason: 'tool_interruption' });
    } else if (
      anthropic.answerText.length === 0 &&
      anthropic.refusalText.length === 0 &&
      anthropic.stopReason !== 'refusal'
    ) {
      anthropic.terminal = 'incomplete';
      anthropic.incompleteDetails.push({ reason: 'empty_answer' });
    } else {
      anthropic.terminal = 'complete';
    }
  } else if (
    anthropic.messageStopSeen &&
    anthropic.messageDeltaSeen &&
    anthropic.stopReason === 'tool_use'
  ) {
    anthropic.terminal = 'incomplete';
    anthropic.incompleteDetails.push({ reason: 'tool_use' });
  } else if (
    anthropic.messageStopSeen &&
    anthropic.messageDeltaSeen &&
    !anthropic.unsupportedRepresentation &&
    (anthropic.stopReason === 'max_tokens' ||
      anthropic.stopReason === 'model_context_window_exceeded' ||
      anthropic.stopReason === 'pause_turn')
  ) {
    anthropic.terminal = 'incomplete';
    anthropic.incompleteDetails.push({ reason: anthropic.stopReason });
  } else if (
    anthropic.stopReason !== undefined &&
    ![
      'end_turn',
      'stop_sequence',
      'refusal',
      'tool_use',
      'max_tokens',
      'model_context_window_exceeded',
      'pause_turn',
    ].includes(anthropic.stopReason)
  ) {
    anthropic.terminal = 'malformed';
  } else if (
    anthropic.messageStopSeen &&
    anthropic.messageDeltaSeen &&
    anthropic.unsupportedRepresentation
  ) {
    anthropic.terminal = 'incomplete';
  } else {
    anthropic.terminal = 'truncated';
  }

  if (anthropic.stopReason === 'refusal' && anthropic.refusalText.length === 0) {
    anthropic.refusalText = anthropic.answerText;
  }

  if (anthropic.refusalText.length > 0 || anthropic.stopReason === 'refusal') {
    anthropic.content = 'refusal';
  } else if (anthropic.toolRecords.length > 0 && anthropic.answerText.length > 0) {
    anthropic.content = 'tool-interrupted';
  } else if (anthropic.toolRecords.length > 0 || anthropic.stopReason === 'tool_use') {
    anthropic.content = 'tool-only';
  } else if (anthropic.answerText.length > 0) {
    anthropic.content = 'answer';
  } else {
    anthropic.content = 'empty';
  }
}

function allBlocksStopped(state: AnthropicState): boolean {
  return [...state.blocks.values()].every((block) => block.stopped);
}

function isToolType(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value === 'tool_use' || value === 'server_tool_use' || value.endsWith('_tool_result'))
  );
}

function isKnownBlockType(value: string): boolean {
  return [
    'text',
    'thinking',
    'redacted_thinking',
    'tool_use',
    'server_tool_use',
    'web_search_tool_result',
    'code_execution_tool_result',
    'search_result',
    'mcp_tool_use',
    'mcp_tool_result',
    'container_upload',
    'refusal',
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
