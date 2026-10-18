import { isSquareAttackedInFen } from './chess-adapter.js';
import {
  POSITION_BRAND,
  type Color,
  type File,
  type PieceOnSquare,
  type PieceType,
  type Position,
  type PositionField,
  type PositionValidationIssue,
  type Rank,
  type Square,
} from './types.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const satisfies readonly File[];
const RIGHTS = 'KQkq';

interface ParsedPlacement {
  readonly pieces: readonly PieceOnSquare[];
  readonly board: ReadonlyMap<Square, PieceOnSquare>;
  readonly whiteKing: Square;
  readonly blackKing: Square;
}

export class PositionValidationError extends Error {
  readonly issues: readonly PositionValidationIssue[];

  constructor(issue: PositionValidationIssue) {
    super(issue.message);
    this.name = 'PositionValidationError';
    this.issues = Object.freeze([Object.freeze(issue)]);
  }
}

function reject(
  field: PositionField,
  code: string,
  message: string,
  square?: Square,
): never {
  const issue = square === undefined ? { field, code, message } : { field, code, message, square };
  throw new PositionValidationError(issue);
}

function squareAt(fileIndex: number, rowIndex: number): Square {
  const file = FILES[fileIndex];
  if (file === undefined) throw new Error('Invalid board file index');
  return `${file}${8 - rowIndex}` as Square;
}

function parsePlacement(placement: string): ParsedPlacement {
  const ranks = placement.split('/');
  if (ranks.length !== 8) {
    return reject('placement', 'rank-count', 'Piece placement must contain exactly eight ranks.');
  }

  const pieces: PieceOnSquare[] = [];
  const board = new Map<Square, PieceOnSquare>();

  ranks.forEach((rankText, rowIndex) => {
    let fileIndex = 0;
    let previousWasDigit = false;

    for (const token of rankText) {
      if (/^[1-8]$/.test(token)) {
        if (previousWasDigit) {
          reject(
            'placement',
            'adjacent-empty-runs',
            'Adjacent empty-square counts are not valid FEN.',
            squareAt(Math.min(fileIndex, 7), rowIndex),
          );
        }
        fileIndex += Number(token);
        previousWasDigit = true;
        if (fileIndex > 8) {
          reject('placement', 'rank-overflow', 'A rank cannot contain more than eight squares.', squareAt(7, rowIndex));
        }
        continue;
      }

      if (!/^[pnbrqkPNBRQK]$/.test(token)) {
        reject('placement', 'piece-symbol', `Unknown piece symbol '${token}'.`);
      }

      if (fileIndex >= 8) {
        reject('placement', 'rank-overflow', 'A rank cannot contain more than eight squares.', squareAt(7, rowIndex));
      }
      const square = squareAt(fileIndex, rowIndex);
      const type = token.toLowerCase() as PieceType;
      const color: Color = token === token.toUpperCase() ? 'w' : 'b';
      const piece = Object.freeze({ square, color, type });
      pieces.push(piece);
      board.set(square, piece);
      fileIndex += 1;
      previousWasDigit = false;

      if (fileIndex > 8) {
        reject('placement', 'rank-overflow', 'A rank cannot contain more than eight squares.', square);
      }
    }

    if (fileIndex !== 8) {
      reject(
        'placement',
        'rank-width',
        `Rank ${8 - rowIndex} must describe exactly eight squares.`,
        squareAt(Math.min(fileIndex, 7), rowIndex),
      );
    }
  });

  const whiteKings = pieces.filter((piece) => piece.color === 'w' && piece.type === 'k');
  const blackKings = pieces.filter((piece) => piece.color === 'b' && piece.type === 'k');
  if (whiteKings.length !== 1) {
    reject(
      'placement',
      'white-king-count',
      whiteKings.length === 0 ? 'The board must contain one white king.' : 'The board cannot contain extra white kings.',
      whiteKings[1]?.square,
    );
  }
  if (blackKings.length !== 1) {
    reject(
      'placement',
      'black-king-count',
      blackKings.length === 0 ? 'The board must contain one black king.' : 'The board cannot contain extra black kings.',
      blackKings[1]?.square,
    );
  }

  for (const piece of pieces) {
    if (piece.type === 'p' && (piece.square[1] === '1' || piece.square[1] === '8')) {
      reject('placement', 'pawn-back-rank', 'Pawns cannot occupy rank 1 or rank 8.', piece.square);
    }
  }

  const whiteKing = whiteKings[0];
  const blackKing = blackKings[0];
  if (whiteKing === undefined || blackKing === undefined) {
    return reject('placement', 'king-count', 'The board must contain one king of each color.');
  }

  const fileDistance = Math.abs(whiteKing.square.charCodeAt(0) - blackKing.square.charCodeAt(0));
  const rankDistance = Math.abs(Number(whiteKing.square[1]) - Number(blackKing.square[1]));
  if (fileDistance <= 1 && rankDistance <= 1) {
    reject('placement', 'adjacent-kings', 'Kings cannot occupy adjacent squares.', whiteKing.square);
  }

  return { pieces: Object.freeze(pieces), board, whiteKing: whiteKing.square, blackKing: blackKing.square };
}

function parseCastlingRights(rights: string, board: ReadonlyMap<Square, PieceOnSquare>): string {
  if (rights === '-') return rights;
  if (rights.length === 0 || !/^[KQkq]+$/.test(rights)) {
    return reject('castlingRights', 'syntax', 'Castling rights must be -, or a subset of KQkq.');
  }

  if (new Set(rights).size !== rights.length) {
    return reject('castlingRights', 'duplicate-right', 'Castling rights cannot repeat a flag.');
  }
  const expectedOrder = [...RIGHTS].filter((right) => rights.includes(right)).join('');
  if (rights !== expectedOrder) {
    return reject('castlingRights', 'order', 'Castling rights must use KQkq order.');
  }

  const homeSquares: Readonly<Record<string, { king: Square; rook: Square; color: Color }>> = {
    K: { king: 'e1', rook: 'h1', color: 'w' },
    Q: { king: 'e1', rook: 'a1', color: 'w' },
    k: { king: 'e8', rook: 'h8', color: 'b' },
    q: { king: 'e8', rook: 'a8', color: 'b' },
  };

  for (const right of rights) {
    const home = homeSquares[right];
    if (home === undefined) {
      return reject('castlingRights', 'unknown-right', `Unknown castling right '${right}'.`);
    }
    const king = board.get(home.king);
    if (king?.color !== home.color || king.type !== 'k') {
      reject('castlingRights', 'king-not-home', `Castling right ${right} requires the ${home.color === 'w' ? 'white' : 'black'} king on ${home.king}.`, home.king);
    }
    const rook = board.get(home.rook);
    if (rook?.color !== home.color || rook.type !== 'r') {
      reject('castlingRights', 'rook-not-home', `Castling right ${right} requires a same-color rook on ${home.rook}.`, home.rook);
    }
  }

  return rights;
}

function parseCounter(value: string, field: 'halfmoveClock' | 'fullmoveNumber'): bigint {
  if (!/^\d+$/.test(value)) {
    return reject(field, 'integer-syntax', 'Counter must contain decimal digits only.');
  }
  const number = BigInt(value);
  if (field === 'fullmoveNumber' && number === 0n) {
    return reject(field, 'positive', 'Fullmove number must be at least 1.');
  }
  return number;
}

function parseEnPassant(
  value: string,
  sideToMove: Color,
  board: ReadonlyMap<Square, PieceOnSquare>,
  halfmoveClock: bigint,
  fullmoveNumber: bigint,
): Square | null {
  if (value === '-') return null;
  if (!/^[a-h][1-8]$/.test(value)) {
    return reject('enPassantSquare', 'syntax', 'En passant must be -, or a file and rank square.');
  }

  const square = value as Square;
  const requiredRank: Rank = sideToMove === 'w' ? '6' : '3';
  if (square[1] !== requiredRank) {
    reject(
      'enPassantSquare',
      'wrong-rank',
      `En-passant target for ${sideToMove === 'w' ? 'White' : 'Black'} to move must be on rank ${requiredRank}.`,
      square,
    );
  }
  if (board.has(square)) {
    reject('enPassantSquare', 'occupied-target', 'The en-passant target square must be empty.', square);
  }

  const file = square[0] as File;
  const pawnRank: Rank = sideToMove === 'w' ? '5' : '4';
  const originRank: Rank = sideToMove === 'w' ? '7' : '2';
  const pawnSquare = `${file}${pawnRank}` as Square;
  const originSquare = `${file}${originRank}` as Square;
  const pushedPawnColor: Color = sideToMove === 'w' ? 'b' : 'w';
  const pawn = board.get(pawnSquare);
  if (pawn?.color !== pushedPawnColor || pawn.type !== 'p') {
    reject(
      'enPassantSquare',
      'missing-pushed-pawn',
      `En-passant target ${square} requires the opposing pawn on ${pawnSquare}.`,
      pawnSquare,
    );
  }
  if (board.has(originSquare)) {
    reject(
      'enPassantSquare',
      'occupied-origin',
      `The pawn's previous square ${originSquare} must be empty.`,
      originSquare,
    );
  }
  if (halfmoveClock !== 0n) {
    reject('halfmoveClock', 'en-passant-counter', 'Halfmove clock must be 0 while an en-passant target is available.');
  }
  if (sideToMove === 'w' && fullmoveNumber < 2n) {
    reject('fullmoveNumber', 'en-passant-counter', 'White cannot have an en-passant target before Black has moved.');
  }

  return square;
}

function freezePosition(fields: {
  fen: string;
  placement: string;
  pieces: readonly PieceOnSquare[];
  sideToMove: Color;
  castlingRights: string;
  enPassantSquare: Square | null;
  halfmoveClock: string;
  fullmoveNumber: string;
}): Position {
  return Object.freeze({ ...fields, [POSITION_BRAND]: true as const });
}

export function parsePosition(fen: string): Position {
  const fields = fen.split(' ');
  if (fields.length !== 6 || fields.some((field) => field.length === 0)) {
    return reject('fen', 'field-count', 'FEN must contain exactly six nonempty fields separated by single spaces.');
  }

  const placement = fields[0];
  const sideField = fields[1];
  const rightsField = fields[2];
  const enPassantField = fields[3];
  const halfmoveField = fields[4];
  const fullmoveField = fields[5];
  if (
    placement === undefined ||
    sideField === undefined ||
    rightsField === undefined ||
    enPassantField === undefined ||
    halfmoveField === undefined ||
    fullmoveField === undefined
  ) {
    return reject('fen', 'field-count', 'FEN must contain exactly six fields.');
  }

  const parsed = parsePlacement(placement);
  if (sideField !== 'w' && sideField !== 'b') {
    return reject('sideToMove', 'syntax', 'Side to move must be w or b.');
  }
  const sideToMove: Color = sideField;
  const castlingRights = parseCastlingRights(rightsField, parsed.board);
  const halfmoveValue = parseCounter(halfmoveField, 'halfmoveClock');
  const fullmoveValue = parseCounter(fullmoveField, 'fullmoveNumber');
  const enPassantSquare = parseEnPassant(
    enPassantField,
    sideToMove,
    parsed.board,
    halfmoveValue,
    fullmoveValue,
  );

  const nonMovingColor: Color = sideToMove === 'w' ? 'b' : 'w';
  const nonMovingKing = nonMovingColor === 'w' ? parsed.whiteKing : parsed.blackKing;
  let nonMovingKingInCheck: boolean;
  try {
    nonMovingKingInCheck = isSquareAttackedInFen(fen, nonMovingKing, sideToMove);
  } catch (error) {
    return reject(
      'placement',
      'library-rejected-position',
      error instanceof Error ? error.message : 'The rules engine rejected the validated position.',
    );
  }

  if (nonMovingKingInCheck) {
    reject(
      'consistency',
      'nonmoving-king-in-check',
      `The ${nonMovingColor === 'w' ? 'white' : 'black'} king cannot be in check when it is not that side's turn.`,
      nonMovingKing,
    );
  }

  return freezePosition({
    fen,
    placement,
    pieces: parsed.pieces,
    sideToMove,
    castlingRights,
    enPassantSquare,
    halfmoveClock: halfmoveField,
    fullmoveNumber: fullmoveField,
  });
}
