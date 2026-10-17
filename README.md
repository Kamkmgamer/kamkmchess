# kamkm chess

Chess against AI models that choose their own moves. The current page is a placeholder; playable chess is subsequent work. The repository includes KHA-31's proof-search API and separate IndexedDB checkpoint store, KHA-34's provider connection profiles and local credential store, the KHA-35 provider protocol core, and a serialized controller core. The placeholder does not connect these modules to a playable match.

## Local development

Use Node **24.22.0** and pnpm **12.14.0**. `.node-version` pins the Node runtime and `packageManager` pins pnpm. Run these commands at the repository root in PowerShell or another Corepack-compatible shell:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Vite prints the local URL. The development server binds to loopback. For the production build:

```sh
corepack pnpm check
corepack pnpm preview
```

Publishable browser files are in `dist/`. The build includes the application license and production dependency notices. Vercel is the selected host. The Go API provides Clerk-authenticated PostgreSQL storage operations; see [API setup and contracts](docs/architecture/go-api.md). Hosted database and Vercel API configuration remain deployment work.

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
| `go test ./backend/... ./cmd/...` | Compile the Go API and run its offline fixtures. PostgreSQL integration fixtures require a separate local database. |
| `go vet ./backend/... ./cmd/...` | Check production Go source for common errors. |

Vitest runs offline fixtures for strict rules, clock calculations, proof checking and search, archive validation, local storage, provider connections and protocols, and serialized controller decisions. A missing fixture suite fails the test command. Fixture coverage does not certify native browser or product acceptance. See [the fixture guide](tests/README.md), [KHA-29 controller evidence](docs/implementation/KHA-29-controller-evidence.md), [KHA-31 proof-search evidence](docs/implementation/KHA-31-evidence.md), [KHA-34 connection API](docs/implementation/KHA-34-api.md) and [evidence](docs/implementation/KHA-34-evidence.md), and [KHA-35 protocol-core evidence](docs/implementation/KHA-35-evidence.md).

## Implementation references

- [Module responsibilities and authority](docs/architecture/modules.md)
- [KHA-29 serialized controller evidence](docs/implementation/KHA-29-controller-evidence.md)
- [KHA-32 pending adjudication API and evidence](docs/implementation/KHA-32-pending-adjudication.md)
- [KHA-31 proof-search evidence](docs/implementation/KHA-31-evidence.md)
- [KHA-34 connection API](docs/implementation/KHA-34-api.md) and [evidence](docs/implementation/KHA-34-evidence.md)
- [KHA-35 protocol-core evidence](docs/implementation/KHA-35-evidence.md)
- [Go API and PostgreSQL storage](docs/architecture/go-api.md)
- [Dependency and artwork inventory](docs/dependency-notices.md)
- [Approved specification](docs/spec/mvp-handoff.md) and [acceptance cases](docs/spec/mvp-acceptance.json)
- [Implementation roadmap](docs/spec/implementation-plan.md) and [canonical Linear tracker](docs/agents/issue-tracker.md)

The owner selected the Classic workspace in [the KHA-12 Linear issue](https://linear.app/kamkm/issue/KHA-12/validate-the-connection-and-chess-match-interface). The disposable prototype source and captures are not included in this repository. That decision does not pass native screen-reader acceptance; see the MVP handoff for the remaining criteria.

## Configuration and distribution

The placeholder needs no environment variables, account services, credentials, provider requests or backend. The planned product stack is a Vercel-hosted React/TypeScript/Vite app, a Go API, PostgreSQL, and Clerk Auth. The connection module offers local profile and credential storage plus an explicit catalog-check API, but the placeholder does not call it. Vite environment-prefix exposure is disabled. Do not put private values in browser source, `public/`, Vite `define` values or public configuration. `.env` files are ignored, but ignoring a file does not make values compiled into JavaScript private.

The supplied CSP permits only same-origin connections and Workers. Connection profiles can describe an explicitly configured foreign endpoint, but browser policy still determines whether a request can reach it. This candidate does not certify deployed CSP or hosted egress controls. Never add a generation relay to work around provider browser restrictions. No service worker or private-traffic cache is installed. Vercel headers, HTTPS, Go API routing and SPA/callback routes need deployed verification; local Vite preview does not enforce hosting configuration.

Run `corepack pnpm install --frozen-lockfile` after checkout. Use exact package versions and review changes to `pnpm-lock.yaml`. Recheck notices and bundle contents when dependencies or assets change. Original code is [MIT licensed](LICENSE); third-party code and future artwork retain their own licenses. Research and experiment dependencies are separate from the production root package.
