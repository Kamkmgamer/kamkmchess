// packages/core/src/index.ts
//
// Vendored verbatim from jvgomg/ditherkit (https://github.com/jvgomg/ditherkit),
// MIT licensed — see the LICENSE file beside this file. The owner chose this
// kit for the hero's dithered photograph. ditherkit's packages are not yet
// published to npm, and the project's pattern is copy-in source from the
// official repository (Quartz, and 23rd previously), so the core package is
// kept here unchanged, apart from non-null index reads that TypeScript's
// noUncheckedIndexedAccess requires where the loops already guarantee the
// index is in bounds — the same minimal adaptation the Quartz copy got.

export type Color = { r: number; g: number; b: number };

export { palettes, type PaletteName } from "./palettes";
export {
  snapDimensionsToPixelSize,
  deriveDimensions,
  computeCoverCrop,
  type SnappedDimensions,
  type CropRegion,
} from "./dimensions";

/**
 * Perceptual distance between two sRGB colours using the "redmean"
 * approximation (Thiadmer Riemersma, 1996). Cheap — no LAB conversion,
 * no gamma handling — but noticeably better than plain sRGB Euclidean,
 * because it adapts the per-channel weighting to the red level.
 *
 * Returns a **squared** distance. We compare squared distances in the
 * argmin loop, which is strictly monotonic with the true distance for
 * non-negative values and saves the sqrt in the hot path.
 *
 * Safe on out-of-range inputs (e.g. Bayer's unclamped `pixels[idx] +
 * threshold`): the channel differences are squared before weighting so
 * sign doesn't matter, and the final value is bounded well within
 * JavaScript's safe-int range.
 */
function colorDistanceSquared(a: Color, b: Color): number {
  const rmean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return (
    ((512 + rmean) * dr * dr) / 256 +
    4 * dg * dg +
    ((767 - rmean) * db * db) / 256
  );
}

/**
 * Finds the closest color in a palette to a given color, using the
 * redmean perceptual distance metric.
 *
 * @param color The color to find the closest match for.
 * @param palette The palette of colors to search.
 * @returns The closest color in the palette (or black if empty).
 */
export function findClosestColor(color: Color, palette: Color[]) {
  if (palette.length === 0) {
    return { r: 0, g: 0, b: 0 };
  }
  let closestColor = palette[0]!;
  let minDiff = Infinity;

  for (const c of palette) {
    const diff = colorDistanceSquared(color, c);
    if (diff < minDiff) {
      minDiff = diff;
      closestColor = c;
    }
  }
  return closestColor;
}

/**
 * Applies threshold dithering to an image.
 * @param pixels The pixel data of the image.
 * @param threshold The threshold value.
 * @param palette The color palette to use.
 */
export function thresholdDither(
  pixels: Uint8ClampedArray,
  threshold: number,
  palette: Color[]
) {
  const c1: Color = palette.length > 0 ? palette[0]! : { r: 0, g: 0, b: 0 };
  const c2: Color = palette.length > 1 ? palette[1]! : { r: 255, g: 255, b: 255 };

  for (let i = 0; i < pixels.length; i += 4) {
    const gray = pixels[i]!;
    const newColor = gray > threshold ? c2 : c1;
    pixels[i] = newColor.r;
    pixels[i + 1] = newColor.g;
    pixels[i + 2] = newColor.b;
  }
}

/**
 * A single offset in an error-diffusion kernel. `dx`/`dy` are the target
 * pixel's offset from the current pixel; `weight` is the fraction of the
 * quantisation error (already divided by the kernel's `divisor`) that gets
 * added to that neighbour.
 */
type KernelOffset = { dx: number; dy: number; weight: number };

/**
 * A pre-normalised error-diffusion kernel. `weights` are the raw integers
 * from the literature; `divisor` is what they're divided by. We store both
 * (instead of pre-computing floats) so each kernel reads like its published
 * form and is easy to audit.
 */
type DiffusionKernel = {
  divisor: number;
  weights: ReadonlyArray<KernelOffset>;
};

/**
 * Floyd-Steinberg (1976). Weights sum to 16; diffuses to 4 neighbours.
 *     *  7
 *  3  5  1
 */
const FLOYD_STEINBERG_KERNEL: DiffusionKernel = {
  divisor: 16,
  weights: [
    { dx: 1, dy: 0, weight: 7 },
    { dx: -1, dy: 1, weight: 3 },
    { dx: 0, dy: 1, weight: 5 },
    { dx: 1, dy: 1, weight: 1 },
  ],
};

/**
 * Atkinson (1980s, original Macintosh). Only diffuses 6/8 of the error,
 * which gives higher contrast and loses some detail in flat regions.
 *     *  1  1
 *  1  1  1
 *     1
 */
const ATKINSON_KERNEL: DiffusionKernel = {
  divisor: 8,
  weights: [
    { dx: 1, dy: 0, weight: 1 },
    { dx: 2, dy: 0, weight: 1 },
    { dx: -1, dy: 1, weight: 1 },
    { dx: 0, dy: 1, weight: 1 },
    { dx: 1, dy: 1, weight: 1 },
    { dx: 0, dy: 2, weight: 1 },
  ],
};

/**
 * Jarvis, Judice & Ninke (1976). Larger footprint than Floyd-Steinberg,
 * producing smoother gradients at the cost of some sharpness.
 *        *  7  5
 *  3  5  7  5  3
 *  1  3  5  3  1
 */
const JJN_KERNEL: DiffusionKernel = {
  divisor: 48,
  weights: [
    { dx: 1, dy: 0, weight: 7 },
    { dx: 2, dy: 0, weight: 5 },
    { dx: -2, dy: 1, weight: 3 },
    { dx: -1, dy: 1, weight: 5 },
    { dx: 0, dy: 1, weight: 7 },
    { dx: 1, dy: 1, weight: 5 },
    { dx: 2, dy: 1, weight: 3 },
    { dx: -2, dy: 2, weight: 1 },
    { dx: -1, dy: 2, weight: 3 },
    { dx: 0, dy: 2, weight: 5 },
    { dx: 1, dy: 2, weight: 3 },
    { dx: 2, dy: 2, weight: 1 },
  ],
};

/**
 * Stucki (1981). A tweak of JJN with weights tuned to reduce some of its
 * over-smoothing in the midtones.
 *        *  8  4
 *  2  4  8  4  2
 *  1  2  4  2  1
 */
const STUCKI_KERNEL: DiffusionKernel = {
  divisor: 42,
  weights: [
    { dx: 1, dy: 0, weight: 8 },
    { dx: 2, dy: 0, weight: 4 },
    { dx: -2, dy: 1, weight: 2 },
    { dx: -1, dy: 1, weight: 4 },
    { dx: 0, dy: 1, weight: 8 },
    { dx: 1, dy: 1, weight: 4 },
    { dx: 2, dy: 1, weight: 2 },
    { dx: -2, dy: 2, weight: 1 },
    { dx: -1, dy: 2, weight: 2 },
    { dx: 0, dy: 2, weight: 4 },
    { dx: 1, dy: 2, weight: 2 },
    { dx: 2, dy: 2, weight: 1 },
  ],
};

/**
 * Burkes (1988). Same footprint as Stucki's top two rows, dropped the
 * third row for speed. Runs roughly twice as fast as Stucki with very
 * similar output quality.
 *        *  8  4
 *  2  4  8  4  2
 */
const BURKES_KERNEL: DiffusionKernel = {
  divisor: 32,
  weights: [
    { dx: 1, dy: 0, weight: 8 },
    { dx: 2, dy: 0, weight: 4 },
    { dx: -2, dy: 1, weight: 2 },
    { dx: -1, dy: 1, weight: 4 },
    { dx: 0, dy: 1, weight: 8 },
    { dx: 1, dy: 1, weight: 4 },
    { dx: 2, dy: 1, weight: 2 },
  ],
};

/**
 * Shared error-diffusion driver. All error-diffusion algorithms share the
 * same structure — pick the nearest palette colour, compute the residual,
 * spread it across a fixed set of neighbours — so the algorithm reduces
 * to the kernel's weight table.
 */
function errorDiffuse(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Color[],
  kernel: DiffusionKernel
) {
  const { divisor, weights } = kernel;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const oldR = pixels[index]!;
      const oldG = pixels[index + 1]!;
      const oldB = pixels[index + 2]!;

      const newColor = findClosestColor({ r: oldR, g: oldG, b: oldB }, palette);
      pixels[index] = newColor.r;
      pixels[index + 1] = newColor.g;
      pixels[index + 2] = newColor.b;

      const errR = (oldR - newColor.r) / divisor;
      const errG = (oldG - newColor.g) / divisor;
      const errB = (oldB - newColor.b) / divisor;

      for (const { dx, dy, weight } of weights) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const idx = (ny * width + nx) * 4;
        pixels[idx] = pixels[idx]! + errR * weight;
        pixels[idx + 1] = pixels[idx + 1]! + errG * weight;
        pixels[idx + 2] = pixels[idx + 2]! + errB * weight;
      }
    }
  }
}

/**
 * Applies Floyd-Steinberg dithering to an image.
 * Classic error diffusion — sharp, general-purpose, the default you
 * probably want.
 */
export function floydSteinbergDither(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Color[]
) {
  errorDiffuse(pixels, width, height, palette, FLOYD_STEINBERG_KERNEL);
}

/**
 * Applies Atkinson dithering to an image.
 * Only diffuses 6/8 of the error, giving higher contrast and that classic
 * early-Mac look. Blows out shadows and highlights more than FS.
 */
export function atkinsonDither(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Color[]
) {
  errorDiffuse(pixels, width, height, palette, ATKINSON_KERNEL);
}

/**
 * Applies Jarvis-Judice-Ninke dithering to an image.
 * Wider footprint than Floyd-Steinberg, producing smoother gradients
 * at the cost of sharpness.
 */
export function jarvisJudiceNinkeDither(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Color[]
) {
  errorDiffuse(pixels, width, height, palette, JJN_KERNEL);
}

/**
 * Applies Stucki dithering to an image.
 * JJN's footprint with tuned weights — slightly sharper midtones.
 */
export function stuckiDither(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Color[]
) {
  errorDiffuse(pixels, width, height, palette, STUCKI_KERNEL);
}

/**
 * Applies Burkes dithering to an image.
 * Stucki's top two rows — about twice as fast as Stucki with very
 * similar quality.
 */
export function burkesDither(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Color[]
) {
  errorDiffuse(pixels, width, height, palette, BURKES_KERNEL);
}

/**
 * 8x8 Bayer threshold matrix (normalised to 0..63). Pre-computing this
 * once avoids the recursive construction on every call.
 *
 * Bayer matrices are constructed recursively:
 *   M(2n) = [[4·M(n),       4·M(n)+2·J(n)],
 *            [4·M(n)+3·J(n), 4·M(n)+J(n)]]
 * where J(n) is an n×n matrix of 1s.
 */
const BAYER_8X8: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/**
 * Applies Bayer ordered dithering to an image.
 *
 * Unlike error diffusion, ordered dithering is fully deterministic per
 * pixel — it just nudges each pixel's value by a fixed threshold taken
 * from a tiled 8x8 matrix before quantising to the palette. That makes
 * it cheap, parallelisable, and produces the stable cross-hatched look
 * you'd recognise from old printers and Game Boy games.
 *
 * The nudge amount is computed as `(matrix / 64 - 0.5) * strength`,
 * where `strength` defaults to 255 / paletteSize so that the nudge is
 * sized to cover one quantisation step — enough to push a pixel over
 * the boundary to the next palette colour, but no further.
 *
 * @param pixels RGBA pixel buffer.
 * @param width Image width.
 * @param height Image height.
 * @param palette Target palette.
 * @param strength Optional override for the nudge amplitude. Defaults
 *   to `255 / palette.length`.
 */
export function bayerDither(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Color[],
  strength?: number
) {
  if (palette.length === 0) return;
  const amplitude = strength ?? 255 / palette.length;
  for (let y = 0; y < height; y++) {
    const row = BAYER_8X8[y & 7]!;
    for (let x = 0; x < width; x++) {
      const threshold = (row[x & 7]! / 64 - 0.5) * amplitude;
      const index = (y * width + x) * 4;
      const r = pixels[index]! + threshold;
      const g = pixels[index + 1]! + threshold;
      const b = pixels[index + 2]! + threshold;
      const newColor = findClosestColor({ r, g, b }, palette);
      pixels[index] = newColor.r;
      pixels[index + 1] = newColor.g;
      pixels[index + 2] = newColor.b;
    }
  }
}

/**
 * Converts an image to grayscale.
 * @param pixels The pixel data of the image.
 */
export function grayscale(pixels: Uint8ClampedArray) {
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    pixels[i] = gray;
    pixels[i + 1] = gray;
    pixels[i + 2] = gray;
  }
}

/**
 * A utility function to clamp a value between a min and a max.
 * @param value The value to clamp.
 * @param min The minimum value.
 * @param max The maximum value.
 * @returns The clamped value.
 */
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Applies a brightness adjustment to pixel data.
 * @param pixels The pixel data to modify.
 * @param brightness The brightness adjustment value (-100 to 100).
 */
export function applyBrightness(pixels: Uint8ClampedArray, brightness: number) {
  // Map brightness from [-100, 100] to a suitable multiplier
  const adjustment = (brightness / 100) * 255;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = clamp(pixels[i]! + adjustment, 0, 255);
    pixels[i + 1] = clamp(pixels[i + 1]! + adjustment, 0, 255);
    pixels[i + 2] = clamp(pixels[i + 2]! + adjustment, 0, 255);
  }
}

/**
 * Applies a contrast adjustment to pixel data.
 * @param pixels The pixel data to modify.
 * @param contrast The contrast adjustment value (-100 to 100).
 */
export function applyContrast(pixels: Uint8ClampedArray, contrast: number) {
  // Map contrast from [-100, 100] to a factor
  const factor = (contrast + 100) / 100;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = clamp(factor * (pixels[i]! - 128) + 128, 0, 255);
    pixels[i + 1] = clamp(factor * (pixels[i + 1]! - 128) + 128, 0, 255);
    pixels[i + 2] = clamp(factor * (pixels[i + 2]! - 128) + 128, 0, 255);
  }
}
