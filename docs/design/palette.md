# Previous blue and copper palette

Superseded by the charcoal and champagne theme described in [landing.md](landing.md).

The owner's seed is `#08456b`. Its HSL hue is 203.03°. Rotating that hue by
180°, while retaining saturation and lightness, gives `#6b2e08` at 23.03°.
This is an HSL hue complement, rather than an RGB channel inversion.

| Role | Color | Use |
| --- | --- | --- |
| Primary | `#08456b` | Primary actions and current navigation |
| Complement | `#6b2e08` | Copper source hue |
| Deep blue | `#052b42` | Expanded navigation groups |
| Light blue | `#4ab1f1` | Icons, control edges and focus |
| Light copper | `#f18a4a` | Selected marker, Play/Explore/time icons and knight mark |
| Primary hover | `#0d70ad` | Primary action hover |
| Page / text | `#000000` / `#ffffff` | Reading contrast |

## Golden-ratio construction

With φ = 1.61803398875, deep-blue HSL lightness is the seed's lightness divided
by φ. Primary-hover lightness is the seed's lightness multiplied by φ. Both
light accents retain their source hue and saturation, with lightness 1/φ,
or 61.8034%. The original complement is too dark for small marks on black,
so the interface uses its lighter copper derivative for those marks.

Navigation and playing surfaces blend blue with dark neutrals at successive
golden-ratio weights, 14.6%, 23.6% and 38.2%. These are tone recipes, not claims
about exact screen coverage. The introduction uses a 1 : 1.618 text/image grid,
giving the image 61.8% of its available track width. Navigation row and icon
dimensions use 32φ and 16φ pixels. Mobile stacking and 44 px interaction floors
take precedence when space is limited.

## Sidebar

The owner's Chess.com screenshots guide the stronger row shapes, large icons,
compact groups and separate bottom actions. The 240 px rail uses filled dark-blue
neutral rows with white labels. The current destination has a blue fill and a
4 px copper marker, so it has a shape cue as well as a color cue. Hash navigation
updates the current link and its parent group rather than leaving Home marked
current everywhere. Play and Explore start collapsed, and the primary setup
button remains visible below the guest identity. The mobile drawer shares this
component. Existing destinations, setup callbacks and disclosure primitives stay
in use.

## Contrast and verification

Calculated with relative sRGB luminance, rounding mixed backgrounds to 8-bit RGB:

| Combination | Ratio |
| --- | ---: |
| White / primary blue | 10.13:1 |
| White / primary hover | 5.33:1 |
| White / navigation rest (`#213847`) | 12.20:1 |
| White / navigation hover (`#394750`) | 9.58:1 |
| Light blue icon / navigation rest | 5.14:1 |
| Copper icon / navigation rest | 4.92:1 |
| Copper selection marker / primary blue | 4.09:1 |

The existing typefaces, white running text, hero artwork and animated dither
remain the foundation. CSS is page-owned; no registry or dependency changes.
Server rendering checks confirm the initial current destination, two collapsed
groups and the retained setup/help controls. Build and lint pass. This pass does
not include live-browser verification.
