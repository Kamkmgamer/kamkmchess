# KHA-34 connection API

This module provides profile and local credential data APIs. It does not wire a connection screen or generation transport into the placeholder application, so this document does not claim that KHA-34 is complete.

## Profiles and destinations

Import the public API from `src/providers/connections`.

```ts
const profile = await createConnectionProfile({
  id: 'my-openai',
  name: 'OpenAI',
  provider: 'openai',
});

const endpoints = getConnectionEndpoints(profile);
// generationUrl: https://api.openai.com/v1/responses
// catalogUrl: https://api.openai.com/v1/models
```

Preset defaults are:

| Provider | Protocol | Base URL | Authentication | Catalog pagination |
| --- | --- | --- | --- | --- |
| OpenAI | Responses | `https://api.openai.com/v1` | Bearer key | `after` |
| OpenRouter | Chat Completions | `https://openrouter.ai/api/v1` | Bearer key | None |
| Anthropic | Messages | `https://api.anthropic.com/v1` | `x-api-key` | `after_id` |

Preset profiles allow an explicit protocol, base URL, catalog URL, authentication mode and extra headers. Custom profiles require an explicit protocol, base URL and authentication mode. `reviseConnectionProfile` validates edits. It changes `configRevision` when network settings change; changing only the profile name keeps the revision. `getConnectionEndpoints` appends the selected protocol route once and preserves any base path prefix.

URLs must use HTTP or HTTPS and cannot contain user information or fragments. Query names that match known credential terms are rejected. This name check does not inspect query values or arbitrary names. The module accepts a configured foreign origin and binds it as a concrete destination. A separately configured catalog URL is included in the binding and first-request disclosure. When its origin differs from the generation URL, the disclosure names the catalog URL and explains that configured authentication and headers are sent there.

Credential-looking literal header names are rejected so the caller can store those values as credentials. This is a name-based guard. It does not find every secret value. Ordinary routing parameters such as `api-version` and `tenant` remain available.

## Catalog and request preparation

`prepareGenerationRequest(profile, boundCredentials, body, config?)` accepts JSON text and returns a POST URL and `RequestInit`. It rejects malformed JSON, non-object JSON, and opaque `BodyInit` values before returning a request. Cache route validation reads only supported wire positions: top-level OpenAI prompt-cache controls, top-level OpenRouter `session_id`, and Anthropic `cache_control` on text content blocks. Nested history metadata does not activate a route check. Configured OpenAI and OpenRouter controls count when set; Anthropic caching counts when `anthropicEphemeral` is explicitly `true`. A false Anthropic flag or a minimum threshold alone does not activate caching. The selected connection profile is authoritative for provider and protocol: OpenAI prompt-cache options require an OpenAI Chat Completions or Responses profile, OpenRouter session affinity requires OpenRouter Chat Completions, and Anthropic ephemeral caching requires Anthropic Messages. Unsupported cache options fail before a request is returned. Route metadata is used for validation and is not added to the request body. `prepareCatalogRequest(profile, boundCredentials)` returns the catalog GET request. Both apply configured authentication and headers, use `credentials: 'omit'` and `redirect: 'error'`, and validate that the binding matches the profile and final destinations. They do not call `fetch`.

`checkConnection(profile, boundCredentials, { fetch, signal, now, maxPages })` is the explicit catalog operation. It uses the caller's injected `fetch`, follows configured catalog pagination, and does not send a generation request or retry failed pages. A profile without a catalog returns manual-entry guidance. Network errors do not guess that CORS caused the failure. The caller encodes and sends any later generation request.

`createManualModelReference` keeps an exact manually entered model ID scoped to its connection. `classifyConnectionRoute` labels route evidence without claiming CORS access or account eligibility. Public HTTPS is the normal remote route. Loopback HTTP is conditional; LAN and private-network evidence remains unverified.

## Local profiles and credentials

`openConnectionStore()` uses browser IndexedDB. `createConnectionStore(persistence)` accepts the persistence interface for fixtures. The store supports profile save/removal, catalog snapshots, disclosure choices, credential assignment and resolution, credential replacement, per-namespace clearing, and clear-all. Guest and account UUID namespaces are separate; the store has no fallback between them. Editing or saving a profile sends no request.

Credentials remain in the selected local persistence. IndexedDB stores their values; the API makes no device-encryption claim. The API does not sync credentials or transfer them to another device. A caller on another device must arrange a deliberate local assignment.

Restored V1 profile, credential, catalog and disclosure records are shape-checked, checked against their profile/configuration/destination metadata, and validated before use. Invalid persisted rows fail with a scoped local-read error and stay available for repair. Failed writes report that data was not saved.

`BoundConnectionCredentials` contains binding metadata, not secret values. Successful credential replacement, forget, namespace clear, clear-all, profile save and profile removal revoke previously resolved bindings that share the same persistence object in the same JavaScript runtime. A pending credential read cannot create a new binding after a later successful mutation. Failed writes leave the active binding usable. Saving a profile conservatively revokes bindings even when its network configuration did not change; the caller must resolve the current binding again.

Revocation does not coordinate separate persistence objects or tabs, including objects that use the same IndexedDB database. It cannot withdraw a prepared `RequestInit`, bytes already handed to a transport, or a request already sent. The transport and identity callers own those fences.

## Disclosure and integration limits

`createFirstRequestDisclosure(profile)` returns configured generation and catalog destinations, provider links, protocol and route evidence, plus consequence and quota language. It describes the configured endpoint operator when a preset points to an overridden host. The caller records an explicit accepted or declined disclosure choice; the module does not create consent automatically. Saved choices are tied to the current destination and configuration revision.

The API can describe foreign endpoints. Browser CSP, host policy and actual transport behavior remain separate checks. This connection module does not implement account sign-out request fencing or sync/export credential-echo blocking. It prepares generation requests but does not send them, parse model output or authorize game moves.
