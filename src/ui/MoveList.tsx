import { useLayoutEffect, useRef } from 'react';
import type { AppliedMoveV1 } from '../storage/index.js';

interface Props {
  readonly moves: readonly AppliedMoveV1[];
  readonly selectedPly: number;
  readonly visible: boolean;
  readonly onSelect: (ply: number) => void;
}
interface Entry { move: AppliedMoveV1; ply: number }
interface Row { number: string; white?: Entry; black?: Entry }

/** Review follows a display cursor; selecting a move never changes the live game. */
export function MoveList({ moves, selectedPly, visible, onSelect }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const rows: Row[] = [];
  for (const [index, move] of moves.entries()) {
    const [, side, , , , number = '1'] = move.fenBefore.split(' ');
    let row = rows.at(-1);
    if (side === 'w' || !row || row.number !== number) {
      row = { number }; rows.push(row);
    }
    row[side === 'w' ? 'white' : 'black'] = { move, ply: index + 1 };
  }

  useLayoutEffect(() => {
    const container = scroll.current;
    if (!visible || !container) return;
    const follow = () => {
      const selected = container.querySelector('[aria-current="step"]');
      if (!selected) { if (selectedPly === 0) container.scrollTop = 0; return; }
      const bounds = container.getBoundingClientRect();
      const target = selected.getBoundingClientRect();
      if (target.top < bounds.top) container.scrollTop -= bounds.top - target.top + 4;
      else if (target.bottom > bounds.bottom) container.scrollTop += target.bottom - bounds.bottom + 4;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(container);
    return () => observer.disconnect();
  }, [selectedPly, moves.length, visible]);

  return <div className="move-scroll" ref={scroll}>
    <table className="move-list" aria-label="Committed moves">
      <colgroup><col className="move-number-column" /><col /><col /></colgroup>
      <thead className="sr-only"><tr><th scope="col">Move</th><th scope="col">White</th><th scope="col">Black</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.white?.move.moveId ?? row.black?.move.moveId ?? index}>
        <th scope="row" title={row.number}>{row.number}.</th>
        {(['white', 'black'] as const).map(side => {
          const entry = row[side];
          return <td key={side}>{entry && <button type="button" aria-label={`View move ${entry.ply}: ${entry.move.san}`}
            aria-current={selectedPly === entry.ply ? 'step' : undefined} onClick={() => onSelect(entry.ply)}>{entry.move.san}</button>}</td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}
