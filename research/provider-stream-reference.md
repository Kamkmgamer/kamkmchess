# Provider stream fixture reference

Research for [KHA-21](https://linear.app/kamkm/issue/KHA-21), retrieved on 2026-10-16. This note checks OpenRouter Responses event names and native Anthropic Messages framing against first-party documentation and source. It supplements [provider-endpoints.md](provider-endpoints.md). It does not report live generation, CORS, account access, or billing behavior. Research used unauthenticated documentation and source GETs only.

## OpenRouter Responses

Use the current endpoint schema as the proposed synthetic fixture contract. Its stream discriminator and OpenRouter's TypeScript SDK agree on `response.output_text.delta`, `response.output_text.done`, `response.completed`, `response.failed`, `response.incomplete`, and `error`. The endpoint's Markdown reference was retrieved successfully even though the web extraction service could not read its HTML URL. The schema advertises `[DONE]` as its SSE sentinel. [Current endpoint reference][R1], [pinned schema discriminator][R2], [pinned SDK discriminator][R3].

The basic-usage guide still shows `response.content_part.delta` and `response.done`. The general streaming guide instead places Responses usage in `response.completed`. This is first-party documentation drift, not evidence that the endpoint supports both event vocabularies. `response.text.delta` appears in neither the reviewed endpoint schema nor its SDK discriminator. Do not accept these three names as text or completion aliases without new evidence. Their live behavior remains unverified. [Pinned basic-usage example][R4], [streaming guide][R5], [schema][R2], [SDK][R3].

The following are wire fields, before the SDK converts snake_case to camelCase:

| Event | Evidenced payload fields | Fixture consequence |
| --- | --- | --- |
| `response.output_text.delta` | Required `content_index`, `delta`, `item_id`, `logprobs`, `output_index`, `sequence_number`, `type`. | Include `logprobs: []` even when unused. Accumulate by item and content index. |
| `response.output_text.done` | Required `content_index`, `item_id`, `logprobs`, `output_index`, `sequence_number`, `text`, `type`. | Ends that text part. It does not establish successful completion of the response. |
| `response.completed` | Required `response`, `sequence_number`, `type`. | Use a full response object with `status: "completed"` and final output/usage. |
| `response.failed` | Required `response`, `sequence_number`, `type`. | Use `status: "failed"`; retain `response.error` and any `response.error_type`. |
| `response.incomplete` | Required `response`, `sequence_number`, `type`. | Use `status: "incomplete"`; retain `response.incomplete_details`. |
| `error` | Required flat `code`, `message`, `param`, `sequence_number`, `type`. `code` and `param` may be null. | Keep this separate from Anthropic's nested error object. |

The text and terminal requirements come directly from the [text delta schema][R6], [text done schema][R7], [completed schema][R8], [failed schema][R9], [incomplete schema][R10], and [error schema][R11]. The outcome recommendations are application decisions. These event schemas reference a general response schema, so the experiment should explicitly assert that terminal event and response status agree instead of assuming the schema enforces that relationship.

For example, a complete schema-shaped text delta and a separate error case are:

```json
{"type":"response.output_text.delta","content_index":0,"delta":"e2e4","item_id":"msg-fixture","logprobs":[],"output_index":0,"sequence_number":4}
{"type":"error","code":"rate_limit_exceeded","message":"Synthetic rate limit","param":null,"sequence_number":5}
```

These are independently authored fixture values, not captured provider responses. Terminal envelopes need a full response object, including required nullable fields. A miniature `{id, status}` response is unsuitable if the experiment claims schema-complete coverage. The response schema requires fields such as `completed_at`, `error`, `incomplete_details`, sampling fields, `instructions`, `metadata`, `tools`, `tool_choice`, and `parallel_tool_calls`. [Pinned response schema][R12].

The incomplete-detail schema lists `max_output_tokens` and `content_filter`; its `reason` is optional. The SDK treats the reason vocabulary as open. Test each listed reason and an absent or unknown reason without converting incomplete output to success. Failed responses may carry a canonical `error_type`, since native error codes can collapse distinct causes into `server_error`. Preserve it without inventing a more precise cause from the native code alone. [Incomplete details][R13], [Responses error guide][R14].

Recommended synthetic cases are a complete text stream, an error before any text, a failed response after partial text, and both listed incomplete reasons. Add missing-terminal, unknown-event, and alias-only streams. Alias-only `response.text.delta`, `response.content_part.delta`, or `response.done` streams must not produce accepted text or successful completion. `[DONE]` or EOF alone must not certify a successful move. These are proposed acceptance rules for the experiment, not observations of OpenRouter's live route.

## Native Anthropic Messages

Anthropic documents matching SSE event names and JSON `type` fields. The normal sequence is `message_start`, indexed content block start/delta/stop events, one or more `message_delta` events, and final `message_stop`. `message_delta.usage` counts are cumulative. Pings and future unknown events must be tolerated. Text content arrives as `content_block_delta` with `delta.type: "text_delta"` and `delta.text`. [Streaming guide][A1].

The final stop reason arrives in `message_delta.delta.stop_reason`; it begins null in `message_start` and is absent from `message_stop`. `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, and `model_context_window_exceeded` have distinct meanings. In particular, `max_tokens` and `model_context_window_exceeded` indicate truncation, while refusal is a normal protocol response. Successful framing does not by itself establish an accepted chess move. [Stop reasons and streaming considerations][A2].

Native stream errors use `event: error` with this nested structure:

```text
event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Synthetic overload"}}

```

Anthropic's example identifies `overloaded_error` as a possible in-stream error, normally HTTP 529 outside streaming. A synthetic stream served with HTTP 200 must retain its actual HTTP 200 and classify the event as failure; do not manufacture HTTP 529. The Messages stream contract does not use a Chat-style `[DONE]` success marker. [Streaming errors and full sequence][A1].

Recommended fixtures cover a normal text block followed by `message_delta` and `message_stop`, a ping between text chunks, cumulative usage, an error before text, an error after partial text, and EOF before `message_stop`. Include truncated and refusal stop reasons. Treat unknown events without corrupting known content or granting success. These are application acceptance rules grounded in the documented sequence.

## Native Anthropic raw preflight profiles

The current overview accepts bearer authorization and still supports `x-api-key`. It requires `anthropic-version` and JSON content type; a multi-workspace API key additionally requires `anthropic-workspace-id`. The pinned TypeScript SDK sends `anthropic-version: 2023-06-01` and adds `anthropic-dangerous-direct-browser-access: true` when `dangerouslyAllowBrowser` is enabled. It also adds SDK metadata. A raw-fetch profile matching the browser opt-in convention should include the direct-browser-access header itself. An SDK constructor option is not a wire header. [API overview][A3], [pinned SDK header construction][A4].

For raw requests, test the requested header-name sets separately:

- `content-type`, `x-api-key`, `anthropic-version`, `anthropic-dangerous-direct-browser-access`.
- `content-type`, `authorization`, `anthropic-version`, `anthropic-dangerous-direct-browser-access`.
- Each applicable set with `anthropic-workspace-id` added.

Do not label these SDK-complete profiles or infer that all SDK metadata headers receive permission. The SDK source proves that its opt-in adds the browser header; it does not by itself prove server-side enforcement of that header, origin permission, or account permission. Raw unauthenticated OPTIONS evidence can establish only the sampled response to the supplied origin, method, and header names.

Anthropic explicitly says CORS is unsupported for organizations with ZDR arrangements. A public OPTIONS response cannot overturn that account-level restriction. The current documentation does not establish that a workspace retention override removes it. [Retention and CORS restriction][A5].

## Evidence limits

OpenRouter source is pinned to docs commit `b0acfd4dfd30c3e0780aa00935c2245d64e3b3a7` and SDK commit `1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0`. Anthropic SDK source is pinned to `04a4c28c70de498d6d0e930e43edb5edb9ac545e`. Mutable documentation describes the contract retrieved on this date. Source agreement supports fixture selection but cannot settle which legacy aliases a live provider might emit. No credentials, provider POSTs, generation, browser automation, or production changes were used for this note.

[R1]: https://openrouter.ai/docs/api/api-reference/responses/create-a-response.md
[R2]: https://github.com/OpenRouterTeam/docs/blob/b0acfd4dfd30c3e0780aa00935c2245d64e3b3a7/openapi/openapi.yaml#L29973
[R3]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/streamevents.ts
[R4]: https://github.com/OpenRouterTeam/docs/blob/b0acfd4dfd30c3e0780aa00935c2245d64e3b3a7/api_reference/responses/basic-usage.mdx#L285
[R5]: https://openrouter.ai/docs/api_reference/streaming
[R6]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/textdeltaevent.ts#L16
[R7]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/textdoneevent.ts#L16
[R8]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/streameventsresponsecompleted.ts#L19
[R9]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/streameventsresponsefailed.ts#L19
[R10]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/streameventsresponseincomplete.ts#L19
[R11]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/errorevent.ts#L15
[R12]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/openresponsesresult.ts#L480
[R13]: https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/incompletedetails.ts#L13
[R14]: https://openrouter.ai/docs/api_reference/responses/error-handling
[A1]: https://platform.claude.com/docs/en/build-with-claude/streaming
[A2]: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
[A3]: https://platform.claude.com/docs/en/api/overview
[A4]: https://github.com/anthropics/anthropic-sdk-typescript/blob/04a4c28c70de498d6d0e930e43edb5edb9ac545e/src/client.ts#L1914
[A5]: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
