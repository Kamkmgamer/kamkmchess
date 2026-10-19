# Readability pass

The owner requested Taste-guided improvements to layout, borders, typography,
sidebar contrast and readability. This pass retains the approved artwork,
animated dither, sticky hero, opening preview and existing content.

## Direction and subject

Retained **The product performs**, seed **1003372513**, with the existing
Instrument Serif / Inter Tight pairing and monochrome palette. No redraw.

Subject inventory: human versus language-model chess; models choosing moves;
planned personal AI connections; exact model IDs; the six-move Italian preview;
White/Black/Random setup; custom FEN; default 15 + 10 time control; paused preview
clocks; a project by two friends; physical model-mark chess artwork; Grim's Bayer
dither.

On this page, the knight facing model-mark chess pieces becomes the visual
introduction, and the actual opening preview becomes the product demonstration.
The live thing is the existing legal opening replay and custom board setup.

The argument stays unchanged: the hero introduces the opponent; the introduction
explains model-selected moves; the preview demonstrates the board; the FAQ
clarifies development status. No sample claims, additional assets or copy added.

## Changes

- Page-owned type roles use regular 17 px body text, 16 px navigation and controls,
  and a 14 px floor for secondary notes. Display headings retain Instrument Serif.
- Running paragraphs use solid white. Secondary inks are solid, surface-relative
  colors instead of translucent running text. The page is black, with a charcoal
  sidebar and playing surface.
- Control borders mix 48% ink with their surface; hover edges use 72%. The owner's
  requested control borders remain the exception to Taste's decorative-line rule.
- The sidebar is 256 px wide, with aligned icons and labels, more substantial
  text, consistent submenu indentation, and 44–48 px interaction rows. Tone and
  spacing replace its three divider lines. Navigation hover uses an underline.
- A footer link selector had overridden the wordmark's display role. The wordmark
  now renders at 40 px rather than 14 px.

Registry components remain unchanged. The overrides live in `src/ui/styles.css`.

## Measurements and verification

Measured from rendered CSS colors, composited to sRGB:

| Element | Contrast |
| --- | ---: |
| Body text on black | 21:1 |
| Sidebar label on charcoal | 19.17:1 |
| Preview disclosure on its playing surface | 8.95:1 |
| Secondary-button border on black | 4.89:1, previously 1.44:1 |

Taste screenshots were inspected at 1440, 768 and 390 px. Headings remain within
two lines, fonts load, and the inspector reports no overflow or small-text
warnings. The options drawer also renders white field text at 16 px or larger.
Build, ESLint and the 19 existing focused opening, setup and board tests pass.

The initial inspector reported three failures for picture count, motion count
and the sticky hero being covered. Its remaining warnings concerned the original
still image and pinned hero. These are documented allowances in the final run:
`few-pictures`, `still-page`, `covered-text`, `pinned-over-picture`, `long-pin`,
`no-footage`. They preserve the owner's approved still image, overlapping sheet
and restrained motion rather than adding content for a gallery quota. With those
allowances, the final inspector reports 0 failures and 0 warnings. Source lint
reports 0 failures; its two font warnings are the approved self-hosted pairing.

## Visual critique

The strongest improvements are text weight, visible controls and the sidebar's
clearer hierarchy. The photo, product surface, question list and compact footer
retain distinct compositions. Phone copy is comfortable and the board guide
stacks without sideways scrolling. The board still needs deliberate scrolling
on a phone; the approved hero remains a full first screen.

Self-review: design 6.5 (the rubric's picture-count cap), usability 8, creativity
7, content 8; weighted 7.2/10. This is a focused readability correction, not a
new imagery or motion direction. No new media or license credits are required.
