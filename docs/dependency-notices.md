# Dependency and asset inventory

Foundation inventory for [Establish the React/TypeScript application and build checks](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks), recorded 2026-10-16. `package.json` pins direct versions and `package-lock.json` locks the complete graph, including platform-specific optional build packages. Original application code is MIT licensed under [LICENSE](../LICENSE).

## Distributed runtime code

| Package | Locked version | License | Source / copyright |
| --- | --- | --- | --- |
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
| globals | 17.13.0 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| typescript-eslint | 8.71.2 | MIT |
| vite | 8.3.4 | MIT |
| vitest | 5.0.5 | MIT |

TypeScript 6.0.3 stays within typescript-eslint 8.71.2's declared `>=4.8.4 <6.1.0` support. The current TypeScript 7 release is not selected. Vite 8 and its React plugin's declared peer versions agree. The verified build runtime is Node 24.22.0 with npm 11.19.1. Dependency installation reported zero known vulnerabilities on 2026-10-16; this does not certify future registry advisories or application security.

## Artwork and later dependencies

This build contains no piece sprites, icons, fonts or third-party artwork. It uses system fonts and a text-only placeholder. No source was copied from the disposable interface prototype.

The approved chess.js **1.4.0** and cm-chessboard **8.15.3** research baselines are not installed yet. The rules and board tickets must pin and review actual versions against the decision recorded in [KHA-22](https://linear.app/kamkm/issue/KHA-22/verify-chess-rules-board-accessibility-and-dependency-licenses), preserve BSD/MIT notices, and add the standard art's actual author/source, CC BY-SA 3.0 license and modification notices before distribution. The research report and raw experiment files are not included here. Their absence does not change those requirements.

Exclude the optional NonCommercial piece set, research-only GPL replay packages and the unsafe stock solver from production. Experiment lockfiles and bundles are not production dependencies or distribution assets. Later artwork licensing remains separate from the original-code MIT license. Complete `OPS-05` requires the final game distribution and asset review, not just this foundation inventory.
