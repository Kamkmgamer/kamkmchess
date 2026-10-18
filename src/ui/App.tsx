import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ChessBoard } from './ChessBoard.js';
import { EvaluationBar } from './EvaluationBar.js';
import { MoveList } from './MoveList.js';
import { useBoardHistory } from './use-board-history.js';
import type { ControllerSnapshotV1 } from '../controller/index.js';
import type { ModelSelection } from '../controller/index.js';
import { legalMoves, parsePosition } from '../rules/index.js';
import type { CoordinateMove, Promotion, Square } from '../rules/index.js';
import { isLocalBoardInputDisabled, parseCoordinateMove, startClassifiedLocalGame, submitBoardMove } from './board-input.js';
import { editorSideToMove, positionSetupError, readEditorPieces, setPositionCastlingRight, setPositionEnPassantSquare, setPositionSideToMove } from './position-editor.js';
import { PositionEditorBoard } from './PositionEditorBoard.js';
import type { LocalGameSession, MatchComposition } from './match-composition.js';
import { T3_PALETTES } from './t3-palettes.js';
import { OpponentPanel } from './OpponentPanel.js';
import { OpponentBadge } from './OpponentBadge.js';
import { EnginePanel } from './EnginePanel.js';
import { composePlayers, MATCH_MODES, seatKinds } from './match-modes.js';
import type { MatchMode } from './match-modes.js';
import { isEngineSelection, runEngineTurn } from '../engines/local.js';
import { BROWSER_ENGINES } from '../engines/browser.js';
import { engineSettings } from '../engines/local.js';
import { Icon, IconButton } from './Icon.js';
import { conciseError, conciseTurnError } from './concise-error.js';
import { controllerRevisionForConfig, matchesOpponentSelection } from './opponent-selection.js';
import { getGenerationJournal } from '../integration/generation-runner.js';
import type { GenerationJournalV1 } from '../integration/generation-runner.js';
import type { HandoffSnapshotV1, OpponentIdentityV1 } from '../opponents/index.js';

type Appearance = 'light' | 'dark' | 'system';
type PromotionMove = Omit<CoordinateMove, 'promotion'>;
interface AppProps {
  readonly composition: MatchComposition;
  readonly initialSession: LocalGameSession;
  readonly initialSnapshot: ControllerSnapshotV1;
  readonly onOpenAccount?: () => void;
}
const PROMOTIONS: readonly { value: Promotion; label: string }[] = [
  { value: 'q', label: 'Queen' }, { value: 'r', label: 'Rook' },
  { value: 'b', label: 'Bishop' }, { value: 'n', label: 'Knight' },
];
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EN_PASSANT_SQUARES = ['-', ...'abcdefgh'.split('').flatMap(file => [`${file}3`, `${file}6`])];

function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1_000));
  return Math.floor(total / 60) + ':' + (total % 60).toString().padStart(2, '0');
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

export function App({ composition, initialSession, initialSnapshot, onOpenAccount }: AppProps) {
  const [session, setSession] = useState(initialSession);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [theme, setTheme] = useState('t3-chat');
  const [appearance, setAppearance] = useState<Appearance>('system');
  const [systemDark, setSystemDark] = useState(false);
  const [coordinate, setCoordinate] = useState('');
  const [coordinateError, setCoordinateError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [promotion, setPromotion] = useState<PromotionMove | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<'mode' | 'white' | 'black' | 'options' | 'position'>('mode');
  const [tool, setTool] = useState<'settings' | 'position' | 'archive' | 'move' | null>(null);
  const [toolPage, setToolPage] = useState(0);
  const [setupFen, setSetupFen] = useState('');
  const [setupMinutes, setSetupMinutes] = useState(15);
  const [setupIncrement, setSetupIncrement] = useState(10);
  const [editorFlipped, setEditorFlipped] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [working, setWorking] = useState(false);
  const [matchMode, setMatchMode] = useState<MatchMode>('local');
  const [engineSide, setEngineSide] = useState<'white' | 'black'>('white');
  const [engineSeats, setEngineSeats] = useState<Record<'white' | 'black', ModelSelection | null>>({ white: null, black: null });
  const [aiSeats, setAiSeats] = useState<Record<'white' | 'black', ModelSelection | null>>({ white: null, black: null });
  const checkedIdentities = useRef(new Map<string, OpponentIdentityV1>());
  const [humanSide, setHumanSide] = useState<'white' | 'black' | 'random'>('white');
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [opponentIdentity, setOpponentIdentity] = useState<OpponentIdentityV1 | null>(null);
  const [handoff, setHandoff] = useState<HandoffSnapshotV1>({ committed: null, queued: null, producing: null });
  const [autoGeneration, setAutoGeneration] = useState(true);
  const [generationAttempt, setGenerationAttempt] = useState(0);
  const [generationState, setGenerationState] = useState<'idle' | 'producing' | 'failed' | 'stopped'>('idle');
  const [generationDetail, setGenerationDetail] = useState('');
  const [generationJournal, setGenerationJournal] = useState<GenerationJournalV1 | null>(null);
  const [journalRefresh, setJournalRefresh] = useState(0);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const history = useBoardHistory(snapshot, !setupOpen && !promotion && !recoveryOpen && !tool);
  const generationController = useRef<AbortController | null>(null);
  const practiceController = useRef<AbortController | null>(null);
  const generationFenceKey = useRef('');
  const sessionRef = useRef(session);
  const setupReturnFocus = useRef<HTMLElement | null>(null);
  const setupKinds = seatKinds(matchMode, 'white', engineSide);
  const setupSelections: Record<'white' | 'black', ModelSelection | null> = matchMode === 'ai' ? { white: null, black: modelSelection }
    : matchMode === 'human-engine' ? { white: null, black: engineSeats.black }
      : { white: setupKinds.white === 'engine' ? engineSeats.white : aiSeats.white,
        black: setupKinds.black === 'engine' ? engineSeats.black : aiSeats.black };
  const setupReady = matchMode === 'local' || (matchMode === 'ai' || matchMode === 'human-engine'
    ? setupSelections.black !== null : setupSelections.white !== null && setupSelections.black !== null);
  const refresh = useCallback((next: ControllerSnapshotV1) => {
    setSnapshot(next);
    if (next.checkpoint.result.kind === 'final') setFeedback(statusLabel(next));
  }, []);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => () => {
    generationController.current?.abort();
    practiceController.current?.abort();
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
    if (current.checkpoint.result.kind !== 'unresolved' || current.checkpoint.clocks.activeSide !== null) return;
    const players = current.checkpoint.selections.players;
    const selection = players.white.kind === 'model' ? players.white : players.black.kind === 'model' ? players.black : undefined;
    if (selection && selection.diagnostic !== 'passed-current-session') return;
    if (Object.values(players).some(player => player.kind === 'model' && player.diagnostic !== 'passed-current-session')) return;
    void startClassifiedLocalGame(session.controller, current).then(refresh).catch(error => {
      setFeedback(error instanceof Error ? error.message : 'The game could not start.');
    });
  }, [session, refresh, snapshot.checkpoint.result.kind, snapshot.checkpoint.clocks.activeSide]);

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
      setGenerationDetail('Thinking…');
      void (async () => {
        let service: Awaited<typeof composition.opponentService> | null = null;
        let continueAutomatically = false;
        try {
          if (isEngineSelection(queuedSelection)) {
            setGenerationDetail('Thinking…');
            const accepted = await runEngineTurn(session.controller, abort!.signal);
            if (sessionRef.current.gameId !== session.gameId) return;
            setGenerationState(accepted ? 'idle' : 'failed');
            setGenerationDetail(accepted ? 'Move saved.' : 'Move unavailable. Retry.');
            setJournalRefresh(revision => revision + 1);
            return;
          }
          const identities = [...checkedIdentities.current.values(), opponentIdentity, handoff.producing, handoff.queued?.identity, handoff.committed];
          let identity = identities.find(candidate => matchesOpponentSelection(candidate, queuedSelection)) ?? null;
          const store = await composition.connectionStore;
          const profile = await store.getProfile(composition.namespace, queuedSelection.connectionId);
          if (!profile) throw new Error('The model connection was removed.');
          service = await composition.opponentService;
          const credentials = await store.resolveCredentials(composition.namespace, profile);
          if (!identity || identity.configRevision !== profile.configRevision || identity.protocol !== profile.protocol ||
              credentials.status !== 'bound' || identity.credentialRevision !== credentials.credentials.credentialRevision) {
            setGenerationDetail('Checking connection…');
            const result = await service.runCompatibilityDiagnostic({ profileId: profile.id, modelId: queuedSelection.modelRoutingId }, abort!.signal);
            if (abort!.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
            if (result.evidence.state !== 'passed-current-session') throw new Error(result.evidence.detail);
            const prepared = await service.prepareSelection({ profileId: profile.id, modelId: queuedSelection.modelRoutingId });
            identity = prepared.queued?.identity ?? prepared.committed;
            if (!identity || identity.modelId !== queuedSelection.modelRoutingId || identity.profileId !== profile.id) throw new Error('Connection changed.');
            const checked = { ...queuedSelection, diagnostic: 'passed-current-session' as const, configurationRevision: controllerRevisionForConfig(profile.configRevision), protocol: profile.protocol };
            const next = await session.controller.queueModelSelection(session.controller.snapshot().fence, checked);
            if (abort!.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
            refresh(next);
            checkedIdentities.current.set(JSON.stringify(checked), identity);
            identities.push(identity);
            setOpponentIdentity(identity);
          }
          service.setProducingSelection(identity);
          const result = await composition.runModelTurn(session, (requested) => {
            const expected = identities.find((candidate) => matchesOpponentSelection(candidate, requested));
            return expected?.configRevision ?? '';
          }, abort!.signal);
          if (sessionRef.current.gameId !== session.gameId) return;
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
              setFeedback('Move saved.');
            }
          } else if (result.kind === 'interrupted' || result.kind === 'capacity-rejected') {
            setGenerationState(abort!.signal.aborted ? 'stopped' : 'failed');
            setGenerationDetail(result.kind === 'interrupted'
              ? (result.protocol?.httpStatus ?? 0) >= 400
                ? `Provider returned HTTP ${result.protocol!.httpStatus}.`
                : result.protocol && result.protocol.terminal !== 'complete'
                  ? `Reply ${result.protocol.terminal}.`
                  : result.detail ?? `Generation ${result.reason}.`
              : result.capacity.status === 'rejected' && result.capacity.reason === 'capacity-unverifiable'
                ? 'The request token capacity could not be verified for this model.'
                : 'The chess position request exceeds the configured request limit. Choose another model or start a new game.');
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
    setFeedback('');
    try {
      const result = await submitBoardMove(session.controller, session.controller.snapshot(), move);
      refresh(result.snapshot);
      if (result.kind === 'accepted') setJournalRefresh((revision) => revision + 1);
      if (result.kind === 'rejected') {
        setFeedback(result.reason === 'illegal-move' ? 'Illegal move.' : 'Position changed. Retry.');
      } else if (result.kind === 'expired') setFeedback('Time expired.');
      else if (result.kind === 'clock-reconciliation-required') setFeedback('Checking clock…');
      else setFeedback('Move saved.');
      return result.kind === 'accepted';
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The move could not be saved.');
      return false;
    } finally { setWorking(false); }
  }, [refresh, session.controller]);

  const closeSetup = () => {
    setSetupOpen(false);
    window.setTimeout(() => setupReturnFocus.current?.focus(), 0);
  };
  const openSetup = (trigger: HTMLElement, fen?: string) => {
    setupReturnFocus.current = trigger;
    setTool(null);
    setSetupStep(fen ? 'position' : 'mode');
    setSetupError('');
    setSetupFen(fen ?? STANDARD_FEN);
    setEditorFlipped(false);
    setSetupOpen(true);
    window.setTimeout(() => document.getElementById('new-game-title')?.focus(), 0);
  };

  const attemptBoardMove = useCallback((move: PromotionMove) => {
    const hasPromotions = legalMoves(snapshot.position).some((candidate) =>
      candidate.from === move.from && candidate.to === move.to && candidate.promotion);
    if (hasPromotions) {
      setPromotion(move);
      setFeedback('Choose a piece for promotion from ' + move.from + ' to ' + move.to + '.');
      return Promise.resolve(false);
    }
    return submitMove(move);
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
      setCoordinateError('Use e2e4 format.');
      return;
    }
    const matchingMoves = legalMoves(snapshot.position).filter((candidate) =>
      candidate.from === move.from && candidate.to === move.to);
    if (!matchingMoves.length) { setCoordinateError('Illegal move.'); return; }
    setCoordinateError('');
    if (matchingMoves.some((candidate) => candidate.promotion) && move.promotion === undefined) {
      setPromotion({ from: move.from, to: move.to });
      setFeedback('Promote a pawn.');
      setTool(null);
      return;
    }
    void submitMove(move).then(accepted => { if (accepted) { setTool(null); setCoordinate(''); } else setCoordinateError('Move unavailable.'); });
  };

  const revalidateSavedOpponent = async (selection: ModelSelection, identity: OpponentIdentityV1) => {
    const saved = snapshot.checkpoint.selections.players.white.kind === 'model' && snapshot.checkpoint.selections.players.black.kind === 'model'
      ? snapshot.checkpoint.selections.players[sideKey]
      : snapshot.checkpoint.selections.players.white.kind === 'model'
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
    checkedIdentities.current.set(JSON.stringify(selection), identity);
    setOpponentIdentity(identity);
    setRecoveryOpen(false);
    if (!final) setAutoGeneration(true);
    setGenerationState('idle');
    setGenerationDetail('Model ready.');
  };

  const beginPractice = async () => {
    const savedModel = snapshot.checkpoint.selections.players.white.kind === 'model'
      ? snapshot.checkpoint.selections.players.white
      : snapshot.checkpoint.selections.players.black.kind === 'model' ? snapshot.checkpoint.selections.players.black : null;
    if (!savedModel) return;
    practiceController.current?.abort();
    const abort = new AbortController(); practiceController.current = abort;
    setWorking(true);
    try {
      const store = await composition.connectionStore;
      const profile = await store.getProfile(composition.namespace, savedModel.connectionId);
      if (!profile) throw new Error('Connection removed.');
      const credentials = await store.resolveCredentials(composition.namespace, profile);
      let identity = [...checkedIdentities.current.values(), opponentIdentity].find(candidate =>
        matchesOpponentSelection(candidate, savedModel) && candidate?.configRevision === profile.configRevision &&
        credentials.status === 'bound' && candidate.credentialRevision === credentials.credentials.credentialRevision);
      const service = await composition.opponentService;
      if (!identity) {
        const result = await service.runCompatibilityDiagnostic({ profileId: profile.id, modelId: savedModel.modelRoutingId }, abort.signal);
        if (abort.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
        if (result.evidence.state !== 'passed-current-session') throw new Error(result.evidence.detail);
        const prepared = await service.prepareSelection({ profileId: profile.id, modelId: savedModel.modelRoutingId });
        identity = prepared.queued?.identity ?? prepared.committed;
        if (!identity || identity.profileId !== profile.id || identity.modelId !== savedModel.modelRoutingId) throw new Error('Connection changed.');
      }
      if (abort.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
      const checked = { ...savedModel, protocol: profile.protocol, configurationRevision: controllerRevisionForConfig(profile.configRevision), diagnostic: 'passed-current-session' as const };
      const practiced = await session.controller.beginPractice(session.controller.snapshot().fence, checked);
      if (abort.signal.aborted || sessionRef.current.gameId !== session.gameId) return;
      checkedIdentities.current.set(JSON.stringify(checked), identity);
      service.setCommittedSelection(identity);
      service.recoverCandidate('resume-prior');
      setModelSelection(checked); setOpponentIdentity(identity);
      refresh(practiced); setJournalRefresh(revision => revision + 1);
      setAutoGeneration(true); setGenerationState('idle'); setGenerationDetail('');
      setFeedback('Practice started.');
    } catch (error) {
      if (abort.signal.aborted) return;
      setGenerationState('failed'); setGenerationDetail(error instanceof Error ? error.message : 'Practice could not start.');
    } finally { if (practiceController.current === abort) { practiceController.current = null; setWorking(false); } }
  };

  const createNewGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupError('');
    let configuredPlayers;
    try {
      configuredPlayers = composePlayers(matchMode, humanSide, engineSide, setupSelections);
    } catch (error) { setSetupError(error instanceof Error ? error.message : 'Check both opponents before starting.'); return; }
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
        players: configuredPlayers,
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
      const started = await startClassifiedLocalGame(nextSession.controller, nextSession.controller.snapshot());
      refresh(started);
      setOrientation(started.checkpoint.selections.players.white.kind === 'model' && started.checkpoint.selections.players.black.kind === 'human' ? 'black' : 'white');
      if (matchMode === 'ai' && opponentIdentity) {
        const service = await composition.opponentService;
        service.setCommittedSelection(opponentIdentity);
        service.recoverCandidate('resume-prior');
      }
      setFeedback(started.checkpoint.clocks.activeSide === null
        ? 'New game saved. ' + statusLabel(started) + '.'
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
      setFeedback('Move undone.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Undo is unavailable.');
    } finally { setWorking(false); }
  };

  const retryModelTurn = () => {
    generationFenceKey.current = '';
    setGenerationState('idle');
    setGenerationDetail('Retrying…');
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
      setGenerationDetail(action === 'retry' ? 'Retrying…' : 'Previous model restored.');
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
      setFeedback('Model change cancelled.');
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
      setGenerationDetail('Paused.');
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
  const sideKey = snapshot.position.sideToMove === 'w' ? 'white' : 'black';
  const activePlayer = snapshot.checkpoint.selections.players[sideKey];
  const isModelTurn = activePlayer.kind === 'model';
  const disabled = history.reviewing || promotion !== null || isLocalBoardInputDisabled(snapshot, working || isModelTurn || generationState === 'producing');
  const players = snapshot.checkpoint.selections.players;
  const spectator = players.white.kind === 'model' && players.black.kind === 'model';
  const recoverySelection = spectator ? activePlayer : players.white.kind === 'model' ? players.white : players.black;
  const humanColor = players.white.kind === 'human' && players.black.kind === 'model' ? 'white'
    : players.black.kind === 'human' && players.white.kind === 'model' ? 'black' : null;
  const premoveColor = !history.reviewing && !final && !setupOpen && !promotion &&
    snapshot.readiness === 'ready' && snapshot.clockReading?.status === 'running' ? humanColor : null;
  const allowPremove = premoveColor !== null && isModelTurn && !working;
  const playerLabel = (side: 'white' | 'black') => {
    const player = snapshot.checkpoint.selections.players[side];
    return isEngineSelection(player) ? BROWSER_ENGINES[engineSettings(player).engineId].name
      : player.kind === 'model' ? player.modelRoutingId : side === 'white' ? 'White' : 'Black';
  };
  let editorPieces: ReturnType<typeof readEditorPieces> | null = null;
  let editorSide: 'w' | 'b' = 'w';
  try {
    editorPieces = readEditorPieces(setupFen || STANDARD_FEN);
    editorSide = editorSideToMove(setupFen || STANDARD_FEN);
  } catch { /* The FEN field reports the validation error on submit. */ }

  const setupSide = setupStep === 'white' ? 'white' : 'black';
  const singleOpponent = matchMode === 'ai' || matchMode === 'human-engine';
  const nextSetup = () => {
    setSetupError('');
    if (setupStep === 'mode') setSetupStep(matchMode === 'local' ? 'options' : singleOpponent ? 'black' : 'white');
    else if (setupStep === 'white') setSetupStep('black');
    else setSetupStep('options');
  };
  const previousSetup = () => {
    setSetupError('');
    if (setupStep === 'position') setSetupStep('options');
    else if (setupStep === 'options') setSetupStep(matchMode === 'local' ? 'mode' : 'black');
    else if (setupStep === 'black' && !singleOpponent) setSetupStep('white');
    else setSetupStep('mode');
  };
  const chosenKind = setupKinds[setupSide];
  const chosenSelection = setupSelections[setupSide];
  const archiveText = [
    ...(generationJournal?.retainedMessages.map(message => `${message.role}: ${message.content}`) ?? []),
    ...(generationJournal?.discardedMessages.map(message => `Undone ${message.role}: ${message.content}`) ?? []),
  ].join('\n\n');
  const archiveWords = archiveText.split(/\s+/).filter(Boolean);
  const openTool = (next: typeof tool) => { setTool(next); setToolPage(0); setFeedback(''); setCoordinateError(''); };
  const focusPage = setupOpen || tool !== null || recoveryOpen;
  return <main className="workspace minimal-workspace">
    {!focusPage && <header className="topbar">
      <a className="wordmark" href="#board" aria-label="Kamkm Chess home">kamkm chess</a>
      <div className="topbar-actions">
        {onOpenAccount && <IconButton icon="account" label="Account and saved games" onClick={onOpenAccount} />}
        <IconButton icon="settings" label="Settings" onClick={() => openTool('settings')} />
        <button className="button primary" type="button" onClick={event => openSetup(event.currentTarget)} aria-label="New game">New</button></div>
    </header>}
    {setupOpen && <section className={`focus-page setup-panel${setupStep === 'position' ? ' position-editor-page' : ''}`} aria-label="New game">
      <nav className="focus-nav" aria-label="Game setup"><IconButton icon="back" label="Back" onClick={previousSetup} disabled={setupStep === 'mode'} />
        <span className="setup-dots" aria-label={`Step ${setupStep}`}><i className={setupStep === 'mode' ? 'active' : ''} /><i className={setupStep === 'white' || setupStep === 'black' ? 'active' : ''} /><i className={setupStep === 'options' || setupStep === 'position' ? 'active' : ''} /></span>
        <IconButton icon="close" label="Close" onClick={closeSetup} /></nav>
      {setupStep === 'mode' ? <>
        <h2 id="new-game-title" tabIndex={-1}>New game</h2>
        <div className="connection-form">
          <label className="sr-label">Game mode<select aria-label="Game mode" value={matchMode} onChange={event => { setMatchMode(event.target.value as MatchMode); setSetupError(''); }}>{MATCH_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
          {singleOpponent && <label>Side<select aria-label="Your side" value={humanSide} onChange={event => setHumanSide(event.target.value as typeof humanSide)}><option value="white">White</option><option value="black">Black</option><option value="random">Random</option></select></label>}
          {matchMode === 'engine-ai' && <label>Engine<select aria-label="Engine plays" value={engineSide} onChange={event => setEngineSide(event.target.value as typeof engineSide)}><option value="white">White</option><option value="black">Black</option></select></label>}
          <button className="button primary" onClick={nextSetup}>Next</button>
        </div>
      </> : setupStep === 'white' || setupStep === 'black' ? <>
        {!singleOpponent && <span className="seat-indicator" aria-label={`${setupSide} opponent`}><span className={`player-badge ${setupSide === 'white' ? 'light' : 'dark'}-piece`} aria-hidden="true"><Icon name="account" /></span></span>}
        {chosenKind === 'engine' ? <EnginePanel key={`setup-${setupSide}-engine`} label={singleOpponent ? 'Your engine opponent' : `${setupSide === 'white' ? 'White' : 'Black'} engine`} selected={engineSeats[setupSide]} onSelect={selection => setEngineSeats(current => ({ ...current, [setupSide]: selection }))} />
          : <OpponentPanel key={`setup-${setupSide}-ai`} service={composition.opponentService} connectionStore={composition.connectionStore} namespace={composition.namespace} idPrefix={`new-${setupSide}-ai`} selected={chosenSelection}
            onSelectionInvalidated={() => { if (singleOpponent) { setModelSelection(null); setOpponentIdentity(null); } else setAiSeats(current => ({ ...current, [setupSide]: null })); }}
            onSelect={(selection, identity) => { checkedIdentities.current.set(JSON.stringify(selection), identity); if (singleOpponent) { setModelSelection(selection); setOpponentIdentity(identity); } else setAiSeats(current => ({ ...current, [setupSide]: selection })); }} />}
        <div className="focus-footer"><IconButton icon="next" label="Next" disabled={!chosenSelection} onClick={nextSetup} /></div>
      </> : <form onSubmit={createNewGame} className={`connection-form${setupStep === 'position' ? ' position-editor-form' : ''}`}>
        {setupStep === 'options' ? <>
          <h2>Time</h2>
          <label>Minutes<input aria-label="Starting minutes" type="number" min="1" max="180" required value={setupMinutes} onChange={event => setSetupMinutes(Number(event.target.value))} /></label>
          <label>Increment<input aria-label="Increment seconds" type="number" min="0" max="600" required value={setupIncrement} onChange={event => setSetupIncrement(Number(event.target.value))} /></label>
          <div className="button-row"><button className="button primary" aria-label="Start game" disabled={working || !setupReady} type="submit">Play</button><IconButton icon="board" label="Custom starting position" onClick={() => setSetupStep('position')} /></div>
        </> : <>
          <h2 id="new-game-title" tabIndex={-1}>Board editor</h2>
          <div className="position-editor-layout">
            <PositionEditorBoard fen={setupFen || STANDARD_FEN} flipped={editorFlipped} onFlip={() => setEditorFlipped(value => !value)}
              onChange={fen => { setSetupFen(fen); setSetupError(''); }} onError={error => setSetupError(positionSetupError(error))} />
            <aside className="editor-control-panel" aria-label="Position settings">
              <label>To move<select aria-label="Side to move" disabled={!editorPieces} value={editorSide} onChange={event => { try { setSetupFen(setPositionSideToMove(setupFen || STANDARD_FEN, event.target.value as 'w' | 'b')); setSetupError(''); } catch (error) { setSetupError(positionSetupError(error)); } }}><option value="w">White to play</option><option value="b">Black to play</option></select></label>
              <fieldset className="editor-castling-rights"><legend>Castling rights</legend>{(['K', 'Q', 'k', 'q'] as const).map(right => <label key={right}><input type="checkbox" aria-label={`${right === 'K' || right === 'Q' ? 'White' : 'Black'} ${right === 'K' || right === 'k' ? 'king' : 'queen'}-side castling`} checked={(setupFen.split(/\s+/)[2] ?? '-').includes(right)} onChange={event => { try { setSetupFen(setPositionCastlingRight(setupFen || STANDARD_FEN, right, event.target.checked)); setSetupError(''); } catch (error) { setSetupError(positionSetupError(error)); } }} />{right === 'K' || right === 'k' ? 'King-side' : 'Queen-side'} ({right === 'K' || right === 'Q' ? 'White' : 'Black'})</label>)}</fieldset>
              <label>En passant<select aria-label="En passant target" value={setupFen.split(/\s+/)[3] ?? '-'} onChange={event => { try { setSetupFen(setPositionEnPassantSquare(setupFen || STANDARD_FEN, event.target.value as Square | '-')); setSetupError(''); } catch (error) { setSetupError(positionSetupError(error)); } }}>{EN_PASSANT_SQUARES.map(square => <option key={square} value={square}>{square === '-' ? 'None' : square}</option>)}</select></label>
              <div className="editor-position-actions"><button className="button quiet" type="button" onClick={() => { setSetupFen(STANDARD_FEN); setSetupError(''); }}>Starting position</button>
                <button className="button quiet" type="button" onClick={() => { setSetupFen('8/8/8/8/8/8/8/8 w - - 0 1'); setSetupError(''); }}>Clear board</button></div>
              <div className="position-editor-footer">{setupError && <p role="alert">{conciseError(new Error(setupError))}</p>}<button className="button primary" type="button" onClick={() => setSetupStep('options')}>Done</button></div>
            </aside>
            <div className="editor-fen-field"><label htmlFor="editor-fen">FEN</label><div className="editor-fen-row"><textarea id="editor-fen" aria-label="Custom starting position (six-field FEN)" rows={2} value={setupFen} onChange={event => { setSetupFen(event.target.value); setSetupError(''); }} /><button className="button quiet" type="button" onClick={() => { if (navigator.clipboard) void navigator.clipboard.writeText(setupFen).catch(() => setSetupError('Select the FEN and copy it manually.')); else setSetupError('Select the FEN and copy it manually.'); }}>Copy</button></div></div>
          </div>
        </>}
        {setupStep === 'options' && setupError && <p role="alert">{conciseError(new Error(setupError))}</p>}
      </form>}
    </section>}
    {tool && !setupOpen && <section className="focus-page" aria-label="Match tools">
      <div className="panel-heading"><h2>{tool === 'move' ? 'Move' : tool.charAt(0).toUpperCase() + tool.slice(1)}</h2><IconButton icon="close" label="Close" onClick={() => setTool(null)} /></div>
      {tool === 'settings' && <div className="connection-form">
        <label>Theme<select value={theme} onChange={event => setTheme(event.target.value)}>{T3_PALETTES.map(palette => <option key={palette.id} value={palette.id}>{palette.label}</option>)}</select></label>
        <label>Appearance<select value={appearance} onChange={event => setAppearance(event.target.value as Appearance)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <div className="button-row"><IconButton icon="board" label="Position" onClick={() => openTool('position')} /><IconButton icon="archive" label="Conversation and archive" onClick={() => openTool('archive')} /><IconButton icon="download" label="Download match archive" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify({ checkpoint: snapshot.checkpoint, conversation: generationJournal }, null, 2)], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = `chess-${session.gameId}.json`; link.click(); URL.revokeObjectURL(url);
        }} /></div>
      </div>}
      {tool === 'move' && <form className="coordinate-form" onSubmit={submitCoordinate}><label className="sr-label" htmlFor="coordinate-move">Enter a move by coordinates</label><input id="coordinate-move" aria-label="Enter a move by coordinates" value={coordinate} onChange={event => { setCoordinate(event.target.value); setCoordinateError(''); }} placeholder="e2e4" autoComplete="off" /><button className="button primary" type="submit" aria-label="Play move" disabled={disabled}>Play</button>{coordinateError && <p role="alert">{coordinateError}</p>}</form>}
      {tool === 'position' && <><p className="fen-value">{history.position.fen}</p><IconButton icon="board" label="Edit starting position" onClick={event => openSetup(event.currentTarget, history.position.fen)} /></>}
      {tool === 'archive' && <><pre className="archive-page">{archiveWords.length ? archiveWords.slice(toolPage * 8, (toolPage + 1) * 8).join(' ') : 'No conversation yet.'}</pre><div className="button-row"><IconButton icon="back" label="Previous page" disabled={toolPage === 0} onClick={() => setToolPage(page => page - 1)} /><IconButton icon="next" label="Next page" disabled={(toolPage + 1) * 8 >= archiveWords.length} onClick={() => setToolPage(page => page + 1)} /></div></>}
    </section>}
    {recoveryOpen && !setupOpen && !tool && <section className="focus-page" aria-label={isEngineSelection(recoverySelection) ? "Choose another engine" : "Choose another model"}>
      <div className="focus-nav"><IconButton icon="close" label="Close" onClick={() => setRecoveryOpen(false)} /></div>
      {isEngineSelection(recoverySelection) ? <EnginePanel key={`recovery-${sideKey}`} label="Engine setup" selected={recoverySelection} onSelect={selection => {
        if (!selection) return;
        void session.controller.queueModelSelection(session.controller.snapshot().fence, selection).then(next => { refresh(next); setRecoveryOpen(false); generationFenceKey.current = ''; setGenerationState('idle'); setAutoGeneration(true); setGenerationAttempt(attempt => attempt + 1); }).catch(error => setFeedback(conciseError(error)));
      }} /> : <OpponentPanel service={composition.opponentService} connectionStore={composition.connectionStore} namespace={composition.namespace} selected={recoverySelection.kind === 'model' ? recoverySelection : modelSelection} onSelect={revalidateSavedOpponent} />}
    </section>}
    <div className="match-layout" hidden={focusPage} data-practice={snapshot.checkpoint.practice.mode} data-committed-model={snapshot.modelHandoff.committed?.modelRoutingId} data-queued-model={snapshot.modelHandoff.queued?.selection.modelRoutingId}>
      <section className="board-column" id="board" aria-label="Chess match board">
        {(['black', 'white'] as const).map(side => <div key={side} className={`player-row ${side} ${activeSide === side ? 'active' : ''}`}>
          <OpponentBadge player={players[side]} side={side} /><div className="player-name"><strong title={playerLabel(side)}>{playerLabel(side)}</strong></div>
          <time className={`clock ${activeSide === side ? 'running' : ''}`} aria-label={`${side} clock ${formatClock(clocks[`${side}Ms`])}`}>{formatClock(clocks[`${side}Ms`])}</time>
        </div>)}
        <div className={`playing-board${spectator ? ' with-evaluation' : ''}`}>
          {spectator && <EvaluationBar key={session.gameId} orientation={orientation} startingFen={snapshot.checkpoint.rules.startingFen}
            moves={snapshot.checkpoint.rules.moves.slice(0, history.ply).map(move => `${move.from}${move.to}${move.promotion ?? ''}`).join(' ')} />}
          <ChessBoard orientation={orientation} snapshot={snapshot} disabled={disabled} onMove={attemptBoardMove} view={history} premoveColor={premoveColor} allowPremove={allowPremove} />
        </div>
        <nav className="board-tools" aria-label="Board tools"><IconButton icon="flip" label="Flip board" onClick={() => setOrientation(side => side === 'white' ? 'black' : 'white')} />
          <IconButton icon="undo" label="Undo" onClick={() => void undo()} disabled={working || snapshot.readiness !== 'ready' || !snapshot.checkpoint.rules.moves.length || snapshot.checkpoint.result.kind !== 'unresolved'} />
          <IconButton icon="code" label="Type a move" disabled={disabled} onClick={() => openTool('move')} /></nav>
        <div className="match-status" role="status" aria-description={generationDetail || feedback}>
          <h2 className="status-heading" aria-label={generationState === 'producing' ? isEngineSelection(activePlayer) ? 'Engine is choosing a move' : 'AI is choosing a move' : undefined}>{history.reviewing ? `${history.ply}/${history.count}` : generationState === 'stopped' ? 'Paused' : generationState === 'failed' ? conciseTurnError(new Error(generationDetail)) : generationState === 'producing' ? generationDetail === 'Checking connection…' ? 'Checking…' : 'Thinking…' : statusLabel(snapshot)}</h2>
          <div className="button-row">
            {generationState === 'producing' && <IconButton icon="stop" label="Stop generation" onClick={() => void stopModelTurn()} />}
            {isModelTurn && !autoGeneration && !final && generationState === 'idle' && <IconButton icon="play" label={isEngineSelection(activePlayer) ? "Resume engine turn" : "Resume model turn"} onClick={retryModelTurn} />}
            {(generationState === 'failed' || generationState === 'stopped') && isModelTurn && <>
              <IconButton icon="play" label={snapshot.modelHandoff.queued?.state === "failed" ? "Retry queued model" : isEngineSelection(activePlayer) ? "Retry engine turn" : "Retry model request"} onClick={() => { if (snapshot.modelHandoff.queued?.state === 'failed') void recoverQueuedModel('retry'); else retryModelTurn(); }} />
              {snapshot.modelHandoff.queued?.state === 'failed' && <IconButton icon="undo" label="Resume previous model" onClick={() => void recoverQueuedModel('resume')} />}
            </>}
            {!final && Object.values(players).some(player => player.kind === 'model') && <IconButton icon="change" label={isEngineSelection(recoverySelection) ? "Choose another engine" : "Choose another model"} onClick={() => setRecoveryOpen(true)} />}
            {snapshot.modelHandoff.queued && <IconButton icon="close" label="Cancel queued model" onClick={() => void cancelQueuedModel()} />}
            {final && snapshot.checkpoint.result.kind === 'final' && snapshot.checkpoint.result.winner !== 'draw' && !spectator && !Object.values(players).some(isEngineSelection) && Object.values(players).some(player => player.kind === 'model') && <IconButton icon="play" label="Start practice from this position" disabled={working} onClick={() => void beginPractice()} />}
          </div>
        </div>
        {promotion && <section className="promotion-panel" aria-label="Promotion"><div className="promotion-options">{PROMOTIONS.map(piece => <button className="button quiet" type="button" key={piece.value} aria-label={piece.label} autoFocus={piece.value === 'q'} onClick={() => selectPromotion(piece.value)}><img alt="" width="36" height="36" src={new URL(`./pieces/${snapshot.position.sideToMove}${piece.value}.svg`, import.meta.url).href} /></button>)}<IconButton icon="close" label="Cancel promotion" onClick={() => setPromotion(null)} /></div></section>}
      </section>
      <aside className="moves-sidebar" aria-labelledby="moves-title">
        <div className="moves-heading"><h2 id="moves-title">Moves</h2><span className="count" aria-label={`Move ${history.ply} of ${history.count}`}>{history.ply}/{history.count}</span></div>
        <MoveList moves={snapshot.checkpoint.rules.moves} selectedPly={history.ply} visible={!focusPage} onSelect={history.select} />
        <nav className="history-controls" aria-label="Move history"><div className="button-row">
          <IconButton icon="first" label="First" onClick={() => history.select(0)} disabled={history.ply === 0} aria-keyshortcuts="Home" />
          <IconButton icon="back" label="Previous" onClick={() => history.select(history.ply - 1)} disabled={history.ply === 0} aria-keyshortcuts="ArrowLeft" />
          <IconButton icon="next" label="Next" onClick={() => history.select(history.ply + 1)} disabled={!history.reviewing} aria-keyshortcuts="ArrowRight" />
          <IconButton icon="last" label="Live" onClick={() => history.select(history.count)} disabled={!history.reviewing} aria-keyshortcuts="End" />
        </div></nav>
      </aside>
    </div>
    <p className="sr-only" role="status" aria-live="polite">{feedback}</p>
  </main>;
}
