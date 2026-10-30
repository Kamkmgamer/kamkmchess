import type { Promotion } from '../rules/index.js';

/** The pieces a promoted pawn may become, in picker order. */
export const PROMOTIONS: readonly { value: Promotion; label: string }[] = [
  { value: 'q', label: 'Queen' }, { value: 'r', label: 'Rook' },
  { value: 'b', label: 'Bishop' }, { value: 'n', label: 'Knight' },
];
