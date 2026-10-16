# kamkm chess

Chess against AI models that choose their own moves. The first implementation ticket establishes the static application and build tools. The current page is a placeholder; playable chess is subsequent work.

## Local development

Use Node **24.22.0**, the supported Node 24 LTS line, and npm **11.19.1**. `.node-version` pins the verified runtime. The package engines reject other Node major versions. Run these commands at the repository root in PowerShell or another npm-compatible shell:

```sh
npm ci
npm run dev
```

Vite prints the local URL. The development server binds to loopback. For the production build:

```sh
npm run check
npm run preview
```

Publishable files are in `dist/`. The build includes the application license, complete production dependency license texts, and Cloudflare Pages header/fallback files. It needs static hosting only.

## Checks

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Strict TypeScript checks for browser code, tools and fixtures. |
| `npm run lint` | ESLint, TypeScript and React Hooks/refresh checks; warnings fail. |
| `npm test` | Run deterministic fixtures once. |
| `npm test -- src/rules/rules.test.ts` | Run the strict rules fixtures. |
| `npm run test:watch` | Rerun selected fixtures during development. |
| `npm run build` | Typecheck, compile static assets and collect runtime license notices. |
| `npm run check` | Lint, full fixture suite and production build. |

Vitest runs the product fixtures for strict rules and pure clock calculations. A missing fixture suite fails the test command. Fixture coverage does not certify native browser or product acceptance. See [the fixture guide](tests/README.md).

## Implementation references

- [Module responsibilities and authority](docs/architecture/modules.md)
- [Dependency and artwork inventory](docs/dependency-notices.md)
- [Approved specification](docs/spec/mvp-handoff.md) and [acceptance cases](docs/spec/mvp-acceptance.json)
- [Implementation roadmap](docs/spec/implementation-plan.md) and [canonical Linear tracker](docs/agents/issue-tracker.md)

The owner selected the Classic workspace in [the KHA-12 Linear issue](https://linear.app/kamkm/issue/KHA-12/validate-the-connection-and-chess-match-interface). The disposable prototype source and captures are not included in this repository. That decision does not pass native screen-reader acceptance; see the MVP handoff for the remaining criteria.

## Configuration and distribution

No environment variables, account services, credentials, provider requests or backend are required for this foundation. Vite environment-prefix exposure is disabled. Do not put private values in browser source, `public/`, Vite `define` values or public configuration. `.env` files are ignored, but ignoring a file does not make values compiled into JavaScript private.

The supplied CSP permits only same-origin connections and Workers for the current build. Future connection/account tickets must update it for explicit supported destinations. Never add a generation relay to work around provider browser restrictions. No service worker or private-traffic cache is installed. Cloudflare header handling, HTTPS and SPA/callback routes require deployed verification in the staging ticket; local Vite preview does not enforce `_headers` or `_redirects`.

Run `npm ci` after checkout. Use exact package versions and review changes to `package-lock.json`. Recheck notices and bundle contents when dependencies or assets change. Original code is [MIT licensed](LICENSE); third-party code and future artwork retain their own licenses. Research and experiment dependencies are separate from the production root package.
