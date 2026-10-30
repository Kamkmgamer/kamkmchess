import { useEffect, useId, useMemo, useState } from 'react';
import { ChessBoard } from './ChessBoard.js';
import { parsePosition } from '../rules/index.js';
import { ChessMcpClient, remoteEndpoint, seatPrompt } from '../agents/remote.js';
import './agent-game.css';

interface LiveBoard {
  gameId: string; fen: string; status: string; players: Record<string, string>; moves: string[];
  clock: { whiteMs: number; blackMs: number }; result: { winner: string | null; reason: string } | null; watch_url: string;
}

export function CopyAgentText({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [message, setMessage] = useState('');
  return <div className="agent-share"><label htmlFor={id}>{label}</label><textarea id={id} readOnly value={value} rows={value.includes('\n') ? 5 : 2} onFocus={event => event.target.select()} />
    <button className="button" type="button" onClick={() => { void navigator.clipboard.writeText(value).then(() => setMessage('Copied'), () => setMessage('Select the text above and copy it.')); }}>Copy {label.toLowerCase()}</button><span role="status">{message}</span></div>;
}

export function AgentGame() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const gameId = params.get('watch') ?? '';
  const side = params.get('side') === 'black' ? 'black' : 'white';
  const token = new URLSearchParams(window.location.hash.slice(1)).get('seat');
  const [board, setBoard] = useState<LiveBoard | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const client = useMemo(() => new ChessMcpClient(), []);
  const invitations = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem(`agent-game:${gameId}`) ?? '{}') as Record<string, string>; } catch { return {}; }
  }, [gameId]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${remoteEndpoint}?watch=${encodeURIComponent(gameId)}`, { credentials: 'omit', cache: 'no-store' });
        if (!response.ok) throw new Error('This game is unavailable. Check the viewing URL or try again.');
        const next = await response.json() as LiveBoard;
        if (live) { setBoard(next); setError(''); }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : 'Connection lost. Retrying.'); }
      finally { if (live) timer = setTimeout(() => { void poll(); }, 1500); }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [gameId]);
  const position = useMemo(() => board ? parsePosition(board.fen) : null, [board]);
  const joinHuman = async () => {
    if (!token) return;
    setBusy(true);
    try { await client.call('join_seat', { resume_token: token, model_name: 'Human' }); setPlaying(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not join.'); }
    finally { setBusy(false); }
  };
  const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  return <main className="agent-game">
    <header><a href="/play">kamkm chess</a><h1>{token ? `${side === 'white' ? 'White' : 'Black'} invitation` : 'Watch the agents play'}</h1>
      <p>Agents play through <a href="/agents.md">MCP</a>. Connect to <code>{remoteEndpoint}</code>. No browser automation is needed.</p></header>
    {error && <p role="alert">{error}</p>}
    <div className="agent-game-layout"><section aria-label="Live chess game">
      {board && position ? <>
        <div className="agent-game-status" role="status">{board.result ? `${board.result.winner ? `${board.result.winner} won` : 'Game ended'}: ${board.result.reason.replaceAll('_', ' ')}` : board.status === 'waiting-for-players' ? 'Waiting for both players to join' : `${position.sideToMove === 'w' ? 'White' : 'Black'} to move`}</div>
        <div className="agent-game-players">{(['white', 'black'] as const).map(color => <span key={color}>{color === 'white' ? 'White' : 'Black'}: {board.players[color]} <strong>{clock(board.clock[`${color}Ms`])}</strong></span>)}</div>
        <ChessBoard orientation={side} model={{ position, identity: gameId }} view={{ position, lastMove: null }} visible disabled={!playing || busy || !!board.result || board.status === 'waiting-for-players' || position.sideToMove !== side[0]} premoveColor={null} allowPremove={false}
          onMove={async move => {
            setBusy(true);
            try {
              const piece = position.pieces.find(piece => piece.square === move.from);
              const promotion = piece?.type === 'p' && /[18]$/.test(move.to) ? 'q' : '';
              await client.call('make_move', { move: `${move.from}${move.to}${promotion}` });
              return true;
            } catch (cause) { setError(cause instanceof Error ? cause.message : 'Move failed.'); return false; }
            finally { setBusy(false); }
          }} />
        {playing && <><p>You are playing {side}. Pawn promotions use a queen.</p><button className="button" disabled={busy || !!board.result} onClick={() => { setBusy(true); void client.call('resign').catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not resign.')).finally(() => setBusy(false)); }}>Resign</button></>}
        <p className="agent-game-moves" aria-label="Moves">{board.moves.map((move, i) => `${i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ''}${move}`).join(' ') || 'No moves yet.'}</p>
      </> : <p role="status">Connecting to the game...</p>}
    </section><aside aria-label="Agent invitations">
      <h2>Share this game</h2>
      <CopyAgentText label="Viewing URL" value={board?.watch_url ?? `${window.location.origin}/play/agent?watch=${encodeURIComponent(gameId)}`} />
      {token && <section><h2>Play {side}</h2><p>Give this prompt to your agent. It joins only the {side} seat. Keep this invitation private.</p><CopyAgentText label={`${side} agent prompt`} value={seatPrompt(window.location.href)} />
        {!playing && <button className="button" disabled={busy} onClick={() => { void joinHuman(); }}>{busy ? 'Joining...' : `Play ${side} myself`}</button>}</section>}
      {Object.entries(invitations).map(([color, url]) => <section key={color}><h2>{color === 'white' ? 'White' : 'Black'} agent</h2><p>Send this invitation to that player, or copy the prompt to their agent.</p><CopyAgentText label={`${color} invitation URL`} value={url} /><CopyAgentText label={`${color} agent prompt`} value={seatPrompt(url)} /></section>)}
      <p>Both players must join before the first move. Black has 15 seconds to answer White's opening move. Watching does not control either seat.</p>
    </aside></div>
  </main>;
}
