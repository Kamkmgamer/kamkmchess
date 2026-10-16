# Foundation completion evidence

Recorded 2026-10-16 for [Establish the React/TypeScript application and build checks](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks). Implementation commit `e3d591843dd8dfbd165c496dc21c766ad4431075` contains the application and tools. The subsequent documentation commit corrects the archive/export contract and records this evidence; it changes no build input.

## Build and reproduction

The production application is the root React/TypeScript/Vite package. It is independent of experiment packages and the disposable prototype. The initial page is a text placeholder. No game, provider, account or persistence behavior is claimed.

Verified on Windows 11 build 26300, Node 24.22.0 and npm 11.19.1. A new detached worktree of the implementation commit contained no `node_modules` or uncommitted source. These commands ran at its root:

```sh
npm ci --no-fund
npm run check
git status --porcelain=v1
```

Expected installation was a lockfile-only reproducible install. Observed exit code was 0, with 176 packages installed and 177 audited, and zero known vulnerabilities reported. The lock includes 201 packages across supported build platforms; optional packages for other platforms were not all installed.

Expected checks were zero lint warnings, strict browser/tool TypeScript success, an operational fixture entry point and a static build with complete runtime license texts. Observed `npm run check` exit code was 0. Vitest reported **zero test files**. There are no product tests or passing product fixtures in this ticket. The captured PowerShell log wraps Vitest's informational stderr include/exclude lines in `NativeCommandError`; the npm process completed successfully and then built the app. This is preserved in the raw log.

All eight output files were byte-for-byte identical between the original checkout and the clean worktree. [The build manifest](kha-26-build.json) records file sizes, SHA-256 digests, the lockfile digest and unrun coverage. The original checkout also passed standalone typechecking and linting during implementation.

## Distribution inspection

The build contains `index.html`, one JavaScript asset, one CSS asset, Cloudflare `_headers`/`_redirects`, `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` and `DEPENDENCY_INVENTORY.json`. The three runtime packages are react 19.3.1, react-dom 19.3.1 and scheduler 0.28.0, all MIT. Their complete installed license texts are in the notices file. See [the dependency inventory guide](../dependency-notices.md).

Source inspection found only the browser entry point and placeholder UI. There is no application server, generation relay, hosted-service configuration or administrative credential. A bounded pattern scan of `src/`, `public/` and `dist/` found zero matches for provider-style long `sk-` keys, private-key PEM headers, `service_role` or `SUPABASE_SECRET_KEY`. This supports this inspected build only, not a general security certification.

Local HTTP reads of the production preview returned 200 for HTML, both assets, both license files and the inventory, with the expected content types. These reads do not establish React rendering, native accessibility, deployed headers or Cloudflare fallback behavior.

## Artifacts

The 76,256-byte `kamkmchess-kha26-static-build.zip` contains the complete static distribution, raw clean-install/check logs, HTTP observations and build manifest. It is attached to [the foundation ticket](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks) as **KHA-26 static build and clean-checkout evidence**, attachment `bad555fd-9ef0-4061-b1d5-d712d29f87a9`.

Its SHA-256 is `2867c768edc3c00cb5c3156b69917fdaf4aba6bb2c49a24e008fca82a28d268d`. The uploaded artifact was downloaded again and its bytes matched this digest. A local copy and raw logs remain under `.scratch/cli-proxy-chess/kha26-foundation/`. Signed transport descriptors are excluded from commits and from the bundle.

## Standards

Independent review of `git diff cf92ab041894578d290622b82b65455c789e6f3c...e3d591843dd8dfbd165c496dc21c766ad4431075` found no violations of the documented standards and no actionable baseline code smells. Tooling-enforced checks and future product responsibilities were excluded.

## Spec

The independent specification review found one P2 documentation error. The module guide excluded raw transcripts from game sync/export, conflicting with the full versioned archive requirement and `DAT-08`. The correction restricts the transcript ban to routine telemetry, preserves complete archives through allowlisted DTOs, excludes secret fields and blocks affected sync/export when recognized credential echoes are present. The reviewer read the correction and confirmed the finding resolved.

Review totals: Standards 0 findings; Spec 1 P2 finding, resolved. Neither axis has an unresolved finding.

## Unrun coverage

Both T3 browser snapshot attempts failed with `Preview automation snapshot timed out after 15000ms.` An intervening evaluate call reported that no preview automation host was available. The fallback browser tool reported `Browser is not available: iab` and its inventory contained no browsers. Rendered-browser verification remains unrun.

All six required native browser/AT targets, deployed HTTPS/CSP/callback routes, actual chess/assets, schema migrations, hosted accounts/sync/backups, live provider routes and cache/cost checks remain unrun. No service was provisioned, app published or model request sent. `OPS-01` and `OPS-05` retain `not_run` for their full required coverage, as do all 79 product cases. This ticket completes the scoped foundation, not launch acceptance.
