import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ControllerSnapshotV1 } from '../controller/index.js';
import { parsePosition } from '../rules/index.js';

interface Cursor { gameId: string; lineId: string; ply: number }

/** A display cursor never changes the controller's live position or clocks. */
export function useBoardHistory(snapshot: ControllerSnapshotV1, keyboardEnabled: boolean) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const { gameId, rules, archive } = snapshot.checkpoint;
  const lineId = archive.currentLine.lineId;
  const count = rules.moves.length;
  const ply = cursor?.gameId === gameId && cursor.lineId === lineId ? Math.min(cursor.ply, count) : count;
  const reviewing = ply < count;
  const selectedMove = ply > 0 ? rules.moves[ply - 1] ?? null : null;
  const fen = reviewing ? selectedMove?.fenAfter ?? rules.startingFen : snapshot.position.fen;
  const position = useMemo(() => parsePosition(fen), [fen]);
  const select = useCallback((next: number) => {
    const bounded = Math.max(0, Math.min(next, count));
    setCursor(bounded === count ? null : { gameId, lineId, ply: bounded });
  }, [count, gameId, lineId]);

  useEffect(() => {
    if (!keyboardEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="spinbutton"], [role="dialog"]')) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      select(event.key === 'Home' ? 0 : event.key === 'End' ? count : ply + (event.key === 'ArrowLeft' ? -1 : 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboardEnabled, count, ply, select]);

  return { count, ply, reviewing, position, lastMove: selectedMove, select };
}
