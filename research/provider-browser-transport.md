# Provider browser transport and synthetic streaming

Evidence for [Verify provider browser preflights and synthetic streaming](https://linear.app/kamkm/issue/KHA-21), recorded on 2026-10-16 in Cairo. Raw UTC timestamps are on 2026-10-15. This resolves the task's bounded experiment and gives the connection decision measured limits.

## What the evidence supports

The sampled provider routes returned readable catalog or authentication/validation responses in Windows Chrome and Edge, with one concrete exception. Adding `X-OpenRouter-Cache: false` to the OpenRouter catalog profile failed browser preflight in both browsers. The diagnostic identifies `x-openrouter-cache` as disallowed, and all four sampled OpenRouter route allowlists omit it. Attribution headers alone worked on catalog GET. Do not make the cache header part of a direct-browser default or claim it can reliably disable caching through these sampled routes.

All 78 final tunnel fixture cases and six separate byte-fragmentation cases met their intended checks. These establish behavior of a disposable fetch client and controlled service. They do not certify live provider generation or a production chess adapter.

The next decision can choose conditional direct-browser profiles. Successful catalog access or OPTIONS responses cannot establish authenticated generation, account eligibility, every SDK header, or a different production origin. Anthropic's documented organization-level ZDR CORS restriction still applies. [Existing provider research](provider-endpoints.md), [retention restriction](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).

## Environment and exact boundaries

- OS was Windows 11 Pro 10.0.26300, build 26300. Chrome was 155.0.8059.79 and Edge was 155.0.4283.45. Node was 24.22.0.
- The controlled HTTPS source and synthetic destination was `https://1fed-156-204-70-131.ngrok-free.app`. Cross-origin synthetic checks used an ordinary `https://example.com` document as the source. The tunnel has been stopped; its URL is an evidence identifier.
- Chrome and Edge ran headless with fresh task-owned profiles and contexts. No CORS/security disabling flags, certificate bypass, or response interception was used. The six loopback cases used ordinary CDP local-network permission grants, with queried states saved separately. Native permission UI was not exercised.
- The T3 preview opened successfully, but two snapshot attempts returned `Preview automation snapshot timed out after 15000ms.` The experiment then used the repository's documented installed-browser workflow.
- Provider traffic was restricted to raw unauthenticated OPTIONS probes and browser model-catalog GETs. Credential/header values were absent or clearly synthetic and invalid. No provider generation POST, real key, model invocation, paid usage, account change, or production deployment occurred.

The [environment](../experiments/provider-browser-transport/evidence/environment.json), [profile source](../experiments/provider-browser-transport/profiles.mjs), and [reproduction instructions](../experiments/provider-browser-transport/README.md) record the routes, exact header sets, versions, and test procedure.

## Raw OPTIONS and browser catalog findings

The final [OPTIONS trace](../experiments/provider-browser-transport/evidence/options.json) contains 25 HTTP probes, separate from browser execution. OpenAI's six profiles and Anthropic's six returned HTTP 200; OpenRouter's thirteen returned HTTP 204. Each recorded response permitted the supplied origin and proposed method. Twenty-one allowlists included every requested header name. The other four were OpenRouter profiles containing the unlisted cache header. HTTP 204 alone did not make those profiles usable.

Each browser then ran nine model-catalog GET profiles from the controlled HTTPS origin:

| Profile | Chrome | Edge | Meaning |
| --- | --- | --- | --- |
| OpenAI bearer | Readable 401 | Readable 401 | The sampled unauthenticated error was readable. |
| OpenAI bearer plus synthetic organization/project | Readable 400 | Readable 400 | Header validation response was readable; no valid scope was tested. |
| OpenRouter bearer, deliberately invalid | Readable 200 | Readable 200 | Public catalog behavior; not authentication success. |
| OpenRouter bearer plus attribution | Readable 200 | Readable 200 | Sampled attribution header set passed catalog transport. |
| OpenRouter attribution plus cache header | CORS failure | CORS failure | `HeaderDisallowedByPreflightResponse` named `x-openrouter-cache`. |
| OpenRouter public, no authentication header | Readable 200 | Readable 200 | Public catalog was readable. |
| Anthropic API key plus version/browser header | Readable 401 | Readable 401 | Invalid-key response was readable. |
| Anthropic bearer plus version/browser header | Readable 401 | Readable 401 | Invalid-bearer response was readable. |
| Anthropic API key plus synthetic workspace/beta | Readable 400 | Readable 400 | Validation response was readable; no eligible workspace was tested. |

The raw OPTIONS matrix also includes JSON generation paths for OpenAI Chat Completions and Responses, OpenRouter Chat Completions/Responses/Messages, and native Anthropic Messages. Those paths received **no provider generation POST**. Their raw allowlists are evidence about the sampled OPTIONS responses only. The experiment used selected raw-fetch headers, not complete SDK-generated metadata.

Readable catalog bodies are bounded samples. Unused response-cookie values are omitted from the published raw header trace. Browser CORS failures retain their actual fetch error and diagnostics; no provider HTTP status is invented for an unreadable response.

## Controlled stream results

The service generated independently authored text and protocol-shaped events. It could not contact a provider. Each browser ran the same 39 tunnel cases:

| Outcome | Cases per browser | Check |
| --- | --- | --- |
| Complete | 9 | Three protocols, normal/stale same-origin and normal cross-origin streams. |
| Stream error after HTTP 200 | 6 | Error before text and after partial text for all protocols. |
| HTTP error | 3 | Readable synthetic HTTP 429, distinct from in-stream errors. |
| Truncated | 4 | Missing terminal events for all protocols and an alias-only Responses stream. |
| Read error | 3 | Deliberate socket disconnect retained partial text without success. |
| Aborted | 6 | Same-origin and cross-origin local abort after first text. |
| Incomplete | 3 | Chat `length`, Responses `max_output_tokens`, Messages `max_tokens`. |
| Protocol error | 3 | Malformed JSON was rejected after partial text. |
| Fetch error | 2 | Missing allowed auth header and wrong allowed origin prevented the synthetic POST. |

Normal streams delivered two intact text deltas separated by more than 100 ms, before terminal completion. These timings establish incremental receipt in the recorded run, not a provider latency benchmark. The separate six loopback cases each observed eight reads, a partial SSE line, and the UTF-8 bytes for `é` split between reads. The streaming decoder reconstructed `fixture café ♞` correctly for all three protocols in both browsers.

Each local-abort case has a matching controlled-server close before normal completion. That proves the controlled connection was closed, not that an upstream provider stops generation, avoids billing, or refunds usage. The stale cases intentionally let a stream finish after invalidation and verified that subsequent text/events were excluded from the disposable client's applied result. This is an isolated fence demonstration, not acceptance testing of a chess controller.

The fixture parser covers only the fields needed for these outcomes. It does not validate complete provider object schemas, multiple output items or choices, tool calls, every refusal/stop reason, thinking state, or production history replay. Those remain implementation and acceptance work.

## Preserved failures and source reconciliation

The initial CRLF run failed protocol checks when several SSE events shared a server write. The public route merged their data and event names; the same loopback response preserved eight separate Messages events. A separate Node HTTP comparison reproduced that difference without the browser client. LF framing preserved all eight events through the public route. Both [CRLF](../experiments/provider-browser-transport/evidence/transport-diagnostic.json) and [LF](../experiments/provider-browser-transport/evidence/transport-diagnostic-lf.json) comparisons are retained. This establishes a failure on that controlled route, not its internal cause or a provider defect.

The final harness uses LF framing. The focused loopback phase checks actual byte fragmentation because the tunnel delivered complete events. Initial browser JSON and source versions remain under [initial evidence](../experiments/provider-browser-transport/evidence/initial/). Those runs also preserve a page-readiness assumption that expected a heading missing from example.com's body, and a later browser-startup race. Readiness now checks the observed document title and waits for the owned debugging endpoint. Failed setup attempts are not counted as final passes.

Independent source research reconciled OpenRouter's fixture contract against its current endpoint reference and pinned SDK. Both use `response.output_text.delta` and `response.completed/failed/incomplete`. The basic guide still shows `response.content_part.delta` and `response.done`. The alias-only fixture produces no text or success; live alias behavior remains unverified. Responses errors have flat fields, while native Anthropic error events use a nested error object. Details and pinned citations are in [provider stream fixture reference](provider-stream-reference.md). The OpenAI fixtures follow its [Responses event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events) and [Chat event reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events).

## Verification and remaining acceptance work

The [evidence checker](../experiments/provider-browser-transport/summarize.mjs) passed all twelve checks. It validates the exact OPTIONS matrix, final outcomes, incremental timing, byte splits, abort/close correlation, invalidation fence, restrictive CORS controls, and absence of browser provider generation requests. It also verifies that the previous KHA-15 evidence manifest and every covered file remain unchanged. The [summary](../experiments/provider-browser-transport/evidence/summary.json), raw browser traces, server write records, and [SHA-256 manifest](../experiments/provider-browser-transport/evidence/file-manifest.json) accompany the source.

The final [cleanup record](../experiments/provider-browser-transport/evidence/cleanup.json) found no remaining task browser processes or listeners on ports 18775, 18776, 19232, 19233, or 4040. The synthetic server and tunnel were stopped.

The bounded experiment is complete. The connection decision still needs an explicit support policy. Later acceptance must establish authenticated generation, account-specific CORS and restrictions, production origin/CSP, exact SDK and optional headers, live stream/error formats, real upstream cancellation and billing, native permission UI, and any claimed Firefox/Safari/mobile platforms. Each custom endpoint also needs its own schema and deployment checks. No unconditional launch-support claim follows from this evidence.
