export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type File = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';
export type Rank = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
export type Square = `${File}${Rank}`;
export type Promotion = 'q' | 'r' | 'b' | 'n';
export const POSITION_BRAND: unique symbol = Symbol('rules-position');
export const REPETITION_LEDGER_BRAND: unique symbol = Symbol('rules-repetition-ledger');

export interface PieceOnSquare {
  readonly square: Square;
  readonly color: Color;
  readonly type: PieceType;
}

export interface Position {
  readonly [POSITION_BRAND]: true;
  readonly fen: string;
  readonly placement: string;
  readonly pieces: readonly PieceOnSquare[];
  readonly sideToMove: Color;
  readonly castlingRights: string;
  readonly enPassantSquare: Square | null;
  readonly halfmoveClock: string;
  readonly fullmoveNumber: string;
}

export interface CoordinateMove {
  readonly from: Square;
  readonly to: Square;
  readonly promotion?: Promotion;
}

export type PositionField =
  | 'fen'
  | 'placement'
  | 'sideToMove'
  | 'castlingRights'
  | 'enPassantSquare'
  | 'halfmoveClock'
  | 'fullmoveNumber'
  | 'consistency';

export interface PositionValidationIssue {
  readonly field: PositionField;
  readonly code: string;
  readonly message: string;
  readonly square?: Square;
}
