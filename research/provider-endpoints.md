# Direct-browser provider protocols and endpoint compatibility

Research for [KHA-20](https://linear.app/kamkm/issue/KHA-20/establish-direct-browser-provider-protocols-and-endpoint-compatibility), checked on 2026-10-16. This report resolves documentation and source facts. It does not certify live provider transport or account access.

## Decision supported by the evidence

Support needs three distinct protocol adapters: Chat Completions, Responses, and Anthropic Messages. Provider identity, model family, and wire protocol are separate facts. A Claude model reached through OpenRouter Chat Completions still speaks Chat Completions to this application. Native Anthropic uses Messages. An editable URL cannot turn an arbitrary API into one of these protocols. OpenAI documents both Chat Completions and Responses; OpenRouter documents all three formats. [OpenAI comparison][O2], [OpenRouter Chat][R1], [OpenRouter Responses][R2], [OpenRouter Messages][R3], [Anthropic overview][A1].

The browser owns the game controller and provider requests. Hosted accounts, database storage, and optional full-game sync remain accepted. The chess backend must receive neither AI credentials nor model requests. This is the owner's accepted boundary, not a claim that every provider recommends browser-held keys. In particular, OpenAI's security guidance says to keep keys out of client code. Its SDK browser opt-in does not reverse that guidance. [OpenAI authentication][O1], [OpenAI SDK][O7].

There is one explicit browser restriction: Anthropic says CORS is unsupported for organizations with Zero Data Retention arrangements. Its suggested backend proxy conflicts with this application's accepted boundary. Such an account cannot be advertised as supported by the direct Anthropic browser route. The docs do not establish that a workspace retention override removes this organization-level CORS restriction. [Anthropic retention][A7].

## Scope and evidence method

I read KHA-20 without changing it, used `CONTEXT.md` only as a glossary, and read the existing [browser-to-proxy report](browser-proxy-transport.md). Research used unauthenticated documentation and source GETs. No real key, authenticated provider request, inference, paid usage, transport experiment, production edit, or deployment occurred. OpenAI research began with official-domain search followed by an actual fetch of the matching official page. A background research agent checked OpenRouter first-party pages; this report is the only repository artifact.

Documentation pages are mutable and all provider facts below are scoped to the review date. Anthropic SDK source is pinned to `04a4c28c70de498d6d0e930e43edb5edb9ac545e`. CLIProxyAPI source remains pinned to v8.0.30, `5be2cdab0869cbaa3d401891f740aebf7e15aa99`. Recommendations below are application design conclusions, not additional provider guarantees.

## Routes, headers, and request formats

### OpenAI

The HTTP API uses `https://api.openai.com/v1`. Chat Completions creates with `POST /chat/completions`; Responses creates with `POST /responses`. Both use bearer authentication and JSON request bodies. Organization and project headers can select the billing/access scope for legacy or multi-organization credentials. No Anthropic version header belongs in an OpenAI preset. [Authentication][O1], [Chat create][O3], [Responses create][O4].

Chat Completions requires `model` and `messages`. It returns `choices[].message`, or streamed `choices[].delta`. Current OpenAI documentation uses `max_completion_tokens` for the output budget, including reasoning tokens; the older `max_tokens` field is deprecated there and incompatible with o-series models. Custom Chat-compatible servers can have different field support, so do not apply that parameter rename universally. [Chat create][O3].

Responses uses `model` and `input`, with `instructions` or instruction messages. It returns typed `output` items, which can include messages and reasoning items. Its output budget is `max_output_tokens`; structured JSON configuration is under `text.format`, whereas Chat uses `response_format`. These differences require serialization and extraction changes, not a URL replacement. OpenAI recommends Responses for new projects while continuing to support Chat Completions. Parameter and endpoint availability still depend on the chosen model. [Responses create][O4], [Migration guide][O2].

The adapter must select a documented endpoint for the exact configured model and supported parameters. A model's name or family does not prove that it supports both APIs, a particular reasoning setting, JSON schema, temperature, or a stop sequence. Discovery below does not answer all these questions. [Chat create][O3], [OpenAI models][O8].

### OpenRouter

OpenRouter documents these full generation URLs:

- `https://openrouter.ai/api/v1/chat/completions` for Chat Completions.
- `https://openrouter.ai/api/v1/responses` for Responses.
- `https://openrouter.ai/api/v1/messages` for Anthropic Messages format.

The current route references document bearer authentication and JSON. The Messages reference does not list `x-api-key` or `anthropic-version` as mandatory. That omission is not proof that alternative headers are unsupported. OpenRouter's optional attribution headers are `HTTP-Referer` and `X-OpenRouter-Title`; legacy `X-Title` remains supported. Attribution is separate from generation authentication. [Chat][R1], [Responses][R2], [Messages][R3], [Authentication][R4], [Attribution][R5].

SDK base URLs differ because SDK methods append different paths. An OpenAI-style client uses `https://openrouter.ai/api/v1`, then appends `/chat/completions` or `/responses`. OpenRouter's Anthropic SDK example sets `https://openrouter.ai/api`, because that SDK appends `/v1/messages`. Putting `/api/v1` into that Anthropic example would duplicate the version path. Record the final HTTP URL independently of the SDK base URL. [Authentication examples][R4], [Anthropic SDK example][R6].

### Native Anthropic

Native Claude uses `https://api.anthropic.com` and `POST /v1/messages`. Current overview guidance accepts `Authorization: Bearer <API key or access token>` and still supports `x-api-key` as a legacy fallback. Send one intended credential form. The overview requires `anthropic-version`, normally `2023-06-01`, and `content-type: application/json`. A multi-workspace API key also needs `anthropic-workspace-id`; a single-workspace key can omit it. [Anthropic overview][A1].

There is a documentation inconsistency: the generated Messages reference marks `anthropic-version` optional, while the overview marks it required. The evidence-backed preset should send it, matching the SDK's default, rather than depend on omission. Optional feature betas are separate headers and should appear only for a documented, selected feature. [Messages create][A2], [Overview][A1], [Pinned SDK header construction][A4].

Messages requires `model`, `messages`, and `max_tokens`. Input roles are `user` and `assistant`; instructions use top-level `system`, not a `system` message. Adjacent turns with the same role are combined. Response `content` is an ordered array of blocks, rather than a Chat `choices` entry. JSON schema output, where the model supports it, uses `output_config.format`. A final assistant prefill can fail on models that do not support it, so it is unsuitable as a universal JSON-enforcement trick. [Messages create][A2].

### Existing CLIProxyAPI

The pinned server registers authenticated `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`. Source route registration does not prove every upstream model implements every route. The existing move contract uses Chat Completions streaming and remains the compatibility baseline; adding other protocols must preserve its logical outcomes. Config-key authentication accepts bearer and `X-Api-Key` among its supported forms. [Pinned routes][C1], [Pinned authentication][C2].

The previous experiment used actual CORS and authentication middleware with synthetic catalog and generation handlers. It established readable cross-origin requests in sampled Windows headless Chrome and Edge 155 under the recorded permissions. Its buffered SSE established body/framing readability, not live chunk delivery, cancellation, or a complete deployed proxy. It says nothing about OpenAI, OpenRouter, Anthropic, or another endpoint's CORS. [Recorded evidence](browser-proxy-transport.md), [Pinned CORS source][C3].

## Browser access and credential handling

OpenAI and Anthropic TypeScript SDKs disable browser use by default and expose `dangerouslyAllowBrowser: true`. Both warn that browser code can expose credentials. Anthropic's pinned SDK also adds `anthropic-dangerous-direct-browser-access: true` when that option is enabled. A raw-fetch adapter following this convention must send the header itself; the constructor flag is not an HTTP field. The SDK sends version and additional SDK metadata headers too. An SDK integration must account for its actual header set in preflight. None of these client options proves that every account, origin, route, or header set receives CORS permission. [OpenAI SDK][O7], [Anthropic SDK][A3], [Pinned Anthropic headers][A4].

OpenRouter supplies stronger affirmative browser-use documentation: its OAuth PKCE guide describes a user-controlled key stored in the user's browser and subsequent `fetch` to Chat Completions. Its authentication guidance recommends key credit limits and keeping unlimited keys out of client code. This is evidence of a documented browser integration pattern, not a CORS commitment for all three APIs, every origin, or extra headers. [OpenRouter OAuth][R7], [Key guidance][R4].

I found no unconditional first-party CORS commitment covering all required OpenAI routes and headers. OpenRouter's reviewed pages likewise do not settle that whole matrix. Anthropic's browser opt-in and browser-access header are affirmative client support, but its ZDR restriction is explicit. Lack of wider evidence means unverified transport, not proof of failure. No provider transport was tested here. [OpenAI SDK][O7], [OpenRouter OAuth][R7], [Anthropic SDK][A3], [Anthropic CORS restriction][A7].

Application conclusions within the accepted architecture:

- Bind each secret to a specific connection identity and approved destination. Never share a global bearer header across provider clients. Treat secret-valued extra headers as credentials too. Changing the destination requires a deliberate credential assignment.
- Keep secrets out of game records, optional cloud sync, exports, analytics, crash reports, console logs, and URLs. Default to browser memory for the session. Persistent browser storage would be a separate explicit product choice and does not make keys inaccessible to page scripts.
- Use browser fetch with `credentials: "omit"` for these header-authenticated presets. Cookie authentication is not established by the reviewed provider contracts. A failed CORS request must not trigger a chess-backend relay.
- Custom headers cannot bypass CORS. JSON and authentication headers affect preflight; browser-forbidden fields such as `Host`, `Origin`, `Cookie`, and `Content-Length` cannot be treated as arbitrary editable headers. [Fetch headers and CORS][W1].

Provider security guidance remains relevant to player-supplied keys. The product must describe their actual exposure without claiming provider endorsement. OpenAI's general server-key recommendation cannot be satisfied by quietly routing through this application's backend. [OpenAI authentication][O1], [SDK warning][O7].

## Discovery, model IDs, and capability limits

OpenAI `GET /v1/models` returns identifiers and basic ownership/availability information. Its listed model schema does not supply context windows, per-protocol support, JSON capabilities, or every parameter constraint. Use the exact ID with the model's documentation. A catalog result is not proof that a given generation body is valid. [OpenAI models][O8].

OpenRouter `GET /api/v1/models` supplies `id`, `context_length`, provider limits, and `supported_parameters`. These help configure requests but do not certify that the current retained conversation plus output/reasoning budget fits. Default provider routing can ignore unsupported parameters. `provider.require_parameters: true` filters for providers that support the requested parameters; it is a routing constraint, not a guarantee of JSON correctness or faithful history. [OpenRouter models][R8], [Parameter enforcement][R9].

Anthropic `GET /v1/models` is paginated. Current docs include nullable `capabilities`, `max_input_tokens`, and `max_tokens`, plus lifecycle information. Do not rely on older assumptions that its catalog only contains names. Null metadata means unknown, and deprecated or explicitly requested retired entries require care. Capability support can still be restricted by the organization. [Anthropic model listing][A5].

CLIProxyAPI's catalog is its local advertised catalog, not a universal capability registry for underlying subscriptions. The existing synthetic test did not establish real catalog registration or upstream permissions. [Pinned route][C1], [Experiment limits](browser-proxy-transport.md).

Allow manual exact model IDs when discovery is missing, blocked, or incomplete. Show capabilities as unknown until documented or supplied by the player for that endpoint. Manual entry does not grant access or establish capacity. Keep the configured request ID and provider's returned model identity for attribution. Do not derive protocol from a model-family prefix or silently replace a configured model with a discovered alternative.

## Streaming, completion, failures, and cancellation

Each adapter needs an incremental SSE parser that handles chunk boundaries and an independent protocol completion classifier. Receiving HTTP 200, a JSON-looking fragment, or an ordinary EOF is insufficient to accept a move.

- Chat Completions uses `data:` frames with `choices[].delta`, a terminal `finish_reason`, and `[DONE]`. `stop` is the normal text completion; `length`, `content_filter`, and tool-call finishes require separate handling. OpenRouter also normalizes `error` and exposes `native_finish_reason`; usage chunks may have no new text. Preserve that evidence instead of counting each chunk as a response. [OpenAI Chat][O3], [OpenRouter finish reasons][R10], [Streaming][R11].
- Responses uses typed events including `response.output_text.delta`, `response.output_item.done`, `response.completed`, `response.incomplete`, and `response.failed`, plus error events. A text-block done event is not the whole-response completion. Keep output ordering, item IDs, final native items, status, errors, and incomplete details. The current OpenAI schema includes reasons such as output-budget exhaustion and filtering. [OpenAI streaming][O9], [Event reference][O10], [Responses schema][O4].
- Anthropic Messages uses `message_start`, block start/delta/stop events, `message_delta`, then `message_stop`. It can emit pings and in-stream errors after HTTP 200; unknown event types must be handled without corrupting known content. Evaluate `stop_reason`: `end_turn` differs from `max_tokens`, `model_context_window_exceeded`, `tool_use`, `pause_turn`, or `refusal`. Native refusal requires mapping through the established game policy; a transport or policy error is not automatically a model's chess resignation. [Anthropic stream][A6], [Messages stop reasons][A2].

OpenRouter's current streaming/schema documentation uses `response.completed`, while Responses basic-usage examples still show `response.done` and `response.content_part.delta`. This guide drift remains unresolved. Prefer the current endpoint schema as the proposed contract, then verify fixtures for that route before implementation. Do not assume undocumented event aliases. [OpenRouter current streaming][R11], [Responses schema][R2], [Older examples/history guide][R12].

OpenRouter documents errors arriving after HTTP 200, sometimes as the first event. Its error representation differs by protocol. Preserve the HTTP status, provider code, native payload, and request identity; normalize context exhaustion separately from authentication, rate limits, overload, malformed events, incomplete output, JSON formatting, and chess illegality. A browser-level fetch failure may not reveal whether the cause was CORS, connectivity, TLS, or permission. Do not manufacture a provider HTTP status from it. [OpenRouter errors][R13], [Fetch standard][W1].

OpenAI's SDK accepts an `AbortSignal`, including while reading a response. Anthropic documents breaking stream iteration or calling `stream.controller.abort()`. These are client cancellation mechanisms. OpenAI's `/responses/{id}/cancel` endpoint applies only to responses created with `background: true`; it is not a generic foreground cancel API. OpenRouter says upstream cancellation/billing cessation depends on provider support, and unsupported or non-streaming requests can finish and bill after disconnect. [OpenAI SDK][O7], [Anthropic SDK][A3], [OpenAI cancel][O11], [OpenRouter cancellation][R11].

The application should abort on invalidation and still fence every late event or response against the active match version. Do not promise provider cancellation, a refund, or generation after the tab closes. No service-worker, background-job, or closed-tab execution promise follows from these HTTP APIs.

Both OpenAI and Anthropic SDKs retry some failures twice by default. Disable hidden SDK retries for generation and let the game controller issue explicit retries with a fresh clock snapshot, retained context, and request/version identity. This is necessary because an SDK transport retry would otherwise resend the old body and clock. Technical retry policy remains separate from the four-illegal-attempt limit. [OpenAI SDK retries][O7], [Anthropic SDK retries][A3].

## Full history and native reasoning

The replay contract concerns everything actually received as retained conversation text, with attribution. Hidden reasoning that was never returned is unavailable. Provider-native opaque state and readable received text must have separate representations.

OpenAI Chat Completions requires the accumulated `messages` on each request. Responses permits manual full `input` replay as well as provider-managed state. For stateless Responses, official guidance says to preserve every returned output item, including reasoning items and assistant `phase` where present. Current docs say encrypted reasoning is returned by default; completed reasoning items, not incomplete added-event values, are the replay source. Do not retain only the SDK's aggregated `output_text`. [Migration][O2], [Conversation state][O5], [Responses item schema][O4].

OpenAI's raw reasoning tokens are not visible. Returned summaries are received text, not raw chain of thought. Current reasoning guidance limits persisted reasoning reuse to compatible models within the same family and says incompatible reasoning is omitted after a family switch. There is no evidence that OpenAI's encrypted reasoning is native state for Anthropic or OpenRouter. Preserve the original items locally, but do not claim invisible reasoning continuity across providers. [OpenAI reasoning][O6].

Anthropic returns ordered text, thinking, and possibly redacted-thinking blocks. Readable thinking is a summary; signatures and redacted data are opaque. Preserve blocks and signatures unchanged for compatible native replay. Thinking blocks are required within thinking/tool-use continuations and recommended across turns; outside tool use, provider permission to omit them does not authorize this application to discard received text. Anthropic documents some cross-platform signature compatibility within Claude, with account-bound exceptions. That is not compatibility with arbitrary model families or protocols. [Anthropic thinking][A8].

OpenRouter accepts readable `reasoning` and structured `reasoning_details`, including text, summaries, and encrypted data with origin-specific formats. It requires order and contents of consecutive native reasoning blocks to remain intact. A common wrapper does not make encrypted or signed native state portable. [OpenRouter reasoning][R14].

Proposed application representation and replay rules:

1. Retain the exact received text and ordered blocks with provider connection, requested/returned model, protocol, attempt, completion state, and match version. Keep opaque native data alongside that record. Partial output already received remains attributable partial output; never relabel it as a complete assistant answer.
2. Build every request from the active retained line, including FEN, piece list, original instructions, all retained received conversation text, and a fresh clock snapshot. Encode speaker/model attribution explicitly because Messages lacks a per-message `name` field and can merge adjacent same-role turns. Transport encoding may change roles or block shapes; it must not summarize, replace, or omit the text. Previous model output must not become privileged system instructions.
3. Replay native opaque state only where the documented protocol/model/account combination accepts it. On a provider switch, replay all received plaintext and attribution as conversation content while retaining native opaque items in the archive. Never describe that text projection as transfer of hidden reasoning. If a selected route cannot carry the required received text faithfully, block it instead of silently degrading the history contract.
4. Prefer explicit full input over server conversation handles for this game. A `previous_response_id` alone does not satisfy the requirement that every request carries the retained conversation. Provider state is especially unsuitable as the authority for Undo.
5. Undo restores the earlier position and corresponding retained context. It does not replay the discarded continuation. Preserve the entire discarded archive separately, including native blocks and request metadata, without refunding elapsed time. Version fencing applies even when an earlier request ignored cancellation.

Native-state replay alone is not proof that received readable summaries reenter the model's visible prompt. OpenAI can omit incompatible reasoning, and Anthropic can strip prior native thinking or reconstruct it from an opaque signature. The canonical attributed text projection must therefore carry all received readable summaries as text when native replay would not preserve their visibility. Keep that projection distinct from native state, retain its original attribution, and never invent missing reasoning text. [OpenAI reasoning compatibility][O6], [Anthropic thinking preservation][A8].

These are application requirements derived from the accepted contract. They do not promise identical model behavior across protocols.

## Capacity, retention, and automatic transformations

OpenAI Responses defaults `truncation` to `disabled`; `auto` can drop earlier conversation items to fit. Send `truncation: "disabled"` explicitly, avoid compaction/context-editing options, and treat capacity rejection as a blocked generation while the clock continues. Input, output, and reasoning budgets all matter. A catalog context number alone cannot validate the complete serialized request. [Responses truncation][O4], [Conversation capacity][O5].

OpenRouter Responses is stateless and requires full history. Its documentation rejects `store: true` and non-null `previous_response_id` with HTTP 400. Its history examples also require assistant message `id` and `status`. OpenRouter's context-compression transform removes or truncates middle messages and is enabled by default for endpoints with context limits of 8,192 tokens or less. Explicitly send `plugins: [{"id":"context-compression","enabled":false}]` and avoid legacy middle-out transforms. Avoid model fallback lists and automatic model routers when substitution is forbidden. Routing among hosts for an exact model still has provider-specific limits and retention policies. [Responses overview][R15], [History guide][R12], [Transforms][R16], [Fallbacks][R6].

For Anthropic, preserve all required text even where the API is allowed to strip earlier native thinking. Do not enable context-management/compaction strategies or treat `model_context_window_exceeded` as successful move generation. Input limits can also cause rejection before any stream starts. The game must not solve capacity errors by trimming history or switching models. [Messages][A2], [Thinking preservation][A8], [Model capacities][A5].

Default provider-side request retention needs an explicit policy:

- Send `store: false` for OpenAI Chat and Responses. Responses stores generated responses by default; the current migration guide also describes default Chat storage for new accounts. Disabling response storage does not disable all abuse-monitoring logs, which can retain content for up to 30 days under standard controls. Do not label this setting Zero Data Retention. [Storage defaults][O2], [OpenAI data controls][O12].
- OpenRouter documents content logging/product-improvement opt-outs by default while collecting metadata; upstream provider policies vary. Keep optional content logging, tools, and plugins off. Its `provider.zdr: true` restricts routing to eligible endpoints but still permits implicit in-memory caching and does not control third-party tool/plugin retention. Response caching is a separate opt-in and can be disabled with `X-OpenRouter-Cache: false` even when a preset enabled it. Such an extra header also expands the CORS evidence needed. Do not infer these properties from `store: false`. [Data collection][R17], [ZDR][R18], [Response cache][R19].
- Native Anthropic Messages has no documented OpenAI-style `store` control in the reviewed schema. Retention depends on account/workspace/model arrangements; some covered models require 30-day retention. Do not add a fictional no-retention field or change account settings. ZDR's documented CORS restriction still applies. [Messages][A2], [Anthropic retention][A7].
- Custom endpoints and CLIProxyAPI need their own operator/upstream retention facts. A compatible JSON body or successful browser request does not establish a logging policy. Preserve the local game/archive contract independently of provider storage.

## Evidence-backed custom endpoint configuration

Configure a connection, not just a model label. The minimum useful fields are a connection ID/display name, selected wire protocol, exact model ID, endpoint URL mapping, authentication scheme and isolated secret, and documented capability overrides when discovery is absent. Model family is attribution metadata, not protocol selection. Keep advanced options limited to requirements supported by that endpoint's own docs.

Preserve arbitrary legitimate path prefixes. For example, `https://gateway.example/team/alice/v1` plus `chat/completions` must retain `/team/alice/`; a leading-slash URL join can discard it. Decide whether the user enters an API root or a full generation URL and make that unambiguous. Store discovery URL separately if it does not share the root. Append each protocol's version/path once. The OpenRouter SDK examples above demonstrate why one universal `baseURL` convention is insufficient. [OpenRouter URL examples][R4], [Anthropic SDK example][R6].

Support documented bearer, API-key-header, or no-auth configurations rather than assuming every endpoint takes a bearer key. Allow endpoint-specific extra headers, including version, organization/project/workspace, beta, or required gateway headers. Prevent duplicate conflicting authentication fields and mark secrets for exclusion from records and logs. Do not offer browser-forbidden headers as working configuration. Discovery can be optional; the generation response, errors, stream framing, completion reasons, and full-history handling still must match the selected adapter. [Provider authentication][O1], [Anthropic headers][A1], [Fetch][W1].

Use the final documented URL rather than depending on redirects. Fetch can change POST to GET for 301/302/303 and strips `Authorization` on cross-origin redirect. That bearer-specific rule is not proof that arbitrary secret custom headers are stripped. A proposed safe default is `redirect: "error"` for credentialed generation and discovery, with endpoint correction rather than automatic credential forwarding. No reviewed provider requires a generation redirect, and no redirect experiment ran. [Fetch redirect algorithm][W1].

Do not automatically try multiple protocols, paths, auth headers, or model substitutes with the player's key. A custom service with a different request/response schema requires another documented adapter. Unknown capabilities should remain unknown; a settings form cannot manufacture protocol compatibility, CORS, token limits, cancellation, or privacy guarantees.

## Game contract preserved across adapters

These requirements come from the accepted task brief and are not provider facts:

- The model independently chooses JSON `{ "move": "...", "plan": "..." }`, with `plan` optional. No legal-move list, narrowed candidate set, engine-selected replacement, or other legal-move hint is supplied. A JSON schema may constrain shape, not enumerate legal moves.
- Every request and explicit retry includes FEN, a piece list, the full attributed retained received conversation, and a fresh clock snapshot. No silent trimming, compaction, summary replacement, or model substitution is allowed.
- Four illegal attempts total remain the limit. A formatting error is not an illegal move; transport, provider, streaming, and capacity errors remain separate. Only a complete parsed move reaches chess legality validation. Do not salvage a plausible move from a failed/truncated stream.
- Full-history capacity failure blocks generation while the clock continues. Undo restores the earlier retained line; the complete discarded continuation remains in a separate archive. Responses and stream events must pass the current version fence before changing the game.
- There is no promise of background generation after a closed tab. Cancellation is best effort at the transport/provider level and never replaces version fencing.

The adapters change wire representation and outcome classification. They must not change these logical outcomes inherited from the CLIProxyAPI Chat Completions move contract.

## Unresolved evidence and support limits

1. OpenAI browser CORS is not certified. Missing evidence is the actual permission for the production origin, Chat/Responses/catalog paths, and exact auth/SDK/optional header sets, including readable errors, incremental streams, and cancellation behavior. Official SDK opt-in is insufficient.
2. OpenRouter has documented browser Chat usage but no reviewed blanket CORS promise for Chat, Responses, Messages, catalog, and all optional headers. Exact route/header transport and Responses event-guide drift remain unverified. Native Messages support must not be inferred from a Chat browser example.
3. Anthropic ZDR CORS is an explicit restriction. Non-ZDR route/header/origin behavior remains untested. No evidence here proves that a workspace retention change removes the restriction, or that every multi-workspace account works directly in-browser.
4. The existing CLIProxyAPI evidence remains limited to its recorded middleware/fixtures/browsers/permissions. Full upstream operation, live streaming, cancellation, and other browser/network environments remain outside it. No rerun occurred.
5. Each custom deployment must establish its own schema, headers, URL conventions, CORS, retention, limits, and native-state compatibility. Manual model IDs solve missing discovery only. They do not solve those requirements.

These limits block unconditional launch-support claims for the affected combinations, not the documentation research itself. The parent owns any Linear resolution, attachment, status change, or narrowly scoped follow-up. This task created none.

[O1]: https://developers.openai.com/api/reference/overview
[O2]: https://developers.openai.com/api/docs/guides/migrate-to-responses
[O3]: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
[O4]: https://developers.openai.com/api/reference/resources/responses/methods/create
[O5]: https://developers.openai.com/api/docs/guides/conversation-state
[O6]: https://developers.openai.com/api/docs/guides/reasoning
[O7]: https://developers.openai.com/api/reference/typescript
[O8]: https://developers.openai.com/api/reference/resources/models/methods/list
[O9]: https://developers.openai.com/api/docs/guides/streaming-responses
[O10]: https://developers.openai.com/api/reference/resources/responses/streaming-events
[O11]: https://developers.openai.com/api/reference/resources/responses/methods/cancel
[O12]: https://developers.openai.com/api/docs/guides/your-data
[A1]: https://platform.claude.com/docs/en/api/overview
[A2]: https://platform.claude.com/docs/en/api/messages/create
[A3]: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
[A4]: https://github.com/anthropics/anthropic-sdk-typescript/blob/04a4c28c70de498d6d0e930e43edb5edb9ac545e/src/client.ts#L1914
[A5]: https://platform.claude.com/docs/en/api/models/list
[A6]: https://platform.claude.com/docs/en/build-with-claude/streaming
[A7]: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
[A8]: https://platform.claude.com/docs/en/build-with-claude/thinking
[R1]: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
[R2]: https://openrouter.ai/docs/api/api-reference/responses/create-a-response
[R3]: https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message
[R4]: https://openrouter.ai/docs/api_reference/authentication
[R5]: https://openrouter.ai/docs/app-attribution
[R6]: https://openrouter.ai/docs/guides/routing/model-fallbacks
[R7]: https://openrouter.ai/docs/guides/overview/auth/oauth
[R8]: https://openrouter.ai/docs/guides/overview/models
[R9]: https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters
[R10]: https://openrouter.ai/docs/api_reference/overview
[R11]: https://openrouter.ai/docs/api_reference/streaming
[R12]: https://openrouter.ai/docs/api_reference/responses/basic-usage
[R13]: https://openrouter.ai/docs/api_reference/errors-and-debugging
[R14]: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning-blocks
[R15]: https://openrouter.ai/docs/api_reference/responses/overview
[R16]: https://openrouter.ai/docs/guides/features/message-transforms
[R17]: https://openrouter.ai/docs/guides/privacy/data-collection
[R18]: https://openrouter.ai/docs/guides/features/zdr
[R19]: https://openrouter.ai/docs/guides/features/response-caching
[C1]: https://github.com/router-for-me/CLIProxyAPI/blob/5be2cdab0869cbaa3d401891f740aebf7e15aa99/internal/api/server_routes.go#L63
[C2]: https://github.com/router-for-me/CLIProxyAPI/blob/5be2cdab0869cbaa3d401891f740aebf7e15aa99/internal/access/config_access/provider.go
[C3]: https://github.com/router-for-me/CLIProxyAPI/blob/5be2cdab0869cbaa3d401891f740aebf7e15aa99/internal/api/server_middleware.go#L167
[W1]: https://fetch.spec.whatwg.org/
