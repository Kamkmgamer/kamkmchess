# Sign in with ChatGPT integration research

**Research date:** 2026-10-22  
**Question:** Can KamkmChess let users sign in with ChatGPT and use their ChatGPT plan for AI chess moves without entering an OpenAI API key?

## Finding

**Yes, there is a documented path that appears applicable to this open-source app, but it requires OpenAI's separate open-source client flow and a dedicated Responses API request mode.** OpenAI's current docs say ChatGPT plan usage is available to all open-source partners; eligible ChatGPT Plus and Pro users can authorize participating apps to make Responses API requests using OAuth credentials rather than an API key. This is distinct from ordinary “Sign in with ChatGPT” identity login, which is currently limited to selected commercial partners. The app should not simply treat an identity token or its existing API-key field as a plan credential.

This is a feasibility conclusion from OpenAI's published docs, not proof that KamkmChess has already been accepted/registered or that its particular chess prompts/models are eligible. OpenAI describes the flow as being for open-source developers and directs clients through a dynamic registration process. The repo is an open-source application, so this seems to fit the documented audience; actual registration, policy eligibility, and successful production access remain to be confirmed.

## What the product means

OpenAI documents three related but distinct integrations under the Sign in with ChatGPT name:

1. **Website identity sign-in:** OAuth 2.0 Authorization Code + PKCE / OpenID Connect. The app gets an identity assertion and uses it to create its own local account/session. Identity scopes do not grant OpenAI API resources or ChatGPT conversations.
2. **ChatGPT plugin/connector sign-in:** Reuses the user's ChatGPT identity in a connector authorization flow. This is for an app/plugin operating through ChatGPT.
3. **ChatGPT plan usage in an open-source app:** A separate OAuth authorization flow issues credentials for eligible Responses API use on a user's ChatGPT plan. This is the relevant path for KamkmChess's in-app model requests and is the documented option that avoids asking for an API key.

The quickstart states that plan usage is available to all open-source partners and selected private clients, while website identity sign-in is available only to selected commercial partners through a limited trial. Therefore, the ordinary website “Continue with ChatGPT” button is **not** a generally available replacement for Clerk or a way to unlock API access. For this app, investigate and implement the open-source plan-usage flow; do not assume commercial website-login access.

## OpenAI's documented open-source flow

The open-source docs direct a client to open `https://auth.openai.com/api/accounts/authorize` in the system browser, use PKCE with fresh `state` and OIDC `nonce`, identify the client/host, receive and exchange the callback, validate identity/permissions, and securely retain credentials for that ChatGPT account. On first registration, the flow uses `client_id=dynamic_agent_client` and an `agent_name_hint` plus a stable `ext_agent_host_id`; the callback returns a client ID to save for that account and reuse. This is a registration entrypoint, not the saved client ID. The docs say this direct flow needs no client secret or partner API key.

For inference, the docs specify `Authorization: Bearer <access_token>` to `POST https://api.openai.com/v1/responses`, with `store: false` and `stream: true`. The model list is account-specific and retrieved from `/v1/models`; the UI should use returned visible model slugs and refresh on account changes. Tokens are OAuth tokens for the authorized plan usage, not the user's API key.

## How this app works today

- AI connections are defined in `src/providers/connections/types.ts` and `profile.ts`. The `openai` preset defaults to the OpenAI Responses API at `https://api.openai.com/v1`, bearer authentication, and a `/models` catalog.
- Requests in `src/providers/connections/requests.ts` currently require a credential value and add it as a bearer token. Connection credentials are destination-bound and stored in browser persistence, not account credentials managed by OpenAI OAuth.
- `src/providers/protocols/responses.ts` already streams Responses API requests and sends `store: false`, but also emits options which OpenAI explicitly says are unsupported in ChatGPT plan usage: currently `max_output_tokens`, `truncation`, and optionally `temperature`, `top_p`, `prompt_cache_key`, and `prompt_cache_retention`.
- App accounts are a separate optional Clerk integration (`src/accounts/clerk.ts`), used for app identity/cloud account services. Existing account sign-in does not authenticate to the OpenAI API. Avoid conflating the app's Clerk identity session with the ChatGPT-plan authorization.
- The browser calls remote HTTPS providers directly where allowed; the site's stateless relay can forward API key headers. The proposed ChatGPT-plan path should instead keep the OAuth lifecycle in an explicit provider/account adapter and send only to OpenAI's documented public Responses endpoint. The access token is sensitive even though it is not an API key.

## Fit and required work

**The core model transport is a promising fit:** existing Responses SSE parsing and response completion checks can likely be reused. The app should add a distinct “ChatGPT plan” connection/auth mode (or dedicated provider adapter) so an OAuth access token is not confused with an API key. The credential contract must support account selection, secure token refresh/reauthorization, revocation/sign-out, and binding a token to the selected ChatGPT account. Follow OpenAI's client registration and UI/UX instructions; do not imitate private ChatGPT `backend-api` endpoints.

The request encoder needs a dedicated compliant payload. For this mode, send the compact chess history as `input` plus `instructions`, set `store:false` and `stream:true`, and omit unsupported parameters, including the app's current `max_output_tokens`, `truncation`, temperature/top-p, and prompt-cache controls. The chess prompt is text-only and fits the documented input pattern. The app must handle plan-usage-specific admission/usage-limit errors and offer a clear recovery path, such as retrying after the user changes plan/usage availability or choosing a separately configured API-key provider. Do not silently fall back to another credential or charge an API account.

The UI should list only models returned as displayable for the selected ChatGPT account and use the returned slug as the request model. OpenAI docs state that available models depend on account and policy. It is not yet established that the full set of models offered through this flow will satisfy KamkmChess's move-generation/response-contract requirements.

**Keep identity-only login and plan usage separate.** If OpenAI later approves the app for the commercial website identity flow, it may be considered as an additional account login method. Its identity scopes alone do not provide inference. Clerk could remain the app account system while a user separately authorizes ChatGPT plan usage, or the app could later support OpenAI identity login if eligible; those are separate choices.

## Constraints and open questions

- The open-source plan flow is documented, but the docs do not establish that this specific repository has completed registration, received a client ID, or passed any OpenAI review. Verify registration requirements before building around assumed production credentials.
- The published plan-usage preview requires `store:false` and `stream:true`; unsupported request fields must be omitted. The docs list restrictions on previous-response state, tools, audio/video, file upload, and other capabilities. This app's current turn-by-turn full-context approach is compatible in principle, but its encoder is not compliant until the fields above are removed for this mode.
- The plan flow is Responses API-specific. It does not authorize generic Chat Completions, Anthropic, OpenRouter, arbitrary custom endpoints, or general API platform resources. The app's other providers remain separate.
- Usage is subject to user eligibility, account/workspace policy, model availability, and plan limits. “No API key” does not imply unlimited or guaranteed inference, nor that all API features/models are exposed.
- OpenAI's docs recommend secure credential storage and prescribe account/profile/session handling. This browser-first app should assess storage and token exposure carefully; ideally use the documented client-side flow and OS/browser protected storage where available, never expose tokens to logs, URLs, relay logs, or cloud-synced game data. Whether this web app can meet the required security expectations with browser storage is a design question.
- The app currently has no OpenAI OAuth client integration or token refresh/account lifecycle for ChatGPT-plan credentials. Clerk is not a substitute for this authorization.
- The website identity flow and open-source plan flow have distinct access status. Commercial website sign-in remains limited trial/selected partners as of the research date; no public general-purpose identity client registration was found in the docs reviewed.
- Explicit unknowns: approval/registration process for a new open-source client; whether publication or user-count thresholds apply; retention/refresh/revocation specifics for this deployment form; whether browser-hosted OAuth callbacks and token storage meet OpenAI's current review expectations; exact model/usage eligibility for each user's ChatGPT plan; and whether any OpenAI policy limits a chess-playing use case.

## Recommendation

Treat this as **feasible for a prototype and potentially production-capable through the open-source ChatGPT plan-usage route**, subject to client registration and eligibility. Before implementation, confirm the project's open-source client registration route with OpenAI's current documentation and use the dedicated SIWC client ID registration rather than request a commercial website OAuth client. Then build the authorization as an independent provider credential flow, add a compliant Responses request mode and account-specific model catalog, and test authorization renewal, revocation, usage-limit errors, and unsupported fields. Keep Clerk app accounts and API-key provider profiles intact as separate options.

## Sources

All sources below are first-party OpenAI developer documentation, accessed 2026-10-22:

- [Sign in with ChatGPT documentation index](https://developers.openai.com/siwc/llms.txt) — integration types and page map.
- [Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart.md) — availability, identity-vs-plan scopes, partner status, and flow overview.
- [Open-source registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) — dynamic registration, OAuth callback, account and host IDs, token handling.
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md) — account-specific model listing and Responses request contract.
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md) — required/unsupported Responses parameters and features.
- [Website identity sign-in](https://developers.openai.com/siwc/website.md) — commercial partner limited trial and OIDC-only identity scopes.
- [Request a client ID](https://developers.openai.com/siwc/request-client-id.md) — commercial client ID waitlist; distinguish this from open-source dynamic client registration.
- [OpenAI API authentication](https://developers.openai.com/api/docs/guides/production-best-practices) — API key security and server-side key handling guidance.

