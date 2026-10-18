import { describe, expect, it } from 'vitest';
import { parsePosition } from '../rules/index.js';
import { editPositionFen, movePositionPiece, positionSetupError, readEditorPieces, setPositionSideToMove } from './position-editor.js';

describe('visual position editor', () => {
  it('moves pieces freely without treating an edit as a played pawn move', () => {
    const standard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const edited = movePositionPiece(standard, 'e2', 'e4');
    expect(edited).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1');
    expect(parsePosition(edited).pieces).toContainEqual({ square: 'e4', color: 'w', type: 'p' });
  });

  it('removes stale castling rights when a rook is moved or replaced', () => {
    const standard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(movePositionPiece(standard, 'h1', 'h3').split(' ')[2]).toBe('Qkq');
    expect(movePositionPiece(standard, 'a1', 'a8').split(' ')[2]).toBe('Kk');
  });
  it('identifies the field and square of an invalid custom FEN', () => {
    try {
      parsePosition('4k3/8/8/8/8/8/8/4KK2 w - - 0 1');
      throw new Error('Expected an invalid position');
    } catch (error) {
      expect(positionSetupError(error)).toBe('piece placement, square f1: The board cannot contain extra white kings.');
    }
    try {
      parsePosition('4k3/8/8/8/8/8/8/4K3 w X - 0 1');
      throw new Error('Expected invalid castling rights');
    } catch (error) {
      expect(positionSetupError(error)).toContain('castling rights:');
    }
  });
  it('places and removes pieces, clearing rights made stale by visual edits', () => {
    const standard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const edited = editPositionFen(standard, 'a2', 'empty');
    expect(edited).toBe('rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w - - 0 1');
    expect(parsePosition(editPositionFen(edited, 'e4', 'bq')).pieces).toContainEqual({ square: 'e4', color: 'b', type: 'q' });
    expect(parsePosition(editPositionFen(edited, 'e4', 'empty')).pieces.some((piece) => piece.square === 'e4')).toBe(false);
  });

  it('changes the side to move without discarding castling rights or move counters', () => {
    const edited = setPositionSideToMove('4k3/8/8/8/8/8/8/4K3 w - - 17 9', 'b');
    expect(edited).toBe('4k3/8/8/8/8/8/8/4K3 b - - 17 9');
    const standard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 17 42';
    expect(setPositionSideToMove(standard, 'b')).toBe(standard.replace(' w ', ' b '));
    const enPassant = '4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 12';
    expect(setPositionSideToMove(enPassant, 'w')).toBe('4k3/8/8/8/3pP3/8/8/4K3 w - - 0 12');
    expect(setPositionSideToMove(enPassant, 'b')).toBe(enPassant);
    expect(() => editPositionFen('invalid FEN', 'e4', 'wp')).toThrow();
  });

  it('allows multi-step edits while the position is temporarily invalid', () => {
    const sparse = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    const kingRemoved = editPositionFen(sparse, 'e1', 'empty');
    expect(readEditorPieces(kingRemoved)).toHaveLength(1);
    const kingReplaced = editPositionFen(kingRemoved, 'd1', 'wk');
    expect(parsePosition(kingReplaced).pieces).toContainEqual({ square: 'd1', color: 'w', type: 'k' });
  });
});
