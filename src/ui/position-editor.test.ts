import { describe, expect, it } from 'vitest';
import { parsePosition } from '../rules/index.js';
import { editPositionFen, readEditorPieces, setPositionSideToMove } from './position-editor.js';

describe('visual position editor', () => {
  it('places and removes pieces, clearing rights made stale by visual edits', () => {
    const standard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const edited = editPositionFen(standard, 'a2', 'empty');
    expect(edited).toBe('rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w - - 0 1');
    expect(parsePosition(editPositionFen(edited, 'e4', 'bq')).pieces).toContainEqual({ square: 'e4', color: 'b', type: 'q' });
    expect(parsePosition(editPositionFen(edited, 'e4', 'empty')).pieces.some((piece) => piece.square === 'e4')).toBe(false);
  });

  it('changes the side to move and clears position metadata that no longer applies', () => {
    const edited = setPositionSideToMove('4k3/8/8/8/8/8/8/4K3 w - - 17 9', 'b');
    expect(edited).toBe('4k3/8/8/8/8/8/8/4K3 b - - 0 1');
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
