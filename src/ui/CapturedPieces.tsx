import type { Color, PieceType } from '../rules/index.js';
import { pieceImage } from './piece-image.js';
import { usePieceStyle } from './use-piece-style.js';

const PIECE_LABELS: Record<PieceType, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** The tray of taken pieces next to a player's name; the leading side also shows its material edge. */
export function CapturedPieces({ pieces, capturedColor, advantage }: {
  readonly pieces: readonly PieceType[];
  readonly capturedColor: Color;
  /** The material edge in pawns, or null when this side is not ahead. */
  readonly advantage: number | null;
}) {
  const style = usePieceStyle();
  if (pieces.length === 0 && advantage === null) return null;
  const label = `${pieces.length === 0 ? 'No captures yet' : `Captured: ${pieces.map(piece => PIECE_LABELS[piece]).join(', ')}`}${advantage === null ? '' : `. Up ${advantage}`}`;
  return <div className="captured-pieces" role="img" aria-label={label}>
    {pieces.map((piece, index) => <img key={index} alt="" src={pieceImage(capturedColor, piece, style)} />)}
    {advantage !== null && <span className="material-advantage">+{advantage}</span>}
  </div>;
}
