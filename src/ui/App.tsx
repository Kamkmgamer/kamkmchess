import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Chessboard, COLOR, INPUT_EVENT_TYPE, PIECES_FILE_TYPE } from 'cm-chessboard';
import spriteUrl from 'cm-chessboard/assets/pieces/standard.svg?url';
import 'cm-chessboard/assets/chessboard.css';
import type { ControllerSnapshotV1 } from '../controller/index.js';
import { runProofSearchPass } from '../proofs/index.js';
import { legalMoves, parsePosition } from '../rules/index.js';
import type { CoordinateMove, Promotion, Square } from '../rules/index.js';
import { isLocalBoardInputDisabled, parseCoordinateMove, startClassifiedLocalGame, submitBoardMove } from './board-input.js';
import { editPositionFen, editorSideToMove, positionSetupError, readEditorPieces, setPositionSideToMove } from './position-editor.js';
import type { EditorPiece } from './position-editor.js';
import type { LocalGameSession, MatchComposition } from './match-composition.js';
import { T3_PALETTES } from './t3-palettes.js';

type Appearance = 'light' | 'dark' | 'system';
type PromotionMove = Omit<CoordinateMove, 'promotion'>;
interface AppProps {
  readonly composition: MatchComposition;
  readonly initialSession: LocalGameSession;
  readonly initialSnapshot: ControllerSnapshotV1;
}
const PROMOTIONS: readonly { value: Promotion; label: string }[] = [
  { value: 'q', label: 'Queen' }, { value: 'r', label: 'Rook' },
  { value: 'b', label: 'Bishop' }, { value: 'n', label: 'Knight' },
];
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EDITOR_PIECES: readonly { value: EditorPiece; label: string; glyph: string }[] = [
  { value: 'empty', label: 'Remove piece', glyph: '·' },
  { value: 'wk', label: 'White king', glyph: '♔' }, { value: 'wq', label: 'White queen', glyph: '♕' },
  { value: 'wr', label: 'White rook', glyph: '♖' }, { value: 'wb', label: 'White bishop', glyph: '♗' },
  { value: 'wn', label: 'White knight', glyph: '♘' }, { value: 'wp', label: 'White pawn', glyph: '♙' },
  { value: 'bk', label: 'Black king', glyph: '♚' }, { value: 'bq', label: 'Black queen', glyph: '♛' },
  { value: 'br', label: 'Black rook', glyph: '♜' }, { value: 'bb', label: 'Black bishop', glyph: '♝' },
  { value: 'bn', label: 'Black knight', glyph: '♞' }, { value: 'bp', label: 'Black pawn', glyph: '♟' },
];

function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1_000));
  return Math.floor(total / 60) + ':' + (total % 60).toString().padStart(2, '0');
}
function squareDescription(snapshot: ControllerSnapshotV1, square: Square): string {
  const piece = snapshot.position.pieces.find((item) => item.square === square);
  if (!piece) return square + ', empty';
  const names: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  return square + ', ' + (piece.color === 'w' ? 'White ' : 'Black ') + names[piece.type];
}

function ChessBoard({ fen, orientation, snapshot, disabled, onMove }: {
  readonly fen: string;
  readonly orientation: 'white' | 'black';
  readonly snapshot: ControllerSnapshotV1;
  readonly disabled: boolean;
  readonly onMove: (move: PromotionMove) => void;
}) {
  const [keyboardOrigin, setKeyboardOrigin] = useState<{ square: Square; fen: string } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const board = useRef<Chessboard | null>(null);
  const onMoveRef = useRef(onMove);
  useEffect(() => { onMoveRef.current = onMove; }, [onMove]);
  useEffect(() => {
    if (!host.current) return undefined;
    const instance = new Chessboard(host.current, {
      position: fen,
      orientation: orientation === 'white' ? COLOR.white : COLOR.black,
      assetsUrl: '',
      style: {
        cssClass: 'green', borderType: 'frame', showCoordinates: true, animationDuration: 140,
        pieces: { type: PIECES_FILE_TYPE.svgSprite, file: spriteUrl, tileSize: 40 },
      },
    });
    board.current = instance;
    return () => {
      instance.disableMoveInput();
      instance.destroy();
      board.current = null;
    };
    // The board is a stable widget. State changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void board.current?.setPosition(fen, false); }, [fen]);
  useEffect(() => {
    if (board.current) void board.current.setOrientation(orientation === 'white' ? COLOR.white : COLOR.black, false);
  }, [orientation]);
  useEffect(() => {
    if (!board.current) return;
    if (disabled) board.current.disableMoveInput();
    else board.current.enableMoveInput((event) => {
      if (event.type === INPUT_EVENT_TYPE.moveInputStarted) {
        const piece = event.squareFrom ? snapshot.position.pieces.find((item) => item.square === event.squareFrom) : undefined;
        return piece?.color === snapshot.position.sideToMove;
      }
      if (event.type === INPUT_EVENT_TYPE.validateMoveInput && event.squareFrom && event.squareTo) {
        onMoveRef.current({ from: event.squareFrom as Square, to: event.squareTo as Square });
      }
      return false;
    });
  }, [disabled, snapshot.position]);
  return (
    <div className="board-frame">
      <div className="board-host" ref={host} role="img" aria-label="Chessboard. Use the coordinate move controls or inspect a square." />
      <details className="board-inspection">
        <summary>Inspect or move with the keyboard</summary>
        <p>Choose a square to inspect it. Choose a piece of the side to move, then its destination to play a move.</p>
        <div className="square-grid">
          {Array.from({ length: 64 }, (_, index) => {
            const square = ('abcdefgh'[index % 8] + String(8 - Math.floor(index / 8))) as Square;
            return <button className="square-inspect" key={square} type="button"
              aria-label={squareDescription(snapshot, square)} aria-pressed={keyboardOrigin?.square === square && keyboardOrigin.fen === snapshot.position.fen}
              onClick={() => {
                const node = document.getElementById('board-announcement');
                if (node) node.textContent = squareDescription(snapshot, square);
                if (disabled) return;
                const piece = snapshot.position.pieces.find((item) => item.square === square);
                if (keyboardOrigin === null || keyboardOrigin.fen !== snapshot.position.fen) {
                  if (piece?.color === snapshot.position.sideToMove) setKeyboardOrigin({ square, fen: snapshot.position.fen });
                  return;
                }
                if (piece?.color === snapshot.position.sideToMove) setKeyboardOrigin({ square, fen: snapshot.position.fen });
                else {
                  onMove({ from: keyboardOrigin.square, to: square });
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

function statusLabel(snapshot: ControllerSnapshotV1): string {
  if (snapshot.readiness === 'restore-recovery-pending') return 'Restoring saved game';
  if (snapshot.readiness === 'expiry-persistence-pending') return 'Saving clock result';
  if (snapshot.readiness === 'clock-reconciliation-required') return 'Clock needs review';
  if (snapshot.checkpoint.result.kind === 'final') {
    const result = snapshot.checkpoint.result;
    return result.winner === 'draw' ? 'Draw' : (result.winner === 'white' ? 'White' : 'Black') + ' wins';
  }
  if (snapshot.checkpoint.result.kind === 'pending-adjudication') return 'Position check pending';
  return (snapshot.position.sideToMove === 'w' ? 'White' : 'Black') + ' to move';
}

function MoveRows({ snapshot }: { readonly snapshot: ControllerSnapshotV1 }) {
  const moves = snapshot.checkpoint.rules.moves;
  if (!moves.length) return <p className="muted">Moves appear here after they are committed.</p>;
  return <ol className="move-list" aria-label="Committed moves">{moves.map((move, index) =>
    <li key={move.moveId}><span>{Math.floor(index / 2) + 1}.</span><strong>{move.san}</strong></li>)}</ol>;
}

export function App({ composition, initialSession, initialSnapshot }: AppProps) {
  const [session, setSession] = useState(initialSession);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [theme, setTheme] = useState('t3-chat');
  const [appearance, setAppearance] = useState<Appearance>('system');
  const [systemDark, setSystemDark] = useState(false);
  const [coordinate, setCoordinate] = useState('');
  const [feedback, setFeedback] = useState('');
  const [promotion, setPromotion] = useState<PromotionMove | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupFen, setSetupFen] = useState('');
  const [setupMinutes, setSetupMinutes] = useState(15);
  const [setupIncrement, setSetupIncrement] = useState(10);
  const [editorPiece, setEditorPiece] = useState<EditorPiece>('wp');
  const [setupError, setSetupError] = useState('');
  const [working, setWorking] = useState(false);
  const setupReturnFocus = useRef<HTMLElement | null>(null);
  const refresh = useCallback((next: ControllerSnapshotV1) => {
    setSnapshot(next);
    if (next.checkpoint.result.kind === 'final') setFeedback(statusLabel(next));
  }, []);
  useEffect(() => session.controller.subscribe(refresh), [refresh, session.controller]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let reconciling = false;
    const tick = async () => {
      if (!reconciling) {
        reconciling = true;
        try {
          const observed = session.controller.snapshot();
          const needsReconciliation = observed.readiness === 'expiry-persistence-pending' ||
            observed.readiness === 'restore-recovery-pending' || observed.clockReading?.status === 'expired';
          const next = needsReconciliation ? await session.controller.reconcile() : observed;
          if (!stopped) setSnapshot(next);
        } catch {
          if (!stopped) setSnapshot(session.controller.snapshot());
        } finally { reconciling = false; }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 1_000);
    };
    timer = window.setTimeout(() => void tick(), 1_000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [session.controller]);
  useEffect(() => {
    const palette = (T3_PALETTES.find((item) => item.id === theme) ?? T3_PALETTES[1]) as {
      colors: Record<string, string>;
      variants?: Partial<Record<'dark' | 'light', Record<string, string>>>;
    };
    const resolved = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance;
    const colors = palette.variants?.[resolved] ?? palette.colors;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(colors)) {
      root.style.setProperty('--t3-' + key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()), value);
    }
    const aliases: Record<string, string> = {
      paper: 'canvas', surface: 'surface', ink: 'text', dim: 'textMuted', rule: 'border', green: 'accent',
      soft: 'secondary', focus: 'focus', warning: 'warningForeground', 'warning-bg': 'warningSurface',
      error: 'errorForeground', 'error-bg': 'errorSurface',
    };
    for (const [alias, role] of Object.entries(aliases)) {
      const value = colors[role];
      if (value !== undefined) root.style.setProperty('--' + alias, value);
    }
    root.dataset.theme = theme;
    root.dataset.appearance = resolved;
    root.style.colorScheme = resolved;
  }, [appearance, systemDark, theme]);

  const submitMove = useCallback(async (move: CoordinateMove) => {
    setWorking(true);
    setFeedback('Move submitted. Waiting for the saved position.');
    try {
      const result = await submitBoardMove(session.controller, session.controller.snapshot(), move);
      refresh(result.snapshot);
      if (result.kind === 'rejected') {
        setFeedback(result.reason === 'illegal-move' ? 'That move is not legal. Choose a legal destination.' : 'The position changed before that move was accepted.');
      } else if (result.kind === 'expired') setFeedback('The active clock expired. The controller is checking the result.');
      else if (result.kind === 'clock-reconciliation-required') setFeedback('The clock needs review before play can continue.');
      else setFeedback('Move saved.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The move could not be saved.');
    } finally { setWorking(false); }
  }, [refresh, session.controller]);

  const closeSetup = () => {
    setSetupOpen(false);
    window.setTimeout(() => setupReturnFocus.current?.focus(), 0);
  };
  const openSetup = (trigger: HTMLElement, fen?: string) => {
    setupReturnFocus.current = trigger;
    setSetupFen(fen ?? STANDARD_FEN);
    setSetupOpen(true);
    window.setTimeout(() => document.getElementById('new-game-title')?.focus(), 0);
  };

  const attemptBoardMove = useCallback((move: PromotionMove) => {
    const hasPromotions = legalMoves(snapshot.position).some((candidate) =>
      candidate.from === move.from && candidate.to === move.to && candidate.promotion);
    if (hasPromotions) {
      setPromotion(move);
      setFeedback('Choose a piece for promotion from ' + move.from + ' to ' + move.to + '.');
    } else void submitMove(move);
  }, [snapshot.position, submitMove]);

  const selectPromotion = (piece: Promotion) => {
    if (!promotion) return;
    const move = { ...promotion, promotion: piece };
    setPromotion(null);
    void submitMove(move);
    window.setTimeout(() => document.getElementById('coordinate-move')?.focus(), 0);
  };
  const submitCoordinate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const move = parseCoordinateMove(coordinate);
    if (!move) {
      setFeedback('Enter four coordinates such as e2e4. Promotion is chosen in a separate step.');
      return;
    }
    const matchingMoves = legalMoves(snapshot.position).filter((candidate) =>
      candidate.from === move.from && candidate.to === move.to);
    if (matchingMoves.some((candidate) => candidate.promotion) && move.promotion === undefined) {
      setPromotion({ from: move.from, to: move.to });
      setFeedback('Choose a piece for promotion.');
      return;
    }
    void submitMove(move);
    setCoordinate('');
  };

  const runPositionCheck = async () => {
    setWorking(true);
    try {
      const work = await session.controller.continueAdjudication(session.controller.snapshot().fence);
      if (!work) {
        setFeedback('There is no pending position check to continue.');
        return;
      }
      setFeedback('Checking this position. The clocks remain active.');
      const result = await runProofSearchPass(work.query, {
        checkpoint: work.searchCheckpoint ?? undefined, maxDiscoveredStates: 10_000, timeBudgetMs: 750,
      });
      const next = await session.controller.acceptAdjudicationResult({
        requestId: work.requestId, fence: work.fence, query: work.query, result,
      });
      const playable = await startClassifiedLocalGame(session.controller, next);
      refresh(playable);
      setFeedback(playable.checkpoint.result.kind === 'pending-adjudication'
        ? playable.adjudication.status === 'setup-ready'
          ? 'Starting position classified. The local game clock is running.'
          : 'The position remains pending. Continue the check to search another bounded pass.'
        : statusLabel(playable));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The position check could not be saved.');
    } finally { setWorking(false); }
  };

  const createNewGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupError('');
    let startingFen: string | undefined;
    if (setupFen.trim()) {
      try { startingFen = parsePosition(setupFen.trim()).fen; }
      catch (error) {
        setSetupError(positionSetupError(error));
        return;
      }
    }
    setWorking(true);
    try {
      const nextSession = await composition.startNewLocalGame({
        ...(startingFen === undefined ? {} : { startingFen }),
        startingTimeMinutes: setupMinutes, incrementSeconds: setupIncrement,
      });
      setSession(nextSession);
      setSnapshot(nextSession.controller.snapshot());
      setSetupOpen(false);
      window.setTimeout(() => setupReturnFocus.current?.focus(), 0);
      setOrientation('white');
      setCoordinate('');
      setPromotion(null);
      setFeedback('New local game created. Classify its starting position before the clock starts.');
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'The new game could not be saved.');
    } finally { setWorking(false); }
  };
  const undo = async () => {
    setWorking(true);
    try {
      const next = await session.controller.undo(snapshot.fence);
      refresh(next);
      setFeedback('Previous committed move restored. Clock time was not refunded.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Undo is unavailable.');
    } finally { setWorking(false); }
  };

  const clocks = snapshot.clockReading?.remaining ?? {
    whiteMs: snapshot.checkpoint.clocks.banksAtAnchor.whiteMs,
    blackMs: snapshot.checkpoint.clocks.banksAtAnchor.blackMs,
  };
  const activeSide = snapshot.checkpoint.clocks.activeSide;
  const final = snapshot.checkpoint.result.kind === 'final';
  const pendingSetup = snapshot.checkpoint.result.kind === 'pending-adjudication' && activeSide === null;
  const disabled = isLocalBoardInputDisabled(snapshot, working);
  let editorPieces: ReturnType<typeof readEditorPieces> | null = null;
  let editorSide: 'w' | 'b' = 'w';
  try {
    editorPieces = readEditorPieces(setupFen || STANDARD_FEN);
    editorSide = editorSideToMove(setupFen || STANDARD_FEN);
  } catch { /* The FEN field reports the validation error on submit. */ }

  return (
    <main className="workspace">
      <header className="topbar">
        <a className="wordmark" href="#board" aria-label="Kamkm Chess home">kamkm chess</a>
        <h1>Classic match</h1>
        <div className="topbar-actions">
          <label className="compact-control">Theme<select value={theme} onChange={(event) => setTheme(event.target.value)}>
            {T3_PALETTES.map((palette) => <option key={palette.id} value={palette.id}>{palette.label}</option>)}
          </select></label>
          <label className="compact-control">Appearance<select value={appearance} onChange={(event) => setAppearance(event.target.value as Appearance)}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select></label>
          <button className="button secondary" type="button" onClick={(event) => {
            if (setupOpen) closeSetup();
            else openSetup(event.currentTarget);
          }}>New game</button>
        </div>
      </header>

      {setupOpen && <section className="setup-panel" aria-labelledby="new-game-title">
        <div className="panel-heading"><div><h2 id="new-game-title" tabIndex={-1}>Start a local game</h2>
          <p>Two people, one board. The game is saved on this device.</p></div>
          <button className="button quiet" type="button" onClick={closeSetup}>Close</button></div>
        <form className="setup-form" onSubmit={createNewGame}>
          <label>Starting minutes<input type="number" min="1" max="180" value={setupMinutes} onChange={(event) => setSetupMinutes(Number(event.target.value))} required /></label>
          <label>Increment seconds<input type="number" min="0" max="600" value={setupIncrement} onChange={(event) => setSetupIncrement(Number(event.target.value))} required /></label>
          <label className="fen-field">Custom starting position (six-field FEN)
            <textarea rows={2} value={setupFen} onChange={(event) => { setSetupFen(event.target.value); setSetupError(''); }} placeholder="Leave blank for the standard position" />
          </label>
          <fieldset className="visual-editor">
            <legend>Visual piece editor</legend>
            <p className="muted">Choose a piece, then a square to place it or remove its current piece. Editing clears castling and en-passant rights.</p>
            <div className="editor-tools">
              <label>Piece to place<select value={editorPiece} onChange={(event) => setEditorPiece(event.target.value as EditorPiece)}>
                {EDITOR_PIECES.map((piece) => <option key={piece.value} value={piece.value}>{piece.label}</option>)}
              </select></label>
              <label>Side to move<select value={editorSide} disabled={!editorPieces}
                onChange={(event) => { try { setSetupFen(setPositionSideToMove(setupFen || STANDARD_FEN, event.target.value as 'w' | 'b')); setSetupError(''); } catch { /* Keep invalid text available for correction. */ } }}>
                <option value="w">White</option><option value="b">Black</option>
              </select></label>
            </div>
            {editorPieces ? <div className="editor-grid" role="group" aria-label="Visual starting position board">
              {Array.from({ length: 64 }, (_, index) => {
                const square = ('abcdefgh'[index % 8] + String(8 - Math.floor(index / 8))) as Square;
                const piece = editorPieces?.find((item) => item.square === square);
                const glyph = piece ? EDITOR_PIECES.find((item) => item.value === `${piece.color}${piece.type}`)?.glyph : undefined;
                return <button className="editor-square" type="button" key={square}
                  aria-label={`${square}, ${piece ? (piece.color === 'w' ? 'white ' : 'black ') + piece.type : 'empty'}`}
                  onClick={() => { try { setSetupFen(editPositionFen(setupFen || STANDARD_FEN, square, editorPiece)); setSetupError(''); } catch (error) { setSetupError(error instanceof Error ? error.message : 'The position cannot be edited.'); } }}>
                  {glyph ?? <span className="sr-only">Empty</span>}
                </button>;
              })}
            </div> : <p className="error-message">Enter a valid FEN before using the visual editor.</p>}
          </fieldset>
           {setupError && <p id="setup-position-error" className="error-message" role="alert">{setupError}</p>}
          <button className="button primary" disabled={working} type="submit">Create game</button>
        </form>
      </section>}

      <div className="match-layout">
        <section className="board-column" id="board" aria-label="Chess match board">
          <div className={'player-row ' + (snapshot.position.sideToMove === 'b' && activeSide === 'black' ? 'active' : '')}>
            <span className="player-badge dark-piece" aria-hidden="true">B</span>
            <div className="player-name"><strong>Black</strong><span>Local player</span></div>
            <time className={'clock ' + (activeSide === 'black' ? 'running' : '')}
              dateTime={'PT' + Math.max(0, Math.ceil(clocks.blackMs / 1_000)) + 'S'}
              aria-label={'Black clock ' + formatClock(clocks.blackMs)}>{formatClock(clocks.blackMs)}</time>
          </div>
          <ChessBoard fen={snapshot.position.fen} orientation={orientation} snapshot={snapshot} disabled={disabled} onMove={attemptBoardMove} />
          <div className={'player-row ' + (snapshot.position.sideToMove === 'w' && activeSide === 'white' ? 'active' : '')}>
            <span className="player-badge light-piece" aria-hidden="true">W</span>
            <div className="player-name"><strong>White</strong><span>Local player</span></div>
            <time className={'clock ' + (activeSide === 'white' ? 'running' : '')}
              dateTime={'PT' + Math.max(0, Math.ceil(clocks.whiteMs / 1_000)) + 'S'}
              aria-label={'White clock ' + formatClock(clocks.whiteMs)}>{formatClock(clocks.whiteMs)}</time>
          </div>
          {promotion && <section className="promotion-panel" aria-labelledby="promotion-title">
            <h2 id="promotion-title">Choose a promotion piece</h2>
            <p>From {promotion.from} to {promotion.to}. Your clock continues while you choose.</p>
            <div className="promotion-options">{PROMOTIONS.map((piece) =>
              <button className="button secondary" type="button" key={piece.value} autoFocus={piece.value === 'q'} onClick={() => selectPromotion(piece.value)}>{piece.label}</button>)}</div>
            <button className="button quiet" type="button" onClick={() => {
              setPromotion(null);
              window.setTimeout(() => document.getElementById('coordinate-move')?.focus(), 0);
            }}>Cancel promotion</button>
          </section>}
          <form className="coordinate-form" onSubmit={submitCoordinate}>
            <label htmlFor="coordinate-move">Enter a move by coordinates</label>
            <div className="coordinate-row"><input id="coordinate-move" value={coordinate} onChange={(event) => setCoordinate(event.target.value)} placeholder="e2e4" autoComplete="off" />
              <button className="button primary" type="submit" disabled={disabled}>Play move</button></div>
            <p className="muted">Type the starting square and destination. Promotion is always a separate choice.</p>
          </form>
          <div className="board-tools">
            <button className="button quiet" type="button" onClick={() => setOrientation((side) => side === 'white' ? 'black' : 'white')}>Flip board</button>
          <button className="button quiet" type="button" onClick={() => void undo()}
            disabled={working || !snapshot.checkpoint.rules.moves.length || snapshot.checkpoint.result.kind !== 'unresolved'}
            aria-description={snapshot.checkpoint.result.kind === 'pending-adjudication' ? 'Resolve the position check before undoing.' : undefined}>Undo</button>
          </div>
        </section>

        <aside className="details-panel" aria-label="Match details">
          <section className="status-block" aria-labelledby="match-status-title">
            <h2 id="match-status-title">{statusLabel(snapshot)}</h2>
            <p>{final && snapshot.checkpoint.result.kind === 'final'
              ? 'Final result recorded: ' + snapshot.checkpoint.result.reason.replaceAll('-', ' ') + '.'
              : pendingSetup ? 'The controller is classifying this starting position before play can begin.'
                : snapshot.checkpoint.result.kind === 'pending-adjudication'
                  ? 'The result is unresolved during an exact position check. The active clock keeps running.'
                  : snapshot.clockReading?.status === 'expired'
                    ? 'A clock has expired. Its result must be reconciled by the controller.'
                    : 'Moves and clocks are committed by the local game controller.'}</p>
            {(pendingSetup || snapshot.checkpoint.result.kind === 'pending-adjudication') &&
              <button className="button primary" type="button" onClick={() => void runPositionCheck()} disabled={working}>
                {working ? 'Checking position…' : 'Continue position check'}
              </button>}
          </section>
          <section className="detail-section" aria-labelledby="moves-title">
            <div className="panel-heading"><h2 id="moves-title">Moves</h2><span className="count">{snapshot.checkpoint.rules.moves.length}</span></div>
            <MoveRows snapshot={snapshot} />
          </section>
          <section className="detail-section" aria-labelledby="position-title">
            <div className="panel-heading"><h2 id="position-title">Position</h2></div>
            <p className="fen-value">{snapshot.position.fen}</p>
            <p className="muted">Standard chess · White and Black take turns locally</p>
          </section>
          <section className="detail-section" aria-labelledby="editor-title">
            <div className="panel-heading"><h2 id="editor-title">Position editor</h2></div>
            <p>Use a validated FEN to start a separate local game from a custom position.</p>
            <button className="button secondary" type="button" onClick={(event) => openSetup(event.currentTarget, snapshot.position.fen)}>Edit starting position</button>
          </section>
          <section className="detail-section">
            <div className="panel-heading"><h2>Match tools</h2></div>
            <p>Undo restores the committed position without refunding clock time. New games keep this result in saved history.</p>
            <p className="muted">Practice after a model loss is unavailable in this two-human local game.</p>
            <button className="button secondary" type="button" onClick={(event) => openSetup(event.currentTarget)}>New local game</button>
          </section>
        </aside>
      </div>
      <p className="feedback" role="status" aria-live="polite">{feedback}</p>
    </main>
  );
}
