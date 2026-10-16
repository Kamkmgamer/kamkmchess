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
  ResponsesSchema,
  ProtocolStreamMetadata,
  ProtocolStreamDecoder,
} from './types';

interface ResponseItem {
  index: number;
  itemId?: string;
  data?: Record<string, unknown>;
  textDeltas: Map<number, string>;
  textDone: Map<number, string>;
  reasoningDeltas: Map<number, string>;
  reasoningDone: Map<number, string>;
}

interface ResponsesState extends ProtocolDecoderState {
  schema: ResponsesSchema;
  items: Map<number, ResponseItem>;
  sequenceData: Map<number, string>;
  terminalEvent: string | undefined;
  terminalData: string | undefined;
  failed: boolean;
  doneSeen: boolean;
  unsupportedRepresentation: boolean;
}

const recognizedEvents = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.refusal.delta',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'error',
]);

export function createResponsesDecoder(
  metadata?: ProtocolStreamMetadata,
): ProtocolStreamDecoder {
  const state: ResponsesState = {
    ...createProtocolState(),
    schema: metadata?.responsesSchema ?? 'openai',
    items: new Map(),
    sequenceData: new Map(),
    terminalEvent: undefined,
    terminalData: undefined,
    failed: false,
    doneSeen: false,
    unsupportedRepresentation: false,
  };

  return createSseProtocolDecoder(
    'responses',
    state,
    consumeResponsesEvent,
    finalizeResponses,
    metadata,
  );
}

export function encodeResponsesRequest(
  history: ProtocolHistory,
  config: ProtocolGenerationConfig,
): EncodedProtocolRequest {
  validateGenerationConfig(config);
  const body: Record<string, unknown> = {
    model: config.model,
    instructions: history.instructions,
    input: history.records.map((record) => ({
      role: record.role,
      content: [
        {
          type: record.role === 'assistant' ? 'output_text' : 'input_text',
          text: record.text,
        },
      ],
    })),
    stream: true,
    max_output_tokens: config.maxOutputTokens,
    truncation: 'disabled',
    store: false,
  };
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

function consumeResponsesEvent(
  event: ProtocolRawEvent,
  base: ProtocolDecoderState,
): void {
  const state = base as ResponsesState;

  if (event.parseError !== undefined) {
    state.malformed = true;
    return;
  }
  if (event.data === '[DONE]') {
    if (state.terminalEvent === undefined) {
      state.doneSeen = true;
    }
    return;
  }
  if (event.data.length === 0) {
    return;
  }
  if (state.doneSeen) {
    state.malformed = true;
    return;
  }
  if (!isRecord(event.payload)) {
    state.malformed = true;
    return;
  }

  const payload = event.payload;
  const type = payload.type;
  if (typeof type !== 'string') {
    if (event.event !== 'message' && recognizedEvents.has(event.event)) {
      state.malformed = true;
    } else {
      state.unknownEvents.push(event);
    }
    return;
  }
  if (event.event !== 'message' && event.event !== type) {
    state.malformed = true;
    return;
  }

  if (
    state.schema === 'openrouter-r12' &&
    isTextPartEvent(type) &&
    !isValidOpenRouterTextEventPayload(payload)
  ) {
    state.malformed = true;
    return;
  }

  if (typeof payload.sequence_number === 'number') {
    const prior = state.sequenceData.get(payload.sequence_number);
    if (prior !== undefined) {
      if (prior !== event.data) {
        state.malformed = true;
      }
      return;
    }
    state.sequenceData.set(payload.sequence_number, event.data);
  }

  if (state.terminalEvent !== undefined) {
    if (
      type === state.terminalEvent &&
      event.data === state.terminalData
    ) {
      return;
    }
    state.malformed = true;
    return;
  }
  if (!recognizedEvents.has(type)) {
    state.unknownEvents.push(event);
    return;
  }

  switch (type) {
    case 'error':
      state.errors.push(payload);
      state.failed = true;
      state.terminalEvent = type;
      state.terminalData = event.data;
      return;
    case 'response.completed':
      completeResponse(payload, event, state);
      return;
    case 'response.failed':
      closeWithResponse('response.failed', payload, event, state);
      return;
    case 'response.incomplete':
      closeWithResponse('response.incomplete', payload, event, state);
      return;
    case 'response.output_item.added':
    case 'response.output_item.done':
      addOutputItem(payload, state);
      return;
    case 'response.output_text.delta':
    case 'response.output_text.done':
      updateTextPart(type, payload, state);
      return;
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary_text.done':
      updateReasoningPart(type, payload, state);
      return;
    case 'response.refusal.delta':
      if (typeof payload.delta !== 'string') {
        state.malformed = true;
      } else {
        state.refusalText += payload.delta;
      }
      return;
    case 'response.function_call_arguments.delta':
    case 'response.function_call_arguments.done':
      state.toolRecords.push({
        type,
        item_id: payload.item_id,
        output_index: payload.output_index,
        delta: payload.delta,
        arguments: payload.arguments,
      });
      return;
    case 'response.created':
    case 'response.queued':
    case 'response.in_progress':
    case 'response.content_part.added':
    case 'response.content_part.done':
      return;
    default:
      state.unknownEvents.push(event);
  }
}

function addOutputItem(
  payload: Record<string, unknown>,
  state: ResponsesState,
): void {
  const index = payload.output_index;
  if (!Number.isInteger(index) || !isRecord(payload.item)) {
    state.malformed = true;
    return;
  }

  const itemIndex = index as number;
  const item = getItem(state, itemIndex);
  const itemId = payload.item.id;
  const itemType = payload.item.type;
  if (
    typeof itemType !== 'string' ||
    (itemId !== undefined && typeof itemId !== 'string') ||
    ((itemType === 'message' || itemType === 'reasoning') &&
      typeof itemId !== 'string') ||
    (item.itemId !== undefined && item.itemId !== itemId) ||
    (item.data !== undefined &&
      ((typeof item.data.id === 'string' &&
        item.data.id !== itemId) ||
        (typeof item.data.type === 'string' &&
          item.data.type !== itemType)))
  ) {
    state.malformed = true;
  }
  if (typeof itemId === 'string') {
    item.itemId = itemId;
  }
  item.data = payload.item;
  refreshStreamedText(state);
}

function updateTextPart(
  type: string,
  payload: Record<string, unknown>,
  state: ResponsesState,
): void {
  const index = payload.output_index;
  const contentIndex = payload.content_index;
  const text = type === 'response.output_text.delta' ? payload.delta : payload.text;
  if (
    !Number.isInteger(index) ||
    (index as number) < 0 ||
    !Number.isInteger(contentIndex) ||
    (contentIndex as number) < 0 ||
    typeof payload.item_id !== 'string' ||
    typeof text !== 'string'
  ) {
    state.malformed = true;
    return;
  }

  const item = getItem(state, index as number);
  if (item.itemId !== undefined && item.itemId !== payload.item_id) {
    state.malformed = true;
  }
  item.itemId = payload.item_id;
  if (typeof item.data?.id === 'string' && item.data.id !== payload.item_id) {
    state.malformed = true;
  }
  const parts =
    type === 'response.output_text.delta' ? item.textDeltas : item.textDone;
  if (type === 'response.output_text.delta') {
    parts.set(contentIndex as number, (parts.get(contentIndex as number) ?? '') + text);
  } else {
    parts.set(contentIndex as number, text);
  }
  refreshStreamedText(state);
}

function updateReasoningPart(
  type: string,
  payload: Record<string, unknown>,
  state: ResponsesState,
): void {
  const index = payload.output_index;
  const summaryIndex = payload.summary_index;
  const text = type === 'response.reasoning_summary_text.delta'
    ? payload.delta
    : payload.text;
  if (
    !Number.isInteger(index) ||
    (index as number) < 0 ||
    !Number.isInteger(summaryIndex) ||
    (summaryIndex as number) < 0 ||
    typeof payload.item_id !== 'string' ||
    typeof text !== 'string'
  ) {
    state.malformed = true;
    return;
  }

  const item = getItem(state, index as number);
  if (
    typeof item.data?.id === 'string' &&
    item.data.id !== payload.item_id
  ) {
    state.malformed = true;
  }
  const parts =
    type === 'response.reasoning_summary_text.delta'
      ? item.reasoningDeltas
      : item.reasoningDone;
  if (type === 'response.reasoning_summary_text.delta') {
    parts.set(
      summaryIndex as number,
      (parts.get(summaryIndex as number) ?? '') + text,
    );
  } else {
    parts.set(summaryIndex as number, text);
  }
  refreshStreamedText(state);
}

function completeResponse(
  payload: Record<string, unknown>,
  event: ProtocolRawEvent,
  state: ResponsesState,
): void {
  if (
    !isValidSequenceNumber(payload.sequence_number) ||
    !validateResponseEnvelope(payload.response, 'completed', state.schema)
  ) {
    state.malformed = true;
    state.terminalEvent = 'response.completed';
    state.terminalData = event.data;
    return;
  }

  const response = payload.response as Record<string, unknown>;
  state.terminalEvent = 'response.completed';
  state.terminalData = event.data;
  hydrateCompletedResponse(response, state);
}

function closeWithResponse(
  type: 'response.failed' | 'response.incomplete',
  payload: Record<string, unknown>,
  event: ProtocolRawEvent,
  state: ResponsesState,
): void {
  const status = type === 'response.failed' ? 'failed' : 'incomplete';
  if (
    !isValidSequenceNumber(payload.sequence_number) ||
    !validateResponseEnvelope(payload.response, status, state.schema)
  ) {
    state.malformed = true;
  }
  state.terminalEvent = type;
  state.terminalData = event.data;

  if (!isRecord(payload.response)) {
    return;
  }
  if (type === 'response.failed') {
    const error = payload.response.error;
    if (error !== null && error !== undefined) {
      state.errors.push(error);
    } else {
      state.errors.push(payload.response);
    }
    state.failed = true;
  } else {
    if (payload.response.incomplete_details !== undefined) {
      state.incompleteDetails.push(payload.response.incomplete_details);
    }
  }
}

function validateResponseEnvelope(
  value: unknown,
  expectedStatus: string,
  schema: ResponsesSchema,
): value is Record<string, unknown> {
  if (schema === 'openrouter-r12') {
    return validateOpenRouterResponseEnvelope(value, expectedStatus);
  }
  return validateOpenAiResponseEnvelope(value, expectedStatus);
}

function validateOpenRouterResponseEnvelope(
  value: unknown,
  expectedStatus: string,
): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.object !== 'response' ||
    value.status !== expectedStatus ||
    !Number.isInteger(value.created_at) ||
    !isNullableInteger(value.completed_at) ||
    !isResponseError(value.error) ||
    !isIncompleteDetails(value.incomplete_details) ||
    !isResponseInstructions(value.instructions) ||
    !isNullableNumber(value.frequency_penalty) ||
    !isNullableNumber(value.presence_penalty) ||
    !isNullableNumber(value.temperature) ||
    !isNullableNumber(value.top_p) ||
    !isStringRecordOrNull(value.metadata) ||
    typeof value.model !== 'string' ||
    !isResponseOutput(value.output) ||
    typeof value.parallel_tool_calls !== 'boolean' ||
    !isResponseToolChoice(value.tool_choice) ||
    !isResponseTools(value.tools)
  ) {
    return false;
  }

  if (expectedStatus === 'completed') {
    return (
      value.completed_at !== null &&
      value.error === null &&
      value.incomplete_details === null
    );
  }
  if (expectedStatus === 'failed') {
    return (
      value.completed_at === null &&
      value.error !== null &&
      value.incomplete_details === null
    );
  }
  return (
    value.completed_at === null &&
    value.error === null &&
    value.incomplete_details !== null
  );
}

function validateOpenAiResponseEnvelope(
  value: unknown,
  expectedStatus: string,
): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.object !== 'response' ||
    value.status !== expectedStatus ||
    typeof value.created_at !== 'number' ||
    !isOpenAiAccessPrograms(value.access_programs) ||
    !isResponseError(value.error) ||
    !isIncompleteDetails(value.incomplete_details) ||
    !isResponseInstructions(value.instructions) ||
    !isStringRecordOrNull(value.metadata) ||
    typeof value.model !== 'string' ||
    !isResponseOutput(value.output) ||
    typeof value.parallel_tool_calls !== 'boolean' ||
    !isNullableNumber(value.temperature) ||
    !isResponseToolChoice(value.tool_choice) ||
    !isResponseTools(value.tools) ||
    !isNullableNumber(value.top_p)
  ) {
    return false;
  }

  if (
    Object.hasOwn(value, 'completed_at') &&
    !isNullableNumber(value.completed_at)
  ) {
    return false;
  }

  if (expectedStatus === 'completed') {
    return value.error === null && value.incomplete_details === null;
  }
  if (value.completed_at !== undefined && value.completed_at !== null) {
    return false;
  }
  if (expectedStatus === 'failed') {
    return value.error !== null && value.incomplete_details === null;
  }
  return value.error === null && value.incomplete_details !== null;
}

function isOpenAiAccessPrograms(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      (value.cyber === 'standard' ||
        value.cyber === 'daybreak_blue' ||
        value.cyber === 'daybreak_red'))
  );
}

function isNullableInteger(value: unknown): boolean {
  return value === null || Number.isInteger(value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || typeof value === 'number';
}

function isResponseError(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.code === 'string' &&
      typeof value.message === 'string' &&
      (value.metadata === undefined || isStringRecord(value.metadata)))
  );
}

function isIncompleteDetails(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      (value.reason === undefined || typeof value.reason === 'string'))
  );
}

function isResponseInstructions(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    (Array.isArray(value) &&
      value.every(
        (item) =>
          isRecord(item) &&
          (typeof item.type === 'string' ||
            (typeof item.role === 'string' &&
              (typeof item.content === 'string' ||
                Array.isArray(item.content)))),
      ))
  );
}

function isStringRecordOrNull(value: unknown): boolean {
  return value === null || isStringRecord(value);
}

function isStringRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isResponseToolChoice(value: unknown): boolean {
  return (
    value === 'auto' ||
    value === 'none' ||
    value === 'required' ||
    (isRecord(value) && typeof value.type === 'string')
  );
}

function isResponseTools(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((tool) => isRecord(tool) && typeof tool.type === 'string')
  );
}

function isResponseOutput(value: unknown): boolean {
  return Array.isArray(value) && value.every(isResponseOutputItem);
}

function isResponseOutputItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'message') {
    return (
      typeof value.id === 'string' &&
      typeof value.role === 'string' &&
      (value.status === undefined || typeof value.status === 'string') &&
      Array.isArray(value.content) &&
      value.content.every(isResponseMessageContent)
    );
  }
  if (value.type === 'reasoning') {
    return typeof value.id === 'string' && Array.isArray(value.summary);
  }
  if (value.type === 'function_call') {
    return (
      (value.id === undefined || typeof value.id === 'string') &&
      typeof value.call_id === 'string' &&
      typeof value.name === 'string' &&
      typeof value.arguments === 'string'
    );
  }
  return true;
}

function isResponseMessageContent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'output_text') {
    return typeof value.text === 'string';
  }
  if (value.type === 'refusal') {
    return typeof value.refusal === 'string';
  }
  return true;
}

function isValidSequenceNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTextPartEvent(type: string): boolean {
  return (
    type === 'response.output_text.delta' ||
    type === 'response.output_text.done'
  );
}

function isValidOpenRouterTextEventPayload(
  payload: Record<string, unknown>,
): boolean {
  return (
    isValidSequenceNumber(payload.sequence_number) &&
    isOpenRouterLogprobs(payload.logprobs)
  );
}

function isOpenRouterLogprobs(value: unknown): boolean {
  return Array.isArray(value) && value.every(isOpenRouterLogprob);
}

function isOpenRouterLogprob(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.token === 'string' &&
    isFiniteNumber(value.logprob) &&
    (value.bytes === undefined || isSafeIntegerArray(value.bytes)) &&
    (value.top_logprobs === undefined ||
      (Array.isArray(value.top_logprobs) &&
        value.top_logprobs.every(isOpenRouterTopLogprob)))
  );
}

function isOpenRouterTopLogprob(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.bytes === undefined || isSafeIntegerArray(value.bytes)) &&
    (value.logprob === undefined || isFiniteNumber(value.logprob)) &&
    (value.token === undefined || typeof value.token === 'string')
  );
}

function isSafeIntegerArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(Number.isSafeInteger);
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function hydrateCompletedResponse(
  response: Record<string, unknown>,
  state: ResponsesState,
): void {
  const output = response.output as unknown[];
  const messages: Array<{ index: number; item: Record<string, unknown> }> = [];
  const tools: unknown[] = [];

  output.forEach((item, index) => {
    if (!isRecord(item)) {
      state.malformed = true;
      return;
    }
    if (item.type === 'message') {
      if (item.role !== 'assistant') {
        state.malformed = true;
        state.otherChoices.push({ output_index: index, item });
      } else {
        messages.push({ index, item });
      }
    } else if (item.type === 'reasoning') {
      return;
    } else if (isToolType(item.type)) {
      tools.push(item);
    } else {
      state.otherChoices.push({ output_index: index, item });
      state.unsupportedRepresentation = true;
      state.incompleteDetails.push({
        reason: 'unsupported_output_item',
        type: item.type,
      });
    }
  });

  for (const { item } of messages) {
    if (
      item.phase !== undefined &&
      item.phase !== null &&
      item.phase !== 'final_answer' &&
      item.phase !== 'analysis' &&
      item.phase !== 'commentary'
    ) {
      state.unsupportedRepresentation = true;
      state.incompleteDetails.push({
        reason: 'unsupported_message_phase',
        phase: item.phase,
      });
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (
          isRecord(part) &&
          part.type !== 'output_text' &&
          part.type !== 'refusal'
        ) {
          state.unsupportedRepresentation = true;
          state.incompleteDetails.push({
            reason: 'unsupported_message_content',
            type: part.type,
          });
        }
      }
    }
  }

  const answer = messages.find(({ item }) => isFinalMessagePhase(item.phase));
  const answerIsCompleted = answer?.item.status === 'completed';
  if (answer !== undefined && !answerIsCompleted) {
    state.malformed = true;
    state.otherChoices.push({ output_index: answer.index, item: answer.item });
  }
  const answerText =
    answer === undefined || !answerIsCompleted
      ? ''
      : messageText(answer.item);
  if (answer !== undefined && answerIsCompleted) {
    const streamed = state.items.get(answer.index);
    if (streamed !== undefined) {
      if (
        (streamed.itemId !== undefined &&
          streamed.itemId !== answer.item.id) ||
        (streamed.data !== undefined &&
          (streamed.data.type !== 'message' ||
            streamed.data.id !== answer.item.id))
      ) {
        state.malformed = true;
      }
      if (
        hasTextParts(streamed) &&
        !streamedTextMatchesMessage(streamed, answer.item)
      ) {
        state.malformed = true;
      }
    }
  }

  for (const message of messages) {
    if (answer === undefined || message.index !== answer.index) {
      state.otherChoices.push({ output_index: message.index, item: message.item });
    }
  }
  for (const tool of tools) {
    state.toolRecords.push(tool);
  }

  state.answerText = answerText;
  state.reasoningText = output
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => {
      if (item.type === 'reasoning') {
        return reasoningText(item);
      }
      return item.type === 'message' && item.phase === 'analysis'
        ? messageText(item)
        : '';
    })
    .join('');
  state.planText = output
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === 'message' && item.phase === 'commentary',
    )
    .map(messageText)
    .join('');
  state.refusalText = messages
    .map(({ item }) => messageRefusal(item))
    .join('');

  if (response.usage !== undefined && response.usage !== null) {
    state.usage = response.usage;
    state.usageRecords.push(response.usage);
  }
}

function refreshStreamedText(state: ResponsesState): void {
  const items = [...state.items.values()].sort((left, right) => left.index - right.index);
  const messages = items.filter((item) => item.data?.type === 'message');
  const answer = messages.find((item) => isFinalMessagePhase(item.data?.phase));
  const reasoningItems = items.filter(
    (item) => item.data?.type === 'reasoning' || item.data?.phase === 'analysis',
  );
  const commentaryItems = items.filter(
    (item) => item.data?.type === 'message' && item.data.phase === 'commentary',
  );

  state.answerText =
    answer === undefined
      ? ''
      : joinedTextParts(answer.textDone, answer.textDeltas);
  state.reasoningText = reasoningItems
    .map((item) =>
      item.data?.type === 'reasoning'
        ? joinedTextParts(item.reasoningDone, item.reasoningDeltas)
        : joinedTextParts(item.textDone, item.textDeltas),
    )
    .join('');
  state.planText = commentaryItems
    .map((item) => joinedTextParts(item.textDone, item.textDeltas))
    .join('');
}

function getItem(state: ResponsesState, index: number): ResponseItem {
  let item = state.items.get(index);
  if (item === undefined) {
    item = {
      index,
      textDeltas: new Map(),
      textDone: new Map(),
      reasoningDeltas: new Map(),
      reasoningDone: new Map(),
    };
    state.items.set(index, item);
  }
  return item;
}

function joinedTextParts(
  done: ReadonlyMap<number, string>,
  deltas: ReadonlyMap<number, string>,
): string {
  const parts = done.size > 0 ? done : deltas;
  return [...parts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
    .join('');
}

function messageText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) {
    return '';
  }
  return item.content
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === 'output_text',
    )
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function messageRefusal(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) {
    return '';
  }
  return item.content
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === 'refusal',
    )
    .map((part) =>
      typeof part.refusal === 'string'
        ? part.refusal
        : typeof part.text === 'string'
          ? part.text
          : '',
    )
    .join('');
}

function reasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const summaryText = summary
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === 'summary_text',
    )
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
  if (summaryText.length > 0) {
    return summaryText;
  }
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function hasTextParts(item: ResponseItem): boolean {
  return item.textDeltas.size > 0 || item.textDone.size > 0;
}

function streamedTextMatchesMessage(
  item: ResponseItem,
  message: Record<string, unknown>,
): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }

  for (const [contentIndex, deltaText] of item.textDeltas) {
    if (item.textDone.get(contentIndex) !== deltaText) {
      return false;
    }
  }
  for (const [contentIndex, doneText] of item.textDone) {
    const content = message.content[contentIndex];
    if (
      !isRecord(content) ||
      content.type !== 'output_text' ||
      content.text !== doneText
    ) {
      return false;
    }
  }
  for (
    let contentIndex = 0;
    contentIndex < message.content.length;
    contentIndex += 1
  ) {
    const content = message.content[contentIndex];
    if (
      isRecord(content) &&
      content.type === 'output_text' &&
      !item.textDone.has(contentIndex)
    ) {
      return false;
    }
  }

  return joinedTextParts(item.textDone, item.textDeltas) === messageText(message);
}

function isFinalMessagePhase(value: unknown): boolean {
  return value === undefined || value === null || value === 'final_answer';
}

function isToolType(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value === 'tool_use' || value.endsWith('_call'))
  );
}

function finalizeResponses(state: ProtocolDecoderState): void {
  const responses = state as ResponsesState;

  if (responses.malformed) {
    responses.terminal = 'malformed';
  } else if (responses.failed) {
    responses.terminal = 'failed';
  } else if (responses.terminalEvent === 'response.completed') {
    if (responses.toolRecords.length > 0) {
      responses.terminal = 'incomplete';
      responses.incompleteDetails.push({ reason: 'tool_interruption' });
    } else if (responses.unsupportedRepresentation) {
      responses.terminal = 'incomplete';
    } else if (
      responses.answerText.length === 0 &&
      responses.refusalText.length === 0
    ) {
      responses.terminal = 'incomplete';
      responses.incompleteDetails.push({ reason: 'empty_answer' });
    } else {
      responses.terminal = 'complete';
    }
  } else if (responses.terminalEvent === 'response.incomplete') {
    responses.terminal = 'incomplete';
  } else {
    responses.terminal = 'truncated';
  }

  if (responses.refusalText.length > 0) {
    responses.content = 'refusal';
  } else if (responses.toolRecords.length > 0 && responses.answerText.length > 0) {
    responses.content = 'tool-interrupted';
  } else if (responses.toolRecords.length > 0) {
    responses.content = 'tool-only';
  } else if (responses.answerText.length > 0) {
    responses.content = 'answer';
  } else {
    responses.content = 'empty';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
