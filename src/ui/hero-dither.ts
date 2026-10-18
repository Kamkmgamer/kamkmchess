import type { DitherGradientProps } from '../components/grim-dither-kit/gradient';

/** Presets of ripgrim's actual DitherGradient, shared with the review page. */
export const heroDitherPresets = {
  bottom: {
    label: 'Black stipple',
    description: 'Fine black stippling over the original image, dissolving into a dark lower edge with a slow drift.',
    layers: [{ from: [0, 0, 0], direction: 'up', cell: 2, opacity: 0.9, bloom: 'off' }],
  },
  top: {
    label: 'Top dissolve',
    description: 'A slightly coarser wash falling from the top edge, with a clear lower board.',
    layers: [{ from: 'grey', direction: 'down', cell: 4, opacity: 0.55, bloom: 'off' }],
  },
  side: {
    label: 'Side dissolve',
    description: 'Larger pixels dissolving from the right edge across the model pieces.',
    layers: [{ from: 'grey', direction: 'left', cell: 5, opacity: 0.68, bloom: 'off' }],
  },
  crossed: {
    label: 'Crossed washes',
    description: 'Two fine dither fades meet from the bottom and left for a fuller texture.',
    layers: [
      { from: 'grey', direction: 'up', cell: 3, opacity: 0.48, bloom: 'off' },
      { from: 'grey', direction: 'right', cell: 4, opacity: 0.38, bloom: 'off' },
    ],
  },
} satisfies Record<string, { label: string; description: string; layers: DitherGradientProps[] }>;

export type HeroDitherVariant = keyof typeof heroDitherPresets;

/** Review links choose the overlay without adding controls to the product. */
export function resolveHeroDitherVariant(search: string): HeroDitherVariant {
  const variant = new URLSearchParams(search).get('dither');
  switch (variant) {
    case 'bottom':
    case 'top':
    case 'side':
    case 'crossed':
      return variant;
    default:
      return 'bottom';
  }
}
