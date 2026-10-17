import type { PieceType, Square } from '../rules/index.js';

export type EditorPiece = 'empty' | `w${PieceType}` | `b${PieceType}`;
export interface EditorPieceOnSquare { readonly square: Square; readonly color: 'w' | 'b'; readonly type: PieceType; }

function editorFields(fen: string): string[] {
  const fields = fen.trim().split(/\s+/);
  const placement = fields[0];
  const side = fields[1];
  if (fields.length !== 6 || placement === undefined || (side !== 'w' && side !== 'b')) {
    throw new Error('Enter a six-field FEN with a valid side to move.');
  }
  const ranks = placement.split('/');
  if (ranks.length !== 8 || ranks.some((rank) => {
    let files = 0;
    for (const token of rank) {
      if (/^[1-8]$/.test(token)) files += Number(token);
      else if (/^[prnbqkPRNBQK]$/.test(token)) files += 1;
      else return true;
    }
    return files !== 8;
  })) throw new Error('The piece placement must contain eight valid ranks.');
  return fields;
}

export function readEditorPieces(fen: string): EditorPieceOnSquare[] {
  const placement = editorFields(fen)[0];
  if (placement === undefined) return [];
  const pieces: EditorPieceOnSquare[] = [];
  for (const [rankIndex, rank] of placement.split('/').entries()) {
    let fileIndex = 0;
    for (const token of rank) {
      if (/^[1-8]$/.test(token)) fileIndex += Number(token);
      else {
        const file = 'abcdefgh'[fileIndex];
        const rankName = String(8 - rankIndex);
        if (file !== undefined) pieces.push({ square: (file + rankName) as Square,
          color: token === token.toUpperCase() ? 'w' : 'b', type: token.toLowerCase() as PieceType });
        fileIndex += 1;
      }
    }
  }
  return pieces;
}

export function editorSideToMove(fen: string): 'w' | 'b' {
  return editorFields(fen)[1] as 'w' | 'b';
}

export function setPositionSideToMove(fen: string, side: 'w' | 'b'): string {
  const fields = editorFields(fen);
  // An en-passant target belongs to the side that can capture it; it cannot
  // survive a turn change. Castling rights and move counters are independent.
  if (fields[1] !== side) fields[3] = '-';
  fields[1] = side;
  return fields.join(' ');
}

export function editPositionFen(fen: string, square: Square, selected: EditorPiece): string {
  const fields = editorFields(fen);
  const pieces = new Map(readEditorPieces(fen).map((piece) => [piece.square, piece.color === 'w' ? piece.type.toUpperCase() : piece.type]));
  if (selected === 'empty') pieces.delete(square);
  else {
    const color = selected[0];
    const type = selected[1];
    if (color === undefined || type === undefined) throw new Error('Choose a piece to place.');
    pieces.set(square, color === 'w' ? type.toUpperCase() : type);
  }
  const ranks = '87654321'.split('').map((rank) => {
    let empty = 0;
    let encoded = '';
    for (const file of 'abcdefgh') {
      const piece = pieces.get((file + rank) as Square);
      if (piece === undefined) empty += 1;
      else {
        if (empty > 0) encoded += empty;
        encoded += piece;
        empty = 0;
      }
    }
    return encoded + (empty > 0 ? empty : '');
  }).join('/');
  // Piece edits can invalidate castling/en-passant rights, so the visual editor clears them.
  return `${ranks} ${fields[1]} - - 0 1`;
}
