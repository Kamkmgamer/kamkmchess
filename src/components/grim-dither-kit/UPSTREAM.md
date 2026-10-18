# Dither Kit gradient

Source: [Boring-Software-Inc/dither-kit](https://github.com/Boring-Software-Inc/dither-kit), author `ripgrim` in the gradient registry item. Documentation: [tripwire.sh/dither-kit](https://www.tripwire.sh/dither-kit).

Pinned revision: `1e7faee9aa252e499651e6736ed65f7a07d9a6bd`.

Copied files: `registry/dither-kit/gradient.tsx`, `pixel.ts`, `palette.ts`, and `lib.ts`. Their only dependencies are React, clsx and tailwind-merge, already installed in this project. This is the standalone gradient component, without the chart engine or installer.

Adaptations: the gradient painter is extracted into `gradient-paint.ts` so the component and review page call the exact same implementation while keeping React Fast Refresh exports separate. Two fixed-size Bayer matrix reads use non-null assertions required by strict indexed access. The hue converter's RGB tuple has an explicit upstream `Rgb` annotation for the same strictness setting. `PixelColor` also accepts an RGB tuple so the selected hero can use a darker charcoal without changing the shared palette. The gradient painting formula and upstream palette remain unchanged. Hero animation lives in project CSS and a wrapper, outside the upstream component.

The upstream package manifests declare `MIT`; this revision does not include a standalone license text. Source attribution and the declared license identifier are retained in the distribution notices. The earlier James Greenaway image-dithering core remains in `../dither-kit/` but is no longer imported by the hero.
