import { BOARD_STYLES, setBoardStyle } from './board-style.js';
import { useBoardStyle } from './use-board-style.js';
import './board-style-options.css';

export function BoardStyleOptions() {
  const style = useBoardStyle();
  const palette = BOARD_STYLES[style];
  return <div className="board-style-options">
    <label>Board style
      <select value={style} onChange={event => setBoardStyle(event.target.value)}>
        {Object.entries(BOARD_STYLES).map(([id, { label }]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
    <div className="board-style-preview" role="img" aria-label={`${palette.label} board`}
      style={{ backgroundColor: palette.light, backgroundImage: `conic-gradient(${palette.dark} 25%, transparent 0 50%, ${palette.dark} 0 75%, transparent 0)` }}>
      <span className="board-style-swatch" style={{ backgroundImage: `radial-gradient(${palette.dest} 30%, transparent 32%)` }} />
    </div>
  </div>;
}
