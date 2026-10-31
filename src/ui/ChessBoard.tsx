import { Icon, IconButton } from './Icon.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import '@lichess-org/chessground/assets/chessground.base.css';
import { legalMoves } from '../rules/index.js';
import type { CoordinateMove, Position, Promotion, Square } from '../rules/index.js';
import { checkedColor, isSquare } from './board-input.js';
import { pieceImage, pieceImageVariables } from './piece-image.js';
import { PROMOTIONS } from './promotion-options.js';
import { usePieceStyle } from './use-piece-style.js';

function squareDescription(position: Position, square: Square): string {
  const piece = position.pieces.find((item) => item.square === square);
  if (!piece) return square + ', empty';
  const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  return square + ', ' + (piece.color === 'w' ? 'White ' : 'Black ') + names[piece.type];
}

/**
 * The board model.
 *
 * The board renders a position and nothing else. The offline workspace and
 * the online workspace both provide this shape, so both use the same board,
 * the same animations and the same keyboard inspection.
 */
export interface BoardModel {
  /** The canonical position of the game. */
  readonly position: Position;
  /**
   * The identity of the game and its line.
   *
   * Queued input is dropped when the identity changes, so a new game, a new
   * line and a new match never keep an input of the previous one.
   */
  readonly identity: string;
}

function destinations(position: Position): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const move of legalMoves(position)) {
    const squares = dests.get(move.from) ?? [];
    if (!squares.includes(move.to)) squares.push(move.to);
    dests.set(move.from, squares);
  }
  return dests;
}

/** A premove waiting in the queue. The promotion piece is chosen at queue time. */
interface QueuedPremove {
  readonly from: Key;
  readonly to: Key;
  readonly promotion?: Promotion;
}

function premoveTailSquares(queue: readonly QueuedPremove[]): Map<Key, string> {
  // The queue head is drawn by Chessground's own premove slot; later entries
  // share its highlight through custom square classes.
  const squares = new Map<Key, string>();
  for (const move of queue.slice(1)) {
    squares.set(move.from, 'current-premove');
    squares.set(move.to, 'current-premove');
  }
  return squares;
}

function syncPremoveDisplay(instance: Api, queue: readonly QueuedPremove[], pending: { readonly from: Key; readonly to: Key } | null): void {
  // Chessground holds a single premove. Point its slot at the queue head so
  // the highlight and play-time validation keep working; a promotion choice
  // that is still open is not queued yet and stays off the board. The slot is
  // not part of the public set() config, but the state is documented as
  // writable at the caller's own risk, and the redraw below renders it.
  const head = pending ? undefined : queue[0];
  if (head) instance.state.premovable.current = [head.from, head.to];
  else delete instance.state.premovable.current;
  instance.set({ highlight: { custom: premoveTailSquares(queue) } });
}

export function ChessBoard({ orientation, model, disabled, visible, onMove, view, premoveColor, allowPremove }: {
  readonly orientation: 'white' | 'black';
  readonly model: BoardModel;
  readonly disabled: boolean;
  readonly visible: boolean;
  readonly onMove: (move: CoordinateMove) => Promise<boolean>;
  readonly view: { readonly position: Position; readonly lastMove: { readonly from: string; readonly to: string } | null };
  readonly premoveColor: 'white' | 'black' | null;
  readonly allowPremove: boolean;
}) {
  const pieceStyle = usePieceStyle();
  const [keyboardOrigin, setKeyboardOrigin] = useState<{ square: Square; fen: string } | null>(null);
  const [premoves, setPremoves] = useState<readonly QueuedPremove[]>([]);
  const [pendingPremovePromotion, setPendingPremovePromotion] = useState<{ readonly from: Key; readonly to: Key } | null>(null);
  const premovesRef = useRef<readonly QueuedPremove[]>([]);
  const pendingPremoveRef = useRef<{ readonly from: Key; readonly to: Key } | null>(null);
  // The premove being submitted right now. Chessground fires move events a
  // tick after playPremove returns, so the queue head must be carried here.
  const playingPremoveRef = useRef<QueuedPremove | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const board = useRef<Api | null>(null);
  const latest = useRef({ model, disabled, onMove, view, premoveColor });
  const fen = view.position.fen;
  const lastMove = view.lastMove;
  const lastFrom = lastMove?.from as Key | undefined;
  const lastTo = lastMove?.to as Key | undefined;

  useLayoutEffect(() => { latest.current = { model, disabled, onMove, view, premoveColor }; }, [model, disabled, onMove, view, premoveColor]);
  const applyQueue = useCallback((next: readonly QueuedPremove[]) => {
    premovesRef.current = next;
    setPremoves(next);
    const instance = board.current;
    if (instance) syncPremoveDisplay(instance, next, pendingPremoveRef.current);
  }, []);
  const clearPremoves = useCallback(() => {
    pendingPremoveRef.current = null;
    setPendingPremovePromotion(null);
    applyQueue([]);
  }, [applyQueue]);
  useEffect(() => {
    if (!host.current) return;
    const instance = Chessground(host.current, {
      fen: latest.current.model.position.fen,
      orientation,
      coordinates: true,
      disableContextMenu: true,
      animation: { enabled: !window.matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 180 },
      movable: {
        free: false,
        showDests: true,
        rookCastle: false,
        events: {
          after: (from, to, metadata) => {
            // Chessground places the piece immediately. Saving must not send
            // the previous FEN back to the board while the transaction runs.
            const current = latest.current;
            instance.set({ movable: { dests: new Map() } });
            const restore = () => {
              if (board.current !== instance) return;
              const { model: shown, disabled: blocked, view: displayed, premoveColor: humanColor } = latest.current;
              const previous = displayed.lastMove;
              instance.set({
                fen: displayed.position.fen,
                turnColor: shown.position.sideToMove === 'w' ? 'white' : 'black',
                lastMove: previous ? [previous.from as Key, previous.to as Key] : [],
              });
              if (!blocked) instance.set({ movable: { color: humanColor ?? (shown.position.sideToMove === 'w' ? 'white' : 'black'), dests: destinations(shown.position) } });
            };
            const discard = () => {
              restore();
              // A rejected premove invalidates every later one: they were
              // queued against positions that never happened.
              if (metadata.premove) clearPremoves();
            };
            if (current.disabled || !isSquare(from) || !isSquare(to)) { restore(); return; }
            // The queued head carries the promotion piece chosen at queue
            // time; it left the queue when the play began.
            const head = metadata.premove ? playingPremoveRef.current : undefined;
            playingPremoveRef.current = null;
            const move: CoordinateMove = head?.promotion ? { from, to, promotion: head.promotion } : { from, to };
            void current.onMove(move).then((accepted) => {
              if (!accepted) discard();
            }).catch(discard);
          },
        },
      },
      draggable: { enabled: true, showGhost: true, distance: 3 },
      premovable: {
        enabled: false,
        showDests: true,
        events: {
          set: (orig, dest) => {
            if (board.current !== instance) return;
            const humanColor = latest.current.premoveColor;
            const piece = instance.state.pieces.get(orig);
            if (humanColor && piece?.role === 'pawn' && piece.color === humanColor &&
              dest[1] === (humanColor === 'white' ? '8' : '1')) {
              // The promotion piece is picked while queueing, before any reply
              // exists to validate against.
              pendingPremoveRef.current = { from: orig, to: dest };
              setPendingPremovePromotion({ from: orig, to: dest });
              syncPremoveDisplay(instance, premovesRef.current, pendingPremoveRef.current);
              return;
            }
            applyQueue([...premovesRef.current, { from: orig, to: dest }]);
          },
          unset: () => {
            if (board.current !== instance) return;
            // Starting a new premove drag clears Chessground's slot first; the
            // queue survives and its head highlight is restored here.
            syncPremoveDisplay(instance, premovesRef.current, pendingPremoveRef.current);
          },
        },
      },
      drawable: { enabled: true, visible: true },
    });
    board.current = instance;
    // Chessground groups Shift and Control together. Pick a distinct brush
    // after its pointer handler starts the drawing, before its first frame.
    const chooseBrush = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const brush = event.altKey ? 'yellow' : event.ctrlKey ? 'blue' : event.shiftKey ? 'red' : 'green';
      requestAnimationFrame(() => {
        if (board.current !== instance) return;
        const drawing = instance.state.drawable.current;
        if (drawing) drawing.brush = brush;
      });
    };
    const element = host.current;
    // React layout changes can move the board without resizing it. Refresh
    // cached coordinates before Chessground handles the next pointer start.
    const refreshBounds = () => instance.state.dom.bounds.clear();
    element.addEventListener('mousedown', refreshBounds, true);
    element.addEventListener('touchstart', refreshBounds, { capture: true, passive: true });
    element.addEventListener('mousedown', chooseBrush, true);
    return () => {
      element.removeEventListener('mousedown', refreshBounds, true);
      element.removeEventListener('touchstart', refreshBounds, true);
      element.removeEventListener('mousedown', chooseBrush, true);
      // Drop the handle first: teardown unsets the premove and its event must
      // not sync a destroyed board.
      board.current = null;
      instance.destroy();
    };
    // Create once; subsequent effects update the stable board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    // Focused tools hide the board. Rebuild its geometry when it returns so
    // Chessground cannot retain the zero-width bounds measured while hidden.
    if (visible) board.current?.redrawAll();
  }, [visible]);

  useEffect(() => {
    // History, Undo, a new game, and match endings invalidate queued input.
    // Resetting the queue on an external identity change is the point of the
    // effect; the board below is reset with it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    clearPremoves();
    board.current?.cancelMove();
  }, [model.identity, premoveColor, clearPremoves]);

  useEffect(() => {
    if (!premoves.length && !pendingPremovePromotion) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearPremoves();
        board.current?.cancelMove();
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [premoves, pendingPremovePromotion, clearPremoves]);

  useEffect(() => {
    board.current?.set({ fen, lastMove: lastFrom && lastTo ? [lastFrom, lastTo] : [], check: checkedColor(view.position) ?? false });
  }, [fen, lastFrom, lastTo, view.position]);
  useEffect(() => {
    const instance = board.current;
    if (!instance) return;
    instance.set({ orientation, turnColor: latest.current.model.position.sideToMove === 'w' ? 'white' : 'black' });
    if (disabled) {
      if (premoveColor) instance.selectSquare(null);
      else instance.cancelMove();
    }
    instance.set({
      movable: {
        color: premoveColor ?? (latest.current.model.position.sideToMove === 'w' ? 'white' : 'black'),
        dests: disabled ? new Map() : destinations(latest.current.model.position),
      },
      premovable: { enabled: premoveColor !== null },
      draggable: { enabled: !disabled || allowPremove },
      selectable: { enabled: !disabled || allowPremove },
    });
    // The queue head plays at once against the fresh legal destinations.
    // Invalid heads are discarded without submitting a controller intent, and
    // a premove that cannot play cancels the rest of the queue: every later
    // entry was premised on positions that never happened.
    if (!disabled && premovesRef.current.length) {
      playingPremoveRef.current = premovesRef.current[0] ?? null;
      if (instance.playPremove()) applyQueue(premovesRef.current.slice(1));
      else { playingPremoveRef.current = null; clearPremoves(); }
    }
  }, [disabled, fen, orientation, premoveColor, allowPremove, applyQueue, clearPremoves]);

  const choosePremovePromotion = (piece: Promotion) => {
    const pending = pendingPremoveRef.current;
    if (!pending) return;
    pendingPremoveRef.current = null;
    setPendingPremovePromotion(null);
    applyQueue([...premovesRef.current, { from: pending.from, to: pending.to, promotion: piece }]);
  };
  const cancelPremovePromotion = () => {
    pendingPremoveRef.current = null;
    setPendingPremovePromotion(null);
    const instance = board.current;
    if (instance) syncPremoveDisplay(instance, premovesRef.current, null);
  };
  const premoveHead = premoves[0];
  const premoveLabel = !premoveHead ? ''
    : premoves.length === 1
      ? `Premove ${premoveHead.from} to ${premoveHead.to} queued.`
      : `Premoves queued: ${premoves.map((move) => `${move.from} to ${move.to}`).join(', ')}.`;

  return (
    <div className="board-frame">
      <div className="board-host cg-wrap" ref={host} style={pieceImageVariables(pieceStyle)} role="img" aria-label="Chessboard. Use the coordinate move controls or inspect a square."
        onContextMenu={(event) => { event.preventDefault(); clearPremoves(); board.current?.cancelMove(); }} />
      {pendingPremovePromotion && premoveColor && <section className="promotion-panel" aria-label="Premove promotion">
        <div className="promotion-options">
          {PROMOTIONS.map((option) => <button className="button quiet" type="button" key={option.value}
            aria-label={option.label} autoFocus={option.value === 'q'} onClick={() => choosePremovePromotion(option.value)}>
            <img alt="" width="36" height="36" src={pieceImage(premoveColor === 'white' ? 'w' : 'b', option.value, pieceStyle)} /></button>)}
          <IconButton icon="close" label="Cancel premove promotion" onClick={cancelPremovePromotion} />
        </div>
      </section>}
      {premoveHead && premoveColor && <div className="premove-notice" role="status" aria-label={premoveLabel}>
        <span className="sr-only">Premove</span>
        {premoves.length > 1 && <span>{premoves.map((move) => `${move.from}${move.to}${move.promotion ?? ''}`).join(' · ')}</span>}
        <IconButton icon="close" label="Cancel premove" onClick={() => { clearPremoves(); board.current?.cancelMove(); }} />
      </div>}
      <p className="sr-only">Right-drag for green arrows; right-click for circles. Hold Shift for red, Control for blue, or Alt for amber.</p>
      <details className="board-inspection sr-only">
        <summary aria-label="Keyboard board"><Icon name="board" /></summary>
        <p className="sr-only">Choose a square to inspect it. Choose a piece of the side to move, then its destination to play a move.</p>
        <div className="square-grid">
          {Array.from({ length: 64 }, (_, index) => {
            const square = ('abcdefgh'[index % 8] + String(8 - Math.floor(index / 8))) as Square;
            return <button className="square-inspect" key={square} type="button"
              aria-label={squareDescription(view.position, square)} aria-pressed={keyboardOrigin?.square === square && keyboardOrigin.fen === fen}
              onClick={() => {
                const node = document.getElementById('board-announcement');
                if (node) node.textContent = squareDescription(view.position, square);
                if (disabled) return;
                const piece = model.position.pieces.find((item) => item.square === square);
                if (piece?.color === model.position.sideToMove) setKeyboardOrigin({ square, fen });
                else if (keyboardOrigin?.fen === fen) {
                  void onMove({ from: keyboardOrigin.square, to: square });
                  setKeyboardOrigin(null);
                }
              }}>{square}</button>;
          })}
        </div>
        <p id="board-announcement" className="sr-only" aria-live="polite" />
      </details>
    </div>
  );
}
