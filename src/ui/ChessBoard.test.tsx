import { Chess } from 'chess.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChessBoard } from './ChessBoard';

describe('board preview orientation', () => {
  it.each([
    { orientation: 'w', firstRank: '8', firstPieceSide: 'b' },
    { orientation: 'b', firstRank: '1', firstPieceSide: 'w' },
  ] satisfies { orientation: 'w' | 'b'; firstRank: string; firstPieceSide: string }[])('keeps piece and coordinate placement correct from $orientation', ({ orientation, firstRank, firstPieceSide }) => {
    const markup = renderToStaticMarkup(<ChessBoard board={new Chess().board()} orientation={orientation} lastMove={null} label="Starting position" />);
    expect(markup.match(/class="board-square"/g)).toHaveLength(64);
    const firstSquare = markup.match(/class="board-square"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    expect(firstSquare).toContain(`class="rank-label">${firstRank}</span>`);
    expect(firstSquare).toContain(`data-side="${firstPieceSide}"`);
  });
});
