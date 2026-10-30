import { useEffect, useMemo, useState } from 'react';
import { ChessBoard } from './ChessBoard.js';
import { MoveList } from './MoveList.js';
import { Icon, IconButton } from './Icon.js';
import { checkedColor } from './board-input.js';
import { parsePosition } from '../rules/index.js';
import type { CoordinateMove, Promotion } from '../rules/index.js';
import { ChessMcpClient, remoteEndpoint, seatPrompt } from '../agents/remote.js';
import type { AppliedMoveV1 } from '../storage/index.js';
import { OpponentLogo } from './OpponentBadge.js';
import { cleanReportedName, resolveReportedBrand } from './opponent-brand.js';
import { formatClock } from './clock-format.js';
import { PROMOTIONS } from './promotion-options.js';
import { pieceImage } from './piece-image.js';
import { usePieceStyle } from './use-piece-style.js';
import './agent-game.css';

interface LiveBoard {
  gameId: string; fen: string; status: string; players: Record<string, string>; moves: string[];
  clock: { whiteMs: number; blackMs: number }; result: { winner: string | null; reason: string } | null; watch_url: string;
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="button" type="button" title={value} data-copy={value} onClick={() => {
    void navigator.clipboard?.writeText(value).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); },
      () => setCopied(false));
  }}>{copied ? 'Copied' : label}</button>;
}

/**
 * A hosted agent game on the shared board. The remote MCP server owns the
 * game; this page renders it with the same board and moves sidebar as every
 * other mode and sends human moves through the seat the URL carries.
 */
export function AgentGame() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const gameId = params.get('watch') ?? '';
  const side = params.get('side') === 'black' ? 'black' : 'white';
  const token = new URLSearchParams(window.location.hash.slice(1)).get('seat');
  const [board, setBoard] = useState<LiveBoard | null>(null);
  const [error, setError] = useState('');
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [orientation, setOrientation] = useState<'white' | 'black'>(side);
  const [promotion, setPromotion] = useState<Omit<CoordinateMove, 'promotion'> | null>(null);
  const pieceStyle = usePieceStyle();
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
        if (!response.ok) throw new Error('This game is unavailable.');
        const next = await response.json() as LiveBoard;
        if (live) { setBoard(next); setError(''); }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : 'Connection lost. Retrying.'); }
      finally { if (live) timer = setTimeout(() => { void poll(); }, 1000); }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [gameId]);
  const position = useMemo(() => board ? parsePosition(board.fen) : null, [board]);
  const moves = useMemo<readonly AppliedMoveV1[]>(() => (board?.moves ?? []).map((san, index) => ({
    moveId: `remote-${index}`, from: '', to: '', promotion: null, san, eventId: `remote-${index}`,
    fenBefore: `start ${index % 2 === 0 ? 'w' : 'b'} - - 0 ${Math.floor(index / 2) + 1}`, fenAfter: '',
  })), [board?.moves]);
  const finished = Boolean(board?.result);
  const myTurn = Boolean(position && joined && !finished && board?.status !== 'waiting-for-players' &&
    position.sideToMove === side[0]);
  const activeSide = board && !finished && board.status !== 'waiting-for-players' && position
    ? position.sideToMove === 'w' ? 'white' : 'black' : null;
  const check = position && board && !finished ? checkedColor(position) : undefined;
  const submitMove = async (from: string, to: string, promotionPiece: string) => {
    setBusy(true);
    setFeedback('');
    try {
      await client.call('make_move', { move: `${from}${to}${promotionPiece}` });
      return true;
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : 'Move failed.');
      return false;
    } finally { setBusy(false); }
  };
  const attemptBoardMove = async (move: Omit<CoordinateMove, 'promotion'>) => {
    if (!position) return false;
    const piece = position.pieces.find(candidate => candidate.square === move.from);
    if (piece?.type === 'p' && /[18]$/.test(move.to)) { setPromotion(move); return false; }
    return submitMove(move.from, move.to, '');
  };
  const selectPromotion = (piece: Promotion) => {
    if (!promotion) return;
    const move = promotion;
    setPromotion(null);
    void submitMove(move.from, move.to, piece);
  };
  const joinHuman = async () => {
    if (!token) return;
    setBusy(true);
    try {
      await client.call('join_seat', { resume_token: token, model_name: 'Human' });
      setJoined(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not join.'); }
    finally { setBusy(false); }
  };
  const resign = () => {
    setBusy(true);
    void client.call('resign').catch((cause: unknown) => setFeedback(cause instanceof Error ? cause.message : 'Could not resign.')).finally(() => setBusy(false));
  };
  const status = !board || !position ? 'Connecting…'
    : board.result ? board.result.winner
      ? `${board.result.winner === 'white' ? 'White' : 'Black'} wins — ${board.result.reason.replaceAll('_', ' ')}`
      : `Draw — ${board.result.reason.replaceAll('_', ' ')}`
    : board.status === 'waiting-for-players' ? 'Waiting for players'
    : `${check ? 'Check — ' : ''}${position.sideToMove === 'w' ? 'White' : 'Black'} to move`;
  return <main className="workspace minimal-workspace" id="main">
    <header className="topbar">
      <a className="wordmark" href="/" aria-label="Kamkm Chess home">kamkm chess</a>
      <div className="topbar-actions"><a className="button primary" href="/play?setup=new" aria-label="New game">New</a></div>
    </header>
    <div className="match-layout">
      <section className="board-column" id="board" aria-label="Chess match board">
        {(['black', 'white'] as const).map(color => {
          const label = board?.players[color] ?? (color === 'white' ? 'White' : 'Black');
          const name = cleanReportedName(label);
          const badge = resolveReportedBrand(label) ? <OpponentLogo modelId={name} />
            : <span className={`player-badge ${color === 'white' ? 'light' : 'dark'}-piece`} aria-hidden="true"><Icon name={name.toLowerCase() === 'human' ? 'user' : 'bot'} /></span>;
          return <div key={color} className={`player-row ${color} ${color === orientation ? 'near-player' : 'far-player'} ${activeSide === color ? 'active' : ''}`}>
            {badge}
            <div className="player-meta"><div className="player-name"><strong title={name}>{name}</strong></div></div>
            <time className={`clock ${activeSide === color ? 'running' : ''}`} data-low={board && board.clock[`${color}Ms`] < 20_000 || undefined}
              aria-label={`${color} clock ${formatClock(board?.clock[`${color}Ms`] ?? 0)}`}>{formatClock(board?.clock[`${color}Ms`] ?? 0)}</time>
          </div>;
        })}
        <div className="playing-board">
          {board && position ? <ChessBoard orientation={orientation} model={{ position, identity: gameId }} view={{ position, lastMove: null }}
            visible disabled={!myTurn || busy} premoveColor={null} allowPremove={false} onMove={attemptBoardMove} />
            : <p className="agent-board-note" role={error ? 'alert' : 'status'}>{error || 'Connecting…'}</p>}
          {promotion && <section className="promotion-panel" aria-label="Promotion"><div className="promotion-options">
            {PROMOTIONS.map(piece => <button className="button quiet" type="button" key={piece.value} aria-label={piece.label}
              autoFocus={piece.value === 'q'} onClick={() => selectPromotion(piece.value)}>
              <img alt="" width="36" height="36" src={pieceImage(position?.sideToMove ?? 'w', piece.value, pieceStyle)} /></button>)}
            <IconButton icon="close" label="Cancel promotion" onClick={() => setPromotion(null)} /></div></section>}
        </div>
      </section>
      <aside className="moves-sidebar" id="moves-panel" aria-label="Moves">
        <div className="moves-heading"><h2>Moves</h2><span className="count" aria-label={`${moves.length} moves`}>{moves.length}</span></div>
        <MoveList moves={moves} selectedPly={moves.length} visible onSelect={() => undefined} />
        <div className="match-status" role="status"
          data-turn={!finished && board?.status !== 'waiting-for-players' && position ? position.sideToMove : undefined}
          data-check={check ? 'true' : undefined}>
          <div className="status-result"><h2 className="status-heading">{status}</h2>
            {/* A live board keeps its failure visible here; before it loads, the board column shows the error. */}
            {board && error !== '' && <p className="status-detail" role="alert">{error}</p>}
            {!(board && error !== '') && (joined || feedback) && <p className="status-detail" role={feedback ? 'alert' : undefined}>{feedback || `Playing ${side}`}</p>}</div>
          <div className="button-row">
            {joined && !finished && <IconButton icon="resign" label="Resign" disabled={busy} onClick={resign} />}
            <IconButton icon="flip" label="Flip board" onClick={() => setOrientation(value => value === 'white' ? 'black' : 'white')} />
          </div>
        </div>
        <section className="agent-invites" aria-label="Share this game">
          {!joined && token && <button className="button primary" type="button" disabled={busy} onClick={() => { void joinHuman(); }}>{busy ? 'Joining…' : `Play ${side}`}</button>}
          <CopyButton label="Copy viewing link" value={board?.watch_url ?? `${window.location.origin}/play/agent?watch=${encodeURIComponent(gameId)}`} />
          {Object.entries(invitations).map(([color, url]) => <CopyButton key={color} label={`Copy ${color} invite`} value={seatPrompt(url)} />)}
        </section>
      </aside>
    </div>
  </main>;
}
