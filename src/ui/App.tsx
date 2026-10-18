import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Chessboard, COLOR, INPUT_EVENT_TYPE, PIECES_FILE_TYPE } from 'cm-chessboard';
import spriteUrl from 'cm-chessboard/assets/pieces/standard.svg?url';
import 'cm-chessboard/assets/chessboard.css';
import type { ControllerSnapshotV1 } from '../controller/index.js';
import type { ModelSelection } from '../controller/index.js';
import {
  checkProofEvidence,
  PROOF_CHECKER_VERSION,
  PROOF_SCHEMA_VERSION,
  RULES_ADAPTER_VERSION,
} from '../proofs/index.js';
import type { ProofEvidence, ProofSearchPassResult } from '../proofs/index.js';
import { legalMoves, parsePosition } from '../rules/index.js';
import type { CoordinateMove, Promotion, Square } from '../rules/index.js';
import { isLocalBoardInputDisabled, parseCoordinateMove, startClassifiedLocalGame, submitBoardMove } from './board-input.js';
import { editPositionFen, editorSideToMove, positionSetupError, readEditorPieces, setPositionSideToMove } from './position-editor.js';
import type { EditorPiece } from './position-editor.js';
import type { LocalGameSession, MatchComposition } from './match-composition.js';
import { T3_PALETTES } from './t3-palettes.js';
import { OpponentPanel } from './OpponentPanel.js';
import { matchesOpponentSelection } from './opponent-selection.js';
import { getGenerationJournal } from '../integration/generation-runner.js';
import type { GenerationJournalV1 } from '../integration/generation-runner.js';
import type { HandoffSnapshotV1, OpponentIdentityV1 } from '../opponents/index.js';

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

/** The standard position has a tiny, independently checked non-deadness witness. */
async function acceptStandardPositionWitness(
  controller: LocalGameSession['controller'],
  snapshot: ControllerSnapshotV1,
): Promise<ControllerSnapshotV1> {
  if (snapshot.position.fen !== STANDARD_FEN || snapshot.adjudication.query?.predicate !== 'global-deadness') return snapshot;
  const work = await controller.continueAdjudication(snapshot.fence);
  if (!work) return controller.snapshot();
  const evidence: ProofEvidence = {
    schemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    kind: 'mate-witness' as const,
    queryIdentity: work.query.queryIdentity,
    intendedColor: 'b',
    moves: [
      { from: 'f2', to: 'f3' }, { from: 'e7', to: 'e5' },
      { from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' },
    ],
  };
  const checked = checkProofEvidence(work.query, evidence);
  if (checked.status !== 'accepted' || checked.conclusion !== 'not-dead') {
    throw new Error('The standard-position witness did not pass the proof checker.');
  }
  const result: ProofSearchPassResult = {
    status: 'accepted', conclusion: 'not-dead', queryIdentity: work.query.queryIdentity, evidence,
    checkpointDisposition: 'fresh',
    pass: { maxDiscoveredStates: 0, timeBudgetMs: 0, discoveredStateCount: 0, processedEdgeCount: 0,
      expandedStateCount: 0, totalDiscoveredStateCount: 0, totalDiscoveredEdgeCount: 0, elapsedMs: 0 },
  };
  return controller.acceptAdjudicationResult({ requestId: work.requestId, fence: work.fence, query: work.query, result });
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
  const [matchMode, setMatchMode] = useState<'local' | 'ai'>('local');
  const [humanSide, setHumanSide] = useState<'white' | 'black' | 'random'>('white');
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [opponentIdentity, setOpponentIdentity] = useState<OpponentIdentityV1 | null>(null);
  const [handoff, setHandoff] = useState<HandoffSnapshotV1>({ committed: null, queued: null, producing: null });
  const [autoGeneration, setAutoGeneration] = useState(!initialSession.restored);
  const [generationAttempt, setGenerationAttempt] = useState(0);
  const [generationState, setGenerationState] = useState<'idle' | 'producing' | 'failed' | 'stopped'>('idle');
  const [generationDetail, setGenerationDetail] = useState('');
  const [generationJournal, setGenerationJournal] = useState<GenerationJournalV1 | null>(null);
  const [journalRefresh, setJournalRefresh] = useState(0);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [usageLabel, setUsageLabel] = useState('Unknown until provider usage is returned.');
  const generationController = useRef<AbortController | null>(null);
  const generationFenceKey = useRef('');
  const sessionRef = useRef(session);
  const analysisAttemptKey = useRef('');
  const setupReturnFocus = useRef<HTMLElement | null>(null);
  const refresh = useCallback((next: ControllerSnapshotV1) => {
    setSnapshot(next);
    if (next.checkpoint.result.kind === 'final') setFeedback(statusLabel(next));
  }, []);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => () => {
    generationController.current?.abort();
    generationController.current = null;
  }, [session.gameId]);
  useEffect(() => session.controller.subscribe(refresh), [refresh, session.controller]);
  useEffect(() => {
    let current = true;
    let unsubscribe: (() => void) | undefined;
    void composition.opponentService.then((service) => {
      if (!current) return;
      setHandoff(service.getSnapshot());
      unsubscribe = service.subscribe(setHandoff);
    });
    return () => { current = false; unsubscribe?.(); };
  }, [composition]);
  useEffect(() => {
    let current = true;
    void composition.readSavedGame(session.gameId).then((saved) => {
      if (current) setGenerationJournal(saved ? getGenerationJournal(saved) : null);
    }).catch((error: unknown) => {
      if (current) setGenerationDetail(error instanceof Error ? error.message : 'Saved archive status is unavailable.');
    });
    return () => { current = false; };
  }, [composition, session.gameId, journalRefresh]);
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

  useEffect(() => {
    const current = session.controller.snapshot();
    if (current.checkpoint.result.kind !== 'pending-adjudication' || current.adjudication.status === 'running') return;
    const query = current.adjudication.query;
    if (!query) return;
    const key = `${current.checkpoint.gameId}/${current.checkpoint.segmentId}/${current.checkpoint.positionRevision}/${query.queryIdentity}`;
    if (analysisAttemptKey.current === key) return;
    analysisAttemptKey.current = key;
    let cancelled = false;
    void (async () => {
      try {
        const standard = current.position.fen === STANDARD_FEN && query.predicate === 'global-deadness';
        const result = standard
          ? await acceptStandardPositionWitness(session.controller, current)
          : await session.analysis.continueAnalysis(current.fence);
        if (!cancelled) {
          const started = await startClassifiedLocalGame(session.controller, result,
            snapshot.checkpoint.selections.players.white.kind === 'model' || snapshot.checkpoint.selections.players.black.kind === 'model'
              ? (snapshot.checkpoint.selections.players.white.kind === 'model'
                ? snapshot.checkpoint.selections.players.white : snapshot.checkpoint.selections.players.black) as ModelSelection
              : modelSelection ?? undefined);
          refresh(started);
        }
      } catch (error) {
        if (!cancelled) setFeedback(error instanceof Error ? error.message : 'The automatic position check failed. Continue it from match details.');
      }
    })();
    return () => { cancelled = true; };
  // The durable game/query identity is the trigger; clock display ticks must not
  // cancel an active Worker pass or authorize another one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSelection, refresh, session, snapshot.checkpoint.gameId, snapshot.checkpoint.segmentId,
    snapshot.checkpoint.positionRevision, snapshot.checkpoint.result.kind, snapshot.adjudication.query?.queryIdentity]);

  const generationSide = snapshot.position.sideToMove === 'w' ? 'white' : 'black';
  const generationSelection = snapshot.checkpoint.selections.players[generationSide];
  const queuedGenerationSelection = snapshot.modelHandoff.queued?.selection;
  const queuedGenerationIdentity = queuedGenerationSelection
    ? [queuedGenerationSelection.connectionId, queuedGenerationSelection.configurationRevision,
      queuedGenerationSelection.modelRoutingId, queuedGenerationSelection.protocol].join('/')
    : '';
  const generationResultKind = snapshot.checkpoint.result.kind;
  const generationReadiness = snapshot.readiness;
  const generationClockStatus = snapshot.clockReading?.status;
  const generationKey = [snapshot.checkpoint.gameId, snapshot.checkpoint.segmentId,
    snapshot.checkpoint.positionRevision, generationSide,
    snapshot.fence.modelConfigurationIdentity ?? '',
    generationSelection.kind === 'model' ? generationSelection.connectionId : '',
    generationSelection.kind === 'model' ? generationSelection.modelRoutingId : '',
    queuedGenerationIdentity].join('/');
  useEffect(() => {
    if (!autoGeneration || generationController.current !== null || generationSelection.kind !== 'model' ||
      generationResultKind !== 'unresolved' || generationReadiness !== 'ready' ||
      generationClockStatus !== 'running') return;
    const selection = generationSelection;
    const queuedSelection = queuedGenerationSelection ?? selection;
    const queuedIdentityAtStart = queuedGenerationIdentity;
    const key = generationKey;
    if (generationFenceKey.current === key) return;
    // Deferring the start lets React StrictMode's setup/cleanup probe cancel a
    // not-yet-started run without leaving a controller or fence locked.
    let cancelled = false;
    let abort: AbortController | null = null;
    const timer = window.setTimeout(() => {
      if (cancelled || generationFenceKey.current === key) return;
      generationFenceKey.current = key;
      abort = new AbortController();
      generationController.current = abort;
      setGenerationState('producing');
      setGenerationDetail('The model is choosing a move. Its clock keeps running.');
      void (async () => {
        let service: Awaited<typeof composition.opponentService> | null = null;
        let continueAutomatically = false;
        try {
          const identities = [opponentIdentity, handoff.producing, handoff.queued?.identity, handoff.committed];
          const identity = identities.find((candidate) => matchesOpponentSelection(candidate, queuedSelection)) ??
            identities.find((candidate) => matchesOpponentSelection(candidate, selection)) ?? null;
          if (!identity) {
            throw new Error('The current-session compatibility check does not match this model. Select and diagnose it again.');
          }
          const store = await composition.connectionStore;
          const profile = await store.getProfile(composition.namespace, queuedSelection.connectionId);
          if (!profile) throw new Error('The model connection was removed. Choose Retry after restoring it or start a new game.');
          if (profile.configRevision !== identity.configRevision || profile.protocol !== identity.protocol) {
            throw new Error('The model connection changed after its compatibility check. Diagnose it again before continuing.');
          }
          service = await composition.opponentService;
          service.setProducingSelection(identity);
          const result = await composition.runModelTurn(session, (requested) => {
            const expected = identities.find((candidate) => matchesOpponentSelection(candidate, requested));
            return expected?.configRevision ?? '';
          }, abort!.signal);
          if (sessionRef.current.gameId !== session.gameId) return;
          if (result.kind !== 'not-started') {
            setUsageLabel(`Provider usage: ${result.usage.status}. Cost: unknown unless a measured rate record is available.`);
          }
          setJournalRefresh((revision) => revision + 1);
          if (result.kind === 'completed' && result.dispatch === 'accepted') {
            const currentHandoff = session.controller.snapshot().modelHandoff;
            const latest = currentHandoff.committed;
            const committedIdentity = latest
              ? identities.find((candidate) => matchesOpponentSelection(candidate, latest)) ?? null : null;
            if (latest && committedIdentity && currentHandoff.queued?.state !== 'failed') {
              service.setCommittedSelection(committedIdentity);
              service.recoverCandidate('resume-prior');
              setModelSelection(latest);
              setOpponentIdentity(committedIdentity);
            }
            if (result.recovery) {
              continueAutomatically = result.recovery.kind === 'automatic';
              setGenerationState(continueAutomatically ? 'idle' : 'failed');
              setGenerationDetail(result.recovery.detail);
              setFeedback(result.recovery.detail);
              if (!continueAutomatically) setAutoGeneration(false);
            } else {
              setGenerationState('idle');
              setGenerationDetail(result.persistence === 'saved-locally'
                ? `Model reply saved locally via ${latest?.modelRoutingId ?? queuedSelection.modelRoutingId}.`
                : `Model reply accepted via ${latest?.modelRoutingId ?? queuedSelection.modelRoutingId}; archive status: ${result.persistence}.`);
              setFeedback('Model reply saved. The controller is checking the resulting match state.');
            }
          } else if (result.kind === 'interrupted' || result.kind === 'capacity-rejected') {
            setGenerationState(abort!.signal.aborted ? 'stopped' : 'failed');
            setGenerationDetail(result.kind === 'interrupted'
              ? result.detail ?? `Generation ${result.reason}. The clock continued.`
              : 'The complete conversation exceeds the destination capacity. Retry or start a new game.');
          } else {
            setGenerationState('failed');
            setGenerationDetail(result.kind === 'not-started' ? statusLabel(result.snapshot) : 'The model reply was not accepted. Use Retry or Switch.');
          }
        } catch (error) {
          if (sessionRef.current.gameId === session.gameId) {
            setGenerationState('failed');
            setGenerationDetail(error instanceof Error ? error.message : 'The model request failed. The clock continued.');
          }
        } finally {
          service?.producingReplySettled();
          if (generationController.current === abort) generationController.current = null;
          if (sessionRef.current.gameId === session.gameId && abort?.signal.aborted) setGenerationState('stopped');
          if (sessionRef.current.gameId === session.gameId) {
            const latest = session.controller.snapshot();
            const latestQueued = latest.modelHandoff.queued?.selection;
            const latestQueuedIdentity = latestQueued
              ? [latestQueued.connectionId, latestQueued.configurationRevision,
                latestQueued.modelRoutingId, latestQueued.protocol].join('/')
              : '';
            if (continueAutomatically && !abort?.signal.aborted) {
              generationFenceKey.current = '';
              setGenerationAttempt((attempt) => attempt + 1);
            } else if (latest.checkpoint.positionRevision !== snapshot.checkpoint.positionRevision ||
              latestQueuedIdentity !== queuedIdentityAtStart) {
              setGenerationAttempt((attempt) => attempt + 1);
            }
          }
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  // Generation is fenced to game/position/model identity. Stream and clock snapshots
  // are display updates and must not clean up a request that is already in flight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGeneration, composition, generationAttempt, generationKey, generationResultKind,
    generationReadiness, generationClockStatus, opponentIdentity?.configRevision, session]);

  const submitMove = useCallback(async (move: CoordinateMove) => {
    setWorking(true);
    setFeedback('Move submitted. Waiting for the saved position.');
    try {
      const result = await submitBoardMove(session.controller, session.controller.snapshot(), move);
      refresh(result.snapshot);
      if (result.kind === 'accepted') setJournalRefresh((revision) => revision + 1);
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
      setFeedback('Checking this position. The clocks remain active.');
      const observed = session.controller.snapshot();
      const standardSetup = observed.position.fen === STANDARD_FEN && observed.adjudication.query?.predicate === 'global-deadness';
      const next = standardSetup
        ? await acceptStandardPositionWitness(session.controller, observed)
        : await session.analysis.continueAnalysis(observed.fence);
      const playable = await startClassifiedLocalGame(session.controller, next, modelSelection ?? undefined);
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

  const stopPositionCheck = async () => {
    setWorking(true);
    try {
      const stopped = await session.analysis.stopAnalysis(session.controller.snapshot().fence);
      refresh(stopped);
      setFeedback('This bounded position-check pass stopped safely. The position remains unresolved until another pass is completed.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The position check could not be stopped.');
    } finally { setWorking(false); }
  };

  const revalidateSavedOpponent = async (selection: ModelSelection, identity: OpponentIdentityV1) => {
    const saved = snapshot.checkpoint.selections.players.white.kind === 'model'
      ? snapshot.checkpoint.selections.players.white
      : snapshot.checkpoint.selections.players.black.kind === 'model'
        ? snapshot.checkpoint.selections.players.black : snapshot.checkpoint.selections.players[sideKey];
    if (saved.kind !== 'model' || !matchesOpponentSelection(identity, selection)) {
      setFeedback('Select a model and complete its current-session compatibility check first.');
      return;
    }
    if (!final) {
      try {
        const result = await session.controller.dispatch({
          schemaVersion: 1, kind: 'queue-model-selection',
          fence: session.controller.snapshot().fence, candidate: selection,
        });
        refresh(result.snapshot);
        if (result.kind !== 'accepted') {
          throw new Error('The game changed before the model could be queued. Check the match status and choose the model again.');
        }
        const sameAsSaved = saved.kind === 'model' && saved.connectionId === selection.connectionId &&
          saved.modelRoutingId === selection.modelRoutingId && saved.protocol === selection.protocol &&
          saved.configurationRevision === selection.configurationRevision;
        if (sameAsSaved) {
          const service = await composition.opponentService;
          service.setCommittedSelection(identity);
          service.recoverCandidate('resume-prior');
        }
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : 'The model selection could not be queued.');
        return;
      }
    }
    setModelSelection(selection);
    setOpponentIdentity(identity);
    setRecoveryOpen(false);
    if (!final) setAutoGeneration(true);
    setGenerationState('idle');
    setGenerationDetail('Compatibility checked for this session. A different model becomes committed after its first interpretable reply.');
  };

  const beginPractice = async () => {
    const savedModel = snapshot.checkpoint.selections.players.white.kind === 'model'
      ? snapshot.checkpoint.selections.players.white
      : snapshot.checkpoint.selections.players.black.kind === 'model'
        ? snapshot.checkpoint.selections.players.black : null;
    if (!savedModel || !opponentIdentity || !modelSelection || savedModel.connectionId !== modelSelection.connectionId ||
      savedModel.modelRoutingId !== modelSelection.modelRoutingId || savedModel.configurationRevision !== modelSelection.configurationRevision) {
      setRecoveryOpen(true);
      setFeedback('Run a current-session compatibility check for the saved model before starting practice.');
      return;
    }
    setWorking(true);
    try {
      const practiced = await session.controller.beginPractice(snapshot.fence, modelSelection);
      refresh(practiced);
      setJournalRefresh((revision) => revision + 1);
      setAutoGeneration(true);
      setGenerationState('idle');
      setFeedback('Practice started in a separate saved segment. The original result remains in match history.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Practice could not be started.');
    } finally { setWorking(false); }
  };

  const createNewGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupError('');
    if (matchMode === 'ai' && modelSelection === null) {
      setSetupError('Choose a connection and pass its explicit compatibility check before starting an AI match.');
      return;
    }
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
        humanSide: matchMode === 'ai' ? humanSide : 'white',
        ...(matchMode === 'ai' && modelSelection ? { modelSelection } : {}),
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
      setAutoGeneration(true);
      setGenerationState('idle');
      setGenerationDetail('');
      setJournalRefresh((revision) => revision + 1);
      setRecoveryOpen(false);
      const withWitness = await acceptStandardPositionWitness(nextSession.controller, nextSession.controller.snapshot());
      const started = await startClassifiedLocalGame(nextSession.controller, withWitness, matchMode === 'ai' ? modelSelection ?? undefined : undefined);
      refresh(started);
      setOrientation(started.checkpoint.selections.players.white.kind === 'human' ? 'white' : 'black');
      if (matchMode === 'ai' && opponentIdentity) {
        const service = await composition.opponentService;
        service.setCommittedSelection(opponentIdentity);
        service.recoverCandidate('resume-prior');
      }
      setFeedback(started.checkpoint.clocks.activeSide === null
        ? 'New game saved. This custom position needs an exact position check before the clock starts.'
        : 'New game saved locally. The match clock is running.');
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'The new game could not be saved.');
    } finally { setWorking(false); }
  };
  const undo = async () => {
    setWorking(true);
    try {
      const next = await session.controller.undo(snapshot.fence);
      refresh(next);
      setJournalRefresh((revision) => revision + 1);
      setFeedback('Previous committed move restored. Clock time was not refunded.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Undo is unavailable.');
    } finally { setWorking(false); }
  };

  const retryModelTurn = () => {
    generationFenceKey.current = '';
    setGenerationState('idle');
    setGenerationDetail('Retry requested. The controller will issue one request; the clock keeps running.');
    setAutoGeneration(true);
    setGenerationAttempt((value) => value + 1);
  };

  const recoverQueuedModel = async (action: 'retry' | 'resume') => {
    setWorking(true);
    try {
      const current = session.controller.snapshot();
      const next = action === 'retry'
        ? await session.controller.retryModelSelection(current.fence)
        : await session.controller.resumePriorModel(current.fence);
      refresh(next);
      generationFenceKey.current = '';
      setGenerationState('idle');
      setGenerationDetail(action === 'retry' ? 'Queued model retry authorized for one turn.' : 'Returned to the previously committed model.');
      setAutoGeneration(true);
      setGenerationAttempt((attempt) => attempt + 1);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Model recovery could not be saved.');
    } finally { setWorking(false); }
  };

  const cancelQueuedModel = async () => {
    setWorking(true);
    try {
      const current = session.controller.snapshot();
      const next = await session.controller.cancelModelSelection(current.fence);
      refresh(next);
      const service = await composition.opponentService;
      service.recoverCandidate('resume-prior');
      generationFenceKey.current = '';
      setAutoGeneration(true);
      setGenerationAttempt((attempt) => attempt + 1);
      setFeedback('Queued model selection cancelled. The committed opponent remains active.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The queued model could not be cancelled.');
    } finally { setWorking(false); }
  };

  const stopModelTurn = async () => {
    setAutoGeneration(false);
    try {
      const stopped = await session.controller.dispatch({
        schemaVersion: 1, kind: 'stop-model-turn', fence: session.controller.snapshot().fence,
      });
      generationController.current?.abort();
      refresh(stopped.snapshot);
      setJournalRefresh((revision) => revision + 1);
      setGenerationState('stopped');
      setGenerationDetail('Generation stopped. The clock kept running and late replies are fenced.');
    } catch (error) {
      setGenerationDetail(error instanceof Error ? error.message : 'The model turn could not be stopped.');
    }
  };

  const clocks = snapshot.clockReading?.remaining ?? {
    whiteMs: snapshot.checkpoint.clocks.banksAtAnchor.whiteMs,
    blackMs: snapshot.checkpoint.clocks.banksAtAnchor.blackMs,
  };
  const activeSide = snapshot.checkpoint.clocks.activeSide;
  const final = snapshot.checkpoint.result.kind === 'final';
  const pendingSetup = snapshot.checkpoint.result.kind === 'pending-adjudication' && activeSide === null;
  const sideKey = snapshot.position.sideToMove === 'w' ? 'white' : 'black';
  const activePlayer = snapshot.checkpoint.selections.players[sideKey];
  const isModelTurn = activePlayer.kind === 'model';
  const disabled = isLocalBoardInputDisabled(snapshot, working || isModelTurn || generationState === 'producing');
  const playerLabel = (side: 'white' | 'black') => {
    const player = snapshot.checkpoint.selections.players[side];
    return player.kind === 'model' ? player.modelRoutingId : 'Local player';
  };
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
        <div className="panel-heading"><div><h2 id="new-game-title" tabIndex={-1}>New match</h2>
          <p>Choose a local two-player game or an AI opponent. Games and credentials stay in this browser.</p></div>
          <button className="button quiet" type="button" onClick={closeSetup}>Close</button></div>
        <div className="setup-form">
          <label>Game mode<select value={matchMode} onChange={(event) => setMatchMode(event.target.value as 'local' | 'ai')}>
            <option value="local">Two players on this device</option><option value="ai">Play against an AI model</option>
          </select></label>
          {matchMode === 'ai' && <label>Your side<select value={humanSide} onChange={(event) => setHumanSide(event.target.value as typeof humanSide)}>
            <option value="white">White</option><option value="black">Black</option><option value="random">Random</option>
          </select></label>}
          <label>Starting minutes<input type="number" min="1" max="180" value={setupMinutes} onChange={(event) => setSetupMinutes(Number(event.target.value))} required /></label>
          <label>Increment seconds<input type="number" min="0" max="600" value={setupIncrement} onChange={(event) => setSetupIncrement(Number(event.target.value))} required /></label>
        </div>
          {matchMode === 'ai' && <OpponentPanel
            service={composition.opponentService} connectionStore={composition.connectionStore}
            onSelect={(selection, identity) => { setModelSelection(selection); setOpponentIdentity(identity); }} selected={modelSelection}
            onSelectionInvalidated={() => { setModelSelection(null); setOpponentIdentity(null); }}
            namespace={composition.namespace} idPrefix="new-opponent" selectLabel="Use this model for the new match"
          />}
        <form className="setup-form" onSubmit={createNewGame}>
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
          <button className="button primary" disabled={working || (matchMode === 'ai' && modelSelection === null)} type="submit">Start game</button>
        </form>
      </section>}

      <div className="match-layout">
        <section className="board-column" id="board" aria-label="Chess match board">
          <div className={'player-row ' + (snapshot.position.sideToMove === 'b' && activeSide === 'black' ? 'active' : '')}>
            <span className="player-badge dark-piece" aria-hidden="true">B</span>
            <div className="player-name"><strong>Black</strong><span>{playerLabel('black')}</span></div>
            <time className={'clock ' + (activeSide === 'black' ? 'running' : '')}
              dateTime={'PT' + Math.max(0, Math.ceil(clocks.blackMs / 1_000)) + 'S'}
              aria-label={'Black clock ' + formatClock(clocks.blackMs)}>{formatClock(clocks.blackMs)}</time>
          </div>
          <ChessBoard fen={snapshot.position.fen} orientation={orientation} snapshot={snapshot} disabled={disabled} onMove={attemptBoardMove} />
          <div className={'player-row ' + (snapshot.position.sideToMove === 'w' && activeSide === 'white' ? 'active' : '')}>
            <span className="player-badge light-piece" aria-hidden="true">W</span>
            <div className="player-name"><strong>White</strong><span>{playerLabel('white')}</span></div>
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
            <h2 id="match-status-title">{generationState === 'producing' ? 'AI is choosing a move' : statusLabel(snapshot)}</h2>
            <p>{final && snapshot.checkpoint.result.kind === 'final'
              ? 'Final result recorded: ' + snapshot.checkpoint.result.reason.replaceAll('-', ' ') + '.'
              : pendingSetup ? 'The controller is classifying this starting position before play can begin.'
                : snapshot.checkpoint.result.kind === 'pending-adjudication'
                  ? 'The result is unresolved during an exact position check. The active clock keeps running.'
                  : snapshot.clockReading?.status === 'expired'
                    ? 'A clock has expired. Its result must be reconciled by the controller.'
                    : 'Moves and clocks are committed by the local game controller. The active clock continues during requests and recovery.'}</p>
            <p className="muted">Save status: saved on this device after each accepted controller transaction.</p>
            {isModelTurn && !autoGeneration && snapshot.checkpoint.result.kind === 'unresolved' &&
              <button className="button primary" type="button" onClick={() => {
                if (opponentIdentity) retryModelTurn(); else setRecoveryOpen((open) => !open);
              }}>{opponentIdentity ? 'Resume model turn' : 'Recheck connection to resume'}</button>}
            {final && snapshot.checkpoint.result.kind === 'final' && snapshot.checkpoint.result.winner !== 'draw' &&
              (snapshot.checkpoint.selections.players.white.kind === 'model' || snapshot.checkpoint.selections.players.black.kind === 'model') &&
              <button className="button secondary" type="button" onClick={() => void beginPractice()} disabled={working}>Start practice from this position</button>}
            {generationState === 'producing' && <button className="button secondary" type="button" onClick={() => void stopModelTurn()}>Stop generation</button>}
            {!final && snapshot.modelHandoff.committed && snapshot.checkpoint.result.kind === 'unresolved' &&
              <button className="button secondary" type="button" onClick={() => setRecoveryOpen((open) => !open)}>Choose another model</button>}
            {(generationState === 'failed' || generationState === 'stopped') && isModelTurn && <div className="recovery-actions">
              <p className="error-message" role="status">{generationDetail}</p>
              {snapshot.modelHandoff.queued?.state === 'failed'
                ? <button className="button primary" type="button" onClick={() => void recoverQueuedModel('retry')} disabled={working}>Retry queued model</button>
                : <button className="button primary" type="button" onClick={retryModelTurn}>Retry model request</button>}
              {snapshot.modelHandoff.queued?.state === 'failed' && <button className="button secondary" type="button" onClick={() => void recoverQueuedModel('resume')} disabled={working}>Resume previous model</button>}
              <button className="button secondary" type="button" onClick={(event) => {
                event.currentTarget.focus();
                setRecoveryOpen((open) => !open);
              }}>Choose another model</button>
            </div>}
            {generationDetail && generationState !== 'failed' && generationState !== 'stopped' && <p className="muted">{generationDetail}</p>}
            <p className="muted">{usageLabel}</p>
            {snapshot.modelHandoff.committed && <p className="muted">Committed model: {snapshot.modelHandoff.committed.modelRoutingId}</p>}
            {snapshot.modelHandoff.producing && <p className="muted">Producing with: {snapshot.modelHandoff.producing.modelRoutingId}</p>}
            {snapshot.modelHandoff.queued && <p className="muted">Queued candidate: {snapshot.modelHandoff.queued.selection.modelRoutingId} · {snapshot.modelHandoff.queued.state}</p>}
            {snapshot.modelHandoff.queued && snapshot.modelHandoff.queued.state !== 'failed' &&
              <button className="button quiet" type="button" onClick={() => void cancelQueuedModel()} disabled={working}>Cancel queued model</button>}
            {(pendingSetup || snapshot.checkpoint.result.kind === 'pending-adjudication') &&
              <div className="button-row">
                <button className="button primary" type="button" onClick={() => void runPositionCheck()} disabled={working}>
                  {working ? 'Checking position…' : 'Continue position check'}
                </button>
                {snapshot.adjudication.status === 'running' && <button className="button secondary" type="button" onClick={() => void stopPositionCheck()}>Stop position check</button>}
              </div>}
          </section>
          <section className="detail-section" aria-labelledby="moves-title">
            <div className="panel-heading"><h2 id="moves-title">Moves</h2><span className="count">{snapshot.checkpoint.rules.moves.length}</span></div>
            <MoveRows snapshot={snapshot} />
          </section>
          <section className="detail-section" aria-labelledby="position-title">
            <div className="panel-heading"><h2 id="position-title">Position</h2></div>
            <p className="fen-value">{snapshot.position.fen}</p>
            <p className="muted">Standard chess · White: {playerLabel('white')} · Black: {playerLabel('black')}</p>
          </section>
          <section className="detail-section" aria-labelledby="editor-title">
            <div className="panel-heading"><h2 id="editor-title">Position editor</h2></div>
            <p>Use a validated FEN to start a separate local game from a custom position.</p>
            <button className="button secondary" type="button" onClick={(event) => openSetup(event.currentTarget, snapshot.position.fen)}>Edit starting position</button>
          </section>
          <section className="detail-section">
            <div className="panel-heading"><h2>Match tools</h2></div>
            <p>Undo restores the committed position without refunding clock time. New games keep this result in saved history.</p>
            <p className="muted">Archive: {generationJournal?.retainedEvents.length ?? 0} current-line events, {generationJournal?.discardedEvents.length ?? 0} discarded events.</p>
            <details className="conversation-details"><summary>Match conversation and archive</summary>
              {generationJournal?.retainedMessages.map((message) => <article key={message.messageId} className="conversation-row">
                <strong>{message.role}</strong><pre>{message.content}</pre>
              </article>)}
              {generationJournal?.discardedMessages.map((message) => <article key={message.messageId} className="conversation-row discarded">
                <strong>Discarded {message.role} after Undo</strong><pre>{message.content}</pre>
              </article>)}
              {!generationJournal?.retainedMessages.length && <p className="muted">No model conversation has been archived yet.</p>}
            </details>
            {snapshot.checkpoint.practice.mode === 'practice' && <p className="muted">Practice segment. Original result remains preserved in the saved match.</p>}
            <button className="button secondary" type="button" onClick={(event) => openSetup(event.currentTarget)}>New local game</button>
          </section>
          {recoveryOpen && <OpponentPanel
            service={composition.opponentService} connectionStore={composition.connectionStore}
            namespace={composition.namespace} idPrefix="recovery-opponent" selectLabel="Queue this model for play"
            selected={snapshot.checkpoint.selections.players.white.kind === 'model'
              ? snapshot.checkpoint.selections.players.white
              : snapshot.checkpoint.selections.players.black.kind === 'model'
                ? snapshot.checkpoint.selections.players.black : modelSelection}
            onSelect={revalidateSavedOpponent}
            onClose={() => setRecoveryOpen(false)}
          />}
        </aside>
      </div>
      <p className="feedback" role="status" aria-live="polite">{feedback}</p>
    </main>
  );
}
