import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ControllerSnapshotV1, ModelSelection } from '../controller/index.js';
import type { OpponentIdentityV1 } from '../opponents/index.js';
import type { LocalGameSession, MatchComposition } from './match-composition.js';
import { parsePosition } from '../rules/index.js';
import type { Square } from '../rules/index.js';
import { startClassifiedLocalGame } from './board-input.js';
import { editorSideToMove, positionSetupError, readEditorPieces, setPositionCastlingRight, setPositionEnPassantSquare, setPositionSideToMove } from './position-editor.js';
import { PositionEditorBoard } from './PositionEditorBoard.js';
import { OpponentPanel } from './OpponentPanel.js';
import { EnginePanel } from './EnginePanel.js';
import { composePlayers, MATCH_MODES, seatKinds } from './match-modes.js';
import type { MatchMode } from './match-modes.js';
import { conciseError } from './concise-error.js';
import './new-game-setup.css';

export interface StartedSidebarGame {
  readonly session: LocalGameSession;
  readonly snapshot: ControllerSnapshotV1;
  readonly identities: readonly OpponentIdentityV1[];
  readonly draft: NewGameDraft;
}
export interface NewGameDraft {
  readonly mode: MatchMode;
  readonly minutes: number;
  readonly increment: number;
  readonly engineSide: 'white' | 'black';
  readonly humanSide: 'white' | 'black' | 'random';
  readonly engineSeats: Record<'white' | 'black', ModelSelection | null>;
  readonly aiSeats: Record<'white' | 'black', ModelSelection | null>;
  readonly modelSelection: ModelSelection | null;
  readonly opponentIdentity: OpponentIdentityV1 | null;
}
interface NewGameSetupProps {
  readonly composition: MatchComposition;
  readonly startingFen?: string | undefined;
  readonly draft?: NewGameDraft | undefined;
  readonly focus?: 'opponent' | 'time' | 'position' | null | undefined;
  readonly onStarted: (game: StartedSidebarGame) => void;
}
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EN_PASSANT_SQUARES = ['-', ...'abcdefgh'.split('').flatMap(file => [`${file}3`, `${file}6`])];

export function NewGameSetup({ composition, startingFen, draft, focus, onStarted }: NewGameSetupProps) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => document.getElementById(focus === 'time' ? 'starting-minutes' : 'game-mode')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const [editorOpen, setEditorOpen] = useState(Boolean(startingFen) || focus === 'position');
  const [setupFen, setSetupFen] = useState(startingFen ?? STANDARD_FEN);
  const [setupMinutes, setSetupMinutes] = useState(draft?.minutes ?? 15);
  const [setupIncrement, setSetupIncrement] = useState(draft?.increment ?? 10);
  const [editorFlipped, setEditorFlipped] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [working, setWorking] = useState(false);
  const [matchMode, setMatchMode] = useState<MatchMode>(focus === 'opponent' ? 'ai' : draft?.mode ?? 'local');
  const [engineSide, setEngineSide] = useState<'white' | 'black'>(draft?.engineSide ?? 'white');
  const [engineSeats, setEngineSeats] = useState<Record<'white' | 'black', ModelSelection | null>>(draft?.engineSeats ?? { white: null, black: null });
  const [aiSeats, setAiSeats] = useState<Record<'white' | 'black', ModelSelection | null>>(draft?.aiSeats ?? { white: null, black: null });
  const checkedIdentities = useRef(new Map<string, OpponentIdentityV1>());
  const [humanSide, setHumanSide] = useState<'white' | 'black' | 'random'>(draft?.humanSide ?? 'white');
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(draft?.modelSelection ?? null);
  const [opponentIdentity, setOpponentIdentity] = useState<OpponentIdentityV1 | null>(draft?.opponentIdentity ?? null);
  const setupKinds = seatKinds(matchMode, 'white', engineSide);
  const setupSelections: Record<'white' | 'black', ModelSelection | null> = matchMode === 'ai' ? { white: null, black: modelSelection }
    : matchMode === 'human-engine' ? { white: null, black: engineSeats.black }
      : { white: setupKinds.white === 'engine' ? engineSeats.white : aiSeats.white,
        black: setupKinds.black === 'engine' ? engineSeats.black : aiSeats.black };
  const setupReady = matchMode === 'local' || (matchMode === 'ai' || matchMode === 'human-engine'
    ? setupSelections.black !== null : setupSelections.white !== null && setupSelections.black !== null);
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
      const started = await startClassifiedLocalGame(nextSession.controller, nextSession.controller.snapshot());
      if (matchMode === 'ai' && opponentIdentity) {
        const service = await composition.opponentService;
        service.setCommittedSelection(opponentIdentity);
        service.recoverCandidate('resume-prior');
      }
      onStarted({ session: nextSession, snapshot: started, identities: [...checkedIdentities.current.values()],
        draft: { mode: matchMode, minutes: setupMinutes, increment: setupIncrement, engineSide, humanSide, engineSeats, aiSeats, modelSelection, opponentIdentity } });
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'The new game could not be saved.');
    } finally { setWorking(false); }
  };
  let editorPieces: ReturnType<typeof readEditorPieces> | null = null;
  let editorSide: 'w' | 'b' = 'w';
  try {
    editorPieces = readEditorPieces(setupFen || STANDARD_FEN);
    editorSide = editorSideToMove(setupFen || STANDARD_FEN);
  } catch { /* The FEN field reports the validation error on submit. */ }

  const singleOpponent = matchMode === 'ai' || matchMode === 'human-engine';
  const seats: readonly ('white' | 'black')[] = singleOpponent ? ['black'] : ['white', 'black'];
  return <section className={`sidebar-game-setup${editorOpen ? ' position-editor-page' : ''}`} aria-label="Game settings">
    <div className="game-mode-options">
      <label>Game mode<select id="game-mode" aria-label="Game mode" value={matchMode} onChange={event => { setMatchMode(event.target.value as MatchMode); setSetupError(''); }}>{MATCH_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
      {singleOpponent && <label>Your side<select aria-label="Your side" value={humanSide} onChange={event => setHumanSide(event.target.value as typeof humanSide)}><option value="white">White</option><option value="black">Black</option><option value="random">Random</option></select></label>}
      {matchMode === 'engine-ai' && <label>Engine plays<select aria-label="Engine plays" value={engineSide} onChange={event => setEngineSide(event.target.value as typeof engineSide)}><option value="white">White</option><option value="black">Black</option></select></label>}
    </div>
    {seats.map(side => setupKinds[side] === 'human' ? null : <section className="game-opponent-options" aria-label={`${side === 'white' ? 'White' : 'Black'} opponent setup`} key={`${side}-${setupKinds[side]}`}>
      {!singleOpponent && setupKinds[side] !== 'engine' && <h3>{side === 'white' ? 'White' : 'Black'} opponent</h3>}
      {setupKinds[side] === 'engine'
        ? <EnginePanel label={singleOpponent ? 'Your engine opponent' : `${side === 'white' ? 'White' : 'Black'} engine`} heading={singleOpponent ? 'Engine opponent' : `${side === 'white' ? 'White' : 'Black'} opponent`} selected={engineSeats[side]} onSelect={selection => setEngineSeats(current => ({ ...current, [side]: selection }))} />
        : <OpponentPanel service={composition.opponentService} connectionStore={composition.connectionStore} namespace={composition.namespace} idPrefix={`new-${side}-ai`} selected={setupSelections[side]}
          onSelectionInvalidated={() => { if (singleOpponent) { setModelSelection(null); setOpponentIdentity(null); } else setAiSeats(current => ({ ...current, [side]: null })); }}
          onSelect={(selection, identity) => { checkedIdentities.current.set(JSON.stringify(selection), identity); if (singleOpponent) { setModelSelection(selection); setOpponentIdentity(identity); } else setAiSeats(current => ({ ...current, [side]: selection })); }} />}
    </section>)}
    <form onSubmit={createNewGame} className="connection-form game-start-form">
      <fieldset className="game-time-options"><legend>Time control</legend>
        <label>Minutes<input id="starting-minutes" aria-label="Starting minutes" type="number" min="1" max="180" required value={setupMinutes} onChange={event => setSetupMinutes(Number(event.target.value))} /></label>
        <label>Increment (sec)<input aria-label="Increment seconds" type="number" min="0" max="600" required value={setupIncrement} onChange={event => setSetupIncrement(Number(event.target.value))} /></label>
      </fieldset>
      <div className="game-position-heading"><span>Starting position</span><button className="button quiet" type="button" aria-label="Custom starting position" aria-expanded={editorOpen} onClick={() => setEditorOpen(value => !value)}>Board setup</button></div>
      {editorOpen && <>
          <div className="position-editor-layout">
            <PositionEditorBoard fen={setupFen || STANDARD_FEN} flipped={editorFlipped} onFlip={() => setEditorFlipped(value => !value)}
              onChange={fen => { setSetupFen(fen); setSetupError(''); }} onError={error => setSetupError(positionSetupError(error))} />
            <aside className="editor-control-panel" aria-label="Position settings">
              <label>To move<select aria-label="Side to move" disabled={!editorPieces} value={editorSide} onChange={event => { try { setSetupFen(setPositionSideToMove(setupFen || STANDARD_FEN, event.target.value as 'w' | 'b')); setSetupError(''); } catch (error) { setSetupError(positionSetupError(error)); } }}><option value="w">White to play</option><option value="b">Black to play</option></select></label>
              <fieldset className="editor-castling-rights"><legend>Castling rights</legend>{(['K', 'Q', 'k', 'q'] as const).map(right => <label key={right}><input type="checkbox" aria-label={`${right === 'K' || right === 'Q' ? 'White' : 'Black'} ${right === 'K' || right === 'k' ? 'king' : 'queen'}-side castling`} checked={(setupFen.split(/\s+/)[2] ?? '-').includes(right)} onChange={event => { try { setSetupFen(setPositionCastlingRight(setupFen || STANDARD_FEN, right, event.target.checked)); setSetupError(''); } catch (error) { setSetupError(positionSetupError(error)); } }} />{right === 'K' || right === 'k' ? 'King-side' : 'Queen-side'} ({right === 'K' || right === 'Q' ? 'White' : 'Black'})</label>)}</fieldset>
              <label>En passant<select aria-label="En passant target" value={setupFen.split(/\s+/)[3] ?? '-'} onChange={event => { try { setSetupFen(setPositionEnPassantSquare(setupFen || STANDARD_FEN, event.target.value as Square | '-')); setSetupError(''); } catch (error) { setSetupError(positionSetupError(error)); } }}>{EN_PASSANT_SQUARES.map(square => <option key={square} value={square}>{square === '-' ? 'None' : square}</option>)}</select></label>
              <div className="editor-position-actions"><button className="button quiet" type="button" onClick={() => { setSetupFen(STANDARD_FEN); setSetupError(''); }}>Starting position</button>
                <button className="button quiet" type="button" onClick={() => { setSetupFen('8/8/8/8/8/8/8/8 w - - 0 1'); setSetupError(''); }}>Clear board</button></div>
              <div className="position-editor-footer">{setupError && <p role="alert">{conciseError(new Error(setupError))}</p>}<button className="button primary" type="button" onClick={() => setEditorOpen(false)}>Done</button></div>
            </aside>
            <div className="editor-fen-field"><label htmlFor="editor-fen">FEN</label><div className="editor-fen-row"><textarea id="editor-fen" aria-label="Custom starting position (six-field FEN)" rows={2} value={setupFen} onChange={event => { setSetupFen(event.target.value); setSetupError(''); }} /><button className="button quiet" type="button" onClick={() => { if (navigator.clipboard) void navigator.clipboard.writeText(setupFen).catch(() => setSetupError('Select the FEN and copy it manually.')); else setSetupError('Select the FEN and copy it manually.'); }}>Copy</button></div></div>
          </div>
      </>}
      {setupError && <p role="alert">{conciseError(new Error(setupError))}</p>}
      <button className="button primary game-start-button" aria-label="Start game" disabled={working || !setupReady} type="submit">{working ? 'Starting...' : 'Start game'}</button>
    </form>
  </section>;
}
