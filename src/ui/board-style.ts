import { createStylePreference } from './style-preference.js';

export interface BoardPalette {
  readonly label: string;
  /** Square colors, also reused by the position editor and the landing preview board. */
  readonly light: string;
  readonly dark: string;
  /** Square feedback colors; the dots keep legal moves visible on light and dark boards alike. */
  readonly lastMove: string;
  readonly selected: string;
  readonly dest: string;
  readonly destRing: string;
  readonly destHover: string;
}

export const BOARD_STYLES = {
  green: {
    label: 'Green',
    light: '#ebecd0',
    dark: '#779556',
    lastMove: 'rgb(255 255 51 / 50%)',
    selected: 'rgb(255 255 51 / 60%)',
    dest: 'rgb(20 20 20 / 16%)',
    destRing: 'rgb(20 20 20 / 18%)',
    destHover: 'rgb(255 255 51 / 35%)',
  },
  walnut: {
    label: 'Walnut',
    light: '#f0d9b5',
    dark: '#b58863',
    lastMove: 'rgb(255 255 51 / 50%)',
    selected: 'rgb(255 255 51 / 60%)',
    dest: 'rgb(20 20 20 / 16%)',
    destRing: 'rgb(20 20 20 / 18%)',
    destHover: 'rgb(255 255 51 / 35%)',
  },
  ice: {
    label: 'Ice',
    light: '#dee3e6',
    dark: '#8ba2b3',
    lastMove: 'rgb(255 255 51 / 47%)',
    selected: 'rgb(255 255 51 / 57%)',
    dest: 'rgb(20 20 20 / 15%)',
    destRing: 'rgb(20 20 20 / 17%)',
    destHover: 'rgb(255 255 51 / 35%)',
  },
  slate: {
    label: 'Slate',
    light: '#a3adc2',
    dark: '#5d6b85',
    lastMove: 'rgb(255 255 51 / 42%)',
    selected: 'rgb(255 255 51 / 52%)',
    dest: 'rgb(255 255 255 / 24%)',
    destRing: 'rgb(255 255 255 / 28%)',
    destHover: 'rgb(255 255 51 / 30%)',
  },
  coral: {
    label: 'Coral',
    light: '#f6e5d7',
    dark: '#c97d5f',
    lastMove: 'rgb(255 255 51 / 45%)',
    selected: 'rgb(255 255 51 / 55%)',
    dest: 'rgb(20 20 20 / 16%)',
    destRing: 'rgb(20 20 20 / 18%)',
    destHover: 'rgb(255 255 51 / 32%)',
  },
} satisfies Record<string, BoardPalette>;

export type BoardStyle = keyof typeof BOARD_STYLES;
export const DEFAULT_BOARD_STYLE: BoardStyle = 'green';
export const BOARD_STYLE_STORAGE_KEY = 'kamkmchess.board-style.v1';

const preference = createStylePreference<BoardStyle>({
  options: BOARD_STYLES,
  fallback: DEFAULT_BOARD_STYLE,
  storageKey: BOARD_STYLE_STORAGE_KEY,
  changeEvent: 'kamkmchess:board-style',
});

export const isBoardStyle = preference.isOption;
export const getBoardStyle = preference.get;
export const setBoardStyle = preference.set;
export const subscribeBoardStyle = preference.subscribe;

const BOARD_VARIABLES = {
  light: '--board-light',
  dark: '--board-dark',
  lastMove: '--board-last-move',
  selected: '--board-selected',
  dest: '--board-dest',
  destRing: '--board-dest-ring',
  destHover: '--board-dest-hover',
} as const;

/** The palette rides on the document element so every board — chessground, editor and landing preview — follows it. */
export function applyBoardStyle(style: BoardStyle): void {
  const root = document.documentElement;
  const palette = BOARD_STYLES[style];
  root.dataset.boardStyle = style;
  for (const [key, variable] of Object.entries(BOARD_VARIABLES)) {
    root.style.setProperty(variable, palette[key as keyof typeof BOARD_VARIABLES]);
  }
}
