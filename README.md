# kamkm chess

Chess against AI models that choose their own moves. The Classic workspace supports local two-player games and browser-direct AI opponents, with device-local saves, continuous clocks, explicit connection diagnostics, compact chess requests, complete conversation archives, Undo, and request recovery. Optional account storage remains disabled until its deployment is configured and verified.

**New game** also supports human versus engine, engine versus engine, engine versus AI, and AI versus AI. Choose each opponent independently. Stockfish Lite and full Stockfish download with one click and run directly in your browser, with hardware-based recommendations, cached downloads, and adjustable thinking time. Leela's browser integration is marked **Coming soon**. See [browser engine setup and implementation](docs/browser-engines.md).

The board uses Lichess's [Chessground](https://github.com/lichess-org/chessground) for animated moves, square-wide mouse and touch dragging, legal destinations, and previous-move highlights. The combined browser application includes GPL-3.0-or-later code; original application code remains available under MIT. See [dependency and artwork notices](docs/dependency-notices.md). Distributions must include the exact corresponding source, available in this repository, along with the generated license notices.

Use Left/Right to review earlier or later moves, Home for the starting position, and End or **Live** to return to play. Moves in the list are clickable. Reviewing history leaves the live game and clocks running. During an AI turn, drag or click your piece to queue one premove. It plays only if legal after the reply; Escape, right-click, and **Cancel premove** clear it. Entering history or starting another game also clears queued input.

Right-drag draws green arrows and right-click marks circles. Hold Shift for red, Control for blue, or Alt for amber. Repeat a drawing to remove it, or left-click an empty square to clear drawings.

Legal moves, king safety, SAN and material checks use Lichess's **chessops 0.15.1**. Positions are classified synchronously; normal play creates no proof-search worker or graph. Draws use practical insufficient-material rules, repetition and the fifty-move rule. Timeouts use side-specific material and a bounded one-ply forced-outcome check. This replaces the former exhaustive dead-position search: unusual blocked positions can remain playable. Older pending saves are migrated automatically and their search data is dropped. The legacy proof tools remain for archive compatibility and offline fixtures. See [rules research and sources](docs/implementation/lichess-rules-research.md).

Each model move receives the current FEN and side, starting FEN with SAN move history, remaining clocks and increment, repeated-position counts when relevant, current-turn retry feedback, and the latest plan and returned reasoning for that side. Replies are asked to include a brief plan for the next turn. This rolling memory survives reloads and follows Undo; raw provider traffic and older thinking stay in the archive. Existing saved games use the same compact requests. See [model input policy](docs/spec/compact-model-input.md).

To play through CLIProxyAPI, choose **New game** and AI mode. CLIProxyAPI is preselected with `http://127.0.0.1:8317/v1`. Enter your proxy API key and exact **Model ID**, then choose **Connect and use model**. Accept the destination disclosure to send one compatibility check. After it passes, choose **Start game**. A bare proxy origin gains `/v1`; existing path prefixes and pasted Chat Completions URLs are preserved. Advanced settings include authentication and protocol overrides. Choose authentication **None** only if your proxy is deliberately configured without a key.

OpenAI, OpenRouter, Anthropic and custom connections remain available in the Provider selector. Their flow saves a connection, reviews its destination disclosure and runs an explicit model check before selection. Saving a connection sends no request; diagnostics and actual model moves can use provider quota. Your provider or proxy must be running and permit browser requests. No server relays AI calls or holds AI credentials.

## Local development

Use Node **24.22.0** and pnpm **12.14.0**. `.node-version` pins the Node runtime and `packageManager` pins pnpm. Run these commands at the repository root in PowerShell or another Corepack-compatible shell:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Vite prints the local URL. The development server binds to loopback. Keep `pnpm dev` running while playing. For the production build:

```sh
pnpm check
pnpm preview
```

The browser tests can start a temporary preview at port 5175 and stop it when they finish; an already-open page at that address cannot reload assets after the server stops. For a persistent production preview, run `pnpm build` followed by `pnpm preview --port 5175 --strictPort` and leave that process running.

Browser files are in `dist/`. The build includes the application license and production dependency notices. Vercel is the selected host. Its Go function routes `/v1/*` to Clerk-authenticated PostgreSQL storage operations; see [API contracts](docs/architecture/go-api.md) and [hosting configuration](docs/implementation/KHA-44-hosting.md). No hosting or account service is needed for guest play. Hosted infrastructure is not provisioned by running the app.

## Checks

| Command | Purpose |
| --- | --- |
| `corepack pnpm typecheck` | Strict TypeScript checks for browser code, tools and fixtures. |
| `corepack pnpm lint` | ESLint, TypeScript and React Hooks/refresh checks; warnings fail. |
| `corepack pnpm test` | Run deterministic fixtures once. |
| `corepack pnpm test -- src/rules/rules.test.ts` | Run the strict rules fixtures. |
| `corepack pnpm test:watch` | Rerun selected fixtures during development. |
| `corepack pnpm build` | Typecheck, compile static assets and collect runtime license notices. |
| `corepack pnpm check` | Lint, full fixture suite and production build. |
| `pnpm test:browser` | Run Chromium playthroughs against the built app with an offline provider fixture. Run `pnpm build` first and install Chromium with `pnpm exec playwright install chromium`. |
| `node --test scripts/release/readiness-audit.test.mjs` | Verify the offline release audit and synthetic secret scanner. |
| `node scripts/release/readiness-audit.mjs` | Inspect the actual distribution and hosting files for release blockers. |
| `go test ./backend/... ./cmd/... ./api/...` | Compile the Go API and run its offline fixtures. PostgreSQL integration fixtures require a separate local database. |
| `go vet ./backend/... ./cmd/... ./api/...` | Check production Go source for common errors. |

Vitest runs offline fixtures for strict rules, clock calculations, proof checking and search, archive validation, local storage, provider connections and protocols, and serialized controller decisions. A missing fixture suite fails the test command. Fixture coverage does not certify native browser or product acceptance. See [the fixture guide](tests/README.md), [KHA-29 controller evidence](docs/implementation/KHA-29-controller-evidence.md), [KHA-31 proof-search evidence](docs/implementation/KHA-31-evidence.md), [KHA-34 connection API](docs/implementation/KHA-34-api.md) and [evidence](docs/implementation/KHA-34-evidence.md), and [KHA-35 protocol-core evidence](docs/implementation/KHA-35-evidence.md).

The browser suite verifies a full legal game through checkmate and reload, compact requests with archived plans, Black-side starts and practice, Stop/Retry, Undo retention, and another game with the same model. It also exercises queued model changes and explicit connection rechecks after reload. Browser and Go CI run automatically for pull requests and `main`. Native screen readers, real provider routes, and hosted account storage still require separate acceptance runs.

## Implementation references

- [Module responsibilities and authority](docs/architecture/modules.md)
- [KHA-29 serialized controller evidence](docs/implementation/KHA-29-controller-evidence.md)
- [KHA-32 pending adjudication API and evidence](docs/implementation/KHA-32-pending-adjudication.md)
- [KHA-33 guest lifecycle, Undo and practice evidence](docs/implementation/KHA-33-lifecycle.md)
- [KHA-31 proof-search evidence](docs/implementation/KHA-31-evidence.md)
- [KHA-34 connection API](docs/implementation/KHA-34-api.md) and [evidence](docs/implementation/KHA-34-evidence.md)
- [KHA-35 protocol-core evidence](docs/implementation/KHA-35-evidence.md)
- [Durable model request and conversation API](docs/implementation/KHA-37-api.md)
- [Opponent catalogs and diagnostic API](docs/implementation/KHA-38-api.md)
- [Controller model handoffs](docs/implementation/KHA-38-controller-api.md)
- [Optional Clerk account API](docs/implementation/KHA-42-api.md) and [cloud sync API](docs/implementation/KHA-43-api.md)
- [Encrypted backups and local restore rehearsal](docs/implementation/MVP-operations.md)
- [Exact position checks and resource limits](docs/implementation/MVP-position-checks.md)
- [Go API and PostgreSQL storage](docs/architecture/go-api.md)
- [Dependency and artwork inventory](docs/dependency-notices.md)
- [Approved specification](docs/spec/mvp-handoff.md) and [acceptance cases](docs/spec/mvp-acceptance.json)
- [Implementation roadmap](docs/spec/implementation-plan.md) and [canonical Linear tracker](docs/agents/issue-tracker.md)

The owner selected the Classic workspace in [the KHA-12 Linear issue](https://linear.app/kamkm/issue/KHA-12/validate-the-connection-and-chess-match-interface). The disposable prototype source and captures are not included in this repository. That decision does not pass native screen-reader acceptance; see the MVP handoff for the remaining criteria.

## Configuration and distribution

Guest play needs no build environment variables. Provider profiles and credentials are configured deliberately in the browser. Vite's general environment-prefix exposure is disabled. Only three public build settings are allowlisted: `KAMKM_PUBLIC_ACCOUNTS_ENABLED`, `KAMKM_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `KAMKM_PUBLIC_API_BASE_URL`. Invalid publishable keys and insecure remote API origins cannot enable accounts. Server secrets stay in the server process environment; see `.env.example`. Never place private keys in browser source, `public/`, or any public setting.

Vercel's CSP permits direct HTTPS and loopback provider connections while keeping scripts and Workers on the application origin. Browser CORS and local-network permission rules still apply. Optional Clerk accounts additionally need exact deployed Clerk origins in CSP and configured Google sign-in. The hosted Go API independently requires `CLOUD_STORAGE_ENABLED=true`; it defaults to a generic no-store 503. Enable account storage only after its hosted identity and backup checks. [The hosting notes](docs/implementation/KHA-44-hosting.md) distinguish Vercel configuration from preexisting files for other static hosts.

Exact position checks run in a Worker and only accept independently checked evidence. Common openings resolve quickly. A difficult position can remain saved with adjudication pending and a continuously running clock; Continue and Stop analysis are explicit actions. A search cutoff never invents a result.

Run `pnpm install --frozen-lockfile` after checkout. Use exact package versions and review changes to `pnpm-lock.yaml`. Recheck notices and bundle contents when dependencies or assets change. Original code is [MIT licensed](LICENSE); third-party code and artwork retain their own licenses. Research and experiment dependencies are separate from the production root package.
