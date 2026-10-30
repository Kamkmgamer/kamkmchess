import { createStylePreference } from './style-preference.js';

export const PIECE_STYLES = {
  merida: { label: 'Merida', artist: 'Armando Hernandez Marroquin' },
  cburnett: { label: 'Cburnett', artist: 'Colin M. L. Burnett' },
  firi: { label: 'Firi', artist: 'James Faure' },
  kaneo: { label: 'Kaneo', artist: 'Kadagaden' },
  kamkm: { label: 'Kamkm', artist: 'The kamkm chess project' },
};

export type PieceStyle = keyof typeof PIECE_STYLES;
export const DEFAULT_PIECE_STYLE: PieceStyle = 'merida';
export const PIECE_STYLE_STORAGE_KEY = 'kamkmchess.piece-style.v1';

const preference = createStylePreference<PieceStyle>({
  options: PIECE_STYLES,
  fallback: DEFAULT_PIECE_STYLE,
  storageKey: PIECE_STYLE_STORAGE_KEY,
  changeEvent: 'kamkmchess:piece-style',
});

/** Notify every board and picker in this tab, even when storage is blocked. */
export const isPieceStyle = preference.isOption;
export const getPieceStyle = preference.get;
export const setPieceStyle = preference.set;
export const subscribePieceStyle = preference.subscribe;
