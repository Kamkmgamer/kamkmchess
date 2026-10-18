# Vercel staging configuration

The repository includes a Vite build, Vercel security headers, a Go function in `api/index.go`, `/v1/*` storage API rewrites, and Clerk callback SPA routes. No hosted project or database was created by this implementation.

## Deployment configuration

Use the pinned Node and pnpm versions from `.node-version` and `package.json`. Run `pnpm install --frozen-lockfile` and `pnpm check`. The browser distribution is `dist/`; Vercel builds the Go function separately using the root Go module. The browser CI uploads the exact distribution after its checks pass. The Go CI also compiles and checks the hosted entry point.

Set the server environment from `.env.example` privately. A PostgreSQL migration role applies `go run ./cmd/migrate` before the application runtime connects using its own least-privileged role. The database provider and its transaction-capable connection URL still require the owner's selection and access. No schema migration runs during an HTTP request. Pool creation and Clerk verifier initialization are reused between requests in a warm function. Failed initialization can retry on a later request.

`CLOUD_STORAGE_ENABLED` defaults to disabled. The function returns a JSON 503 with `Cache-Control: no-store` until it equals `true`. Enabling public account storage requires verified backups, deployed identity checks and a release decision. Environment provisioning alone does not enable it. A missing database or Clerk configuration returns a generic 503 without configuration values. The local Go server remains available for deliberate development without the hosted enablement gate.

## Browser connections

Vercel's CSP allows HTTPS connections and HTTP loopback destinations for player-configured direct AI connections. The protocol layer still requires explicit destination disclosure, matching credential bindings, omitted cookies and redirect rejection. A provider must permit browser CORS; the application has no generation relay. The CSP keeps scripts and Workers on the application origin. Clerk's external browser SDK and configured account origin will need an exact deployment-specific CSP addition when accounts are enabled. Account configuration must not be presented as working until that setup is verified.

HTTP connections to other hosts do not pass this production policy. A loopback proxy may require browser local-network permission and native verification. HTTPS pages and individual browsers still enforce mixed-content and local-network rules. No CSP declaration certifies that a provider is reachable.

The preexisting untracked `public/_headers` and `public/_redirects` files are not the Vercel configuration. `vercel.json` is authoritative for this host. Other static hosts need their own reviewed headers and routing; copying `dist/` elsewhere is not deployment verification.

## Evidence and remaining runs

Offline Go fixtures verify the disabled gate, generic errors, and preservation of HTTP method, authentication header and pagination through the hosted rewrite. They do not establish that Vercel's hosted Go runtime, HTTPS headers, Clerk redirects or PostgreSQL connectivity work in a deployed environment.

KHA-44 remains open for an actual staging URL, configured Clerk/Google origins, a selected PostgreSQL service, deployed route tests, MIME/CSP verification, and measured storage/free-tier limits. KHA-45 backup rehearsal, native assistive-technology acceptance and live-provider evidence remain separate requirements. Do not mark those runs passed from local fixtures.
