# Dependency and asset inventory

Foundation inventory for [Establish the React/TypeScript application and build checks](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks), recorded 2026-10-16. `package.json` pins direct versions and `package-lock.json` locks the complete graph, including platform-specific optional build packages. Original application code is MIT licensed under [LICENSE](../LICENSE).

## Distributed runtime code

| Package | Locked version | License | Source / copyright |
| --- | --- | --- | --- |
| chess.js | 1.4.0 | BSD-2-Clause | Jeff Hlywa. [chess.js source](https://github.com/jhlywa/chess.js). |
| react | 19.3.1 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |
| react-dom | 19.3.1 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |
| scheduler | 0.28.0 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |

`npm run build` reads actual installed runtime package versions, checks them against the lockfile, and copies each full license text into `dist/THIRD_PARTY_NOTICES.txt`. It copies the original-code license to `dist/LICENSE.txt`. Missing license text or a runtime version mismatch fails the build. Ship these files with the assets.

The build also writes `dist/DEPENDENCY_INVENTORY.json` with every locked package path, version, declared license, tooling/runtime scope and optional flag. This includes optional packages for other operating systems, not a claim that they are all installed or bundled. Review the lockfile and this inventory on changes. Tooling is not copied as a browser runtime dependency. The Vite module-preload polyfill is disabled for the selected modern targets.

## Direct build and verification tools

| Package | Pinned version | Declared license |
| --- | --- | --- |
| @eslint/js | 10.0.1 | MIT |
| @types/node | 24.19.2 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| @vitejs/plugin-react | 6.1.2 | MIT |
| eslint | 10.12.0 | MIT |
| eslint-plugin-react-hooks | 7.1.1 | MIT |
| eslint-plugin-react-refresh | 0.5.7 | MIT |
| fake-indexeddb | 6.2.5 | Apache-2.0 |
| globals | 17.13.0 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| typescript-eslint | 8.71.2 | MIT |
| vite | 8.3.4 | MIT |
| vitest | 5.0.5 | MIT |

The optional developer subpackage in `supabase/tests/local/` has its own lockfile. It pins `@electric-sql/pglite` 0.5.10 (Apache-2.0) and vendors pgTAP 1.3.3's extension SQL/control bundle (revised FreeBSD license, retained in the SQL). These tools run embedded PostgreSQL for offline fixtures. They are not dependencies of the application package or browser bundle. The [runner guide](../supabase/tests/local/README.md) records source provenance and checksums.

TypeScript 6.0.3 stays within typescript-eslint 8.71.2's declared `>=4.8.4 <6.1.0` support. The current TypeScript 7 release is not selected. Vite 8 and its React plugin's declared peer versions agree. The verified build runtime is Node 24.22.0 with npm 11.19.1. Dependency installation reported zero known vulnerabilities on 2026-10-16; this does not certify future registry advisories or application security.

## Artwork and later dependencies

This build contains no piece sprites, icons, fonts or third-party artwork. It uses system fonts and a text-only placeholder. No source was copied from the disposable interface prototype.

The approved chess.js **1.4.0** runtime dependency is installed and listed above. cm-chessboard **8.15.3** remains a research baseline and is not installed yet. The board work must pin and review its actual version against [the dependency research](../research/chess-dependencies.md), preserve required dependency notices, and add the standard art's actual author/source, CC BY-SA 3.0 license and modification notices before distribution. The absence of the board package and artwork here does not replace those choices.

Exclude the optional NonCommercial piece set, research-only GPL replay packages and the unsafe stock solver from production. Experiment lockfiles and bundles are not production dependencies or distribution assets. Later artwork licensing remains separate from the original-code MIT license. Complete `OPS-05` requires the final game distribution and asset review, not just this foundation inventory.
