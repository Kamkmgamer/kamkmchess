# KHA-35 protocol-core evidence

## Scope

This candidate adds the preparatory protocol core for [KHA-35](https://linear.app/kamkm/issue/KHA-35/implement-chat-responses-and-messages-streaming-adapters). The [protocol modules](../../src/providers/protocols/index.ts) encode explicit request data and decode received Chat Completions, Responses and Anthropic Messages streams. They retain received bytes, raw events and unknown fields while returning normalized protocol outcomes.

The core does not fetch, select endpoints, read credentials, retry requests, parse chess moves or authorize controller transitions. Provider transport, connection profiles and credential handling remain future work. The application page is still a placeholder. This candidate does not complete KHA-35.

All 79 product acceptance cases remain `not_run`. Native browser, assistive technology, cloud and live-provider acceptance were not run. The offline fixtures below do not replace those checks.

## Provider references and Responses schemas

The public provider references used to check the protocol contracts are:

- OpenAI [Responses create API](https://developers.openai.com/api/reference/resources/responses/methods/create).
- OpenRouter [Responses create endpoint](https://openrouter.ai/docs/api/api-reference/responses/create-a-response.md) and [streaming guide](https://openrouter.ai/docs/api_reference/streaming).
- Anthropic [Messages API](https://platform.claude.com/docs/en/api/messages) and [streaming guide](https://platform.claude.com/docs/en/build-with-claude/streaming).

The native OpenAI Responses schema is the default. The OpenRouter R12 schema requires explicit selection. Its pinned public schema and SDK references are [OpenRouter's OpenAPI definition at commit `b0acfd4`](https://github.com/OpenRouterTeam/docs/blob/b0acfd4dfd30c3e0780aa00935c2245d64e3b3a7/openapi/openapi.yaml#L29973), [the pinned response schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/openresponsesresult.ts#L480), and [the pinned stream event definitions](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a4c465c9f0115f8e6b7e62dc3cf35d3587c10c0/src/models/streamevents.ts).

The R12 decoder requires `completed_at`, `frequency_penalty` and `presence_penalty` in the response envelope, including when their values are null. Text `delta` and `done` events require a non-negative safe-integer `sequence_number` and a `logprobs` array. Each log probability entry requires a string `token` and numeric `logprob`; optional `bytes` values must be integer arrays, and optional `top_logprobs` entries must use the documented field types. These R12-only checks do not apply to native OpenAI Responses.

Historical candidate note: The behavior described in the following paragraph records source commit `12c5503fa9212d7fe6ae91482cccf9b5581121b6`, cited in Verification. It is superseded by the follow-up state below and remains here to preserve the original candidate record.

The pinned R12 schema also requires `code`, `message`, `param`, `sequence_number` and `type` on a flat `error` event. A known diagnostic limitation remains: an `error` event with missing required fields can be classified as `failed` instead of `malformed`. `failed` is never a complete answer, so this does not authorize a move or affect MOV-03. This candidate keeps that non-blocking behavior unchanged.

## Verification

Source commit: `12c5503fa9212d7fe6ae91482cccf9b5581121b6`. Candidate base: `f354261c5dcfc136c04cded6e5a953fbf1545304`.

### PR follow-up state

The `kha35/streaming-adapters-followup` branch tightens the R12 error shape checks so missing or wrongly typed required fields are malformed, retains named Chat events without attempting to parse their payloads as JSON, and treats data-bearing frames after `[DONE]` as malformed. Invalid UTF-8 in a terminated frame remains malformed under the shared SSE decoder; an invalid-UTF-8 unterminated final frame remains raw and leaves the stream `truncated`. No regression fixtures were added or run for these follow-up changes, so the related acceptance evidence remains outstanding; all 79 product acceptance cases remain `not_run`.

| Command | Expected result | Observed result |
| --- | --- | --- |
| `npm ci` | Install the pinned dependencies from the lockfile. | Passed. 178 packages added; 179 audited; zero vulnerabilities. |
| `npm test -- src/providers/protocols/chat-completions.test.ts src/providers/protocols/responses.test.ts src/providers/protocols/anthropic-messages.test.ts` | All three protocol fixture files pass. | Passed. 68 tests across 3 files. |
| `npm run check` | Lint, full offline fixtures, both TypeScript projects, production build and notice generation pass. | Passed. Lint had zero warnings; 174 tests passed across 8 files; both TypeScript projects passed; Vite 8.3.4 built 15 modules; distribution notices were written. |

The committed [build ZIP](artifacts/KHA-35-build-12c5503.zip) contains the generated distribution. Its [SHA-256 entry manifest](artifacts/KHA-35-build-12c5503.json) records the source commit, ZIP digest, and each archive entry's path, size and digest. The archive has 8 entries. Its complete SHA-256 is `c657b4547a2040859cc900ca712bd8cc404e9d70dcaa42e3322b0ff7dfaa9419`. Each entry digest was computed from the bytes inside the ZIP and checked against the build output.

No provider credentials or provider API requests were used. These results establish an offline local build only. They do not certify deployment or product acceptance.
