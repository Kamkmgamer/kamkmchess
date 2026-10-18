import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parsePosition } from '../rules/position';
import { OpeningPreview } from './OpeningPreview';
import { defaultSetup } from './game-setup';
import { GameNavigation } from './GameNavigation';

describe('landing integration with the playable workspace', () => {
  it('links the primary play action to the existing game', () => {
    const markup = renderToStaticMarkup(<GameNavigation onOptions={() => {}} onNavigate={() => {}} onAppearance={() => {}} />);
    expect(markup).toMatch(/<a[^>]+href="\/play"[^>]*>[\s\S]*?Play against AI/);
  });

  it('shows a validated custom position without enabling opening replay', () => {
    const position = parsePosition('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
    const markup = renderToStaticMarkup(<OpeningPreview setup={{ ...defaultSetup, humanColor: 'b', start: { kind: 'custom', position } }} onOptions={() => {}} />);
    expect(markup.match(/class="board-square"/g)).toHaveLength(64);
    expect(markup).toContain('You play Black');
    expect(markup).toContain('Black to move');
    expect(markup).toContain('This position is checkmate.');
    expect(markup).not.toContain('Next move');
  });
});
