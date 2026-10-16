import { describe, expect, it } from 'vitest';
import {
  createResponsesDecoder,
  encodeResponsesRequest,
} from './index';

describe('Responses protocol decoder', () => {
  it('[MOV-03] accepts the official native OpenAI response.completed event without optional fields', () => {
    const decoder = createResponsesDecoder();
    decoder.push(new TextEncoder().encode(nativeOpenAiCompletedEvent()));

    const result = decoder.finish();

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('Hi there! How can I assist you today?');
  });

  it('[MOV-03] accepts the documented native OpenAI SSE sequence with omitted text deltas filled', () => {
    const decoder = createResponsesDecoder();
    decoder.push(new TextEncoder().encode(nativeOpenAiStreamExample()));

    const result = decoder.finish();

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('Hi there! How can I assist you today?');
    expect(result.raw.events).toHaveLength(14);
  });

  it('[MOV-03] accepts native optional fields when present and absent', () => {
    const withOptionalFields = {
      ...nativeOpenAiResponse(),
      completed_at: 1741290959,
      background: false,
      conversation: { id: 'conv-fixture' },
      frequency_penalty: null,
      presence_penalty: null,
      provider_extension: { retained: true },
    };
    const result = decodeResponsesWithSchema(
      sse('response.completed', {
        sequence_number: 13,
        response: withOptionalFields,
      }),
      'openai',
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('Hi there! How can I assist you today?');
    expect(result.raw.events[0]?.payload).toMatchObject({
      response: {
        frequency_penalty: null,
        presence_penalty: null,
        provider_extension: { retained: true },
      },
    });
  });

  it('[MOV-03] accepts a null completed_at when the native schema supplies it', () => {
    const result = decodeResponsesWithSchema(
      sse('response.completed', {
        sequence_number: 13,
        response: { ...nativeOpenAiResponse(), completed_at: null },
      }),
      'openai',
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('Hi there! How can I assist you today?');
  });

  it('[MOV-03] rejects a native completed_at value with the wrong shape', () => {
    const result = decodeResponsesWithSchema(
      sse('response.completed', {
        sequence_number: 13,
        response: { ...nativeOpenAiResponse(), completed_at: '1741290959' },
      }),
      'openai',
    );

    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('');
  });

  it('[MOV-03] rejects native responses missing required fields or terminal status', () => {
    const requiredFields = [
      'access_programs',
      'created_at',
      'error',
      'incomplete_details',
      'instructions',
      'metadata',
      'model',
      'object',
      'output',
      'parallel_tool_calls',
      'temperature',
      'tool_choice',
      'tools',
      'top_p',
      'id',
    ];

    for (const field of requiredFields) {
      const response = { ...nativeOpenAiResponse() };
      delete response[field];
      const result = decodeResponsesWithSchema(
        sse('response.completed', { sequence_number: 13, response }),
        'openai',
      );

      expect(result.terminal, `missing ${field}`).toBe('malformed');
      expect(result.answerText, `missing ${field}`).toBe('');
    }

    const responseWithoutStatus = { ...nativeOpenAiResponse() };
    delete responseWithoutStatus.status;
    const missingStatus = decodeResponsesWithSchema(
      sse('response.completed', {
        sequence_number: 13,
        response: responseWithoutStatus,
      }),
      'openai',
    );
    expect(missingStatus.terminal).toBe('malformed');
    expect(missingStatus.answerText).toBe('');

    const wrongShapes: Record<string, unknown> = {
      access_programs: { cyber: 'unknown' },
      created_at: '1741290958',
      error: { code: 'server_error' },
      id: [],
      incomplete_details: { reason: 7 },
      instructions: [{}],
      metadata: [],
      model: {},
      object: 'not_a_response',
      output: {},
      parallel_tool_calls: 'true',
      status: 'incomplete',
      temperature: '1',
      tool_choice: {},
      tools: [{}],
      top_p: '1',
    };
    for (const [field, value] of Object.entries(wrongShapes)) {
      const response = { ...nativeOpenAiResponse(), [field]: value };
      const result = decodeResponsesWithSchema(
        sse('response.completed', { sequence_number: 13, response }),
        'openai',
      );

      expect(result.terminal, `wrong ${field} shape`).toBe('malformed');
      expect(result.answerText, `wrong ${field} shape`).toBe('');
    }
  });

  it('[MOV-03, CON-05] validates native failed and incomplete envelopes without requiring completed_at', () => {
    const failedResponse: Record<string, unknown> = {
      ...nativeOpenAiResponse(),
      status: 'failed',
      error: { code: 'server_error', message: 'Synthetic failure' },
      output: [],
    };
    const failed = decodeResponsesWithSchema(
      sse('response.failed', {
        sequence_number: 13,
        response: failedResponse,
      }),
      'openai',
    );
    expect(failed.terminal).toBe('failed');

    const incompleteResponse: Record<string, unknown> = {
      ...nativeOpenAiResponse(),
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
    };
    const incomplete = decodeResponsesWithSchema(
      sse('response.incomplete', {
        sequence_number: 13,
        response: incompleteResponse,
      }),
      'openai',
    );
    expect(incomplete.terminal).toBe('incomplete');

    const contradictions = [
      {
        event: 'response.failed',
        response: { ...failedResponse, completed_at: 1741290959 },
      },
      {
        event: 'response.failed',
        response: { ...failedResponse, error: null },
      },
      {
        event: 'response.failed',
        response: {
          ...failedResponse,
          incomplete_details: { reason: 'content_filter' },
        },
      },
      {
        event: 'response.incomplete',
        response: { ...incompleteResponse, completed_at: 1741290959 },
      },
      {
        event: 'response.incomplete',
        response: {
          ...incompleteResponse,
          error: { code: 'server_error', message: 'Synthetic failure' },
        },
      },
      {
        event: 'response.incomplete',
        response: { ...incompleteResponse, incomplete_details: null },
      },
      {
        event: 'response.failed',
        response: { ...failedResponse, status: 'completed' },
      },
    ];

    for (const { event, response } of contradictions) {
      const result = decodeResponsesWithSchema(
        sse(event, { sequence_number: 13, response }),
        'openai',
      );
      expect(result.terminal, event).toBe('malformed');
    }
  });

  it('[MOV-03] accepts a complete OpenRouter R12 response only when that schema is selected', () => {
    const stream = sse('response.completed', {
      sequence_number: 1,
      response: responseEnvelope('completed', [finalMessage()]),
    });
    const defaultSchemaResult = decodeResponsesWithSchema(stream, 'openai');
    const openRouterResult = decodeResponsesWithSchema(
      stream,
      'openrouter-r12',
    );

    expect(defaultSchemaResult.terminal).toBe('malformed');
    expect(defaultSchemaResult.answerText).toBe('');
    expect(openRouterResult.terminal).toBe('complete');
    expect(openRouterResult.answerText).toBe('e2e4');
  });

  it('[MOV-03, HIS-05] marks conflicting streamed part text malformed and retains final text', () => {
    const result = decodeResponses(
      sse('response.output_item.added', {
        sequence_number: 1,
        output_index: 0,
        item: {
          id: 'final-1',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }) +
        sse('response.output_text.delta', {
          sequence_number: 2,
          output_index: 0,
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          delta: 'not-the-answer',
        }) +
        sse('response.output_text.done', {
          sequence_number: 3,
          output_index: 0,
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          text: 'e2e4',
        }) +
        sse('response.completed', {
          sequence_number: 4,
          response: responseEnvelope('completed', [finalMessage()]),
        }),
    );

    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events).toHaveLength(4);
    expect(result.raw.events[1]?.payload).toMatchObject({
      delta: 'not-the-answer',
    });
    expect(result.raw.events[2]?.payload).toMatchObject({ text: 'e2e4' });
  });

  it('[MOV-03, HIS-05] reconciles split deltas by content index and deduplicates sequence repeats', () => {
    const firstPartStart = sse('response.output_text.delta', {
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      item_id: 'final-1',
      logprobs: [],
      delta: 'e',
    });
    const result = decodeResponses(
      sse('response.output_item.added', {
        sequence_number: 1,
        output_index: 0,
        item: {
          id: 'final-1',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }) +
        firstPartStart +
        firstPartStart +
        sse('response.output_text.delta', {
          sequence_number: 3,
          output_index: 0,
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          delta: '2',
        }) +
        sse('response.output_text.done', {
          sequence_number: 4,
          output_index: 0,
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          text: 'e2',
        }) +
        sse('response.output_text.delta', {
          sequence_number: 5,
          output_index: 0,
          content_index: 1,
          item_id: 'final-1',
          logprobs: [],
          delta: 'e',
        }) +
        sse('response.output_text.delta', {
          sequence_number: 6,
          output_index: 0,
          content_index: 1,
          item_id: 'final-1',
          logprobs: [],
          delta: '4',
        }) +
        sse('response.output_text.done', {
          sequence_number: 7,
          output_index: 0,
          content_index: 1,
          item_id: 'final-1',
          logprobs: [],
          text: 'e4',
        }) +
        sse('response.completed', {
          sequence_number: 8,
          response: responseEnvelope('completed', [
            {
              ...finalMessage(),
              content: [
                { type: 'output_text', text: 'e2', annotations: [] },
                { type: 'output_text', text: 'e4', annotations: [] },
              ],
            },
          ]),
        }),
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events).toHaveLength(9);
  });

  it('[MOV-03] rejects streamed text that lacks its content-part done event', () => {
    const result = decodeResponses(
      sse('response.output_item.added', {
        sequence_number: 1,
        output_index: 0,
        item: {
          id: 'final-1',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }) +
        sse('response.output_text.delta', {
          sequence_number: 2,
          output_index: 0,
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          delta: 'e2e4',
        }) +
        sse('response.completed', {
          sequence_number: 3,
          response: responseEnvelope('completed', [finalMessage()]),
        }),
    );

    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('e2e4');
  });

  it('[MOV-03] marks stale output item identities malformed and retains the final answer', () => {
    const mismatchedItems = [
      sse('response.output_text.delta', {
        sequence_number: 1,
        output_index: 0,
        content_index: 0,
        item_id: 'stale-item',
        logprobs: [],
        delta: 'e2e4',
      }) +
        sse('response.output_item.added', {
          sequence_number: 2,
          output_index: 0,
          item: {
            id: 'final-1',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        }) +
        sse('response.output_text.done', {
          sequence_number: 3,
          output_index: 0,
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          text: 'e2e4',
        }),
      sse('response.output_item.added', {
        sequence_number: 1,
        output_index: 0,
        item: {
          id: 'stale-item',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }) +
        sse('response.output_text.delta', {
          sequence_number: 2,
          output_index: 0,
          content_index: 0,
          item_id: 'stale-item',
          logprobs: [],
          delta: 'e2e4',
        }) +
        sse('response.output_text.done', {
          sequence_number: 3,
          output_index: 0,
          content_index: 0,
          item_id: 'stale-item',
          logprobs: [],
          text: 'e2e4',
        }),
    ];

    for (const stream of mismatchedItems) {
      const result = decodeResponses(
        stream +
          sse('response.completed', {
            sequence_number: 4,
            response: responseEnvelope('completed', [finalMessage()]),
          }),
      );

      expect(result.terminal).toBe('malformed');
      expect(result.answerText).toBe('e2e4');
    }
  });

  it('[MOV-03, HIS-05] rejects missing or wrongly shaped required fields and contradictory completion data', () => {
    const requiredNullableFields = [
      'completed_at',
      'error',
      'frequency_penalty',
      'incomplete_details',
      'instructions',
      'metadata',
      'presence_penalty',
      'temperature',
      'top_p',
    ];

    for (const field of requiredNullableFields) {
      const response = responseEnvelope('completed', [finalMessage()]);
      delete response[field];
      const result = decodeResponses(
        sse('response.completed', { sequence_number: 1, response }),
      );

      expect(result.terminal, `missing ${field}`).toBe('malformed');
      expect(result.answerText, `missing ${field}`).toBe('');
    }

    const wrongShapes: Record<string, unknown> = {
      completed_at: '2',
      error: { code: 'server_error' },
      frequency_penalty: '0',
      incomplete_details: { reason: 7 },
      instructions: [{}],
      metadata: { bad_value: 1 },
      presence_penalty: '0',
      temperature: '0',
      top_p: '1',
    };

    for (const [field, value] of Object.entries(wrongShapes)) {
      const response = {
        ...responseEnvelope('completed', [finalMessage()]),
        [field]: value,
      };
      const result = decodeResponses(
        sse('response.completed', { sequence_number: 1, response }),
      );

      expect(result.terminal, `wrong ${field} shape`).toBe('malformed');
      expect(result.answerText, `wrong ${field} shape`).toBe('');
    }

    const wrongRequiredShapes: Record<string, unknown> = {
      created_at: '1',
      id: [],
      object: 'not_a_response',
      status: 'incomplete',
      model: {},
      output: {},
      parallel_tool_calls: 'false',
      tool_choice: {},
      tools: [{}],
    };
    for (const [field, value] of Object.entries(wrongRequiredShapes)) {
      const response = {
        ...responseEnvelope('completed', [finalMessage()]),
        [field]: value,
      };
      const result = decodeResponses(
        sse('response.completed', { sequence_number: 1, response }),
      );

      expect(result.terminal, `wrong ${field} shape`).toBe('malformed');
      expect(result.answerText, `wrong ${field} shape`).toBe('');
    }

    const contradictoryFields: Record<string, unknown>[] = [
      { completed_at: null },
      { error: { code: 'server_error', message: 'Synthetic error' } },
      { incomplete_details: {} },
    ];
    for (const fields of contradictoryFields) {
      const response = {
        ...responseEnvelope('completed', [finalMessage()]),
        ...fields,
      };
      const result = decodeResponses(
        sse('response.completed', { sequence_number: 1, response }),
      );

      expect(result.terminal).toBe('malformed');
      expect(result.answerText).toBe('');
    }

    const malformedOutput = responseEnvelope('completed', [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'e2e4' }],
      },
    ]);
    const malformedOutputResult = decodeResponses(
      sse('response.completed', {
        sequence_number: 1,
        response: malformedOutput,
      }),
    );
    expect(malformedOutputResult.terminal).toBe('malformed');
    expect(malformedOutputResult.answerText).toBe('');
  });

  it('[MOV-03, HIS-05] accepts omitted optional response fields and retains extensions', () => {
    const response = responseEnvelope('completed', [finalMessage()]);
    for (const field of [
      'background',
      'max_output_tokens',
      'max_tool_calls',
      'output_text',
      'previous_response_id',
      'prompt',
      'prompt_cache_key',
      'prompt_cache_options',
      'reasoning',
      'safety_identifier',
      'service_tier',
      'store',
      'text',
      'top_logprobs',
      'truncation',
      'usage',
      'user',
      'alignment',
      'error_type',
      'openrouter_metadata',
    ]) {
      delete response[field];
    }

    const result = decodeResponses(
      sse('response.completed', { sequence_number: 1, response }),
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events[0]?.payload).toMatchObject({
      response: { provider_extension: { retained: true } },
    });
  });

  it('[MOV-03, CON-05] keeps failed and incomplete envelope data consistent with status', () => {
    const validFailure = decodeResponses(
      sse('response.failed', {
        sequence_number: 1,
        response: responseEnvelope('failed', []),
      }),
    );
    expect(validFailure.terminal).toBe('failed');

    const contradictoryResponses = [
      {
        event: 'response.failed',
        response: {
          ...responseEnvelope('failed', []),
          incomplete_details: {},
        },
      },
      {
        event: 'response.failed',
        response: {
          ...responseEnvelope('failed', []),
          error: null,
        },
      },
      {
        event: 'response.failed',
        response: {
          ...responseEnvelope('failed', []),
          completed_at: 2,
        },
      },
      {
        event: 'response.incomplete',
        response: {
          ...responseEnvelope('incomplete', []),
          error: { code: 'server_error', message: 'Synthetic error' },
        },
      },
      {
        event: 'response.incomplete',
        response: {
          ...responseEnvelope('incomplete', []),
          completed_at: 2,
        },
      },
    ];

    for (const { event, response } of contradictoryResponses) {
      const result = decodeResponses(
        sse(event, { sequence_number: 1, response }),
      );
      expect(result.terminal).toBe('malformed');
      expect(result.answerText).toBe('');
    }
  });

  it('[MOV-03, HIS-01, HIS-05] uses the first message output as answer and keeps reasoning items separate', () => {
    const decoder = createResponsesDecoder({ responsesSchema: 'openrouter-r12' });
    const stream =
        sse('response.output_item.added', {
          output_index: 0,
          item: {
            id: 'reason-1',
            type: 'reasoning',
            status: 'in_progress',
            summary: [],
          },
        }) +
          sse('response.reasoning_summary_text.delta', {
            item_id: 'reason-1',
            output_index: 0,
            summary_index: 0,
            delta: 'checking the board',
            sequence_number: 2,
          }) +
          sse('response.output_item.added', {
            output_index: 1,
            item: {
              id: 'message-1',
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          }) +
          sse('response.output_text.delta', {
            content_index: 0,
            delta: '{"move":"e2e4","plan":"café"}',
            item_id: 'message-1',
            logprobs: [],
            output_index: 1,
            sequence_number: 4,
          }) +
          sse('response.output_text.done', {
            content_index: 0,
            item_id: 'message-1',
            logprobs: [],
            output_index: 1,
            sequence_number: 5,
            text: '{"move":"e2e4","plan":"café"}',
          }) +
          sse('response.completed', {
            sequence_number: 6,
            response: responseEnvelope('completed', [
              {
                id: 'reason-1',
                type: 'reasoning',
                status: 'completed',
                summary: [{ type: 'summary_text', text: 'checking the board' }],
              },
              {
                id: 'message-1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: '{"move":"e2e4","plan":"café"}',
                    annotations: [],
                  },
                ],
              },
            ]),
          });
    const bytes = new TextEncoder().encode(stream);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      decoder.push(bytes.slice(offset, offset + 1));
    }

    const result = decoder.finish();

    expect(result.terminal).toBe('complete');
    expect(result.content).toBe('answer');
    expect(result.answerText).toBe('{"move":"e2e4","plan":"café"}');
    expect(result.reasoningText).toBe('checking the board');
    expect(result.usage).toMatchObject({ total_tokens: 17 });
    expect(result.raw.chunks.flatMap((chunk) => Array.from(chunk))).toEqual(Array.from(bytes));
    expect(result.raw.events.at(-1)?.payload).toMatchObject({
      response: { provider_extension: { retained: true } },
    });
    expect(result.raw.events.map((event) => event.event)).toContain(
      'response.output_text.done',
    );
  });

  it('[MOV-02, MOV-03] does not treat analysis-phase message text as the answer', () => {
    const result = decodeResponses(
      sse('response.completed', {
        sequence_number: 1,
        response: responseEnvelope('completed', [
          {
            id: 'analysis-1',
            type: 'message',
            role: 'assistant',
            phase: 'analysis',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'returned analysis',
                annotations: [],
              },
            ],
          },
          {
            id: 'final-1',
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'e2e4', annotations: [] },
            ],
          },
        ]),
      }),
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('e2e4');
    expect(result.reasoningText).toBe('returned analysis');
  });

  it('[MOV-03] does not promote non-assistant response messages to the answer', () => {
    const result = decodeResponses(
      sse('response.completed', {
        sequence_number: 1,
        response: responseEnvelope('completed', [
          {
            id: 'message-1',
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'output_text', text: 'e2e4', annotations: [] }],
          },
        ]),
      }),
    );

    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('');
    expect(result.otherChoices).toContainEqual({
      output_index: 0,
      item: expect.objectContaining({ role: 'user' }),
    });
  });

  it('[MOV-03] rejects selected assistant answer items that are not completed', () => {
    for (const status of ['in_progress', 'incomplete']) {
      const result = decodeResponses(
        sse('response.completed', {
          sequence_number: 1,
          response: responseEnvelope('completed', [
            {
              id: 'final-1',
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              status,
              content: [{ type: 'output_text', text: 'e2e4', annotations: [] }],
            },
          ]),
        }),
      );

      expect(result.terminal).toBe('malformed');
      expect(result.answerText).toBe('');
      expect(result.otherChoices).toContainEqual({
        output_index: 0,
        item: expect.objectContaining({ status }),
      });
    }
  });

  it('[MOV-03, MOV-09] preserves tool outputs but does not report a tool-only stream as a complete answer', () => {
    const result = decodeResponses(
      sse('response.completed', {
        sequence_number: 1,
        response: responseEnvelope('completed', [
          {
            id: 'call-1',
            type: 'function_call',
            call_id: 'call-1',
            name: 'unexpected',
            arguments: '{"x":1}',
            status: 'completed',
          },
        ]),
      }),
    );

    expect(result.terminal).toBe('incomplete');
    expect(result.content).toBe('tool-only');
    expect(result.answerText).toBe('');
    expect(result.toolRecords).toHaveLength(1);
  });

  it('[MOV-02, MOV-03] keeps refusal and additional message items separate from the first final answer', () => {
    const additional = decodeResponses(
      sse('response.completed', {
        sequence_number: 1,
        response: responseEnvelope('completed', [
          {
            id: 'final-1',
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            status: 'completed',
            content: [{ type: 'output_text', text: 'e2e4', annotations: [] }],
          },
          {
            id: 'final-2',
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            status: 'completed',
            content: [{ type: 'output_text', text: 'd2d4', annotations: [] }],
          },
        ]),
      }),
    );
    const refusal = decodeResponses(
      sse('response.completed', {
        sequence_number: 1,
        response: responseEnvelope('completed', [
          {
            id: 'refusal-1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'refusal',
                refusal: 'I cannot choose a move.',
              },
            ],
          },
        ]),
      }),
    );

    expect(additional.terminal).toBe('complete');
    expect(additional.answerText).toBe('e2e4');
    expect(additional.otherChoices).toContainEqual({
      output_index: 1,
      item: expect.objectContaining({ id: 'final-2' }),
    });
    expect(refusal.terminal).toBe('complete');
    expect(refusal.content).toBe('refusal');
    expect(refusal.answerText).toBe('');
    expect(refusal.refusalText).toBe('I cannot choose a move.');
  });

  it('[MOV-03] does not report a usage-only completed response as an answer', () => {
    const result = decodeResponses(
      sse('response.completed', {
        sequence_number: 1,
        response: responseEnvelope('completed', []),
      }),
    );

    expect(result.terminal).toBe('incomplete');
    expect(result.content).toBe('empty');
    expect(result.answerText).toBe('');
    expect(result.usage).toMatchObject({ total_tokens: 17 });
  });

  it('[MOV-03] does not treat text-done, DONE, EOF, or undocumented aliases as completion', () => {
    const textDone = decodeResponses(
      sse('response.output_item.added', {
        output_index: 0,
        item: {
          id: 'message-1',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }) +
        sse('response.output_text.done', {
          content_index: 0,
          item_id: 'message-1',
          logprobs: [],
          output_index: 0,
          sequence_number: 2,
          text: 'partial',
        }),
    );
    const aliases = decodeResponses(
      sse('response.text.delta', { delta: 'alias text' }) +
        sse('response.content_part.delta', { delta: 'old text alias' }) +
        sse('response.done', {
          response: responseEnvelope('completed', []),
        }),
    );
    const doneOnly = decodeResponses('data: [DONE]\n\n');

    expect(textDone.terminal).toBe('truncated');
    expect(textDone.answerText).toBe('partial');
    expect(aliases.terminal).toBe('truncated');
    expect(aliases.answerText).toBe('');
    expect(aliases.unknownEvents).toHaveLength(3);
    expect(doneOnly.terminal).toBe('truncated');
  });

  it('[MOV-03, HIS-05] rejects a known Responses SSE event with missing JSON type and keeps raw bytes', () => {
    const missingTypeFrame = ssePayload('response.output_text.delta', {
      content_index: 0,
      delta: 'g1',
      item_id: 'final-1',
      output_index: 0,
      sequence_number: 1,
    });
    const stream =
      missingTypeFrame +
      sse('response.output_text.delta', {
        content_index: 0,
        delta: 'e2e4',
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 2,
      }) +
      sse('response.output_text.done', {
        content_index: 0,
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 3,
        text: 'e2e4',
      }) +
      sse('response.completed', {
        sequence_number: 4,
        response: responseEnvelope('completed', [finalMessage()]),
      });
    const result = decodeResponses(stream);

    expect(result.terminal).toBe('malformed');
    expect(result.raw.events[0]?.event).toBe('response.output_text.delta');
    expect(result.raw.events[0]?.rawBytes).toEqual(
      new TextEncoder().encode(missingTypeFrame),
    );
    expect(result.raw.events[0]?.payload).not.toHaveProperty('type');
  });

  it('[MOV-03, HIS-05] rejects non-string and mismatched JSON types on known Responses events', () => {
    const invalidFrames = [
      ssePayload('response.output_text.delta', {
        type: null,
        content_index: 0,
        delta: 'g1',
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 1,
      }),
      ssePayload('response.output_text.delta', {
        type: 'response.output_text.done',
        content_index: 0,
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 2,
        text: 'g1',
      }),
    ];

    for (const invalidFrame of invalidFrames) {
      const result = decodeResponses(
        invalidFrame +
          sse('response.output_text.delta', {
            content_index: 0,
            delta: 'e2e4',
            item_id: 'final-1',
            logprobs: [],
            output_index: 0,
            sequence_number: 3,
          }) +
          sse('response.output_text.done', {
            content_index: 0,
            item_id: 'final-1',
            logprobs: [],
            output_index: 0,
            sequence_number: 4,
            text: 'e2e4',
          }) +
          sse('response.completed', {
            sequence_number: 5,
            response: responseEnvelope('completed', [finalMessage()]),
          }),
      );

      expect(result.terminal).toBe('malformed');
      expect(result.raw.events[0]?.rawBytes).toEqual(
        new TextEncoder().encode(invalidFrame),
      );
    }
  });

  it('[MOV-03] keeps generic Responses message routing and unknown named events forward-compatible', () => {
    const unknownFrame = ssePayload('provider.future_event', {
      extension: 'preserved',
    });
    const result = decodeResponses(
      unknownFrame +
        ssePayload('message', {
          type: 'response.output_text.delta',
          content_index: 0,
          delta: 'e2e4',
          item_id: 'final-1',
          logprobs: [],
          output_index: 0,
          sequence_number: 1,
        }) +
        ssePayload('message', {
          type: 'response.output_text.done',
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          output_index: 0,
          sequence_number: 2,
          text: 'e2e4',
        }) +
        ssePayload('message', {
          type: 'response.completed',
          sequence_number: 3,
          response: responseEnvelope('completed', [finalMessage()]),
        }),
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('e2e4');
    expect(result.unknownEvents).toHaveLength(1);
    expect(result.raw.events[0]?.rawBytes).toEqual(
      new TextEncoder().encode(unknownFrame),
    );
  });

  it.each([
    {
      eventType: 'response.output_text.delta',
      invalidIndex: 0,
      invalidPayload: {
        content_index: 0,
        delta: 'e2e4',
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
      },
      validOtherEvent: sse('response.output_text.done', {
        content_index: 0,
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 2,
        text: 'e2e4',
      }),
    },
    {
      eventType: 'response.output_text.done',
      invalidIndex: 0,
      invalidPayload: {
        content_index: 0,
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        text: 'e2e4',
      },
      validOtherEvent: sse('response.output_text.delta', {
        content_index: 0,
        delta: 'e2e4',
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 1,
      }),
    },
  ])(
    '[MOV-03, HIS-05] rejects an R12 $eventType without sequence_number and retains its raw frame',
    ({ eventType, invalidIndex, invalidPayload, validOtherEvent }) => {
      const invalidFrame = sse(eventType, invalidPayload);
      const events = [invalidFrame, validOtherEvent];
      const result = decodeResponses(
        events.join('') +
          sse('response.completed', {
            sequence_number: 3,
            response: responseEnvelope('completed', [finalMessage()]),
          }),
      );

      expect(result.terminal).toBe('malformed');
      expect(result.raw.events[invalidIndex]?.rawBytes).toEqual(
        new TextEncoder().encode(invalidFrame),
      );
      expect(result.raw.events[invalidIndex]?.payload).toMatchObject({
        type: eventType,
      });
    },
  );

  it.each(['delta', 'done'] as const)(
    '[MOV-03, HIS-05] rejects an R12 text event without logprobs and retains its raw frame (%s)',
    (eventType) => {
      const deltaFields: Record<string, unknown> = {
        content_index: 0,
        delta: 'e2e4',
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 1,
      };
      const doneFields: Record<string, unknown> = {
        content_index: 0,
        item_id: 'final-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 2,
        text: 'e2e4',
      };
      const invalidIndex = eventType === 'delta' ? 0 : 1;
      const invalidFields = eventType === 'delta' ? deltaFields : doneFields;
      delete invalidFields.logprobs;
      const events = [
        sse('response.output_text.delta', deltaFields),
        sse('response.output_text.done', doneFields),
      ];

      const result = decodeResponses(
        events.join('') +
          sse('response.completed', {
            sequence_number: 3,
            response: responseEnvelope('completed', [finalMessage()]),
          }),
      );

      expect(result.terminal).toBe('malformed');
      expect(result.raw.events[invalidIndex]?.rawBytes).toEqual(
        new TextEncoder().encode(events[invalidIndex]),
      );
      expect(result.raw.events[invalidIndex]?.payload).not.toHaveProperty(
        'logprobs',
      );
    },
  );

  it('[MOV-03] requires non-negative safe integer R12 text sequence numbers', () => {
    const invalidSequenceNumbers: unknown[] = [
      null,
      '1',
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const eventType of ['delta', 'done'] as const) {
      for (const sequenceNumber of invalidSequenceNumbers) {
        const deltaFields: Record<string, unknown> = {
          content_index: 0,
          delta: 'e2e4',
          item_id: 'final-1',
          logprobs: [],
          output_index: 0,
          sequence_number: 1,
        };
        const doneFields: Record<string, unknown> = {
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          output_index: 0,
          sequence_number: 2,
          text: 'e2e4',
        };
        const invalidFields = eventType === 'delta' ? deltaFields : doneFields;
        invalidFields.sequence_number = sequenceNumber;
        const result = decodeResponses(
          sse('response.output_text.delta', deltaFields) +
            sse('response.output_text.done', doneFields) +
            sse('response.completed', {
              sequence_number: 3,
              response: responseEnvelope('completed', [finalMessage()]),
            }),
        );

        expect(result.terminal).toBe('malformed');
      }
    }
  });

  it('[MOV-03] validates R12 text logprobs against the pinned nested shape', () => {
    const invalidLogprobs: unknown[] = [
      {},
      [{ logprob: -0.1 }],
      [{ token: 'e2e4' }],
      [{ token: 42, logprob: -0.1 }],
      [{ token: 'e2e4', logprob: '-0.1' }],
      [{ token: 'e2e4', logprob: -0.1, bytes: 'e2e4' }],
      [{ token: 'e2e4', logprob: -0.1, bytes: [1.5] }],
      [{ token: 'e2e4', logprob: -0.1, top_logprobs: {} }],
      [
        {
          token: 'e2e4',
          logprob: -0.1,
          top_logprobs: [{ token: 42 }],
        },
      ],
      [
        {
          token: 'e2e4',
          logprob: -0.1,
          top_logprobs: [{ logprob: 'invalid' }],
        },
      ],
      [
        {
          token: 'e2e4',
          logprob: -0.1,
          top_logprobs: [{ bytes: [1.5] }],
        },
      ],
    ];

    for (const eventType of ['delta', 'done'] as const) {
      for (const logprobs of invalidLogprobs) {
        const deltaFields: Record<string, unknown> = {
          content_index: 0,
          delta: 'e2e4',
          item_id: 'final-1',
          logprobs: [],
          output_index: 0,
          sequence_number: 1,
        };
        const doneFields: Record<string, unknown> = {
          content_index: 0,
          item_id: 'final-1',
          logprobs: [],
          output_index: 0,
          sequence_number: 2,
          text: 'e2e4',
        };
        const invalidFields = eventType === 'delta' ? deltaFields : doneFields;
        invalidFields.logprobs = logprobs;
        const result = decodeResponses(
          sse('response.output_text.delta', deltaFields) +
            sse('response.output_text.done', doneFields) +
            sse('response.completed', {
              sequence_number: 3,
              response: responseEnvelope('completed', [finalMessage()]),
            }),
        );

        expect(result.terminal).toBe('malformed');
      }
    }
  });

  it('[MOV-03, HIS-05] accepts documented R12 logprob shapes and retains extensions', () => {
    const logprobs = [
      {
        token: 'e2e4',
        logprob: -0.1,
        bytes: [101, 50],
        top_logprobs: [
          {
            token: 'd2d4',
            logprob: -0.2,
            bytes: [100, 50],
            provider_extension: 'retained',
          },
        ],
        provider_extension: { retained: true },
      },
      { token: 'position', logprob: 0, top_logprobs: [{}] },
    ];
    const result = decodeResponses(
      sse('response.output_text.delta', {
        content_index: 0,
        delta: 'e2e4',
        item_id: 'final-1',
        logprobs,
        output_index: 0,
        sequence_number: 1,
      }) +
        sse('response.output_text.done', {
          content_index: 0,
          item_id: 'final-1',
          logprobs,
          output_index: 0,
          sequence_number: 2,
          text: 'e2e4',
        }) +
        sse('response.completed', {
          sequence_number: 3,
          response: responseEnvelope('completed', [finalMessage()]),
        }),
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events[0]?.payload).toMatchObject({
      logprobs: [{
        provider_extension: { retained: true },
        top_logprobs: [{ provider_extension: 'retained' }],
      }, {
        token: 'position',
        top_logprobs: [{}],
      }],
    });
  });

  it('[MOV-03] keeps native OpenAI text events independent of R12 logprobs fields', () => {
    const result = decodeResponsesWithSchema(
      sse('response.output_text.delta', {
        content_index: 0,
        delta: 'Hi there! How can I assist you today?',
        item_id: 'msg_67c9fdcf37fc8190ba82116e33fb28c507b8b0ad4e5eb654',
        output_index: 0,
        sequence_number: 1,
      }) +
        sse('response.output_text.done', {
          content_index: 0,
          item_id: 'msg_67c9fdcf37fc8190ba82116e33fb28c507b8b0ad4e5eb654',
          output_index: 0,
          sequence_number: 2,
          text: 'Hi there! How can I assist you today?',
        }) +
        sse('response.completed', {
          sequence_number: 3,
          response: nativeOpenAiResponse(),
        }),
      'openai',
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('Hi there! How can I assist you today?');
  });

  it('[MOV-03, HIS-05] does not normalize response.completed without its terminating SSE frame', () => {
    const terminalEvent = sse('response.completed', {
      sequence_number: 1,
      response: responseEnvelope('completed', [
        {
          id: 'final-1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'e2e4', annotations: [] }],
        },
      ]),
    }).slice(0, -1);
    const decoder = createResponsesDecoder({ responsesSchema: 'openrouter-r12' });
    decoder.push(new TextEncoder().encode(terminalEvent));

    const result = decoder.finish();

    expect(result.terminal).toBe('truncated');
    expect(result.answerText).toBe('');
    expect(result.raw.events.at(-1)?.frameTerminated).toBe(false);
  });

  it('[MOV-03] rejects response.completed without its required sequence number', () => {
    const decoder = createResponsesDecoder({ responsesSchema: 'openrouter-r12' });
    decoder.push(
      new TextEncoder().encode(
        sse('response.completed', {
          response: responseEnvelope('completed', [
            {
              id: 'final-1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'e2e4', annotations: [] }],
            },
          ]),
        }),
      ),
    );

    const result = decoder.finish();

    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('');
  });

  it('[CON-05, MOV-03] keeps HTTP-200 stream errors and incomplete responses out of the answer state', () => {
    const failedDecoder = createResponsesDecoder({
      httpStatus: 200,
      responsesSchema: 'openrouter-r12',
    });
    failedDecoder.push(
      new TextEncoder().encode(
        sse('response.output_item.added', {
          output_index: 0,
          item: {
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        }) +
          sse('response.output_text.delta', {
            content_index: 0,
            delta: 'partial',
            item_id: 'message-1',
            logprobs: [],
            output_index: 0,
            sequence_number: 2,
          }) +
          sse('error', {
            code: 'rate_limit_exceeded',
            message: 'Synthetic rate limit',
            param: null,
            sequence_number: 3,
          }),
      ),
    );
    const failed = failedDecoder.finish();
    const incomplete = decodeResponses(
      sse('response.incomplete', {
        sequence_number: 1,
        response: responseEnvelope('incomplete', []),
      }),
    );

    expect(failed.terminal).toBe('failed');
    expect(failed.httpStatus).toBe(200);
    expect(failed.answerText).toBe('partial');
    expect(failed.errors).toContainEqual({
      type: 'error',
      code: 'rate_limit_exceeded',
      message: 'Synthetic rate limit',
      param: null,
      sequence_number: 3,
    });
    expect(incomplete.terminal).toBe('incomplete');
    expect(incomplete.incompleteDetails).toContainEqual({});
  });

  it('[MOV-03] rejects an incomplete response that omits its required nullable detail field', () => {
    const response = responseEnvelope('incomplete', []);
    delete response.incomplete_details;
    const result = decodeResponses(
      sse('response.incomplete', {
        sequence_number: 1,
        response,
      }),
    );

    expect(result.terminal).toBe('malformed');
    expect(result.incompleteDetails).toEqual([]);
  });

  it('[MOV-03, HIS-05] deduplicates repeated sequence numbers for normalization but keeps both raw events', () => {
    const decoder = createResponsesDecoder({ responsesSchema: 'openrouter-r12' });
    const delta = sse('response.output_text.delta', {
      content_index: 0,
      delta: 'e2e4',
      item_id: 'message-1',
      logprobs: [],
      output_index: 0,
      sequence_number: 1,
    });
    decoder.push(
      new TextEncoder().encode(
        sse('response.output_item.added', {
          output_index: 0,
          item: {
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        }) +
          delta +
          delta,
      ),
    );

    const result = decoder.finish();

    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events).toHaveLength(3);
  });

  it('[HIS-01, MOV-09] replays the full ordered history and disables server truncation', () => {
    const request = encodeResponsesRequest(
      {
        instructions: 'Choose a move.',
        records: [
          { id: 'one', role: 'user', text: 'Position A' },
          { id: 'two', role: 'assistant', text: 'Plan A' },
        ],
      },
      { model: 'exact-model-id', maxOutputTokens: 256 },
    );

    expect(request.body).toMatchObject({
      model: 'exact-model-id',
      instructions: 'Choose a move.',
      stream: true,
      max_output_tokens: 256,
      truncation: 'disabled',
      store: false,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Position A' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Plan A' }] },
      ],
    });
    expect(request.sourceRecordIds).toEqual(['one', 'two']);
    expect(request.body).not.toHaveProperty('previous_response_id');
    expect(request.body).not.toHaveProperty('tools');
  });
});

function decodeResponses(stream: string) {
  return decodeResponsesWithSchema(stream, 'openrouter-r12');
}

function decodeResponsesWithSchema(
  stream: string,
  responsesSchema: 'openai' | 'openrouter-r12',
) {
  const decoder = createResponsesDecoder({ responsesSchema });
  decoder.push(new TextEncoder().encode(stream));
  return decoder.finish();
}

function sse(type: string, fields: Record<string, unknown>): string {
  return (
    'event: ' +
    type +
    '\ndata: ' +
    JSON.stringify({ type, ...fields }) +
    '\n\n'
  );
}

function ssePayload(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function finalMessage() {
  return {
    id: 'final-1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'e2e4', annotations: [] }],
  };
}

function responseEnvelope(
  status: string,
  output: readonly unknown[],
): Record<string, unknown> {
  return {
    id: 'resp-fixture',
    object: 'response',
    created_at: 1,
    completed_at: status === 'completed' ? 2 : null,
    status,
    background: false,
    error:
      status === 'failed'
        ? { code: 'server_error', message: 'Synthetic failure' }
        : null,
    incomplete_details: status === 'incomplete' ? {} : null,
    instructions: null,
    max_output_tokens: 256,
    max_tool_calls: null,
    model: 'exact-model-id',
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    prompt: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: null,
    safety_identifier: null,
    service_tier: 'default',
    store: false,
    frequency_penalty: null,
    presence_penalty: null,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 17,
    },
    metadata: {},
    provider_extension: { retained: true },
  };
}

function nativeOpenAiCompletedEvent(): string {
  return sse('response.completed', {
    sequence_number: 13,
    response: nativeOpenAiResponse(),
  });
}

function nativeOpenAiStreamExample(): string {
  const messageId =
    'msg_67c9fdcf37fc8190ba82116e33fb28c507b8b0ad4e5eb654';
  const fullText = 'Hi there! How can I assist you today?';
  const contentPart = {
    type: 'output_text',
    text: fullText,
    annotations: [],
    logprobs: [],
  };
  const deltas: Array<[string, Record<string, unknown>]> = [
    'Hi',
    ' there',
    '!',
    ' How can',
    ' I assist you',
    ' today?',
  ].map((delta, index) => [
    'response.output_text.delta',
    {
      sequence_number: 4 + index,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
    },
  ]);
  const events: Array<[string, Record<string, unknown>]> = [
    [
      'response.created',
      {
        sequence_number: 0,
        response: nativeOpenAiInProgressResponse(),
      },
    ],
    [
      'response.in_progress',
      {
        sequence_number: 1,
        response: nativeOpenAiInProgressResponse(),
      },
    ],
    [
      'response.output_item.added',
      {
        sequence_number: 2,
        output_index: 0,
        item: {
          id: messageId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      },
    ],
    [
      'response.content_part.added',
      {
        sequence_number: 3,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { ...contentPart, text: '' },
      },
    ],
    ...deltas,
    [
      'response.output_text.done',
      {
        sequence_number: 10,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text: fullText,
        logprobs: [],
      },
    ],
    [
      'response.content_part.done',
      {
        sequence_number: 11,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: contentPart,
      },
    ],
    [
      'response.output_item.done',
      {
        sequence_number: 12,
        output_index: 0,
        item: {
          id: messageId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [contentPart],
        },
      },
    ],
    ['response.completed', { sequence_number: 13, response: nativeOpenAiResponse() }],
  ];

  // The reference omits intermediate events; these deltas fill its displayed final text.
  return events.map(([event, payload]) => sse(event, payload)).join('');
}

function nativeOpenAiInProgressResponse(): Record<string, unknown> {
  return {
    ...nativeOpenAiResponse(),
    status: 'in_progress',
    output: [],
    max_output_tokens: null,
    usage: null,
  };
}

function nativeOpenAiResponse(): Record<string, unknown> {
  return {
    id: 'resp_67c9fdcecf488190bdd9a0409de3a1ec07b8b0ad4e5eb654',
    object: 'response',
    access_programs: null,
    created_at: 1741290958,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: 'You are a helpful assistant.',
    model: 'gpt-6-astra',
    output: [
      {
        id: 'msg_67c9fdcf37fc8190ba82116e33fb28c507b8b0ad4e5eb654',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Hi there! How can I assist you today?',
            annotations: [],
            logprobs: [],
          },
        ],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 37,
      output_tokens: 11,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 48,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
    user: null,
    metadata: {},
  };
}
