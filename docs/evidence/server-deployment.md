# Server deployment evidence

Deployment date: 2026-10-18. The owner selected a Vercel frontend with the Go API
and PostgreSQL together on the existing server.

The frontend origin is `https://chess.khalil.mageed.net`. The public API is
`https://chess-api.agent.soft-magic.com`. Both server containers report healthy.
The API runs as an unprivileged container user behind Apache HTTPS. PostgreSQL
16.14 is on the private application network, with no published database port.
The former external port 55432 was checked from outside the server and refused
the connection after the topology change. The former Vercel database credential
was rotated; Vercel's project environment contains only public browser settings.

## Hosted API checks

Two disposable users in the actual Clerk production instance obtained genuine
browser session JWTs on the canonical HTTPS origin. A temporary browser SDK
fixture obtained the sessions without sending test verification emails. The
requests went to the real public API and private PostgreSQL database.

The following checks passed:

- Missing tokens returned 401 and a foreign origin returned 403.
- An authenticated owner listed, created and read a game.
- A second owner could neither read nor delete the first owner's game, and its
  game list did not contain that game.
- A checkpoint commit, operation receipt, and archive batch were readable.
- Repeating the accepted operation returned its idempotent duplicate result.
- A takeover advanced the ownership epoch; a stale commit returned 409.
- Owner deletion returned 204, and the deleted game subsequently returned 404.

This live run found that Clerk's browser JWT headers include `cat` and `oiat`.
The previous verifier rejected these metadata fields. The fix accepts their
expected types while continuing to reject unsupported JOSE controls, duplicate
fields, wrong origins and invalid identity claims. Its regression test failed
before the fix and passed afterwards.

## Backups and recovery

The operator command used the matching pg_dump 16.14 binary in the database
container. Daily and weekly exports were AES-256-GCM encrypted and authenticated
with the existing backup tool. An initial daily export restored the schema into
`kamkmchess_restore_20261018`, independently of the live database.

The later daily export at 17:27 UTC contained two synthetic deletion tombstones.
Restoring the older weekly export into the rehearsal database with that newer
daily ledger reported `apply 2` and reapplied both deletions. SQL verification
found zero games and two tombstones in the restored database. No restore was
pointed at the live database.

A daily cron entry runs the certificate sync and encrypted backup at 03:17
server time, preserving the account's preexisting cron entry. Rotation retains
seven daily and four weekly exports. The database certificate's complete chain
and hostname were checked against public trust roots. An initial encrypted
recovery copy and passphrase are kept privately outside the server; recurring
offsite synchronization is not configured.

## Checks and limits

The frontend lint, 569 fixture tests, typecheck and production build passed.
The readiness audit fixtures passed 21 tests after updating them for the split
deployment. Go tests and vet passed for `backend/...` and `cmd/...`.

The actual production sign-in modal rendered its email and password fields with
no browser errors. This required loading the matching `@clerk/ui` package with
the headless SDK and permitting Clerk Protect's CDN and rotating client-script
subdomains in the CSP. The static-host `/v1/games` compatibility route returned
the server's 401 JSON response, and the removed `/api/index` route returned 404.
The actual signed-in production frontend created an account game and displayed
`Synced.` after the server returned 201 for create and 200 for its commit.

This browser flow also exposed an older server schema that rejected controller
extensions and null history bindings for local games. The server now preserves
the browser's opaque versioned extension sections, rejects credential-bearing
fields recursively, and requires history bindings to be completely local or
complete model bindings. A fixture captured from the browser failed before the
fix and passed afterwards, alongside malformed and credential-bearing cases.

Clerk production DNS, TLS and mail verification passed. Production Google OAuth
still requires an OAuth client in the Clerk dashboard. Native screen-reader
acceptance, real model-provider acceptance, host-loss recovery from a separately
scheduled offsite destination, and measured long-term storage capacity were not
established by these checks.
