/**
 * The online workspace screen (KHA-74).
 *
 * The screen extends the current board-and-moves workspace with compact
 * access to new play, the concurrent games and the profile and history. It
 * renders the canonical online snapshot of the focused match with the same
 * board, the same move list and the same keyboard history tools as the
 * offline game.
 *
 * The rules this module keeps:
 *
 * - The offline game is never replaced. The online screen is a focus page
 *   above it, and the offline game keeps its own controller, its own clock
 *   and its own state.
 * - Switching tabs never joins a queue and never drops a live game. Every
 *   attached match keeps its subscription while another tab is shown.
 * - The screen uses the shared board and the shared move list. The online
 *   position and the online moves are the canonical ones of the service.
 * - The clearly represented actions are icons with an accessible name and a
 *   hover label. The visible copy stays inside the twenty-word convention.
 * - The separate declared-models block does not exist. A seat shows one
 *   compact control label.
 */
import { useEffect, useState } from 'react';
import { createGuestCredential } from '../online/auth.js';
import { IconButton } from './Icon.js';
import { ChessBoard } from './ChessBoard.js';
import { MoveList } from './MoveList.js';
import { legalMoves, parsePosition } from '../rules/index.js';
import type { CoordinateMove, Promotion } from '../rules/index.js';
import { formatOnlineClock, onlineClockReading } from '../online/clock.js';
import type { OnlineClockReading } from '../online/clock.js';
import { onlineSideToMove } from '../online/turn.js';
import type { OnlineComposition } from '../online/composition.js';
import type { Seat, SeatControl, TimeControl } from '../online/contracts.js';
import type { FriendInvitation } from '../online/friend-routes.js';
import type { OnlineProfileHistory } from '../online/history.js';
import {
  onlineAppliedMoves,
  onlineConnectionText,
  onlineGameTitle,
  onlinePositionFen,
  onlineResultText,
  onlineSeatRows,
  onlineStatusText,
} from './online-view.js';
import './online.css';

/** The removal action the privacy owner implements. */
export interface OnlinePrivacyPort {
  /** Removes the public replay of one match. */
  removePublicReplay(matchId: string, reason: 'owner_request' | 'erasure_request'): Promise<void>;
}

/** The tabs of the online screen. */
export type OnlineTab = 'games' | 'new' | 'profile';

export interface OnlineWorkspaceProps {
  readonly composition: OnlineComposition;
  readonly onClose: () => void;
  /** Opens the account profile and history of the owner. */
  readonly onOpenProfile?: () => void;
  /** The public label of the owner's own agent, when one is selected. */
  readonly agentLabel?: string | null;
  /** The privacy actions of the owner. */
  readonly privacy?: OnlinePrivacyPort | null;
  /** The section the screen opens on. */
  readonly initialTab?: OnlineTab;
}

const CLOCK_CHOICES: readonly { readonly minutes: number; readonly increment: number }[] = [
  { minutes: 3, increment: 2 },
  { minutes: 5, increment: 3 },
  { minutes: 10, increment: 5 },
];

const PROMOTIONS: readonly { value: Promotion; label: string }[] = [
  { value: 'q', label: 'Queen' }, { value: 'r', label: 'Rook' },
  { value: 'b', label: 'Bishop' }, { value: 'n', label: 'Knight' },
];

function timeControl(minutes: number, increment: number): TimeControl {
  return { startingTimeMs: minutes * 60_000, incrementMs: increment * 1_000 };
}

/**
 * The online workspace screen.
 *
 * The screen owns no service state. It renders the composition and asks it to
 * act.
 */
export function OnlineWorkspace({ composition, onClose, onOpenProfile, agentLabel, privacy, initialTab }: OnlineWorkspaceProps) {
  const [tab, setTab] = useState<OnlineTab>(initialTab ?? 'games');
  const [clockIndex, setClockIndex] = useState(1);
  const [now, setNow] = useState(() => Date.now());
  const [ply, setPly] = useState(0);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const [confirm, setConfirm] = useState<'draw' | 'resign' | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [shownMatchId, setShownMatchId] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<FriendInvitation | null>(null);
  const [invitationLink, setInvitationLink] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [history, setHistory] = useState<OnlineProfileHistory | null>(null);
  const [historyProfile, setHistoryProfile] = useState('');

  useEffect(() => composition.subscribe(() => setRevision(value => value + 1)), [composition]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const games = composition.workspace.games;
  const focusedId = composition.workspace.focusedMatchId ?? games[0]?.matchId ?? null;
  // A new match resets the review cursor. The state is adjusted while
  // rendering, so no effect ever sets state after a paint.
  if (focusedId !== shownMatchId) {
    setShownMatchId(focusedId);
    setPly(0);
    setPromotion(null);
    setConfirm(null);
  }

  const focused = focusedId === null ? null : composition.workspace.state(focusedId);
  const view = focused?.snapshot ?? null;
  const queue = composition.queueState;
  const seat: Seat | null = view?.yourSeat ?? null;
  const reading: OnlineClockReading = view
    ? onlineClockReading(view.clock, now)
    : { whiteMs: 0, blackMs: 0, activeSeat: null, expired: false, replyDeadlineAt: null, replySeat: null };
  const appliedMoves = view ? onlineAppliedMoves(view) : [];
  const position = view ? parsePosition(onlinePositionFen(view, Math.min(ply, appliedMoves.length))) : null;
  // The turn belongs to the seat the canonical position and the opening
  // reply name. The main clock is never the authority for the turn.
  const sideToMove = view ? onlineSideToMove(view) : null;
  // A reviewed position is not the live game. The board refuses a move while
  // the owner looks at an earlier position.
  const reviewing = view !== null && ply !== appliedMoves.length;
  const rows = view ? onlineSeatRows(view, seat) : [];
  const agentRunner = view && seat ? composition.agentRunnerState(view.matchId, seat) : null;
  // The browser only plays the agent of the owner when the owner chose the
  // private selection of this seat. Without that choice the seat waits.
  const ownSeatIsAgent = view !== null && seat !== null
    && view.seats.find(candidate => candidate.seat === seat)?.control.kind === 'agent';
  const boundAgentLabel = view && seat ? composition.agentBindingFor(view.matchId, seat) : null;
  const status = view
    ? (focused && focused.status !== 'live' ? onlineConnectionText(focused.status) : onlineStatusText(view, reading))
    : '';

  function openGame(matchId: string): void {
    composition.workspace.focus(matchId);
    setTab('games');
  }

  async function submitMove(move: Omit<CoordinateMove, 'promotion'>): Promise<boolean> {
    if (!view || !focusedId || !position) return false;
    const candidates = legalMoves(position).filter(candidate => candidate.from === move.from && candidate.to === move.to);
    if (candidates.length === 0) {
      setMessage('Illegal move.');
      return false;
    }
    if (candidates.some(candidate => candidate.promotion)) {
      setPromotion({ from: move.from, to: move.to });
      return false;
    }
    const client = composition.commandClient(focusedId, seat ?? 'white');
    if (!client) {
      setMessage('The seat is not authorized.');
      return false;
    }
    setBusy(true);
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      await client.move(`${move.from}${move.to}`);
      setMessage('Move sent.');
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The move was refused.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function choosePromotion(piece: Promotion): Promise<void> {
    if (!promotion || !focusedId || !view) return;
    const client = composition.commandClient(focusedId, seat ?? 'white');
    setPromotion(null);
    if (!client) return;
    setBusy(true);
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      await client.move(`${promotion.from}${promotion.to}${piece}`);
      setMessage('Move sent.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The move was refused.');
    } finally {
      setBusy(false);
    }
  }

  async function sendAction(action: 'draw' | 'resign' | 'takeover' | 'agent'): Promise<void> {
    if (!focusedId || !view) return;
    const client = composition.commandClient(focusedId, seat ?? 'white');
    if (!client) {
      setMessage('The seat is not authorized.');
      return;
    }
    setBusy(true);
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      if (action === 'draw') await client.offerDraw();
      else if (action === 'resign') await client.resign();
      else if (action === 'takeover') await client.setControl({ kind: 'human' });
      else await client.setControl({ kind: 'agent', modelLabel: agentLabel ?? 'Agent' });
      setMessage(action === 'draw' ? 'Draw offered.' : action === 'resign' ? 'Resigned.' : 'Control changed.');
      setConfirm(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The action was refused.');
    } finally {
      setBusy(false);
    }
  }

  async function removeReplay(): Promise<void> {
    if (!focusedId || !view) return;
    // The owner-requested removal is a participant command of the match. The
    // service owns the removal; the browser never deletes anything itself.
    const client = composition.commandClient(focusedId, seat ?? 'white');
    if (!client) {
      setMessage('The seat is not authorized.');
      return;
    }
    setBusy(true);
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      await client.submit({ kind: 'remove_public_replay', reason: 'owner_request' });
      setMessage('Replay removed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The replay was not removed.');
    } finally {
      setBusy(false);
    }
  }

  async function eraseGuestReplays(): Promise<void> {
    if (!privacy || !focusedId) return;
    setBusy(true);
    try {
      await privacy.removePublicReplay(focusedId, 'erasure_request');
      setMessage('Shared replays erased.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The replays were not erased.');
    } finally {
      setBusy(false);
    }
  }

  async function enterQueue(control: SeatControl, intent: 'reuse' | 'new' = 'reuse'): Promise<void> {
    setBusy(true);
    try {
      const choice = CLOCK_CHOICES[clockIndex] ?? CLOCK_CHOICES[1]!;
      await composition.enterQueue({ control, timeControl: timeControl(choice.minutes, choice.increment) }, { intent });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The entry could not be created.');
    } finally {
      setBusy(false);
    }
  }

  function queueOption(option: 'retry' | 'play-yourself' | 'keep-searching' | 'cancel' | 'rejoin'): void {
    void (async () => {
      if (option === 'retry') await composition.queue.retry();
      else if (option === 'play-yourself') await composition.queue.playYourself();
      else if (option === 'keep-searching') await composition.queue.keepSearching();
      else if (option === 'cancel') await composition.queue.cancel();
      else await composition.queue.rejoin();
    })();
  }

  /** Creates one shareable friend link. */
  async function createInvitation(): Promise<void> {
    setBusy(true);
    try {
      const choice = CLOCK_CHOICES[clockIndex] ?? CLOCK_CHOICES[1]!;
      const created = await composition.friends.create({
        kind: 'link',
        seat: 'white',
        timeControl: timeControl(choice.minutes, choice.increment),
        control: { kind: 'human' },
      });
      setInvitation(created.invitation);
      setInvitationLink(`${window.location.origin}/invite/${created.invitation.invitationId}`);
      // The inviter tracks its own invitation. When the invitee accepts, the
      // inviter claims the seat credential of the created match and follows
      // it, so it can play its own seat.
      composition.trackInvitation(created.invitation.invitationId, created.ownerToken);
      setMessage('Invitation created.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The invitation could not be created.');
    } finally {
      setBusy(false);
    }
  }

  /** Reads the preview of an invitation. */
  async function previewInvitation(): Promise<void> {
    const code = invitationCode.trim().split('/').filter(Boolean).pop() ?? '';
    if (code.length === 0) {
      setMessage('Enter the invitation code.');
      return;
    }
    setBusy(true);
    try {
      setInvitation(await composition.friends.preview(code));
      setMessage('Invitation ready.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The invitation could not be read.');
    } finally {
      setBusy(false);
    }
  }

  /** Accepts an invitation and shows the created match. */
  async function acceptInvitation(): Promise<void> {
    if (!invitation) return;
    setBusy(true);
    try {
      const accepted = await composition.friends.accept(invitation.invitationId, { kind: 'human' });
      if (accepted.guestCredential) {
        composition.registerGuestCredential(createGuestCredential({
          guestId: accepted.guestCredential.guestId,
          matchId: accepted.guestCredential.matchId,
          seat: accepted.guestCredential.seat,
          token: accepted.guestCredential.token,
        }), 'guest');
      }
      composition.attachAndFocus(accepted.match.matchId, accepted.seat);
      setTab('games');
      setMessage('Match started.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The invitation could not be accepted.');
    } finally {
      setBusy(false);
    }
  }

  /** Proposes a rematch of the focused match. */
  async function proposeRematch(): Promise<void> {
    if (!focusedId) return;
    setBusy(true);
    try {
      const rematch = await composition.friends.proposeRematch(focusedId);
      setMessage(`Rematch proposed: ${rematch.status}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The rematch could not be proposed.');
    } finally {
      setBusy(false);
    }
  }

  /** Reads the public game history of a profile. */
  async function readHistory(): Promise<void> {
    const profileId = historyProfile.trim();
    if (profileId.length === 0) {
      setMessage('Enter a profile id.');
      return;
    }
    setBusy(true);
    try {
      setHistory(await composition.publicHistory.history(profileId));
      setMessage('History loaded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The history could not be read.');
    } finally {
      setBusy(false);
    }
  }

  /** Erases the shared replays of the whole account. The scope is explicit. */
  async function eraseEverySharedReplay(): Promise<void> {
    setBusy(true);
    try {
      await composition.privacy.removeAccount();
      setMessage('Every shared replay of this account was erased.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The replays were not erased.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="focus-page online-workspace" aria-label="Online play">
    <div className="panel-heading">
      <h2>Online</h2>
      <IconButton icon="close" label="Close online play" onClick={onClose} />
    </div>
    <nav className="online-tabs" aria-label="Online sections">
      <IconButton icon="plus" label="New play" aria-pressed={tab === 'new'} onClick={() => setTab('new')} />
      <IconButton icon="moves" label="Games" aria-pressed={tab === 'games'} onClick={() => setTab('games')} />
      <IconButton icon="account" label="Profile and history" aria-pressed={tab === 'profile'} onClick={() => setTab('profile')} />
    </nav>

    {tab === 'new' && <section className="online-panel" aria-label="New play">
      <div className="online-clock">
        {CLOCK_CHOICES.map((choice, index) => <button
          key={`${choice.minutes}-${choice.increment}`}
          type="button"
          className={`button ${clockIndex === index ? 'primary' : 'quiet'}`}
          aria-pressed={clockIndex === index}
          onClick={() => setClockIndex(index)}>{choice.minutes}+{choice.increment}</button>)}
      </div>
      <div className="button-row">
        <button className="button primary" type="button" disabled={busy || !composition.features.queue || !composition.accountSignedIn} onClick={() => void enterQueue({ kind: 'human' })}>Play yourself</button>
        <button className="button" type="button" disabled={busy || !composition.features.queue || !composition.accountSignedIn || !agentLabel} onClick={() => void enterQueue({ kind: 'agent', modelLabel: agentLabel ?? 'Agent' })}>Watch agent</button>
        <button className="button quiet" type="button" disabled={busy || !composition.features.queue || !composition.accountSignedIn} onClick={() => void enterQueue({ kind: 'human' }, 'new')}>Another entry</button>
      </div>
      {composition.features.queue && !composition.accountSignedIn && <p role="status">Sign in to join the queue. Friend games work without an account.</p>}
      {queue.detail && <p role="status">{queue.detail}</p>}
      {queue.options.length > 0 && <div className="button-row">
        {queue.options.includes('retry') && <button className="button" type="button" onClick={() => queueOption('retry')}>Retry</button>}
        {queue.options.includes('play-yourself') && <button className="button" type="button" onClick={() => queueOption('play-yourself')}>Play yourself</button>}
        {queue.options.includes('keep-searching') && <button className="button" type="button" onClick={() => queueOption('keep-searching')}>Keep searching</button>}
        {queue.options.includes('rejoin') && <button className="button" type="button" onClick={() => queueOption('rejoin')}>Rejoin</button>}
        {queue.options.includes('cancel') && <button className="button quiet" type="button" onClick={() => queueOption('cancel')}>Cancel</button>}
      </div>}
      {queue.assignment && <p role="status">Matched. {queue.assignment.opponentLabel}</p>}

      {composition.queueEntries.length > 0 && <ul className="online-entries" aria-label="Queue entries">
        {composition.queueEntries.map(entry => <li key={entry.id}>
          <span className="online-entry-state">{entry.state.detail || entry.state.phase}</span>
          <IconButton icon="moves" label={`Show queue entry ${entry.id}`} onClick={() => entry.focus()} />
          <IconButton icon="close" label={`Cancel queue entry ${entry.id}`} disabled={busy} onClick={() => void entry.cancel()} />
        </li>)}
      </ul>}

      <h3>Friend</h3>
      <div className="button-row">
        <button className="button" type="button" disabled={busy || !composition.features.friends} onClick={() => void createInvitation()}>Invite a friend</button>
      </div>
      {invitationLink && <label className="online-field">Invitation link
        <input readOnly value={invitationLink} aria-label="Invitation link" />
      </label>}
      <label className="online-field">Invitation code
        <input value={invitationCode} aria-label="Invitation code" onChange={event => setInvitationCode(event.target.value)} />
      </label>
      <div className="button-row">
        <button className="button quiet" type="button" disabled={busy || !composition.features.friends} onClick={() => void previewInvitation()}>Preview</button>
        <button className="button" type="button" disabled={busy || !invitation || invitation.status !== 'open'} onClick={() => void acceptInvitation()}>Accept</button>
      </div>
      {invitation && <p role="status">
        {invitation.inviterLabel} · {invitation.inviterSeat} · {Math.round(invitation.timeControl.startingTimeMs / 60000)}+{Math.round(invitation.timeControl.incrementMs / 1000)}
      </p>}
    </section>}

    {tab === 'games' && <section className="online-panel" aria-label="Concurrent games">
      {games.length === 0 && <p>No online games yet.</p>}
      <ul className="online-games">
        {games.map(game => <li key={game.matchId}>
          <button className="button quiet" type="button" onClick={() => openGame(game.matchId)} aria-current={game.matchId === focusedId ? 'true' : undefined}>
            {game.snapshot ? onlineGameTitle(game.snapshot, game.snapshot.yourSeat) : game.matchId}
          </button>
          <span className="online-game-status">{game.status === 'live' ? '' : onlineConnectionText(game.status)}</span>
        </li>)}
      </ul>
      <div className="button-row">
        <IconButton icon="plus" label="New game" onClick={() => { setTab('new'); setMessage('Choose a clock and enter the queue for another game.'); }} />
      </div>
    </section>}

    {tab === 'profile' && <section className="online-panel" aria-label="Profile and history">
      <p>{games.length} online game{games.length === 1 ? '' : 's'}.</p>
      {onOpenProfile && <button className="button" type="button" onClick={onOpenProfile}>Profile and history</button>}
      <label className="online-field">Profile id
        <input value={historyProfile} aria-label="Profile id" onChange={event => setHistoryProfile(event.target.value)} />
      </label>
      <div className="button-row">
        <button className="button quiet" type="button" disabled={busy} onClick={() => void readHistory()}>Public history</button>
        <button className="button quiet" type="button" disabled={busy} onClick={() => void eraseEverySharedReplay()}>Erase every shared replay of this account</button>
      </div>
      {history && <p role="status">{history.totals.wins} wins · {history.totals.draws} draws · {history.totals.losses} losses</p>}
      {view && view.result !== null && <div className="button-row">
        <a className="button quiet" href={`/v1/public/matches/${encodeURIComponent(view.matchId)}/replay`} target="_blank" rel="noreferrer">Public replay</a>
        <IconButton icon="close" label="Remove public replay" disabled={busy} onClick={() => void removeReplay()} />
        {privacy && <button className="button quiet" type="button" disabled={busy} onClick={() => void eraseGuestReplays()}>Erase shared replays</button>}
      </div>}
    </section>}

    {tab === 'games' && view && position && <div className="match-layout online-match">
      <section className="board-column" aria-label="Online match board">
        {rows.map(row => <div key={row.seat} className={`player-row ${row.seat}`}>
          <div className="player-name"><strong title={row.label}>{row.label}</strong><span className="player-control">{row.controlLabel}</span></div>
          <time className={`clock ${reading.activeSeat === row.seat ? 'running' : ''}`} aria-label={`${row.seat} clock ${formatOnlineClock(row.seat === 'white' ? reading.whiteMs : reading.blackMs)}`}>
            {formatOnlineClock(row.seat === 'white' ? reading.whiteMs : reading.blackMs)}
          </time>
        </div>)}
        <div className="playing-board">
          <ChessBoard
            orientation={seat === 'black' ? 'black' : 'white'}
            model={{ position, identity: view.matchId }}
            disabled={busy || view.status !== 'active' || sideToMove !== seat || reviewing}
            visible
            onMove={submitMove}
            view={{ position, lastMove: null }}
            premoveColor={null}
            allowPremove={false}
          />
          {promotion && <section className="promotion-panel" aria-label="Promotion">
            <div className="promotion-options">
              {PROMOTIONS.map(piece => <button className="button quiet" type="button" key={piece.value} aria-label={piece.label} onClick={() => void choosePromotion(piece.value)}>
                <img alt="" width="36" height="36" src={new URL(`./pieces/${position.sideToMove}${piece.value}.svg`, import.meta.url).href} />
              </button>)}
              <IconButton icon="close" label="Cancel promotion" onClick={() => setPromotion(null)} />
            </div>
          </section>}
        </div>
        <nav className="board-tools" aria-label="Online board tools">
          <IconButton icon="draw" label="Agree a draw" disabled={busy || view.status !== 'active'} onClick={() => setConfirm('draw')} />
          <IconButton icon="resign" label="Resign game" disabled={busy || view.status !== 'active'} onClick={() => setConfirm('resign')} />
          {seat && <IconButton icon="account" label="Take over" disabled={busy || view.status !== 'active'} onClick={() => void sendAction('takeover')} />}
          {seat && agentLabel && <IconButton icon="change" label="Hand to agent" disabled={busy || view.status !== 'active'} onClick={() => void sendAction('agent')} />}
        </nav>
        {confirm && <div className="online-confirm" role="group" aria-label={confirm === 'draw' ? 'Confirm draw' : 'Confirm resignation'}>
          <p>{confirm === 'draw' ? 'Agree a draw? It cannot be undone.' : 'Resign this game? It cannot be undone.'}</p>
          <div className="button-row">
            <button className="button primary" type="button" onClick={() => void sendAction(confirm)}>Confirm</button>
            <button className="button quiet" type="button" onClick={() => setConfirm(null)}>Keep playing</button>
          </div>
        </div>}
        {agentRunner && (agentRunner.phase === 'uncertain' || agentRunner.phase === 'paused' || agentRunner.phase === 'failed') &&
          <div className="online-decisions" role="group" aria-label="Agent decisions">
            <p>{agentRunner.phase === 'uncertain' ? 'The agent turn is uncertain.' : agentRunner.phase === 'paused' ? 'The agent turn waits for you.' : 'The agent turn failed.'}</p>
            <div className="button-row">
              <button className="button" type="button" disabled={busy} onClick={() => void composition.agentDecision(view.matchId, seat ?? 'white', 'retry')}>Retry</button>
              <button className="button" type="button" disabled={busy} onClick={() => void composition.agentDecision(view.matchId, seat ?? 'white', 'switch-model')}>Switch model</button>
              <button className="button" type="button" disabled={busy} onClick={() => void composition.agentDecision(view.matchId, seat ?? 'white', 'takeover')}>Take over</button>
            </div>
          </div>}
        {seat && ownSeatIsAgent && !boundAgentLabel && <div className="online-decisions" role="group" aria-label="Choose your agent">
          <p>Choose the agent of this seat.</p>
          <div className="button-row">
            {composition.agentCatalog.map(entry => <button className="button" type="button" key={entry.label} disabled={busy}
              onClick={() => composition.bindAgentSeat(view.matchId, seat, entry.label)}>{entry.label}</button>)}
          </div>
        </div>}
        {view.result !== null && <div className="button-row">
          <button className="button quiet" type="button" disabled={busy} onClick={() => void proposeRematch()}>Propose rematch</button>
        </div>}
        <div className="match-status" role="status">
          <h2 className="status-heading">{status}</h2>
        </div>
      </section>
      <aside className="moves-sidebar" aria-label="Online moves">
        <div className="moves-heading"><h2>Moves</h2><span className="count" aria-label={`Move ${ply} of ${appliedMoves.length}`}>{ply}/{appliedMoves.length}</span></div>
        <MoveList moves={appliedMoves} selectedPly={ply} visible onSelect={setPly} />
        <nav className="history-controls" aria-label="Move history"><div className="button-row">
          <IconButton icon="first" label="First" onClick={() => setPly(0)} disabled={ply === 0} aria-keyshortcuts="Home" />
          <IconButton icon="back" label="Previous" onClick={() => setPly(value => Math.max(0, value - 1))} disabled={ply === 0} aria-keyshortcuts="ArrowLeft" />
          <IconButton icon="next" label="Next" onClick={() => setPly(value => Math.min(appliedMoves.length, value + 1))} disabled={ply >= appliedMoves.length} aria-keyshortcuts="ArrowRight" />
          <IconButton icon="last" label="Live" onClick={() => setPly(appliedMoves.length)} disabled={ply >= appliedMoves.length} aria-keyshortcuts="End" />
        </div></nav>
      </aside>
    </div>}

    {view && view.result !== null && <p className="online-result">{onlineResultText(view)}</p>}
    {message && <p className="sr-only" role="status" aria-live="polite">{message}</p>}
    <span className="sr-only" aria-live="polite">{revision}</span>
  </section>;
}
