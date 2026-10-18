# CLIProxyAPI setup

CLIProxyAPI is the default provider in New game, AI mode. The quick form takes a proxy URL, proxy API key and exact model ID. Connect and use model saves the connection locally, asks for destination consent when needed, sends one compatibility diagnostic and prepares a successful model. Start game remains an explicit player action.

The default URL is `http://127.0.0.1:8317/v1`. Bare origins gain `/v1`; path prefixes and pasted `/chat/completions` endpoints are preserved. Chat Completions and bearer authentication are the defaults. Advanced settings expose protocol, authentication, connection name and catalog override. Authentication None supports deliberately unauthenticated proxies.

Credentials stay in browser storage and are sent directly to the configured destination. Changing the URL, protocol, catalog destination or authentication requires an explicitly entered key for that configuration. Switching provider creates a new connection instead of rewriting a saved connection. Clearing the catalog override restores the default destination. Canceling disclosure sends no diagnostic. HTTP authentication failures show actionable messages without displaying the upstream response body.

The existing OpenAI, OpenRouter, Anthropic and custom connection flows remain available. A successful diagnostic checks the requested model on the chosen protocol for this session. It does not certify every model exposed by a proxy. The proxy must be running and permit requests from the app's origin.

## Verification

Four focused Chromium scenarios passed, covering proxy setup and legal play, no request before consent, cancellation and saved-key reuse, exact model aliases and prefixed endpoints, HTTP 401 without hidden retry, clearing catalog overrides, destination-bound keys, preserved saved providers and same-model rematches. Desktop and mobile captures were inspected. The Impeccable detector reported no findings.

The complete `pnpm check` passed ESLint, 451 unit tests across 40 files, both TypeScript projects, the production build and license notice generation. All 12 Chromium scenarios passed in 39.1 seconds. Build warnings remain for the existing application and optional Clerk bundle sizes.

GPT 6 Luna implemented the provider support and diagnosed the rematch regression. Space Bunny Free independently reviewed the connection flow. Its first review found three saved-connection defects, which were fixed and covered by the browser regression above. Its second review confirmed those fixes and the rematch identity validation. It also found that switching authentication to None could retain a typed key. Authentication changes now clear that input, and persistence only assigns API keys to modes that support them.

After that final authentication fix, lint, both TypeScript projects and the production build passed again. The expanded saved-connection browser scenario passed with an existing bearer connection switched to None, confirming the diagnostic sends no Authorization header and the model remains playable.

These checks use intercepted provider fixtures. No real proxy request, provider charge, commit, push or deployment was performed.
