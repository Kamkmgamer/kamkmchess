import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from './SettingsPage.js';
import { T3_PALETTES } from './t3-palettes.js';

const noop = () => undefined;

function render(props: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  return renderToStaticMarkup(<SettingsPage theme="screen" appearance="dark" sound={true}
    onTheme={noop} onAppearance={noop} onSound={noop}
    game={{ onPosition: noop, onArchive: noop, onDownload: noop }} {...props} />);
}

describe('settings page', () => {
  it('groups the pickers into labelled radio groups', () => {
    const markup = render();
    for (const [id, label] of [['settings-board-heading', 'Board style'], ['settings-piece-heading', 'Piece style'], ['settings-theme-heading', 'Theme'], ['settings-appearance-label', 'Appearance']] as const) {
      expect(markup).toContain(`role="radiogroup" aria-labelledby="${id}"`);
      expect(markup).toContain(`id="${id}">${label}<`);
    }
  });

  it('offers every board, piece and theme option as a radio', () => {
    const markup = render();
    expect(markup.match(/name="settings-board-style"/g)).toHaveLength(5);
    expect(markup.match(/name="settings-piece-style"/g)).toHaveLength(5);
    expect(markup.match(/name="settings-theme"/g)).toHaveLength(T3_PALETTES.length);
    expect(markup.match(/name="settings-appearance"/g)).toHaveLength(3);
  });

  it('checks the current board, piece, theme and appearance', () => {
    const markup = render();
    for (const value of ['green', 'merida', 'screen', 'dark']) {
      expect(markup).toMatch(new RegExp(`<input(?=[^>]*checked="")(?=[^>]*value="${value}")[^>]*`));
    }
  });

  it('credits the selected piece set outside the tile labels', () => {
    const markup = render();
    expect(markup).toContain('Merida by Armando Hernandez Marroquin');
  });

  it('renders a full-board preview in the current styles', () => {
    const markup = render();
    const start = markup.indexOf('settings-preview-board');
    const preview = markup.slice(start, markup.indexOf('</div>', start));
    expect(preview.match(/<img /g)).toHaveLength(32);
    expect(markup).toContain('Preview: Green board, Merida pieces');
  });

  it('exposes sound as a switch and the game actions under their exact names', () => {
    const markup = render();
    expect(markup).toContain('role="switch" aria-checked="true" aria-label="Sound"');
    expect(markup).toContain('aria-label="Position"');
    expect(markup).toContain('aria-label="Conversation and archive"');
    expect(markup).toContain('aria-label="Download game (JSON)"');
    const withoutGame = renderToStaticMarkup(<SettingsPage theme="screen" appearance="dark" sound={true}
      onTheme={noop} onAppearance={noop} onSound={noop} />);
    expect(withoutGame).not.toContain('This game');
  });
});
