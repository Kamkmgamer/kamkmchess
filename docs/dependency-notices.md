# Dependency and asset inventory

Foundation inventory for [Establish the React/TypeScript application and build checks](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks), recorded 2026-10-16. `package.json` pins direct versions and `package-lock.json` locks the complete graph, including platform-specific optional build packages. Original application code is MIT licensed under [LICENSE](../LICENSE).

## Distributed runtime code

The hero also includes the standalone `DitherGradient`, pixel primitives and palette from [Grim's Dither Kit](https://github.com/Boring-Software-Inc/dither-kit), author `ripgrim`, pinned at `1e7faee9aa252e499651e6736ed65f7a07d9a6bd`. This copy-in source declares MIT in its upstream package manifests. Provenance and strict-TypeScript adaptations are recorded in `src/components/grim-dither-kit/UPSTREAM.md`. It reuses existing React, clsx and tailwind-merge dependencies. It replaces the earlier image-processing overlay; that older vendored core remains in the repository.

| Package | Locked version | License | Source / copyright |
| --- | --- | --- | --- |
| chess.js | 1.4.0 | BSD-2-Clause | Jeff Hlywa. [chess.js source](https://github.com/jhlywa/chess.js). |
| react | 19.3.1 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |
| react-dom | 19.3.1 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |
| scheduler | 0.28.0 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |
| @base-ui/react | 1.9.0 | MIT | [Base UI](https://base-ui.com). Used by Quartz Button. |
| @fortawesome/free-solid-svg-icons | 7.3.1 | CC BY 4.0 (SVGs), MIT (code) | [Font Awesome Free license](https://fontawesome.com/license/free). |
| @fontsource-variable/inter-tight | 5.3.0 | OFL-1.1 | The Inter Project Authors. [Inter Tight source](https://github.com/rsms/inter-tight), packaged by [Fontsource](https://fontsource.org/fonts/inter-tight). Only the Latin subset is bundled. |
| @fontsource/instrument-serif | 5.3.0 | OFL-1.1 | The Instrument Serif Project Authors. [Instrument Serif source](https://github.com/Instrument/instrument-serif), packaged by [Fontsource](https://fontsource.org/fonts/instrument-serif). The regular Latin WOFF2 is bundled for editorial headings. |
| @fontsource-variable/space-grotesk | 5.3.0 | OFL-1.1 | The Space Grotesk Project Authors. [Space Grotesk source](https://github.com/floriankarsten/space-grotesk), packaged by [Fontsource](https://fontsource.org/fonts/space-grotesk). Retained from the earlier type treatment; no font file is currently bundled. |
| class-variance-authority | 0.7.1 | Apache-2.0 | [CVA](https://cva.style). Quartz control variants. |
| clsx | 2.1.1 | MIT | [clsx source](https://github.com/lukeed/clsx). |
| tailwind-merge | 3.7.0 | MIT | [tailwind-merge source](https://github.com/dcastil/tailwind-merge). |

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
| @tailwindcss/vite | 4.3.3 | MIT |
| eslint | 10.12.0 | MIT |
| eslint-plugin-react-hooks | 7.1.1 | MIT |
| eslint-plugin-react-refresh | 0.5.7 | MIT |
| fake-indexeddb | 6.2.5 | Apache-2.0 |
| globals | 17.13.0 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| typescript-eslint | 8.71.2 | MIT |
| tailwindcss | 4.3.3 | MIT |
| vite | 8.3.4 | MIT |
| vitest | 5.0.5 | MIT |

The optional developer subpackage in `supabase/tests/local/` has its own lockfile. It pins `@electric-sql/pglite` 0.5.10 (Apache-2.0) and vendors pgTAP 1.3.3's extension SQL/control bundle (revised FreeBSD license, retained in the SQL). These tools run embedded PostgreSQL for offline fixtures. They are not dependencies of the application package or browser bundle. The [runner guide](../supabase/tests/local/README.md) records source provenance and checksums.

TypeScript 6.0.3 stays within typescript-eslint 8.71.2's declared `>=4.8.4 <6.1.0` support. The current TypeScript 7 release is not selected. Vite 8 and its React plugin's declared peer versions agree. The verified build runtime is Node 24.22.0 with npm 11.19.1. Dependency installation reported zero known vulnerabilities on 2026-10-16; this does not certify future registry advisories or application security.

## Artwork and later dependencies

The landing page self-hosts two OFL fonts (Space Grotesk for display, Inter Tight for prose and controls, Latin subset only), carries an original AI-generated monochrome hero photograph and clip, and uses Font Awesome Free chess/interface SVGs (CC BY 4.0, with MIT JavaScript). Quartz source is MIT licensed, copyright (c) 2026 Arlan Marat. Its license is retained in [QUARTZ-LICENSE.txt](design/QUARTZ-LICENSE.txt) and added to generated distribution notices. [Landing page design notes](design/landing.md) record the component registry URLs, local adaptations and asset credits. No source was copied from the disposable interface prototype.

The approved chess.js **1.4.0** runtime dependency is installed and listed above. cm-chessboard **8.15.3** remains a research baseline and is not installed yet. The board work must pin and review its actual version against [the dependency research](../research/chess-dependencies.md), preserve required dependency notices, and add the standard art's actual author/source, CC BY-SA 3.0 license and modification notices before distribution. The absence of the board package and artwork here does not replace those choices.

Exclude the optional NonCommercial piece set, research-only GPL replay packages and the unsafe stock solver from production. Experiment lockfiles and bundles are not production dependencies or distribution assets. Later artwork licensing remains separate from the original-code MIT license. Complete `OPS-05` requires the final game distribution and asset review, not just this foundation inventory.
