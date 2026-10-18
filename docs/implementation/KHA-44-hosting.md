# Vercel frontend and server API

The owner selected Vercel for the frontend and the existing server for both
the Go API and PostgreSQL on 2026-10-18. The earlier Vercel Go function was
removed. `vercel.json` sends `/v1/*` compatibility requests to the HTTPS API;
the configured frontend normally calls that API directly.

The frontend is `https://chess.khalil.mageed.net`, and the API is
`https://chess-api.agent.soft-magic.com`. PostgreSQL has no published port.
The API loopback port is proxied by Apache with a cPanel AutoSSL certificate.
The container uses a restricted database role and verifies the database TLS
hostname and public certificate chain. Migration and backup credentials stay
in separate private files on the server. Vercel receives only public browser
configuration, never database or Clerk secret keys.

Clerk production DNS, HTTPS and mail records are verified. Email code sign-in
is enabled. Google sign-in requires a production OAuth client in Clerk; the
generic sign-in button supports the configured methods. Vercel CSP allows the
exact production Clerk script and account origins, Clerk images, inline
component styles, and the challenge iframe. Provider generation remains direct
from the browser, and the API only persists account-owned game data.

The [deployment runbook](../../deploy/README.md) records build commands,
services, secret handling, backup rotation, certificate refresh, and recovery.
[Deployment evidence](../evidence/server-deployment.md) records the hosted
Clerk/API checks and actual restore rehearsal. Local tests do not establish
native assistive-technology acceptance or live model-provider compatibility.
