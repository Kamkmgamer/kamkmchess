# Dependency and asset inventory

Foundation inventory for [Establish the React/TypeScript application and build checks](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks), recorded 2026-10-16. `package.json` pins direct versions and `package-lock.json` locks the complete graph, including platform-specific optional build packages. Original application code is MIT licensed under [LICENSE](../LICENSE).

## Distributed runtime code

| Package | Locked version | License | Source / copyright |
| --- | --- | --- | --- |
| chess.js | 1.4.0 | BSD-2-Clause | Jeff Hlywa. [chess.js source](https://github.com/jhlywa/chess.js). |
| cm-chessboard | 8.15.3 | MIT | Stefan Haack. [cm-chessboard source](https://github.com/shaack/cm-chessboard). |
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

This build uses the standard piece sprite shipped by cm-chessboard and uses system fonts. The disposable prototype's application code is not included; the extracted theme values are identified below.

The approved chess.js **1.4.0** and cm-chessboard **8.15.3** runtime dependencies are pinned. The board imports cm-chessboard's assets/pieces/standard.svg; it does not use the separately licensed NonCommercial Staunty sprite. The standard sprite identifies the Wikimedia Commons standard chess pieces, credits Cburnett, and carries the CC BY-SA 3.0 notice in the SVG. The asset is distributed without modification. The generated THIRD_PARTY_NOTICES.txt repeats this attribution and license.

The selectable T3 Code palette values in src/ui/t3-palettes.ts were extracted from packages/shared/src/themePalettes.ts at commit 9503155da67add4fbd7fbc51c99ec19a0c8c4a2c, SHA-256 82385050b8b691ff280efc0e93ea9dd8a4bbfd64a4c50cf8536b5c15d1e74479. The prototype bundle's original source hash was verified against the owner-attached KHA-12 bundle (1631a48a909168bbc63bbb84164e5da2c0912f8fcb1c3f78faea87a797103ddf). The T3 Code MIT notice is retained at [T3-Code-MIT.txt](licenses/T3-Code-MIT.txt) and included in generated distribution notices. Palette data and board colors are the only extracted presentation inputs; prototype application code is not included.

Exclude the optional NonCommercial piece set, research-only GPL replay packages and the unsafe stock solver from production. Experiment lockfiles and bundles are not production dependencies or distribution assets. Later artwork licensing remains separate from the original-code MIT license. Complete `OPS-05` requires the final game distribution and asset review, not just this foundation inventory.
