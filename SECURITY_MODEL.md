# Security model: kamkmchess

Threat model used by the security scan profile `screen-gd threat-modeled security scan`. Component names below are the ones findings are tagged with; keep them stable. Built from the code and the owner's answers on 2026-10-30.

## System overview and trust boundaries
Vite/React SPA (`src/`) on Vercel at chess.khalil.mageed.net. Browser holds chess rules, clocks, results and the user's AI provider credentials (`src/providers/connections`, IndexedDB). Stateless Node relay `api/provider-relay.ts` / `server/provider-relay.ts` forwards requests to custom HTTPS AI endpoints (SSRF-pinned, no logging). Go API (`cmd/server`, `backend/*`) at chess-api.agent.soft-magic.com behind Apache -> Docker (`deploy/`), PostgreSQL 16 on a private Docker network, Clerk session tokens for accounts, guest seat tokens for link guests, anonymous MCP endpoint (`backend/mcpserver`). Historical Supabase schema (`supabase/`) is provenance only.

## Components
- **kamkmchess web client**: `src/` (ui, landing, providers, online, accounts, agents, storage, moves, proofs).
- **kamkmchess provider relay**: `api/provider-relay.ts`, `server/provider-relay.ts`, `src/providers/transport.ts`.
- **kamkmchess Go API**: `cmd/`, `backend/httpapi`, `backend/serverapp`, `backend/storage`, `backend/migrations`, `backend/history`, `backend/privacy`, `backend/profile`, `backend/cohort`.
- **kamkmchess online play**: `backend/online`, `backend/onlineauth`, `backend/invite`, `backend/queue`, `backend/rulesworker`, `backend/serverengine`, `backend/agentboards`, `src/online`.
- **kamkmchess MCP endpoint**: `backend/mcpserver`.
- **kamkmchess deployment**: `deploy/` (compose, Dockerfile, pg_hba, runtime grants, backups, restore fence), `backend/backup`, `supabase/` (historical).

## Entry points
- Public: static site, `GET /v1/online/matches/{id}/replay`, public profiles, MCP endpoint (anonymous), provider relay (anyone can POST; forwards to public HTTPS only).
- Clerk-authenticated: `/v1/games*` account sync, queue, friends, privacy/deletion, owner switches.
- Guest-seat token: `/v1/online/matches/{id}` commands/updates.
- Server-only: migrate, khabackup, khasuspend, agentinvite CLIs.

## Assets
- Users' AI provider API keys and custom endpoint config (browser-held; pass through relay; must never reach Go API or logs).
- Account game history and archives in PostgreSQL (owner-scoped).
- Online match integrity and clocks (match authority), guest seat credentials.
- Clerk session tokens; database roles and secrets in `deploy/*.env`.
- Public profile and replay privacy (removal/anonymization).

## Attackers
- Anonymous internet user: relay abuse (SSRF, open proxy), MCP endpoint abuse, replay/profile enumeration, DoS.
- Authenticated user reaching another owner's games or commanding another seat.
- Guest with a seat token escalating to other matches/seats.
- Malicious or compromised AI provider returning hostile text (treated as untrusted per CONTEXT.md).
- Attacker with access to the host (cPanel/Apache) - infrastructure.

## Existing controls
Clerk verification + origin allowlist (`APP_ALLOWED_ORIGINS`), owner-scoped SQL, least-privileged runtime role, read-only container UID 65532, no published Postgres port, body limits (8 MiB; MCP 64 KiB), duplicate-key rejection, credential field rejection in DTOs, relay DNS pinning and private-network rejection, `Cache-Control: no-store`, restore fence.

## Owner priorities
- Assets that matter most, in order: (1) users' AI provider API keys (browser-held, forwarded by the provider relay), (2) online match integrity (guest seats, matchmaking, MCP endpoint), (3) account game data in PostgreSQL behind the Go API.

## Out of scope / accepted risk
- No separate infrastructure repository; infrastructure is `deploy/` (compose, Dockerfile, pg_hba, runtime grants, backups, restore fence).

## Open questions
- Is the anonymous MCP endpoint meant to stay unauthenticated in production?
