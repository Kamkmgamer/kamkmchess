import { useEffect, useSyncExternalStore } from 'react';
import { applyBoardStyle, DEFAULT_BOARD_STYLE, getBoardStyle, subscribeBoardStyle } from './board-style.js';

export function useBoardStyle() {
  const style = useSyncExternalStore(subscribeBoardStyle, getBoardStyle, () => DEFAULT_BOARD_STYLE);
  useEffect(() => { applyBoardStyle(style); }, [style]);
  return style;
}
