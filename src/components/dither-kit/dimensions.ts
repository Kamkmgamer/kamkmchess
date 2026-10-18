// packages/core/src/dimensions.ts
//
// Pure math helpers for resolving the user-facing "I want a W×H output
// with N-pixel cells" model into the canonical, runtime-correct
// numbers that every layer of the toolkit must agree on.
//
// Two functions, no state, no DOM, no Sharp — usable from React, Next,
// the worker, the playground, the SSR route handler, and the docs.
//
// Vocabulary:
//   - **target**:   what the user asked for (may not be reachable)
//   - **output**:   the canonical bitmap dimensions actually rendered
//   - **process**:  the (smaller) dimensions the dither runs at
//
// Invariants the helpers guarantee:
//   1. `outputWidth = processWidth * pixelSize`
//   2. `outputHeight = processHeight * pixelSize`
//   3. Both process dimensions are at least 1, even for absurd inputs
//   4. The output is never larger than the target — we always round
//      *down*. The user said "no bigger than 1000" and we honour it.

/**
 * Snap a target output dimension pair to multiples of `pixelSize`. The
 * snapped values are the *canonical* values: every part of the toolkit
 * (canvas attribute, route URL, cache key, log line) uses these and
 * not the original input.
 *
 * Rounds down so the result never exceeds the user's target. A target
 * of 1000 with pixelSize 3 becomes 999 (333 cells × 3), not 1002.
 *
 * Returns process dimensions alongside the snapped output so callers
 * don't have to recompute the divide. `rounded` is true when either
 * input was changed by snapping — useful for surfacing a dev warning.
 */
export interface SnappedDimensions {
  /** Canonical output bitmap width. ALWAYS the value to render at. */
  outputWidth: number;
  /** Canonical output bitmap height. */
  outputHeight: number;
  /** Resolution the dither algorithm runs at. = output / pixelSize. */
  processWidth: number;
  processHeight: number;
  /** True if either output dimension differs from the requested target. */
  rounded: boolean;
}

export function snapDimensionsToPixelSize(
  targetWidth: number,
  targetHeight: number,
  pixelSize: number
): SnappedDimensions {
  // Treat fractional / sub-1 pixelSize as 1. The user-facing controls
  // should already clamp this, but defending here means the helper
  // can't return zero-sized buffers.
  const cell = Math.max(1, Math.floor(pixelSize));
  const processWidth = Math.max(1, Math.floor(targetWidth / cell));
  const processHeight = Math.max(1, Math.floor(targetHeight / cell));
  const outputWidth = processWidth * cell;
  const outputHeight = processHeight * cell;
  return {
    outputWidth,
    outputHeight,
    processWidth,
    processHeight,
    rounded: outputWidth !== targetWidth || outputHeight !== targetHeight,
  };
}

/**
 * Derive a complete `{ width, height }` pair from a partial spec plus
 * the source aspect ratio. Used when a consumer passes only one of
 * `width` / `height` and we need to fill in the other.
 *
 * Rules:
 *   - both passed → returned verbatim
 *   - only width  → height computed from `width * source.height / source.width`
 *   - only height → width  computed from `height * source.width / source.height`
 *   - neither     → returns the source's intrinsic dimensions
 *
 * Uses `Math.round` for the derived dimension. The follow-up call to
 * `snapDimensionsToPixelSize` will then clamp the result to a multiple
 * of pixelSize.
 */
export function deriveDimensions(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number | undefined,
  targetHeight: number | undefined
): { width: number; height: number } {
  if (targetWidth !== undefined && targetHeight !== undefined) {
    return { width: targetWidth, height: targetHeight };
  }
  if (targetWidth !== undefined) {
    return {
      width: targetWidth,
      height: Math.max(1, Math.round((targetWidth * sourceHeight) / sourceWidth)),
    };
  }
  if (targetHeight !== undefined) {
    return {
      width: Math.max(1, Math.round((targetHeight * sourceWidth) / sourceHeight)),
      height: targetHeight,
    };
  }
  return { width: sourceWidth, height: sourceHeight };
}

/**
 * A rectangular region of the source image, expressed in source-pixel
 * coordinates. The four numbers map directly to the `sx, sy, sWidth,
 * sHeight` arguments of the canvas `drawImage` 9-argument form, and
 * to Sharp's `extract` plus `resize` chain.
 */
export interface CropRegion {
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
}

/**
 * Compute a centre-anchored "cover" crop of a source image so that,
 * when scaled to fit a target box, the source covers the box exactly
 * with its aspect ratio preserved. Pixels along the long axis of the
 * source are cropped equally on both sides.
 *
 * This is the runtime equivalent of CSS `object-fit: cover` and Sharp's
 * `fit: 'cover'`, exposed as a pure helper so the React `drawImage`
 * pipeline can do the same thing as the Sharp server-side pipeline
 * with a single shared definition.
 *
 * Why we crop at all: when the caller passes `width` and `height` that
 * don't match the source's intrinsic aspect ratio, *something* has to
 * give. Stretching distorts faces and breaks dithering's whole point.
 * Letterboxing leaves dead bars in the output. Cropping preserves the
 * subject and gives the caller exactly the pixels they asked for.
 */
export function computeCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): CropRegion {
  const srcAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;

  if (srcAspect > targetAspect) {
    // Source is wider than target → crop the left/right edges.
    const sWidth = sourceHeight * targetAspect;
    const sx = (sourceWidth - sWidth) / 2;
    return { sx, sy: 0, sWidth, sHeight: sourceHeight };
  }
  if (srcAspect < targetAspect) {
    // Source is taller than target → crop the top/bottom edges.
    const sHeight = sourceWidth / targetAspect;
    const sy = (sourceHeight - sHeight) / 2;
    return { sx: 0, sy, sWidth: sourceWidth, sHeight };
  }
  // Aspect ratios match — no crop, full source.
  return { sx: 0, sy: 0, sWidth: sourceWidth, sHeight: sourceHeight };
}
