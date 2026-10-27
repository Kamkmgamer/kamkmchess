import { describe, expect, it } from 'vitest';
import {
  createAnthropicMessagesDecoder,
  encodeAnthropicMessagesRequest,
} from './index';

describe('Anthropic Messages protocol decoder', () => {
  it('[MOV-03, HIS-05] keeps thinking, text, usage, and unknown events separate through fragmented CRLF input', () => {
    const stream =
      sse('message_start', {
        message: {
          id: 'msg-fixture',
          type: 'message',
          role: 'assistant',
          model: 'exact-model-id',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 0,
            vendor_count: 2,
          },
        },
      }) +
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }) +
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'checking position' },
      }) +
      sse('content_block_stop', { index: 0 }) +
      sse('ping', {}) +
      ssePayload('future_event', { extra: 'preserved' }) +
      sse('content_block_start', {
        index: 1,
        content_block: { type: 'text', text: '' },
      }) +
      sse('content_block_delta', {
        index: 1,
        delta: { type: 'text_delta', text: '{"move":"café"}' },
      }) +
      sse('content_block_stop', { index: 1 }) +
      sse('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 5,
          output_tokens: 4,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          vendor_count: 2,
        },
      }) +
      sse('message_stop', {});
    const bytes = new TextEncoder().encode(stream);
    const decoder = createAnthropicMessagesDecoder();
    for (let offset = 0; offset < bytes.length; offset += 1) {
      decoder.push(bytes.slice(offset, offset + 1));
    }

    const result = decoder.finish();

    expect(result.terminal).toBe('complete');
    expect(result.content).toBe('answer');
    expect(result.answerText).toBe('{"move":"café"}');
    expect(result.reasoningText).toBe('checking position');
    expect(result.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 4,
      vendor_count: 2,
    });
    expect(result.usageRecords).toHaveLength(2);
    expect(result.unknownEvents).toHaveLength(1);
    expect(result.raw.chunks.flatMap((chunk) => Array.from(chunk))).toEqual(Array.from(bytes));
  });

  it('[MOV-03] requires a normal message_delta stop reason and message_stop', () => {
    const stopReasonOnly = decodeAnthropic(
      messageStart() + textBlock('e2e4') + messageDelta('end_turn'),
    );
    const messageStopOnly = decodeAnthropic(
      messageStart() + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    expect(stopReasonOnly.terminal).toBe('truncated');
    expect(stopReasonOnly.answerText).toBe('e2e4');
    expect(messageStopOnly.terminal).toBe('truncated');
  });

  it('[MOV-03, HIS-05] rejects a known Anthropic SSE event with missing JSON type and keeps raw bytes', () => {
    const missingTypeFrame = ssePayload('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: 'g1' },
    });
    const stream =
      messageStart() +
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      missingTypeFrame +
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'f3' },
      }) +
      sse('content_block_stop', { index: 0 }) +
      messageDelta('end_turn') +
      sse('message_stop', {});
    const result = decodeAnthropic(stream);
    const rawEvent = result.raw.events[2];

    expect(result.terminal).toBe('malformed');
    expect(rawEvent?.event).toBe('content_block_delta');
    expect(rawEvent?.rawBytes).toEqual(
      new TextEncoder().encode(missingTypeFrame),
    );
    expect(rawEvent?.payload).not.toHaveProperty('type');
  });

  it('[MOV-03] retains mismatched known-event types as malformed protocol data', () => {
    const mismatchedFrame = ssePayload('content_block_delta', {
      type: 'content_block_stop',
      index: 0,
      delta: { type: 'text_delta', text: 'g1' },
    });
    const result = decodeAnthropic(
      messageStart() +
        sse('content_block_start', {
          index: 0,
          content_block: { type: 'text', text: '' },
        }) +
        mismatchedFrame +
        sse('content_block_delta', {
          index: 0,
          delta: { type: 'text_delta', text: 'f3' },
        }) +
        sse('content_block_stop', { index: 0 }) +
        messageDelta('end_turn') +
        sse('message_stop', {}),
    );

    expect(result.terminal).toBe('malformed');
    expect(result.raw.events[2]?.rawBytes).toEqual(
      new TextEncoder().encode(mismatchedFrame),
    );
  });

  it('[MOV-03, HIS-05] rejects content-block events after message_delta and keeps their bytes raw', () => {
    const decoder = createAnthropicMessagesDecoder();
    const lateBlockStart = sse('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    const lateTextDelta = sse('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: 'e2e4' },
    });
    const lateBlockStop = sse('content_block_stop', { index: 0 });
    const messageStop =
      'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n';
    const stream =
      messageStart() +
      messageDelta('end_turn') +
      lateBlockStart +
      lateTextDelta +
      lateBlockStop +
      messageStop;
    const bytes = new TextEncoder().encode(stream);
    decoder.push(bytes);

    const result = decoder.finish();

    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('');
    expect(result.raw.events.map((event) => event.event)).toEqual([
      'message_start',
      'message_delta',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_stop',
    ]);
    expect(
      result.raw.events.slice(2).map((event) => Array.from(event.rawBytes)),
    ).toEqual(
      [lateBlockStart, lateTextDelta, lateBlockStop, messageStop].map((frame) =>
        Array.from(new TextEncoder().encode(frame)),
      ),
    );
    expect(result.raw.chunks.flatMap((chunk) => Array.from(chunk))).toEqual(
      Array.from(bytes),
    );
  });

  it('[MOV-03, HIS-01] merges cumulative usage fields without adding counts', () => {
    const result = decodeAnthropic(
      messageStart() +
        textBlock('e2e4') +
        sse('message_delta', {
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 9, provider_total: 14 },
        }) +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    expect(result.terminal).toBe('complete');
    expect(result.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 9,
      provider_total: 14,
    });
    expect(result.usageRecords).toHaveLength(2);
  });

  it('[MOV-03, HIS-05] does not normalize message_stop without its terminating SSE frame', () => {
    const decoder = createAnthropicMessagesDecoder();
    const stream =
      messageStart() +
      textBlock('e2e4') +
      messageDelta('end_turn') +
      'event: message_stop\ndata: {"type":"message_stop"}\n';
    decoder.push(new TextEncoder().encode(stream));

    const result = decoder.finish();

    expect(result.terminal).toBe('truncated');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events.at(-1)?.frameTerminated).toBe(false);
  });

  it('[MOV-03] keeps documented truncation reasons incomplete', () => {
    for (const reason of ['max_tokens', 'model_context_window_exceeded', 'pause_turn']) {
      const result = decodeAnthropic(
        messageStart() +
          textBlock('partial') +
          messageDelta(reason) +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      );

      expect(result.terminal).toBe('incomplete');
      expect(result.incompleteDetails).toContainEqual({ reason });
      expect(result.answerText).toBe('partial');
    }
  });

  it('[MOV-03, MOV-09] classifies refusal and tool-only responses without making either an answer', () => {
    const refusal = decodeAnthropic(
      messageStart() +
        textBlock('I cannot choose a move.') +
        messageDelta('refusal') +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const toolOnly = decodeAnthropic(
      messageStart() +
        sse('content_block_start', {
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tool-1',
            name: 'unexpected',
            input: {},
          },
        }) +
        sse('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
        }) +
        sse('content_block_stop', { index: 0 }) +
        messageDelta('tool_use') +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const refusalBlock = decodeAnthropic(
      messageStart() +
        sse('content_block_start', {
          index: 0,
          content_block: {
            type: 'refusal',
            text: 'I cannot choose a move.',
          },
        }) +
        sse('content_block_stop', { index: 0 }) +
        messageDelta('end_turn') +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    expect(refusal.terminal).toBe('complete');
    expect(refusal.content).toBe('refusal');
    expect(refusal.answerText).toBe('I cannot choose a move.');
    expect(toolOnly.terminal).toBe('incomplete');
    expect(toolOnly.content).toBe('tool-only');
    expect(toolOnly.answerText).toBe('');
    expect(toolOnly.toolRecords).toHaveLength(2);
    expect(refusalBlock.terminal).toBe('complete');
    expect(refusalBlock.content).toBe('refusal');
    expect(refusalBlock.refusalText).toBe('I cannot choose a move.');
  });

  it('[CON-05, MOV-03] classifies nested stream errors as failures before or after partial text', () => {
    const beforeText = decodeAnthropic(
      'event: error\ndata: ' +
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Synthetic overload' },
        }) +
        '\n\n',
    );
    const afterTextDecoder = createAnthropicMessagesDecoder({ httpStatus: 200 });
    afterTextDecoder.push(
      new TextEncoder().encode(
        messageStart() +
          textBlock('partial') +
          'event: error\ndata: ' +
          JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Synthetic overload' },
          }) +
          '\n\n',
      ),
    );
    const afterText = afterTextDecoder.finish();

    expect(beforeText.terminal).toBe('failed');
    expect(afterText.terminal).toBe('failed');
    expect(afterText.httpStatus).toBe(200);
    expect(afterText.answerText).toBe('partial');
    expect(afterText.errors).toContainEqual({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Synthetic overload' },
    });
  });

  it('[MOV-03] does not complete on an unterminated or unrecognized content block', () => {
    const unterminated = decodeAnthropic(
      messageStart() +
        sse('content_block_start', {
          index: 0,
          content_block: { type: 'text', text: '' },
        }) +
        sse('content_block_delta', {
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        }) +
        messageDelta('end_turn') +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const opaque = decodeAnthropic(
      messageStart() +
        sse('content_block_start', {
          index: 0,
          content_block: { type: 'future_block', payload: 'opaque' },
        }) +
        sse('content_block_stop', { index: 0 }) +
        messageDelta('end_turn') +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    expect(unterminated.terminal).toBe('malformed');
    expect(unterminated.answerText).toBe('partial');
    expect(opaque.terminal).toBe('incomplete');
    expect(opaque.content).toBe('empty');
    expect(opaque.raw.events[1]?.payload).toMatchObject({
      content_block: { type: 'future_block', payload: 'opaque' },
    });
  });

  it('[MOV-03, MOV-07, HIS-05] does not turn usage-only completion into an answer and fences Stop-late data', () => {
    const usageOnly = decodeAnthropic(
      messageStart() +
        messageDelta('end_turn') +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const decoder = createAnthropicMessagesDecoder();
    const partial = messageStart() + textBlock('partial');
    const late = messageDelta('end_turn') + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    decoder.push(new TextEncoder().encode(partial));
    decoder.abort();
    decoder.push(new TextEncoder().encode(late));
    const aborted = decoder.finish();

    expect(usageOnly.terminal).toBe('incomplete');
    expect(usageOnly.content).toBe('empty');
    expect(usageOnly.answerText).toBe('');
    expect(usageOnly.usage).toMatchObject({ output_tokens: 2 });
    expect(aborted.terminal).toBe('aborted');
    expect(aborted.answerText).toBe('partial');
    expect(aborted.raw.events).toHaveLength(6);
  });

  it('[MOV-03, HIS-05] keeps duplicate message_stop harmless and rejects data after that terminal', () => {
    const end = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const duplicate = decodeAnthropic(
      messageStart() +
        textBlock('e2e4') +
        messageDelta('end_turn') +
        end +
        end,
    );
    const late = decodeAnthropic(
      messageStart() +
        textBlock('e2e4') +
        messageDelta('end_turn') +
        end +
        sse('future_event', { late: true }),
    );

    expect(duplicate.terminal).toBe('complete');
    expect(duplicate.answerText).toBe('e2e4');
    expect(duplicate.raw.events).toHaveLength(7);
    expect(late.terminal).toBe('malformed');
    expect(late.raw.events.at(-1)?.payload).toMatchObject({ late: true });
  });

  it('[HIS-01, MOV-09] encodes full history with Messages roles and no tool declarations', () => {
    const request = encodeAnthropicMessagesRequest(
      {
        instructions: 'Choose a move.',
        records: [
          { id: 'one', role: 'user', text: 'Position A' },
          { id: 'two', role: 'assistant', text: 'Plan A' },
          { id: 'three', role: 'assistant', text: 'e2e4' },
        ],
      },
      { model: 'exact-model-id', maxOutputTokens: 256 },
    );

    expect(request.body).toMatchObject({
      model: 'exact-model-id',
      system: 'Choose a move.',
      stream: true,
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'Position A' },
        { role: 'assistant', content: 'Plan A' },
        { role: 'assistant', content: 'e2e4' },
      ],
    });
    expect(request.sourceRecordIds).toEqual(['one', 'two', 'three']);
    expect(request.body).not.toHaveProperty('tools');
    expect(request.body).not.toHaveProperty('anthropic-version');
    expect(request.body).not.toHaveProperty('x-api-key');
  });

  it('[CST-01] translates every reasoning effort to Anthropic adaptive thinking', () => {
    const expected: Record<'low' | 'medium' | 'high' | 'xhigh' | 'max', 'low' | 'medium' | 'high' | 'xhigh' | 'max'> = {
      low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    };
    for (const reasoningEffort of Object.keys(expected) as Array<keyof typeof expected>) {
      const request = encodeAnthropicMessagesRequest(
        { instructions: 'Choose a move.', records: [] },
        { model: 'claude-sonnet-4-5', maxOutputTokens: 4096, temperature: 0.2, reasoningEffort },
      );
      expect(request.body).toMatchObject({
        thinking: { type: 'adaptive' },
        output_config: { effort: expected[reasoningEffort] },
      });
      expect(request.body).not.toHaveProperty('temperature');
    }
  });

  it('[CST-01] adds a cache breakpoint only when the stable prefix meets the selected model minimum', () => {
    const records = [
      { id: 'old-user', role: 'user' as const, text: 'Retained question' },
      { id: 'old-answer', role: 'assistant' as const, text: 'Retained answer' },
      { id: 'fresh', role: 'user' as const, text: 'Fresh position' },
    ];
    const config = {
      model: 'selected-claude-model',
      maxOutputTokens: 256,
      cache: { anthropicEphemeral: true, anthropicCacheMinimumTokens: 1024 },
    };
    const encode = (cachePrefixTokenCount?: number) => encodeAnthropicMessagesRequest(
      {
        instructions: 'Choose a move.',
        records,
        cachePrefixRecordCount: 2,
        ...(cachePrefixTokenCount === undefined ? {} : { cachePrefixTokenCount }),
      },
      config,
    ).body;

    const tooShort = encode(1023);
    const eligible = encode(1024);
    const unknownMinimum = encodeAnthropicMessagesRequest(
      {
        instructions: 'Choose a move.',
        records,
        cachePrefixRecordCount: 2,
        cachePrefixTokenCount: 2048,
      },
      {
        model: 'selected-claude-model',
        maxOutputTokens: 256,
        cache: { anthropicEphemeral: true },
      },
    ).body;
    const eligibleMessages = eligible.messages as Array<{
      content: string | Array<Record<string, unknown>>;
    }>;

    expect(tooShort.system).toBe('Choose a move.');
    expect(tooShort.messages).toEqual(records.map(({ role, text }) => ({ role, content: text })));
    expect(eligible.system).toBe('Choose a move.');
    expect(eligibleMessages[0]?.content).toBe('Retained question');
    expect(eligibleMessages[1]?.content).toEqual([
      { type: 'text', text: 'Retained answer', cache_control: { type: 'ephemeral' } },
    ]);
    expect(eligibleMessages[2]?.content).toBe('Fresh position');
    expect(encode().messages).toEqual(records.map(({ role, text }) => ({ role, content: text })));
    expect(unknownMinimum.messages).toEqual(records.map(({ role, text }) => ({ role, content: text })));
  });
});

function sse(type: string, fields: Record<string, unknown>): string {
  return (
    'event: ' +
    type +
    '\r\ndata: ' +
    JSON.stringify({ type, ...fields }) +
    '\r\n\r\n'
  );
}

function ssePayload(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function decodeAnthropic(stream: string) {
  const decoder = createAnthropicMessagesDecoder();
  decoder.push(new TextEncoder().encode(stream));
  return decoder.finish();
}

function messageStart(): string {
  return sse('message_start', {
    message: {
      id: 'msg-fixture',
      type: 'message',
      role: 'assistant',
      model: 'exact-model-id',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  });
}

function textBlock(text: string): string {
  return (
    sse('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    sse('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text },
    }) +
    sse('content_block_stop', { index: 0 })
  );
}

function messageDelta(reason: string): string {
  return sse('message_delta', {
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { input_tokens: 5, output_tokens: 2 },
  });
}
