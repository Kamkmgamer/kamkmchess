import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parsePosition } from '../rules/position';
import { OpeningPreview } from './OpeningPreview';
import { defaultSetup } from './game-setup';
import { GameNavigation } from './GameNavigation';

describe('landing integration with the playable workspace', () => {
  it('links the primary play action to the existing game', () => {
    const markup = renderToStaticMarkup(<GameNavigation onOptions={() => {}} onNavigate={() => {}} onAppearance={() => {}} account={{ status: 'disabled', user: null, busy: false, message: '' }} onAccount={() => {}} />);
    expect(markup).toMatch(/<button[^>]*>[\s\S]*?AI opponent/);
    expect(markup).not.toContain('Opponent label');
    expect(markup).not.toContain('Preview options');
  });

  it('shows the signed-in account in the settings control', () => {
    const markup = renderToStaticMarkup(<GameNavigation onOptions={() => {}} onNavigate={() => {}} onAppearance={() => {}}
      account={{ status: 'ready', user: { name: 'Alex Player', email: 'alex@example.com', imageUrl: 'https://img.clerk.com/avatar.png' }, busy: false, message: '' }} onAccount={() => {}} />);
    expect(markup).toContain('Alex Player');
    expect(markup).toContain('alex@example.com');
    expect(markup).toContain('aria-label="Account settings"');
    expect(markup).not.toContain('Guest player');
    expect(markup).not.toContain('aria-label="Game settings"');
  });

  it('shows a finished custom position with the demo players and result', () => {
    const position = parsePosition('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
    const markup = renderToStaticMarkup(<OpeningPreview setup={{ ...defaultSetup, humanColor: 'b', start: { kind: 'custom', position } }} onOptions={() => {}} />);
    expect(markup.match(/class="board-square"/g)).toHaveLength(64);
    expect(markup).toContain('Stockfish 19');
    expect(markup).toContain('GPT-6.9-Astra');
    expect(markup).toContain('alt="Stockfish logo"');
    expect(markup).toContain('alt="ChatGPT logo"');
    expect(markup).toContain('Black at the bottom');
    expect(markup).toContain('White wins by checkmate.');
    expect(markup).not.toContain('Next move');
  });
});
