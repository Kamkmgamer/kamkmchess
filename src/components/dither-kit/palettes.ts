// packages/core/src/palettes.ts
//
// Built-in palette presets. These are pure data — no runtime cost to
// anyone who doesn't import them — but save every consumer from having
// to hand-roll the common retro palettes.
//
// Each palette is exported as a `Color[]` so it can be passed directly
// to any dither function in this package. The `palettes` object at the
// bottom is the public entry point: `palettes.gameboy`, `palettes.bw`.

import type { Color } from "./index";

/**
 * Parse a `#rrggbb` hex string into a Color. Unsafe: assumes valid input,
 * used only to keep the palette tables below readable.
 */
function hex(s: string): Color {
  const n = parseInt(s.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Pure black-and-white. The default palette for most dither use cases. */
const bw: Color[] = [hex("#000000"), hex("#ffffff")];

/**
 * Original DMG Game Boy palette — four shades of the famous green LCD.
 * Ordered dark → light.
 */
const gameboy: Color[] = [
  hex("#0f380f"),
  hex("#306230"),
  hex("#8bac0f"),
  hex("#9bbc0f"),
];

/**
 * CGA Mode 4, Palette 1, high intensity. The blue/magenta/cyan/white
 * palette that PC games used to look weird in for most of the 1980s.
 */
const cga: Color[] = [
  hex("#000000"),
  hex("#55ffff"),
  hex("#ff55ff"),
  hex("#ffffff"),
];

/**
 * A compact, perceptually-spaced subset of the NES's 54-colour palette.
 * Not the full hardware palette — that's too many colours to be useful
 * as a dither target — but enough to give output an unmistakable NES feel.
 */
const nes: Color[] = [
  hex("#000000"),
  hex("#fcfcfc"),
  hex("#a4e4fc"),
  hex("#3cbcfc"),
  hex("#0078f8"),
  hex("#0000fc"),
  hex("#b8b8f8"),
  hex("#6888fc"),
  hex("#f8b8f8"),
  hex("#d800cc"),
  hex("#f878f8"),
  hex("#f85898"),
  hex("#f87858"),
  hex("#fca044"),
  hex("#f83800"),
  hex("#bcbcbc"),
  hex("#7c7c7c"),
  hex("#b8f818"),
  hex("#00b800"),
  hex("#f8d878"),
  hex("#fce0a8"),
  hex("#c84c0c"),
];

/** The PICO-8 fantasy console's 16-colour palette. */
const pico8: Color[] = [
  hex("#000000"),
  hex("#1d2b53"),
  hex("#7e2553"),
  hex("#008751"),
  hex("#ab5236"),
  hex("#5f574f"),
  hex("#c2c3c7"),
  hex("#fff1e8"),
  hex("#ff004d"),
  hex("#ffa300"),
  hex("#ffec27"),
  hex("#00e436"),
  hex("#29adff"),
  hex("#83769c"),
  hex("#ff77a8"),
  hex("#ffccaa"),
];

/**
 * Built-in palette presets. Pass any entry directly to a dither function:
 *
 * @example
 * ```ts
 * import { floydSteinbergDither, palettes } from "@ditherkit/core";
 * floydSteinbergDither(pixels, w, h, palettes.gameboy);
 * ```
 */
export const palettes = {
  bw,
  gameboy,
  cga,
  nes,
  pico8,
} as const;

export type PaletteName = keyof typeof palettes;
