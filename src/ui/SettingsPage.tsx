import type { ReactNode } from 'react';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { pieceImage } from './piece-image.js';
import type { Color, PieceType } from '../rules/index.js';
import { BOARD_STYLES, isBoardStyle, setBoardStyle } from './board-style.js';
import { useBoardStyle } from './use-board-style.js';
import { isPieceStyle, PIECE_STYLES, setPieceStyle } from './piece-style.js';
import { usePieceStyle } from './use-piece-style.js';
import { T3_PALETTES } from './t3-palettes.js';
import './settings-page.css';

const PREVIEW_FEN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const PREVIEW_LAST_MOVE = new Set(['f8', 'c5']);
const FILES = 'abcdefgh';
const BOARD_STYLE_IDS = Object.keys(BOARD_STYLES).filter(isBoardStyle);
const PIECE_STYLE_IDS = Object.keys(PIECE_STYLES).filter(isPieceStyle);
const APPEARANCES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

/** The placement field of a FEN becomes a flat 64-square list of piece letters. */
function parsePlacement(fen: string): (string | null)[] {
  const squares: (string | null)[] = [];
  for (const character of fen.split(' ')[0] ?? '') {
    if (character === '/') continue;
    const empty = Number(character);
    if (Number.isInteger(empty)) for (let index = 0; index < empty; index += 1) squares.push(null);
    else squares.push(character);
  }
  return squares;
}

const PREVIEW_PIECES = parsePlacement(PREVIEW_FEN);

type FenPiece = { readonly color: Color; readonly type: PieceType };
const FEN_PIECES: Record<string, FenPiece> = {
  K: { color: 'w', type: 'k' }, Q: { color: 'w', type: 'q' }, R: { color: 'w', type: 'r' },
  B: { color: 'w', type: 'b' }, N: { color: 'w', type: 'n' }, P: { color: 'w', type: 'p' },
  k: { color: 'b', type: 'k' }, q: { color: 'b', type: 'q' }, r: { color: 'b', type: 'r' },
  b: { color: 'b', type: 'b' }, n: { color: 'b', type: 'n' }, p: { color: 'b', type: 'p' },
};

function systemIsDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveAppearance(appearance: string): 'light' | 'dark' {
  return appearance === 'dark' || (appearance === 'system' && systemIsDark()) ? 'dark' : 'light';
}

function paletteColors(palette: (typeof T3_PALETTES)[number], resolved: 'light' | 'dark') {
  return resolved === 'dark' && 'variants' in palette && 'dark' in palette.variants ? palette.variants.dark : palette.colors;
}

function SettingTile({ group, value, checked, onPick, label, children }: {
  readonly group: string; readonly value: string; readonly checked: boolean;
  readonly onPick: (value: string) => void; readonly label: string; readonly children: ReactNode;
}) {
  return <label className="settings-tile">
    <input className="settings-radio-input" type="radio" name={group} value={value} checked={checked} onChange={() => onPick(value)} />
    {children}
    <span className="settings-tile-label">{label}</span>
    <span className="settings-tile-check"><Icon name="check" /></span>
  </label>;
}

export function SettingsPage({ theme, appearance, sound, onTheme, onAppearance, onSound, game }: {
  readonly theme: string; readonly appearance: string; readonly sound: boolean;
  readonly onTheme: (id: string) => void; readonly onAppearance: (value: string) => void; readonly onSound: (enabled: boolean) => void;
  readonly game?: { readonly onPosition: () => void; readonly onArchive: () => void; readonly onDownload: () => void };
}) {
  const boardStyle = useBoardStyle();
  const pieceStyle = usePieceStyle();
  const resolved = resolveAppearance(appearance);
  const themePalette = T3_PALETTES.find(palette => palette.id === theme);
  const appearanceLabel = APPEARANCES.find(option => option.value === appearance)?.label ?? appearance;
  const actions: { readonly icon: IconName; readonly label: string; readonly title: string; readonly description: string; readonly onClick: () => void }[] = game ? [
    { icon: 'board', label: 'Position', title: 'Position', description: 'Copy the FEN or start a new game from here', onClick: game.onPosition },
    { icon: 'archive', label: 'Conversation and archive', title: 'Conversation and archive', description: "Read the model's reasoning for this game", onClick: game.onArchive },
    { icon: 'download', label: 'Download game (JSON)', title: 'Download game', description: 'Save the full game as JSON', onClick: game.onDownload },
  ] : [];

  return <div className="settings-layout">
    <section className="settings-card settings-preview" aria-labelledby="settings-preview-heading">
      <h3 id="settings-preview-heading">Preview</h3>
      <div className="settings-preview-board" role="img" aria-label={`Preview: ${BOARD_STYLES[boardStyle].label} board, ${PIECE_STYLES[pieceStyle].label} pieces`}>
        {PREVIEW_PIECES.map((letter, index) => {
          const row = Math.floor(index / 8);
          const column = index % 8;
          const square = `${FILES[column]}${8 - row}`;
          const light = (row + column) % 2 === 0;
          const piece = letter === null ? null : FEN_PIECES[letter] ?? null;
          return <span key={square} className={`preview-square ${light ? 'light' : 'dark'}${PREVIEW_LAST_MOVE.has(square) ? ' last-move' : ''}`}>
            {piece && <img src={pieceImage(piece.color, piece.type, pieceStyle)} alt="" />}
            {column === 0 && <span className="preview-coord preview-rank">{8 - row}</span>}
            {row === 7 && <span className="preview-coord preview-file">{FILES[column]}</span>}
          </span>;
        })}
      </div>
      <p className="preview-caption">{BOARD_STYLES[boardStyle].label} board · {PIECE_STYLES[pieceStyle].label} pieces</p>
      <p className="preview-caption dim">{themePalette?.label ?? theme} theme · {appearanceLabel}</p>
    </section>
    <div className="settings-stack">
      <section className="settings-card" aria-labelledby="settings-board-heading">
        <div className="settings-card-heading"><h3 id="settings-board-heading">Board style</h3><p className="settings-card-desc">Square and highlight colours.</p></div>
        <div className="settings-tiles" role="radiogroup" aria-labelledby="settings-board-heading">
          {BOARD_STYLE_IDS.map(id => <SettingTile key={id} group="settings-board-style" value={id} label={BOARD_STYLES[id].label} checked={boardStyle === id} onPick={setBoardStyle}>
            <span className="settings-tile-checker" style={{ backgroundColor: BOARD_STYLES[id].light, backgroundImage: `conic-gradient(${BOARD_STYLES[id].dark} 25%, transparent 0 50%, ${BOARD_STYLES[id].dark} 0 75%, transparent 0)` }} />
          </SettingTile>)}
        </div>
      </section>
      <section className="settings-card" aria-labelledby="settings-piece-heading">
        <div className="settings-card-heading"><h3 id="settings-piece-heading">Piece style</h3><p className="settings-card-desc">The artwork used on every board.</p></div>
        <div className="settings-tiles" role="radiogroup" aria-labelledby="settings-piece-heading">
          {PIECE_STYLE_IDS.map(id => <SettingTile key={id} group="settings-piece-style" value={id} label={PIECE_STYLES[id].label} checked={pieceStyle === id} onPick={setPieceStyle}>
            <span className="settings-tile-pieces">
              <span className="tile-piece-square light"><img src={pieceImage('w', 'k', id)} alt="" /></span>
              <span className="tile-piece-square dark"><img src={pieceImage('b', 'n', id)} alt="" /></span>
            </span>
          </SettingTile>)}
        </div>
        <p className="settings-piece-credit">{PIECE_STYLES[pieceStyle].label} by {PIECE_STYLES[pieceStyle].artist}</p>
      </section>
      <section className="settings-card" aria-labelledby="settings-theme-heading">
        <div className="settings-card-heading"><h3 id="settings-theme-heading">Theme</h3><p className="settings-card-desc">The palette for the whole app.</p></div>
        <div className="settings-tiles" role="radiogroup" aria-labelledby="settings-theme-heading">
          {T3_PALETTES.map(palette => {
            const colors = paletteColors(palette, resolved);
            const sidebar = colors.sidebar;
            return <SettingTile key={palette.id} group="settings-theme" value={palette.id} label={palette.label} checked={theme === palette.id} onPick={onTheme}>
              <span className="settings-tile-theme" style={{ backgroundColor: colors.canvas, borderColor: colors.border }}>
                <span className="tile-theme-sidebar" style={{ backgroundColor: sidebar }} />
                <span className="tile-theme-main">
                  <span className="tile-theme-bar" style={{ backgroundColor: colors.text, width: '60%' }} />
                  <span className="tile-theme-bar" style={{ backgroundColor: colors.textMuted, width: '40%' }} />
                </span>
                <span className="tile-theme-accent" style={{ backgroundColor: colors.accent }} />
              </span>
            </SettingTile>;
          })}
        </div>
        <div className="settings-appearance">
          <p className="settings-appearance-label" id="settings-appearance-label">Appearance</p>
          <div className="settings-segments" role="radiogroup" aria-labelledby="settings-appearance-label">
            {APPEARANCES.map(option => <label key={option.value} className="settings-segment">
              <input className="settings-radio-input" type="radio" name="settings-appearance" value={option.value} checked={appearance === option.value} onChange={() => onAppearance(option.value)} />
              {option.label}
            </label>)}
          </div>
        </div>
      </section>
      <section className="settings-card" aria-labelledby="settings-sound-heading">
        <h3 id="settings-sound-heading">Sound</h3>
        <div className="settings-sound">
          <div><p className="settings-sound-title">Move sounds</p><p className="settings-card-desc">Play a sound when a move lands.</p></div>
          <button type="button" className="settings-switch" role="switch" aria-checked={sound} aria-label="Sound" onClick={() => onSound(!sound)}><span className="settings-switch-knob" /></button>
        </div>
      </section>
      {game && <section className="settings-card" aria-labelledby="settings-game-heading">
        <h3 id="settings-game-heading">This game</h3>
        <div className="settings-actions">
          {actions.map(action => <button key={action.label} type="button" className="settings-action" aria-label={action.label} onClick={action.onClick}>
            <span className="settings-action-icon"><Icon name={action.icon} /></span>
            <span className="settings-action-text"><span className="settings-action-title">{action.title}</span><span className="settings-action-desc">{action.description}</span></span>
            <span className="settings-action-next"><Icon name="next" /></span>
          </button>)}
        </div>
      </section>}
    </div>
  </div>;
}
