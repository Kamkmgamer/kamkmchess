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
import { composePlayersBySide, type BoardSide, type SeatKind, type SideKinds } from './match-modes.js';
import { AGENT_TIME_CONTROL } from '../agents/seat.js';
import { conciseError } from './concise-error.js';
import { ChessMcpClient, remoteEndpoint } from '../agents/remote.js';
import './new-game-setup.css';

export interface StartedSidebarGame {
  readonly session: LocalGameSession;
  readonly snapshot: ControllerSnapshotV1;
  readonly identities: readonly OpponentIdentityV1[];
  readonly draft: NewGameDraft;
}
export interface NewGameDraft {
  readonly sideKinds: SideKinds;
  readonly minutes: number;
  readonly increment: number;
  readonly engineSeats: Record<'white' | 'black', ModelSelection | null>;
  readonly aiSeats: Record<'white' | 'black', ModelSelection | null>;
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
    const frame = requestAnimationFrame(() => document.getElementById(focus === 'time' ? 'starting-minutes' : 'white-player')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const [editorOpen, setEditorOpen] = useState(Boolean(startingFen) || focus === 'position');
  const [setupFen, setSetupFen] = useState(startingFen ?? STANDARD_FEN);
  const [setupMinutes, setSetupMinutes] = useState(draft?.minutes ?? 15);
  const [setupIncrement, setSetupIncrement] = useState(draft?.increment ?? 10);
  const [editorFlipped, setEditorFlipped] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [working, setWorking] = useState(false);
  const [sideKinds, setSideKinds] = useState<SideKinds>(draft?.sideKinds ?? (focus === 'opponent' ? { white: 'human', black: 'ai' } : { white: 'human', black: 'human' }));
  const [engineSeats, setEngineSeats] = useState<Record<'white' | 'black', ModelSelection | null>>(draft?.engineSeats ?? { white: null, black: null });
  const [aiSeats, setAiSeats] = useState<Record<'white' | 'black', ModelSelection | null>>(draft?.aiSeats ?? { white: null, black: null });
	const hasAgent = sideKinds.white === 'agent' || sideKinds.black === 'agent';
	const [serverThink, setServerThink] = useState(1000);
  const checkedIdentities = useRef(new Map<string, OpponentIdentityV1>());
  const selectedIdentities = useRef(new Map<BoardSide, OpponentIdentityV1>());
  const seatSelection = (side: BoardSide) => sideKinds[side] === 'engine' ? engineSeats[side] : sideKinds[side] === 'ai' ? aiSeats[side] : null;
  const setupSelections: Record<BoardSide, ModelSelection | null> = { white: seatSelection('white'), black: seatSelection('black') };
  // Human and agent seats need no checked selection; engines and AI models do.
  const setupReady = hasAgent ? !Object.values(sideKinds).includes('ai') : (['white', 'black'] as const).every(side => sideKinds[side] === 'human' || sideKinds[side] === 'agent' || setupSelections[side] !== null);
  const changeSideKind = (side: BoardSide, kind: SeatKind) => {
    const hadAgent = sideKinds.white === 'agent' || sideKinds.black === 'agent';
    const hasAgent = kind === 'agent' || sideKinds[side === 'white' ? 'black' : 'white'] === 'agent';
    if (hasAgent && !hadAgent) { setSetupMinutes(AGENT_TIME_CONTROL.minutes); setSetupIncrement(AGENT_TIME_CONTROL.incrementSeconds); }
    else if (!hasAgent && hadAgent) { setSetupMinutes(15); setSetupIncrement(10); }
    if (kind !== 'ai') selectedIdentities.current.delete(side);
    setSideKinds(current => ({ ...current, [side]: kind }));
    setSetupError('');
  };
  const createNewGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupError('');
    if (hasAgent) {
      setWorking(true);
      try {
        const agentSide = sideKinds.white === 'agent' ? 'white' : 'black';
        const otherSide = agentSide === 'white' ? 'black' : 'white';
        const opponent = sideKinds[otherSide];
        if (opponent === 'ai') throw new Error('For a shared game, choose Human, Engine or Agent for the other side.');
        const fen = parsePosition(setupFen.trim() || STANDARD_FEN).fen;
        const board = await new ChessMcpClient().call('start_game', { model_name: `${agentSide} agent`, color: agentSide, opponent, defer_join: true, starting_fen: fen, minutes: setupMinutes, increment_seconds: setupIncrement, engine_think_ms: serverThink });
        const invitations: Record<string, string> = { [agentSide]: String(board.seat_url) };
        if (opponent === 'agent') invitations[otherSide] = String(board.opponent_url);
        sessionStorage.setItem(`agent-game:${String(board.gameId)}`, JSON.stringify(invitations));
        window.location.assign(String(opponent === 'human' ? board.opponent_url : board.watch_url));
      } catch (error) { setSetupError(error instanceof Error ? error.message : 'The agent game could not be started.'); }
      finally { setWorking(false); }
      return;
    }
    let configuredPlayers;
    try {
      configuredPlayers = composePlayersBySide(sideKinds, setupSelections);
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
      const selectedAiIdentities = [...selectedIdentities.current.values()];
      if (selectedAiIdentities.length === 1) {
        const service = await composition.opponentService;
        service.setCommittedSelection(selectedAiIdentities[0]!);
        service.recoverCandidate('resume-prior');
      }
      onStarted({ session: nextSession, snapshot: started, identities: [...checkedIdentities.current.values()],
        draft: { sideKinds, minutes: setupMinutes, increment: setupIncrement, engineSeats, aiSeats } });
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

  const seats: readonly BoardSide[] = ['white', 'black'];
  return <section className={`sidebar-game-setup${editorOpen ? ' position-editor-page' : ''}`} aria-label="Game settings">
    <p>Playing with an agent? Use the <a href="/agents.md">MCP server</a> for moves. Start an Agent game below to get a live viewing link and separate seat invitations.</p>
    <div className="game-mode-options">
      {seats.map(side => <label key={side}>{side === 'white' ? 'White' : 'Black'}<select id={`${side}-player`} aria-label={side === 'white' ? 'White' : 'Black'} value={sideKinds[side]} onChange={event => changeSideKind(side, event.target.value as SeatKind)}>
        <option value="human">Human</option><option value="engine">Engine</option><option value="ai">Browser AI</option><option value="agent">Agent</option>
      </select></label>)}
    </div>
    {seats.map(side => sideKinds[side] === 'human' ? null : sideKinds[side] === 'agent' ? <AgentSeatNote key={`${side}-agent`} side={side} /> : hasAgent && sideKinds[side] === 'engine' ? <section className="game-opponent-options" key={side}><h3>{side === 'white' ? 'White' : 'Black'}: server Stockfish</h3><label>Thinking time<select value={serverThink} onChange={event => setServerThink(Number(event.target.value))}><option value={100}>Casual, 100 ms</option><option value={1000}>Club, 1 second</option><option value={5000}>Strong, 5 seconds</option></select></label></section> : <section className="game-opponent-options" aria-label={`${side === 'white' ? 'White' : 'Black'} opponent setup`} key={`${side}-${sideKinds[side]}`}>
      <h3>{side === 'white' ? 'White' : 'Black'} {sideKinds[side] === 'engine' ? 'engine' : 'browser AI'}</h3>
      {sideKinds[side] === 'engine'
        ? <EnginePanel label={`${side === 'white' ? 'White' : 'Black'} engine`} heading={`${side === 'white' ? 'White' : 'Black'} engine`} selected={engineSeats[side]} onSelect={selection => setEngineSeats(current => ({ ...current, [side]: selection }))} />
        : <OpponentPanel service={composition.opponentService} connectionStore={composition.connectionStore} namespace={composition.namespace} idPrefix={`new-${side}-ai`} selected={setupSelections[side]}
          onSelectionInvalidated={() => { selectedIdentities.current.delete(side); setAiSeats(current => ({ ...current, [side]: null })); }}
          onSelect={(selection, identity) => { checkedIdentities.current.set(JSON.stringify(selection), identity); selectedIdentities.current.set(side, identity); setAiSeats(current => ({ ...current, [side]: selection })); }} />}
    </section>)}
    {hasAgent && Object.values(sideKinds).includes('ai') && <p role="alert">Choose Agent for an external agent, Engine for server Stockfish, or Human for a person on the shared board.</p>}
    <form onSubmit={createNewGame} className="connection-form game-start-form">
      <fieldset className="game-time-options"><legend>Time control</legend>
        <label>Minutes<input id="starting-minutes" aria-label="Starting minutes" type="number" inputMode="numeric" min="1" max="180" required value={setupMinutes} onChange={event => setSetupMinutes(Number(event.target.value))} /></label>
        <label>Increment (sec)<input aria-label="Increment seconds" type="number" inputMode="numeric" min="0" max="600" required value={setupIncrement} onChange={event => setSetupIncrement(Number(event.target.value))} /></label>
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
            <div className="editor-fen-field"><label htmlFor="editor-fen">FEN</label><div className="editor-fen-row"><textarea id="editor-fen" aria-label="Custom starting position (six-field FEN)" autoCapitalize="none" autoComplete="off" spellCheck={false} rows={2} value={setupFen} onChange={event => { setSetupFen(event.target.value); setSetupError(''); }} /><button className="button quiet" type="button" onClick={() => { if (navigator.clipboard) void navigator.clipboard.writeText(setupFen).catch(() => setSetupError('Select the FEN and copy it manually.')); else setSetupError('Select the FEN and copy it manually.'); }}>Copy</button></div></div>
          </div>
      </>}
      {setupError && <p role="alert">{conciseError(new Error(setupError))}</p>}
      <button className="button primary game-start-button" aria-label="Start game" disabled={working || !setupReady} type="submit">{working ? 'Starting...' : 'Start game'}</button>
    </form>
  </section>;
}

function AgentSeatNote({ side }: { readonly side: BoardSide }) {
  return <section className="game-opponent-options agent-seat-note" aria-label={`${side === 'white' ? 'White' : 'Black'} agent`}>
    <h3>{side === 'white' ? 'White' : 'Black'}: agent</h3>
    <p>Start the game to get a {side} invitation URL and a prompt for your agent. It will join this side through MCP. You can watch every move through the viewing URL.</p>
    <p>MCP endpoint: <code>{remoteEndpoint}</code></p>
  </section>;
}
