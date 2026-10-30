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
 * - Every new entry is explicit. The owner may wait with several entries at
 *   once, and the screen offers an explicit new entry for the human seat and
 *   for the seat of the own agent. The default actions keep the shared entry
 *   of the browser, so a game never authorizes another entry on its own.
 * - The screen uses the shared board and the shared move list. The online
 *   position and the online moves are the canonical ones of the service.
 * - The clearly represented actions are icons with an accessible name and a
 *   hover label. The visible copy stays inside the twenty-word convention,
 *   and the regression of the screen counts the words of the new-play panel
 *   and of the profile panel, so a later copy change cannot pass the
 *   convention by claim alone.
 * - The separate declared-models block does not exist. A seat shows one
 *   compact control label.
 * - The profile panel keeps the two removals apart. The ordinary account
 *   deletion removes the account data and keeps the shared games, and it asks
 *   for a confirmation before it sends anything. The explicit removal of the
 *   shared replays stays a separate action, and it asks for its own
 *   confirmation too: the erasure removes the shared replays of both
 *   participants, so the question names that consequence before the owner
 *   confirms it, and the owner may keep the shared replays.
 * - The public history shows the published games of the profile. Every game
 *   names its public opponent, its kind, its outcome and the time of its
 *   completion, and its public replay is one action away. An abort is named
 *   as an abort and it is marked as unscored.
 */
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createRequestOwner } from './request-owner.js';
import { createGuestCredential } from '../online/auth.js';
import { Icon, IconButton } from './Icon.js';
import { ChessBoard } from './ChessBoard.js';
import { MoveList } from './MoveList.js';
import { OpponentPanel } from './OpponentPanel.js';
import { OpponentLogo } from './OpponentBadge.js';
import { ProfileAvatarView } from './profile-avatar.js';
import { useSeatProfiles } from './online-identities.js';
import { createProfileClient } from '../profile/client.js';
import { FriendInvitationPreview } from './friend-preview.js';
import { friendInvitationRequest } from './friend-setup.js';
import {
  ownedInvitationAcceptable,
  ownedInvitationCancelTarget,
  ownedInvitationCancelable,
  ownedInvitationStateLabel,
} from './online-owned-invitations.js';
import { legalMoves, parsePosition } from '../rules/index.js';
import type { CoordinateMove, Promotion } from '../rules/index.js';
import { PROMOTIONS } from './promotion-options.js';
import { formatOnlineClock, onlineClockReading } from '../online/clock.js';
import type { OnlineClockReading } from '../online/clock.js';
import { onlineSideToMove } from '../online/turn.js';
import type { ProviderRunnerPhase } from '../online/provider-runner.js';
import type { OnlineComposition } from '../online/composition.js';
import type { OnlinePresenceView } from '../online/presence-client.js';
import type { Seat, SeatControl, TimeControl } from '../online/contracts.js';
import type { FriendInvitation, FriendRematch } from '../online/friend-routes.js';
import { rematchAction } from '../online/friends.js';
import type { OnlineGameKind, OnlineHistoryEntry, OnlineOutcome, OnlineProfileHistory } from '../online/history.js';
import type { OnlineAgentCheck } from '../online/readiness.js';
import type { ModelSelection } from '../controller/index.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';
import type { OpponentService } from '../opponents/index.js';
import type { OnlineOfferView, OnlineMatchView } from '../online/updates.js';
import {
  acceptOnlineDraw,
  acceptOnlineTakeback,
  claimOnlineWin,
  keepOnlineWaiting,
  offerOnlineDraw,
  offerOnlineTakeback,
  onlineConfirmCopy,
  onlineConfirmLabel,
  onlineIncomingOfferNote,
  onlineIncomingOffers,
  onlineOwnOfferNote,
  onlineOwnOffers,
  onlineRecoveryState,
  onlineTakebackAllowed,
  onlineTakebackTarget,
} from './online-match-controls.js';
import type { OnlineConfirmAction } from './online-match-controls.js';
import {
  onlineAppliedMoves,
  onlineConnectionText,
  onlineGameTitle,
  onlinePositionFen,
  onlineResultText,
  onlineSeatRows,
  onlineStatusText,
} from './online-view.js';
import { onlineSeatRunsAgent, onlineTakeoverPort, takeOverOnlineSeat } from './online-takeover.js';
import {
  onlineTakeoverErrorFeedback,
  onlineTakeoverFeedback,
  reportOnlineTakeover,
} from './online-takeover-feedback.js';
import type { OnlineTakeoverSurfaces } from './online-takeover-feedback.js';
import { handSeatToAgent, onlineAgentHandoffFeedback, onlineAgentHandoffPort, reportOnlineAgentHandoff } from './online-agent-handoff.js';
import type { OnlineAgentHandoffSurfaces } from './online-agent-handoff.js';
import { enterOnlineQueue, queueEntryContext, queueEntryControlLabel } from './online-queue-entries.js';
import { enterExplicitQueueEntry } from './online-explicit-entries.js';
import {
  createOnlineAccountDeletion,
  createOnlineReplayErasure,
  onlineAccountDeletionCancelLabel,
  onlineAccountDeletionConfirmGroup,
  onlineAccountDeletionConfirmLabel,
  onlineAccountDeletionCopy,
  onlineAccountDeletionLabel,
  onlineAccountDeletionNote,
  onlineAccountDeletionVisible,
  onlineAccountReplayRemovalLabel,
  onlineAccountReplayRemovalVisible,
  onlineGuestReplayRemovalLabel,
  onlineReplayErasureCancelLabel,
  onlineReplayErasureConfirmGroup,
  onlineReplayErasureConfirmLabel,
  onlineReplayErasureCopy,
  onlineReplayErasureNote,
} from './online-account-removal.js';
import type { OnlineAccountDeletion, OnlineReplayErasure, OnlineReplayErasureScope } from './online-account-removal.js';
import './online.css';

/** The tabs of the online screen. */
export type OnlineTab = 'games' | 'new' | 'profile';

export interface OnlineWorkspaceProps {
  readonly composition: OnlineComposition;
  readonly onClose: () => void;
  /** Opens the account profile and history of the owner. */
  readonly onOpenProfile?: () => void;
  /** Opens the browser-owned AI connection setup before queueing an agent. */
  readonly onConfigureAgent?: () => void;
  /** The public label of the owner's own agent, when one is selected. */
  readonly agentLabel?: string | null;
  /** The section the screen opens on. */
  readonly initialTab?: OnlineTab;
  /**
   * The readiness check of one selected own model.
   *
   * The check runs in the browser, so the credential of the model never
   * reaches the service. A failed check blocks an agent seat: the owner is
   * never given a human seat instead of the model it chose.
   */
  readonly checkAgent?: (selection: ModelSelection) => Promise<OnlineAgentCheck>;
  /** The local connection picker dependencies, supplied by the app shell. */
  readonly agentService?: Promise<OpponentService>;
  readonly agentConnectionStore?: Promise<ConnectionStore>;
  readonly agentNamespace?: ConnectionNamespace;
  /** Refreshes the shell's private agent catalog after a connection is saved. */
  readonly onAgentConnected?: () => void;
}

const CLOCK_CHOICES: readonly { readonly minutes: number; readonly increment: number }[] = [
  { minutes: 3, increment: 2 },
  { minutes: 5, increment: 3 },
  { minutes: 10, increment: 5 },
];

/**
 * The interval of the presence read of the focused match.
 *
 * The offline minute runs while the match version stays the same, so the
 * claim state is read again while the owner waits.
 */
const PRESENCE_REFRESH_MS = 10_000;

function timeControl(minutes: number, increment: number): TimeControl {
  return { startingTimeMs: minutes * 60_000, incrementMs: increment * 1_000 };
}

function screenRequestContext(composition: OnlineComposition, addressInvitation: string | null): string {
  const focus = composition.workspace.focusedMatchId ?? composition.workspace.games[0]?.matchId ?? null;
  return JSON.stringify([composition.identityKey, composition.identityGeneration,
    composition.pendingInvitation ?? addressInvitation, focus]);
}

/**
 * The note of the agent decisions, when the interface renders them.
 *
 * The runner offers its decisions in the phases `uncertain`, `paused`,
 * `failed` and `stopped`. The interface renders the block for the same
 * phases, so the owner sees every decision the runner offers, and the note
 * names the phase honestly: a stopped runner waits for a decision of the
 * owner.
 */
function agentDecisionNote(phase: ProviderRunnerPhase): string | null {
  if (phase === 'uncertain') return 'The agent turn is uncertain.';
  if (phase === 'paused') return 'The agent turn waits for you.';
  if (phase === 'failed') return 'The agent turn failed.';
  if (phase === 'stopped') return 'The agent is stopped. It waits for your decision.';
  return null;
}

/**
 * The visible failure of an action of the screen.
 *
 * The failure is shown, not only announced: a sighted owner has to see that
 * the action failed and what to do about it. The region is an alert, so a
 * screen reader announces it as soon as it appears.
 */
export function OnlineFailureNotice({ failure }: { readonly failure: string }) {
  return <p className="online-error" role="alert">{failure}</p>;
}

/**
 * The confirmation of an action of the match.
 *
 * The copy tells the owner whether the action is an offer the opponent still
 * has to accept or a result that cannot be undone. The panel never describes
 * an offer as an agreement.
 */
export function OnlineConfirmPanel({
  action,
  busy,
  moveNumber,
  onConfirm,
  onCancel,
}: {
  readonly action: OnlineConfirmAction;
  readonly busy: boolean;
  /** The move a takeback offer discards, when the action is a takeback. */
  readonly moveNumber?: number;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return <div className="online-confirm" role="group" aria-label={onlineConfirmLabel(action)}>
    <p>{onlineConfirmCopy(action, moveNumber)}</p>
    <div className="button-row">
      <button className="button primary" type="button" disabled={busy} onClick={onConfirm}>Confirm</button>
      <button className="button quiet" type="button" onClick={onCancel}>Keep playing</button>
    </div>
  </div>;
}

/**
 * The confirmation of the ordinary account deletion.
 *
 * The panel asks before it sends anything, and its copy names what the
 * deletion removes and what it keeps. The panel is separate from the
 * confirmation of a match action, because the account deletion never touches
 * a game.
 */
export function OnlineAccountDeletionPanel({
  busy,
  onConfirm,
  onCancel,
}: {
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return <div className="online-confirm" role="group" aria-label={onlineAccountDeletionConfirmGroup()}>
    <p>{onlineAccountDeletionCopy()}</p>
    <div className="button-row">
      <button className="button primary" type="button" disabled={busy} onClick={onConfirm}>{onlineAccountDeletionConfirmLabel()}</button>
      <button className="button quiet" type="button" onClick={onCancel}>{onlineAccountDeletionCancelLabel()}</button>
    </div>
  </div>;
}

/**
 * The confirmation of an explicit removal of the shared replays.
 *
 * The panel asks before it sends anything, and its copy names the scope of
 * the erasure and its consequence for both participants. The erasure is
 * irreversible, so the panel offers the way back next to the question.
 */
export function OnlineReplayErasurePanel({
  scope,
  busy,
  onConfirm,
  onCancel,
}: {
  /** The scope of the erasure. */
  readonly scope: OnlineReplayErasureScope;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return <div className="online-confirm" role="group" aria-label={onlineReplayErasureConfirmGroup()}>
    <p>{onlineReplayErasureCopy(scope)}</p>
    <div className="button-row">
      <button className="button primary" type="button" disabled={busy} onClick={onConfirm}>{onlineReplayErasureConfirmLabel()}</button>
      <button className="button quiet" type="button" onClick={onCancel}>{onlineReplayErasureCancelLabel()}</button>
    </div>
  </div>;
}

/**
 * The removals of the profile panel.
 *
 * The panel offers the three removals, and it keeps them apart:
 *
 * - The ordinary account deletion removes the account data and keeps the
 *   shared games. It asks before it sends anything.
 * - The account-wide erasure removes the shared replays of the whole
 *   account. It asks before it sends anything, and its question names the
 *   consequence for both participants.
 * - The erasure of the guest seat removes the shared replays of the one seat
 *   this browser owns. It asks before it sends anything too.
 *
 * The actions are icon actions with an accessible name and a hover label, so
 * the visible copy of the panel stays inside the twenty-word convention. The
 * notes of the panel are short, and the questions of the confirmations carry
 * the full consequence.
 */
export function OnlineProfileRemovals({
  busy,
  accountSignedIn,
  guestSeatAvailable,
  accountDeletion,
  accountErasure,
  guestErasure,
  onDeleteAccount,
  onEraseAccount,
  onEraseGuest,
}: {
  readonly busy: boolean;
  /** A signed-in account owns an account to delete. */
  readonly accountSignedIn: boolean;
  /** The browser owns a seat of the focused match. */
  readonly guestSeatAvailable: boolean;
  /** The flow of the ordinary account deletion. */
  readonly accountDeletion: OnlineAccountDeletion;
  /** The flow of the account-wide erasure of the shared replays. */
  readonly accountErasure: OnlineReplayErasure;
  /** The flow of the erasure of the shared replays of the guest seat. */
  readonly guestErasure: OnlineReplayErasure;
  /** Confirms the ordinary account deletion. */
  readonly onDeleteAccount: () => void;
  /** Confirms the account-wide erasure of the shared replays. */
  readonly onEraseAccount: () => void;
  /** Confirms the erasure of the shared replays of the guest seat. */
  readonly onEraseGuest: () => void;
}) {
  return <>
    <div className="button-row">
      {onlineAccountDeletionVisible(accountSignedIn) && <IconButton icon="account" label={onlineAccountDeletionLabel()} disabled={busy} onClick={() => accountDeletion.open()} />}
      {onlineAccountReplayRemovalVisible(accountSignedIn) && <IconButton icon="close" label={onlineAccountReplayRemovalLabel()} disabled={busy} onClick={() => accountErasure.open()} />}
      <IconButton icon="close" label={onlineGuestReplayRemovalLabel()} disabled={busy || !guestSeatAvailable} onClick={() => guestErasure.open()} />
    </div>
    {onlineAccountDeletionVisible(accountSignedIn) && <p>{onlineAccountDeletionNote()}</p>}
    <p>{onlineReplayErasureNote()}</p>
    {accountDeletion.step === 'asking' && <OnlineAccountDeletionPanel
      busy={busy}
      onConfirm={onDeleteAccount}
      onCancel={() => accountDeletion.cancel()}
    />}
    {accountErasure.step === 'asking' && <OnlineReplayErasurePanel
      scope="account"
      busy={busy}
      onConfirm={onEraseAccount}
      onCancel={() => accountErasure.cancel()}
    />}
    {guestErasure.step === 'asking' && <OnlineReplayErasurePanel
      scope="guest"
      busy={busy}
      onConfirm={onEraseGuest}
      onCancel={() => guestErasure.cancel()}
    />}
  </>;
}

/**
 * The offers of this browser that the opponent has not answered yet.
 *
 * The panel names the offer and the consent it still needs, so the owner
 * never reads an open offer as a result.
 */
export function OnlineOwnOfferStatus({
  view,
  offers,
}: {
  readonly view: OnlineMatchView;
  readonly offers: readonly OnlineOfferView[];
}) {
  if (offers.length === 0) return null;
  return <div className="online-offers" role="status" aria-label="Your offers">
    {offers.map(offer => <p key={offer.offerId}>{onlineOwnOfferNote(view, offer)}</p>)}
  </div>;
}

/**
 * The offers of the opponent that the owner may answer.
 *
 * Every offer has an explicit acceptance. The ignore action is local: the
 * service keeps the offer open, so ignoring one only stops the browser from
 * asking about it again.
 */
export function OnlineOfferPanel({
  view,
  offers,
  busy,
  onAccept,
  onIgnore,
}: {
  readonly view: OnlineMatchView;
  readonly offers: readonly OnlineOfferView[];
  readonly busy: boolean;
  readonly onAccept: (offer: OnlineOfferView) => void;
  readonly onIgnore: (offer: OnlineOfferView) => void;
}) {
  if (offers.length === 0) return null;
  return <div className="online-offers" role="group" aria-label="Offers of the opponent">
    {offers.map(offer => <div key={offer.offerId} className="online-offer">
      <p>{onlineIncomingOfferNote(view, offer)}</p>
      <div className="button-row">
        <IconButton
          icon="check"
          label={offer.kind === 'draw' ? 'Accept draw offer' : 'Accept takeback offer'}
          variant="default"
          disabled={busy}
          onClick={() => onAccept(offer)}
        />
        <IconButton icon="close" label="Ignore offer" disabled={busy} onClick={() => onIgnore(offer)} />
      </div>
    </div>)}
  </div>;
}

/**
 * The recovery actions of an offline opponent.
 *
 * The claim appears only while the service published it, and the note names
 * the state the service published. The browser never infers a win from its
 * own clock, and keeping the wait never concedes a result.
 */
export function OnlineRecoveryPanel({
  presence,
  busy,
  onClaim,
  onKeepWaiting,
}: {
  readonly presence: OnlinePresenceView | null;
  readonly busy: boolean;
  readonly onClaim: () => void;
  readonly onKeepWaiting: () => void;
}) {
  const recovery = onlineRecoveryState(presence);
  if (recovery.note === '') return null;
  return <div className="online-recovery" role="group" aria-label="Opponent offline">
    <p role="status">{recovery.note}</p>
    <div className="button-row">
      {recovery.claimAllowed && <IconButton icon="check" label="Claim win" variant="default" disabled={busy} onClick={onClaim} />}
      {recovery.keepWaitingAllowed && <IconButton icon="play" label="Keep waiting" disabled={busy} onClick={onKeepWaiting} />}
    </div>
  </div>;
}

/**
 * The visible label of the kind of a published game.
 *
 * The label names the kind of the game, so the owner tells a friend game, a
 * queue game and a fallback game apart.
 */
function historyKindLabel(kind: OnlineGameKind): string {
  switch (kind) {
    case 'friend': return 'Friend';
    case 'queue': return 'Queue';
    case 'fallback': return 'Fallback';
  }
}

/**
 * The state of a rematch offer, as the owner sees it.
 *
 * The proposer waits for the opponent, and the opponent may accept the offer.
 * An offer that expired is named as expired, so the owner never looks at a
 * control that the service would refuse.
 */
function rematchStatusText(rematch: FriendRematch, now: number): string {
  if (rematch.status === 'accepted') return 'The rematch was accepted.';
  if (rematch.proposedByViewer) return 'The rematch waits for your opponent.';
  const deadline = Date.parse(rematch.expiresAt);
  if (!Number.isNaN(deadline) && deadline <= now) return 'The rematch offer expired.';
  return `${rematch.proposerLabel} offered a rematch.`;
}

/**
 * The visible label of the outcome of a published game.
 *
 * An abort is named as an abort. It is never a scored result, and the label
 * never calls it one.
 */
function historyOutcomeLabel(outcome: OnlineOutcome): string {
  switch (outcome) {
    case 'win': return 'Win';
    case 'draw': return 'Draw';
    case 'loss': return 'Loss';
    case 'abort': return 'Abort';
  }
}

/**
 * The one line of a published game.
 *
 * The line names the public opponent of the game, the kind of the game and
 * the outcome of the game. An unscored game says so, because an abort is
 * published without a scored result.
 */
function historyGameText(game: OnlineHistoryEntry): string {
  const outcome = historyOutcomeLabel(game.outcome);
  const scored = game.scored ? '' : ' · unscored';
  return `${game.opponentLabel} · ${historyKindLabel(game.gameKind)} · ${outcome}${scored}`;
}

/**
 * The totals of a public history.
 *
 * The totals name the aborts apart from the scored results, so the owner sees
 * how many games ended without a result.
 */
function historyTotalsText(history: OnlineProfileHistory): string {
  const totals = history.totals;
  return `${totals.wins} wins · ${totals.draws} draws · ${totals.losses} losses · ${totals.aborts} aborts`;
}

/**
 * The completion time of a published game.
 *
 * The time is shown in UTC, so the same game reads the same way in every
 * browser and the value stays stable.
 */
function historyCompletedText(completedAt: string): string {
  const date = new Date(completedAt);
  if (Number.isNaN(date.getTime())) return completedAt;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The public path of the replay of a published game.
 *
 * The path is the route of the public replay of the service. A path that
 * leaves the origin of the browser is not a replay of this service, so the
 * screen offers no link to it.
 */
function historyReplayPath(game: OnlineHistoryEntry): string | null {
  const path = game.replayPath;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}

/**
 * The published games of a public profile history (KHA-78).
 *
 * The service publishes the completed games of a profile, and the screen
 * shows them: every game with its public opponent, the kind of the game, the
 * outcome of the game and the time of its completion. The public replay of
 * every game is one action away, through the path the service published.
 *
 * An abort is named as an abort and it is marked as unscored, because an
 * abort is published without a scored result.
 *
 * The panel shows the public projection only. It names no field of the
 * service answer that the owner does not read, and it leaks no private
 * identity of a participant.
 */
export function OnlinePublicHistory({ history }: { readonly history: OnlineProfileHistory }) {
  const games = history.games;
  return <>
    <p role="status">{historyTotalsText(history)}</p>
    {games.length === 0
      ? <p>No published games yet.</p>
      : <ul className="online-games" aria-label="Public game history">
        {games.map(game => {
          const replay = historyReplayPath(game);
          return <li key={game.matchId}>
            <span>{historyGameText(game)}</span>
            <time className="online-game-status" dateTime={game.completedAt}>{historyCompletedText(game.completedAt)}</time>
            {replay !== null && <a className="button quiet" href={replay} target="_blank" rel="noreferrer"
              aria-label={`Public replay of the game against ${game.opponentLabel}`}>Public replay</a>}
          </li>;
        })}
      </ul>}
  </>;
}

/**
 * The online workspace screen.
 *
 * The screen owns no service state. It renders the composition and asks it to
 * act.
 */
export function OnlineWorkspace({ composition, onClose, onOpenProfile, onConfigureAgent, agentLabel, initialTab, checkAgent,
  agentService, agentConnectionStore, agentNamespace, onAgentConnected }: OnlineWorkspaceProps) {
  const [tab, setTab] = useState<OnlineTab>(initialTab ?? 'games');
  const [clockIndex, setClockIndex] = useState(1);
  const [now, setNow] = useState(() => Date.now());
  // The review cursor follows the live position. It only holds an earlier
  // position while the owner looks at one: a new accepted move does not throw
  // the owner back to the live end.
  const [review, setReview] = useState<{ count: number; ply: number } | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const [confirm, setConfirm] = useState<OnlineConfirmAction | null>(null);
  const [message, setMessageText] = useState('');
  /**
   * The failure of the last action, as the owner sees it.
   *
   * A failure is shown on the screen, not only announced. The owner of a
   * failed action has to read what failed and what to do about it, so the
   * failure carries the actionable message of the browser or of the service.
   */
  const [failure, setFailure] = useState('');

  const [busy, setBusy] = useState(false);
  /**
   * The presence of the focused match, as the service published it.
   *
   * The claim and the keep waiting actions exist only while the service
   * allows them, so the panel reads this state and never the local clock.
   */
  const [presence, setPresence] = useState<OnlinePresenceView | null>(null);
  /**
   * The offers of the opponent that the owner ignored.
   *
   * The service keeps such an offer open, so ignoring one only stops the
   * browser from asking about it again.
   */
  const [ignoredOffers, setIgnoredOffers] = useState<readonly string[]>([]);
  const [revision, setRevision] = useState(0);
  const [shownMatchId, setShownMatchId] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<FriendInvitation | null>(null);
  const [invitationLink, setInvitationLink] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  // The setup of the invitation this browser creates. The kind decides between
  // a shareable link and a named challenge, the seat is the color of the
  // inviter, the control is the seat of the inviter and the position is the
  // custom board of the game.
  const [friendKind, setFriendKind] = useState<'link' | 'challenge'>('link');
  const [friendSeat, setFriendSeat] = useState<Seat>('white');
  const [friendControl, setFriendControl] = useState<'human' | 'agent'>('human');
  const [friendRecipient, setFriendRecipient] = useState('');
  const [friendFen, setFriendFen] = useState('');
  const [connectAgentOpen, setConnectAgentOpen] = useState(false);
  // The seat of the browser that accepts an invitation. The acceptor chooses
  // it before the acceptance, so the seat of the created match keeps it.
  const [joinControl, setJoinControl] = useState<'human' | 'agent'>('human');
  const [history, setHistory] = useState<OnlineProfileHistory | null>(null);
  const [historyProfile, setHistoryProfile] = useState('');
  /**
   * The revision of the ordinary account deletion.
   *
   * The flow owns the step of the deletion, so the screen only needs to know
   * that the step moved.
   */
  const [, setAccountDeletionRevision] = useState(0);
  /**
   * The ordinary account deletion of the profile panel.
   *
   * The flow owns the confirmation, so the request leaves the browser only
   * after the owner confirmed it. The flow never reaches the explicit removal
   * of the shared replays.
   */
  const accountDeletion = useMemo(() => createOnlineAccountDeletion({
    privacy: composition.privacy,
    onChange: () => setAccountDeletionRevision(value => value + 1),
  }), [composition]);
  /**
   * The revisions of the two explicit erasures.
   *
   * The flows own their steps, so the screen only needs to know that a step
   * moved.
   */
  const [, setAccountErasureRevision] = useState(0);
  const [, setGuestErasureRevision] = useState(0);
  /**
   * The account-wide erasure of the shared replays.
   *
   * The flow owns the confirmation, so the request leaves the browser only
   * after the owner confirmed it. The scope is the whole account, and the
   * flow never acts for a single seat.
   */
  const accountErasure = useMemo(() => createOnlineReplayErasure({
    scope: 'account',
    privacy: composition.privacy,
    onChange: () => setAccountErasureRevision(value => value + 1),
  }), [composition]);
  // A published invitation link opens the online screen with the exact
  // invitation of the link. The composition publishes it, and the address
  // carries it too.
  const [addressInvitation] = useState(() => {
    if (typeof window === 'undefined') return null;
    const linked = new URLSearchParams(window.location.search).get('invite');
    if (linked) return linked;
    const segments = window.location.pathname.split('/').filter(Boolean);
    const index = segments.indexOf('invite');
    return index >= 0 ? segments[index + 1] ?? null : null;
  });
  const linkedInvitation = composition.pendingInvitation ?? addressInvitation;
  const [invitationPreviewed, setInvitationPreviewed] = useState(false);
  const [rematchOffer, setRematchOffer] = useState<{ matchId: string; offer: FriendRematch } | null>(null);

  /**
   * Reports a status of the screen to the owner.
   *
   * The status is announced to a screen reader. A status also closes the
   * visible failure, so a recovered action never leaves an error behind.
   */
  function setMessage(text: string): void {
    setFailure('');
    setMessageText(text);
  }

  /**
   * Reports a failed action to the owner.
   *
   * The failure is shown and announced: the owner has to see that the action
   * failed and what to do about it. The polite status stays empty, so the
   * failure is announced once.
   */
  function reportFailure(text: string): void {
    setFailure(text);
    setMessageText('');
  }

  /**
   * The surfaces of the screen that show the outcome of a takeover.
   *
   * A proved takeover is a status of the screen. A refused takeover and an
   * unknown takeover are visible failures, so a sighted owner sees that the
   * control of the seat did not change.
   */
  const takeoverSurfaces: OnlineTakeoverSurfaces = {
    status: setMessage,
    failure: reportFailure,
  };

  /**
   * The surfaces of the screen that show the outcome of a hand-back.
   *
   * A proved hand-back is a status of the screen. A refused hand-back and an
   * unknown hand-back are visible failures, so a sighted owner sees that the
   * seat does not play the agent.
   */
  const handoffSurfaces: OnlineAgentHandoffSurfaces = {
    status: setMessage,
    failure: reportFailure,
  };

  useEffect(() => composition.subscribe(() => setRevision(value => value + 1)), [composition]);
  const games = composition.workspace.games;
  const focusedId = composition.workspace.focusedMatchId ?? games[0]?.matchId ?? null;
  const requestContext = screenRequestContext(composition, addressInvitation);
  // Each committed screen context has its own owner. Old handlers retain the
  // old owner, so they cannot finish or publish into a newer operation.
  const requestOwner = useMemo(() => createRequestOwner({
    context: requestContext,
    onPendingChange: setBusy,
    isContextCurrent: () => screenRequestContext(composition, addressInvitation) === requestContext,
  }), [composition, addressInvitation, requestContext]);
  const [shownRequestOwner, setShownRequestOwner] = useState(requestOwner);
  if (shownRequestOwner !== requestOwner) {
    setShownRequestOwner(requestOwner);
    setBusy(false);
    setInvitationPreviewed(false);
    setInvitation(null);
    setInvitationLink('');
    setRematchOffer(null);
    setMessage('');
  }
  useLayoutEffect(() => {
    requestOwner.revive();
    return () => { requestOwner.invalidate(); };
  }, [requestOwner]);
  useEffect(() => {
    if (!linkedInvitation || invitationPreviewed) return;
    const key = requestOwner.begin();
    if (!key) return;
    void (async () => {
      try {
        const preview = await composition.friends.preview(linkedInvitation);
        if (!requestOwner.isCurrent(key)) return;
        setInvitationCode(linkedInvitation);
        setInvitationPreviewed(true);
        setInvitation(preview);
        setTab('new');
      } catch (error) {
        if (!requestOwner.isCurrent(key)) return;
        setInvitationCode(linkedInvitation);
        setInvitationPreviewed(true);
        reportFailure(error instanceof Error ? error.message : 'The invitation could not be read.');
      } finally {
        requestOwner.finish(key);
      }
    })();
  }, [composition, invitationPreviewed, linkedInvitation, requestOwner, busy]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  /**
   * Reads the invitations of the current identity again.
   *
   * The screen is mounted again after a reload and after a navigation, and the
   * invitations of the owner are durable: the owner token and the list of the
   * invitations stay on the device. The read therefore finds the pending
   * invitation of the owner again, so it can be cancelled there.
   *
   * The read belongs to the identity: it uses the owner token of the identity
   * scoped record, and another identity never sees the invitation of the
   * first one.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    void composition.refreshOwnedInvitations();
    const onFocus = (): void => { void composition.refreshOwnedInvitations(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); };
  }, [composition, composition.identityKey]);
  // A new match resets the review cursor. The state is adjusted while
  // rendering, so no effect ever sets state after a paint.
  if (focusedId !== shownMatchId) {
    setShownMatchId(focusedId);
    setReview(null);
    setPromotion(null);
    setConfirm(null);
    // The offers of the previous match do not belong to the new one.
    setIgnoredOffers([]);
  }

  const focused = focusedId === null ? null : composition.workspace.state(focusedId);
  const view = focused?.snapshot ?? null;
  const queue = composition.queueState;
  /**
   * The failure of the queue, as the owner sees it.
   *
   * A blocked entry is a failure of the screen, so its reason is shown as an
   * error and not only as a status of the entry.
   */
  const queueFailure = queue.phase === 'agent-failed' ? queue.detail : '';
  const seat: Seat | null = view?.yourSeat ?? null;
  /**
   * The rematch offer of the focused match, and the action it offers.
   *
   * The service publishes an offer only while it can still be accepted, and
   * the service tells the owner whether the owner proposed the offer. The
   * proposal is already the consent of the proposer, so the acceptance
   * control belongs to the opponent of the proposer alone.
   */
  const rematch = rematchOffer !== null && rematchOffer.matchId === focusedId ? rematchOffer.offer : null;
  const rematchChoice = rematch === null ? 'none' : rematchAction(rematch, { now });
  /**
   * The erasure of the shared replays of the guest seat of this browser.
   *
   * The flow owns the confirmation, so the request leaves the browser only
   * after the owner confirmed it. The seat is read when the owner confirms,
   * so the erasure acts for the seat of the focused match. The scope stays on
   * the guest path, and it never names an account.
   */
  const guestErasure = useMemo(() => createOnlineReplayErasure({
    scope: 'guest',
    privacy: composition.privacy,
    onChange: () => setGuestErasureRevision(value => value + 1),
  }), [composition]);
  const reading: OnlineClockReading = view
    ? onlineClockReading(view.clock, now)
    : { whiteMs: 0, blackMs: 0, activeSeat: null, expired: false, replyDeadlineAt: null, replySeat: null };
  const appliedMoves = view ? onlineAppliedMoves(view) : [];
  const moveCount = appliedMoves.length;
  // A cursor that held an earlier position keeps it while new moves arrive.
  // A cursor that was at the live end follows the live end.
  // The cursor is clamped to the moves the canonical state carries, so a
  // takeback never leaves the cursor behind the live position.
  const ply = review !== null && review.ply < review.count
    ? Math.min(review.ply, moveCount)
    : moveCount;
  const position = view ? parsePosition(onlinePositionFen(view, Math.min(ply, appliedMoves.length))) : null;
  // The turn belongs to the seat the canonical position and the opening
  // reply name. The main clock is never the authority for the turn.
  const sideToMove = view ? onlineSideToMove(view) : null;
  // A reviewed position is not the live game. The board refuses a move while
  // the owner looks at an earlier position.
  const reviewing = view !== null && ply !== moveCount;
  const rows = view ? onlineSeatRows(view, seat) : [];
  // A signed-in seat's public label is the username its owner chose, so the
  // public profile — name and avatar — is one unauthenticated lookup away.
  const seatProfiles = useSeatProfiles(rows.map(row => row.label), createProfileClient({ baseUrl: composition.baseUrl }));
  const agentRunner = view && seat ? composition.agentRunnerState(view.matchId, seat) : null;
  // The runner offers its decisions in the phases the interface renders them
  // in, so the owner sees every decision the runner offers.
  const agentDecisionText = agentRunner ? agentDecisionNote(agentRunner.phase) : null;
  // The control the service published for the seat of the owner.
  const ownSeatControl: SeatControl | null = view !== null && seat !== null
    ? view.seats.find(candidate => candidate.seat === seat)?.control ?? null
    : null;
  // The browser only plays the agent of the owner when the owner chose the
  // private selection of this seat. Without that choice the seat waits.
  const ownSeatIsAgent = ownSeatControl !== null && ownSeatControl.kind === 'agent';
  // The binding of the seat is published by its private identity, so the
  // display asks for the public label of that binding.
  const boundAgentLabel = view && seat ? composition.agentBindingLabelFor(view.matchId, seat) : null;
  /**
   * True when this browser plays the seat of the owner with its own agent.
   *
   * The browser holds the private selection of the seat, so it owns the
   * runner of the seat, the lease of the seat and the private binding of the
   * seat. The takeover of such a seat goes through the decision of the
   * composition, because only that decision ends them.
   */
  const ownSeatRunsAgent = onlineSeatRunsAgent(ownSeatControl, boundAgentLabel !== null);
  // The own agent of the owner. The composition publishes it, so a browser
  // without a connected model offers the human seat only and never claims an
  // agent it cannot run.
  const ownAgent = composition.agent;
  const ownAgentLabel = ownAgent?.label ?? agentLabel ?? null;
  const status = view
    ? (focused && focused.status !== 'live' ? onlineConnectionText(focused.status) : onlineStatusText(view, reading))
    : '';
  // The offers of the focused match, as the canonical view publishes them.
  const incomingOffers = view ? onlineIncomingOffers(view, seat, ignoredOffers) : [];
  const ownOffers = view ? onlineOwnOffers(view, seat) : [];
  // The exact target of a takeback offer of this browser. The service needs
  // the version of the position the takeback restores.
  const takebackTarget = view ? onlineTakebackTarget(view) : null;
  const takebackAllowed = view !== null && onlineTakebackAllowed(view);
  // The presence of the focused match. A presence of another match never
  // reaches the panel of this one.
  const publishedPresence = presence !== null && presence.matchId === focusedId ? presence : null;
  /**
   * The invitations of the current identity.
   *
   * The composition publishes them with the state the service gave them, so a
   * pending invitation of the owner survives a reload and a navigation.
   */
  const ownedInvitations = composition.ownedInvitations;
  /**
   * The invitation the cancel action of the setup names.
   *
   * The invitation the owner is looking at is preferred, and a recovered
   * invitation is the next one. The action names an invitation of this
   * identity only.
   */
  const cancelTargetId = ownedInvitationCancelTarget(
    invitation,
    ownedInvitations,
    id => composition.ownsInvitation(id),
  );

  /**
   * Reads the presence of the focused match.
   *
   * The offline minute runs while the match version stays the same, so the
   * read is repeated while the owner waits. The claim is offered only while
   * the service publishes it, and the browser never infers it from its own
   * clock.
   */
  useEffect(() => {
    if (!focusedId || !seat) return;
    let cancelled = false;
    const read = async (): Promise<void> => {
      const client = composition.presenceClient(focusedId, seat);
      if (!client) return;
      try {
        const published = await client.view();
        if (cancelled) return;
        setPresence(published);
      } catch {
        if (cancelled) return;
        // The service did not answer. The screen offers no claim it cannot
        // prove, so the state falls back to nothing.
        setPresence(null);
      }
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, PRESENCE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [composition, focusedId, seat, view?.version]);

  function openGame(matchId: string): void {
    composition.workspace.focus(matchId);
    setTab('games');
  }

  async function submitMove(move: Omit<CoordinateMove, 'promotion'>): Promise<boolean> {
    if (!view || !focusedId || !position) return false;
    const candidates = legalMoves(position).filter(candidate => candidate.from === move.from && candidate.to === move.to);
    if (candidates.length === 0) {
      reportFailure('Illegal move.');
      return false;
    }
    if (candidates.some(candidate => candidate.promotion)) {
      setPromotion({ from: move.from, to: move.to });
      return false;
    }
    const client = composition.commandClient(focusedId, seat ?? 'white');
    if (!client) {
      reportFailure('The seat is not authorized.');
      return false;
    }
    const key = requestOwner.begin();
    if (!key) return false;
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      await client.move(`${move.from}${move.to}`);
      if (!requestOwner.isCurrent(key)) return false;
      setMessage('Move sent.');
      return true;
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return false;
      reportFailure(error instanceof Error ? error.message : 'The move was refused.');
      return false;
    } finally {
      requestOwner.finish(key);
    }
  }

  async function choosePromotion(piece: Promotion): Promise<void> {
    if (!promotion || !focusedId || !view) return;
    const client = composition.commandClient(focusedId, seat ?? 'white');
    setPromotion(null);
    if (!client) return;
    const key = requestOwner.begin();
    if (!key) return;
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      await client.move(`${promotion.from}${promotion.to}${piece}`);
      if (!requestOwner.isCurrent(key)) return;
      setMessage('Move sent.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The move was refused.');
    } finally {
      requestOwner.finish(key);
    }
  }

  async function sendAction(action: 'draw' | 'resign' | 'takeback'): Promise<void> {
    if (!focusedId || !view) return;
    const client = composition.commandClient(focusedId, seat ?? 'white');
    if (!client) {
      reportFailure('The seat is not authorized.');
      return;
    }
    if (action === 'takeback' && takebackTarget === null) {
      reportFailure('The match has no move to take back.');
      return;
    }
    const key = requestOwner.begin();
    if (!key) return;
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      if (action === 'draw') await offerOnlineDraw(client);
      else if (action === 'resign') await client.resign();
      else await offerOnlineTakeback(client, takebackTarget?.targetVersion ?? 0);
      if (!requestOwner.isCurrent(key)) return;
      setMessage(action === 'draw' ? 'Draw offered.' : action === 'resign' ? 'Resigned.' : 'Takeback offered.');
      setConfirm(null);
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The action was refused.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Hands the seat of the owner to its agent.
   *
   * The hand-back goes through the decision of the composition: it asks the
   * service for the control change, keeps the private selection of the owner
   * and replaces the runner of the seat, so the seat never waits for the
   * deadline of its turn with a runner that gave up.
   *
   * The browser sends one command, never two. The outcome is explicit: the
   * screen never claims a seat the agent does not play, and a hand-back that
   * did not happen is shown as a visible failure with the reason it did not
   * happen.
   */
  async function handOverSeatToAgent(): Promise<void> {
    if (!focusedId || !seat) return;
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const outcome = await handSeatToAgent(
        { matchId: focusedId, seat },
        onlineAgentHandoffPort(composition),
      );
      if (!requestOwner.isCurrent(key)) return;
      reportOnlineAgentHandoff(handoffSurfaces, onlineAgentHandoffFeedback(outcome));
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      // The hand-back threw, so it did not happen. It is a visible failure as
      // well, and the message of the browser is kept.
      reportOnlineAgentHandoff(handoffSurfaces, {
        kind: 'failure',
        detail: error instanceof Error ? error.message : 'The hand-back was refused.',
      });
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Takes the seat of the owner over.
   *
   * A seat the browser plays with its own agent goes through the decision of
   * the composition: it stops the runner, releases the lease of the seat and
   * drops the private binding of the seat, so nothing of the agent stays
   * alive after the service changed the control. A human seat and a seat of
   * the browser engine keep the direct control change of the service: they
   * have no runner of this browser.
   *
   * The browser sends one command, never two. The outcome is explicit: the
   * screen never claims a takeover it cannot prove, and a takeover that did
   * not happen is shown as a visible failure instead of a status only a
   * screen reader reads.
   */
  async function takeOverSeat(): Promise<void> {
    if (!focusedId || !view || !seat) return;
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const outcome = await takeOverOnlineSeat({
        matchId: focusedId,
        seat,
        control: ownSeatControl,
        version: view.version,
        controlEpoch: view.controlEpoch,
        browserRunsAgent: ownSeatRunsAgent,
      }, onlineTakeoverPort(composition));
      if (!requestOwner.isCurrent(key)) return;
      // A refused takeover and an unknown takeover are visible failures: the
      // owner has to see that the control of the seat did not change.
      reportOnlineTakeover(takeoverSurfaces, onlineTakeoverFeedback(outcome));
      setConfirm(null);
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      // The takeover threw, so it did not happen. It is a visible failure as
      // well, and the message of the browser is kept.
      reportOnlineTakeover(takeoverSurfaces, onlineTakeoverErrorFeedback(error));
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Answers an offer of the opponent.
   *
   * The acceptance is explicit: the browser sends the exact offer the service
   * published, and the service decides whether it is applied.
   */
  async function acceptOffer(offer: OnlineOfferView): Promise<void> {
    if (!focusedId || !view) return;
    const client = composition.commandClient(focusedId, seat ?? 'white');
    if (!client) {
      reportFailure('The seat is not authorized.');
      return;
    }
    const key = requestOwner.begin();
    if (!key) return;
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      if (offer.kind === 'draw') await acceptOnlineDraw(client, offer.offerId);
      else await acceptOnlineTakeback(client, offer.offerId);
      if (!requestOwner.isCurrent(key)) return;
      setMessage(offer.kind === 'draw' ? 'Draw accepted.' : 'Takeback accepted.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The offer was refused.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Claims the win after the opponent stayed offline.
   *
   * The claim belongs to the service: the browser sends the claim the service
   * offered and reports the outcome the service answered.
   */
  async function claimWin(): Promise<void> {
    if (!focusedId || !view || !seat) return;
    const client = composition.presenceClient(focusedId, seat);
    if (!client) {
      reportFailure('The seat is not authorized.');
      return;
    }
    const key = requestOwner.begin();
    if (!key) return;
    try {
      await claimOnlineWin(client, { expectedVersion: view.version, controlEpoch: view.controlEpoch });
      if (!requestOwner.isCurrent(key)) return;
      setMessage('The win was claimed.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The claim was refused.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Records that the owner keeps waiting for the offline opponent.
   *
   * The choice never concedes a result. It only tells the service that the
   * owner waits.
   */
  async function keepWaiting(): Promise<void> {
    if (!focusedId || !view || !seat) return;
    const client = composition.presenceClient(focusedId, seat);
    if (!client) {
      reportFailure('The seat is not authorized.');
      return;
    }
    const key = requestOwner.begin();
    if (!key) return;
    try {
      await keepOnlineWaiting(client);
      if (!requestOwner.isCurrent(key)) return;
      setMessage('You keep waiting.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The choice was refused.');
    } finally {
      requestOwner.finish(key);
    }
  }

  async function removeReplay(): Promise<void> {
    if (!focusedId || !view) return;
    // The owner-requested removal is a participant command of the match. The
    // service owns the removal; the browser never deletes anything itself.
    const client = composition.commandClient(focusedId, seat ?? 'white');
    if (!client) {
      reportFailure('The seat is not authorized.');
      return;
    }
    const key = requestOwner.begin();
    if (!key) return;
    try {
      client.setVersion(view.version);
      client.setControlEpoch(view.controlEpoch);
      await client.submit({ kind: 'remove_public_replay', reason: 'owner_request' });
      if (!requestOwner.isCurrent(key)) return;
      setMessage('Replay removed.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The replay was not removed.');
    } finally {
      requestOwner.finish(key);
    }
  }

  async function enterQueue(control: SeatControl, intent: 'reuse' | 'new' = 'reuse'): Promise<void> {
    // Queueing is a waiting destination, not a side effect hidden inside the
    // setup form. Move the owner to Games before the request starts so the
    // next screen explains what is happening and where the match will open.
    setTab('games');
    setMessage(control.kind === 'agent' ? 'Your agent is checking in. The queue will open the game here.' : 'You are in the queue. The game will open here when an opponent is found.');
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const choice = CLOCK_CHOICES[clockIndex] ?? CLOCK_CHOICES[1]!;
      // The failure of the attempt is the actionable message of the browser
      // or of the service, so the owner reads what to do about it.
      const failure = await enterOnlineQueue(
        composition,
        { control, timeControl: timeControl(choice.minutes, choice.increment) },
        intent,
      );
      if (!requestOwner.isCurrent(key)) return;
      if (failure !== null) reportFailure(failure);
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Creates an explicit new entry of the owner.
   *
   * The request goes through the helper of the explicit entries, so the
   * screen and the regression of the helper name the same seat and the same
   * new mode. The default entries of the owner keep the shared entry of the
   * browser, so this path never replaces the entry the owner waits with.
   */
  async function enterExplicitEntry(seat: 'human' | 'agent'): Promise<void> {
    setTab('games');
    setMessage('Your additional queue entry is being created. Track it here.');
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const choice = CLOCK_CHOICES[clockIndex] ?? CLOCK_CHOICES[1]!;
      const failure = await enterExplicitQueueEntry(
        composition,
        seat,
        ownAgentLabel,
        timeControl(choice.minutes, choice.increment),
      );
      if (!requestOwner.isCurrent(key)) return;
      if (failure !== null) reportFailure(failure);
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Applies an owner decision to the agent seat and reports its outcome.
   *
   * The outcome is explicit: the interface never claims a success it cannot
   * prove.
   */
  async function applyDecision(
    matchId: string,
    seat: Seat,
    decision: 'retry' | 'switch-model' | 'takeover',
    choice?: string,
  ): Promise<void> {
    if (busy) return;
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const outcome = await composition.agentDecision(matchId, seat, decision, choice);
      if (!requestOwner.isCurrent(key)) return;
      if (outcome.kind === 'accepted') {
        setMessage(decision === 'takeover' ? 'The seat is yours.' : `The seat plays ${outcome.publicModelLabel}.`);
      } else if (outcome.kind === 'refused') {
        reportFailure(outcome.detail);
      } else {
        reportFailure(outcome.detail);
      }
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The decision was not applied.');
    } finally {
      requestOwner.finish(key);
    }
  }

  function queueOption(option: 'retry' | 'play-yourself' | 'keep-searching' | 'cancel' | 'rejoin'): void {
    const key = requestOwner.begin();
    if (!key) return;
    void (async () => {
      try {
        if (option === 'retry') await composition.queue.retry();
        else if (option === 'play-yourself') await composition.queue.playYourself();
        else if (option === 'keep-searching') await composition.queue.keepSearching();
        else if (option === 'cancel') await composition.queue.cancel();
        else await composition.queue.rejoin();
      } catch (error) {
        if (!requestOwner.isCurrent(key)) return;
        reportFailure(error instanceof Error ? error.message : 'The queue action was refused.');
      } finally {
        requestOwner.finish(key);
      }
    })();
  }

  /**
   * Checks the own agent of a friend seat.
   *
   * The check runs in the browser, so the credential of the model never
   * reaches the service. A failed check blocks the seat: the owner is never
   * given a human seat instead of the model it chose.
   */
  async function checkOwnAgent(selection: ModelSelection): Promise<OnlineAgentCheck> {
    if (!checkAgent) return { ready: false, detail: 'The agent check is unavailable.' };
    return checkAgent(selection);
  }

  /**
   * Creates one friend invitation with the chosen setup.
   *
   * The inviter chooses the kind of the invitation, the color of its own
   * seat, the clock, the custom position and whether its own seat plays the
   * human or the own agent. The private selection of the agent is captured
   * before the service is asked, so the seat of the created match keeps the
   * model the owner chose.
   */
  async function createInvitation(): Promise<void> {
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const choice = CLOCK_CHOICES[clockIndex] ?? CLOCK_CHOICES[1]!;
      const setup = friendInvitationRequest({
        kind: friendKind,
        seat: friendSeat,
        control: friendControl,
        recipient: friendRecipient,
        startingFen: friendFen,
        timeControl: timeControl(choice.minutes, choice.increment),
        modelLabel: ownAgentLabel,
        accountSignedIn: composition.accountSignedIn,
      });
      if (!setup.ok) {
        reportFailure(setup.message);
        return;
      }
      // The private selection of the agent is captured before the service is
      // asked, so a model the owner picks later never replaces the agent of
      // the created match.
      const selection = friendControl === 'agent' ? ownAgent?.selection ?? null : null;
      if (friendControl === 'agent') {
        if (!selection) {
          reportFailure('Choose your agent first.');
          return;
        }
        const ready = await checkOwnAgent(selection);
        if (!requestOwner.isCurrent(key)) return;
        if (!ready.ready) {
          reportFailure(ready.detail || 'The agent is not ready.');
          return;
        }
        // The chosen public label is registered before the invitation exists,
        // so the service keeps the label the owner chose.
        await composition.registerAgentLabel();
        if (!requestOwner.isCurrent(key)) return;
      }
      const created = await composition.friends.create(setup.request);
      if (!requestOwner.isCurrent(key)) return;
      setInvitation(created.invitation);
      setInvitationLink(`${window.location.origin}/invite/${created.invitation.invitationId}`);
      // The inviter tracks its own invitation. When the invitee accepts, the
      // inviter claims the seat credential of the created match and follows
      // it, so it can play its own seat.
      composition.trackInvitation(created.invitation.invitationId, created.ownerToken, selection);
      // The invitation is published with the state the service gave it, so
      // it is listed with the other invitations of this identity.
      composition.publishOwnedInvitation(created.invitation);
      setMessage('Invitation created.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The invitation could not be created.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Cancels an invitation of this identity.
   *
   * The owner token of the invitation stays in the browser: the composition
   * sends it in the private header of the surface, so the service proves the
   * ownership itself. The record of the invitation is settled only when the
   * service confirms the cancellation.
   */
  async function cancelOwnedInvitation(invitationId: string): Promise<void> {
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const cancelled = await composition.cancelOwnedInvitation(invitationId);
      if (!requestOwner.isCurrent(key)) return;
      if (invitation?.invitationId === invitationId) setInvitation(cancelled);
      setMessage('Invitation cancelled.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The invitation could not be cancelled.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Cancels the invitation of this identity that the screen names.
   *
   * The invitation on the screen is preferred, and a recovered invitation is
   * the next one. The action never names an invitation of another identity.
   */
  async function cancelInvitation(): Promise<void> {
    if (!cancelTargetId) return;
    await cancelOwnedInvitation(cancelTargetId);
  }

  /**
   * Shows an invitation of this identity.
   *
   * The inviter reads the invitation again and finds its link, so it can
   * share it once more while it is still open.
   */
  function showOwnedInvitation(view: FriendInvitation): void {
    setInvitation(view);
    setInvitationCode(view.invitationId);
    setInvitationLink(`${window.location.origin}/invite/${view.invitationId}`);
  }

  /** Reads the preview of an invitation. */
  async function previewInvitation(): Promise<void> {
    const code = invitationCode.trim().split('/').filter(Boolean).pop() ?? '';
    if (code.length === 0) {
      reportFailure('Enter the invitation code.');
      return;
    }
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const preview = await composition.friends.preview(code);
      if (!requestOwner.isCurrent(key)) return;
      setInvitation(preview);
      setMessage('Invitation ready.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The invitation could not be read.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Accepts an invitation and shows the created match.
   *
   * The acceptor chooses the human seat or its own agent before the
   * acceptance, and the private selection of that agent is captured before
   * the service is asked, so the seat of the created match keeps it.
   */
  async function acceptInvitation(): Promise<void> {
    if (!invitation) return;
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const selection = joinControl === 'agent' ? ownAgent?.selection ?? null : null;
      if (joinControl === 'agent') {
        if (!selection) {
          reportFailure('Choose your agent first.');
          return;
        }
        const ready = await checkOwnAgent(selection);
        if (!requestOwner.isCurrent(key)) return;
        if (!ready.ready) {
          reportFailure(ready.detail || 'The agent is not ready.');
          return;
        }
        await composition.registerAgentLabel();
        if (!requestOwner.isCurrent(key)) return;
      }
      const accepted = await composition.friends.accept(
        invitation.invitationId,
        selection ? { kind: 'agent', modelLabel: ownAgentLabel ?? 'Agent' } : { kind: 'human' },
      );
      if (!requestOwner.isCurrent(key)) return;
      if (accepted.guestCredential) {
        composition.registerGuestCredential(createGuestCredential({
          guestId: accepted.guestCredential.guestId,
          matchId: accepted.guestCredential.matchId,
          seat: accepted.guestCredential.seat,
          token: accepted.guestCredential.token,
        }), 'guest');
      }
      // The seat of the acceptor keeps the model the owner chose, so the
      // browser plays it with its own private selection.
      composition.attachAndFocus(accepted.match.matchId, accepted.seat, undefined, selection);
      setTab('games');
      setMessage('Match started.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The invitation could not be accepted.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /** Proposes a rematch of the focused match. */
  async function proposeRematch(): Promise<void> {
    if (!focusedId) return;
    const matchId = focusedId;
    const key = requestOwner.begin();
    if (!key) return;
    // The private selection of the agent is captured before the service is
    // asked, so the seat of the new match keeps the model of the owner.
    const selection = composition.agent?.selection ?? null;
    try {
      const rematch = await composition.friends.proposeRematch(matchId);
      if (!requestOwner.isCurrent(key)) return;
      // The proposer tracks the rematch: it claims the seat of the new match
      // after the opponent accepted it.
      composition.trackRematch(rematch.rematchId, matchId, selection);
      setRematchOffer({ matchId, offer: rematch });
      setMessage(`Rematch proposed: ${rematch.status}.`);
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The rematch could not be proposed.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /** Accepts a rematch offer and shows the created match. */
  async function acceptRematch(): Promise<void> {
    const offer = rematchOffer;
    if (!offer || offer.matchId !== focusedId) return;
    // The proposer cannot accept its own offer, and a dead offer is never
    // accepted. The service refuses both, so the screen does not ask for it.
    if (rematchAction(offer.offer, { now }) === 'none') return;
    const key = requestOwner.begin();
    if (!key) return;
    try {
      // The private selection of the agent is captured before the service is
      // asked, so the new seat keeps the model of the owner.
      const selection = composition.agent?.selection ?? null;
      const accepted = await composition.friends.acceptRematch(offer.offer.rematchId, { rotateCredential: true, matchId: offer.matchId });
      if (!requestOwner.isCurrent(key)) return;
      if (accepted.guestCredential) {
        composition.registerGuestCredential(createGuestCredential({
          guestId: accepted.guestCredential.guestId,
          matchId: accepted.guestCredential.matchId,
          seat: accepted.guestCredential.seat,
          token: accepted.guestCredential.token,
        }), 'guest');
      }
      composition.attachAndFocus(accepted.match.matchId, accepted.seat, undefined, selection);
      setRematchOffer(null);
      setMessage('Rematch accepted.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The rematch could not be accepted.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /** Reads the pending rematch offer of the focused match. */
  async function readRematchOffer(): Promise<void> {
    if (!focusedId) return;
    const matchId = focusedId;
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const offer = await composition.friends.pendingRematch(matchId);
      if (!requestOwner.isCurrent(key)) return;
      setRematchOffer(offer ? { matchId, offer } : null);
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The rematch could not be read.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Deletes the online account of the owner.
   *
   * The request reaches the service only from the confirmed step of the
   * flow, so the confirmation of the panel is the only way to send it. The
   * shared replays stay: the account deletion is not the erasure of the
   * replays.
   */
  async function deleteOnlineAccount(): Promise<void> {
    const key = requestOwner.begin();
    if (!key) return;
    try {
      const report = await accountDeletion.confirm();
      if (!requestOwner.isCurrent(key)) return;
      const games = report.anonymizedMatches;
      setMessage(`The online account data was deleted. ${games} shared game${games === 1 ? '' : 's'} stay as Deleted player.`);
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The account data was not deleted.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Erases every shared replay of the signed-in account.
   *
   * The scope is the whole account, and the label says so. The removal of one
   * match is the participant command of that match. The panel offers this
   * action to a signed-in account only, so the request never reaches the
   * account route with a guest.
   *
   * The request reaches the service only from the confirmed step of the
   * flow, so the confirmation of the panel is the only way to send it. The
   * erasure removes the shared replays of both participants, and the owner
   * may keep them.
   */
  async function eraseEverySharedReplay(): Promise<void> {
    const key = requestOwner.begin();
    if (!key) return;
    try {
      await accountErasure.confirm();
      if (!requestOwner.isCurrent(key)) return;
      setMessage('Every shared replay of this account was erased.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The replays were not erased.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Erases the shared replays of the guest seat of this browser.
   *
   * The scope is the guest seat, never the account of a signed-in browser. The
   * request stays on the guest path, and it proves the ownership of the seat
   * with the guest credential.
   *
   * The request reaches the service only from the confirmed step of the
   * flow, so the confirmation of the panel is the only way to send it.
   */
  async function eraseGuestReplays(): Promise<void> {
    const key = requestOwner.begin();
    if (!key) return;
    try {
      // The scope is the guest seat of this browser, never one match and
      // never the account of a signed-in browser. The seat of the focused
      // match is read when the owner confirms.
      await guestErasure.confirm(focusedId !== null && seat !== null ? { matchId: focusedId, seat } : null);
      if (!requestOwner.isCurrent(key)) return;
      setMessage('The shared replays of this guest seat were erased.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The replays were not erased.');
    } finally {
      requestOwner.finish(key);
    }
  }

  /**
   * Reads the public game history of a profile.
   *
   * The read is a public read, so it needs no credential. The answer of the
   * service is the published history of the profile, and the screen shows its
   * games. The games of a previous profile leave the screen with the read,
   * so a history never shows the games of another profile.
   */
  async function readHistory(): Promise<void> {
    const profileId = historyProfile.trim();
    if (profileId.length === 0) {
      reportFailure('Enter a profile id.');
      return;
    }
    const key = requestOwner.begin();
    if (!key) return;
    // The games of the previous profile leave the screen before the read, so
    // a history never shows the games of another profile.
    setHistory(null);
    try {
      const answer = await composition.publicHistory.history(profileId);
      if (!requestOwner.isCurrent(key)) return;
      setHistory(answer);
      setMessage('History loaded.');
    } catch (error) {
      if (!requestOwner.isCurrent(key)) return;
      reportFailure(error instanceof Error ? error.message : 'The history could not be read.');
    } finally {
      requestOwner.finish(key);
    }
  }

  return <section className="focus-page online-workspace" aria-label="Online play">
    <div className="panel-heading">
      <h2>Online</h2>
      <IconButton icon="close" label="Close online play" onClick={onClose} />
    </div>
    <nav className="online-tabs" aria-label="Online sections">
      <button className="button secondary online-tab" type="button" aria-label="New play" aria-pressed={tab === 'new'} onClick={() => setTab('new')}>
        <Icon name="plus" /><span>New game</span>
      </button>
      <button className="button secondary online-tab" type="button" aria-label="Games" aria-pressed={tab === 'games'} onClick={() => setTab('games')}>
        <Icon name="moves" /><span>Games</span>
      </button>
      <button className="button secondary online-tab" type="button" aria-label="Profile and history" aria-pressed={tab === 'profile'} onClick={() => setTab('profile')}>
        <Icon name="account" /><span>Profile &amp; history</span>
      </button>
    </nav>
    <OnlineFailureNotice failure={failure || queueFailure} />

    {agentService && agentConnectionStore && <section className="online-agent-panel" aria-label="Your online agent">
      <div className="online-agent-heading">
        <div>
          <h3>Your agent</h3>
          <p>{ownAgentLabel ? `${ownAgentLabel} is ready.` : 'Connect a model to play online.'}</p>
        </div>
        <IconButton
          icon={connectAgentOpen ? 'close' : 'link'}
          label={connectAgentOpen ? 'Close agent connection' : 'Connect an agent'}
          variant={connectAgentOpen ? 'default' : 'primary'}
          onClick={() => setConnectAgentOpen(value => !value)}
        />
      </div>
      {connectAgentOpen && <OpponentPanel
        service={agentService}
        connectionStore={agentConnectionStore}
        namespace={agentNamespace ?? { kind: 'guest' }}
        idPrefix="online-agent"
        selected={ownAgent?.selection ?? null}
        onSelectionInvalidated={() => composition.setAgent(null)}
        onSelect={(selection, identity) => {
          composition.setAgent({ label: identity.modelId, selection });
          setConnectAgentOpen(false);
          setMessage(`${identity.modelId} is ready for online play.`);
          onAgentConnected?.();
        }}
      />}
    </section>}

    {tab === 'new' && <section className="online-panel online-new-panel" aria-label="New play">
      <div className="online-new-heading">
        <div>
          <h3 className="online-route-heading" aria-label="Choose a route" />
          <p className="online-route-note" aria-label="Pick one way to start. Your game opens in Games." />
        </div>
        <div className="online-clock" role="group" aria-label="Clock">
          {CLOCK_CHOICES.map((choice, index) => <button
            key={`${choice.minutes}-${choice.increment}`}
            type="button"
            className={`button ${clockIndex === index ? 'primary' : 'quiet'}`}
            aria-pressed={clockIndex === index}
            onClick={() => setClockIndex(index)}>{choice.minutes}+{choice.increment}</button>)}
        </div>
      </div>

      <section className="online-path online-queue-path" aria-label="Queue for a match">
        <div className="online-path-heading">
          <div>
            <h3 className="online-path-title" aria-label="Queue" />
            <p className="online-path-note" aria-label="Find a casual opponent." />
          </div>
          <span className={`online-path-badge${composition.accountSignedIn ? ' is-ready' : ''}`} data-label={composition.accountSignedIn ? 'Account' : 'Sign in required'} aria-label={composition.accountSignedIn ? 'Account' : 'Sign in required'} />
        </div>
        <div className="button-row">
          <IconButton icon="play" label="Play yourself" variant="primary" disabled={busy || !composition.features.queue || !composition.accountSignedIn} onClick={() => void enterQueue({ kind: 'human' })} />
          <IconButton icon="moves" label="Watch agent" disabled={busy || !composition.features.queue || !composition.accountSignedIn || !ownAgentLabel} onClick={() => void enterQueue({ kind: 'agent', modelLabel: ownAgentLabel ?? 'Agent' })} />
          <IconButton icon="plus" label="Another entry" disabled={busy || !composition.features.queue || !composition.accountSignedIn} onClick={() => void enterExplicitEntry('human')} />
          <IconButton icon="moves" label="Another agent entry" disabled={busy || !composition.features.queue || !composition.accountSignedIn || !ownAgentLabel} onClick={() => void enterExplicitEntry('agent')} />
        </div>
        {onConfigureAgent && !ownAgentLabel && <button className="button quiet online-connect-agent" type="button" onClick={onConfigureAgent}>Connect an AI</button>}
        {ownAgentLabel && <p className="online-agent-ready" role="status">Agent ready: {ownAgentLabel}</p>}
        {composition.featuresStatus === 'unreachable' && <p role="status">Online play cannot reach the server right now. Check the connection and reopen this panel.</p>}
        {composition.featuresStatus === 'answered' && !composition.features.queue && !composition.features.friends && <p role="status">Online play is switched off on the server right now.</p>}
        {composition.features.queue && !composition.accountSignedIn && <p role="status">Sign in to join the queue. Friend games work without an account.</p>}
        {queue.detail && queue.detail !== queueFailure && <p role="status">{queue.detail}</p>}
        {queue.options.length > 0 && <div className="button-row">
          {queue.options.includes('retry') && <button className="button" type="button" onClick={() => queueOption('retry')}>Retry</button>}
          {queue.options.includes('play-yourself') && <IconButton icon="play" label="Play yourself" variant="default" onClick={() => queueOption('play-yourself')} />}
          {queue.options.includes('keep-searching') && <button className="button" type="button" onClick={() => queueOption('keep-searching')}>Keep searching</button>}
          {queue.options.includes('rejoin') && <button className="button" type="button" onClick={() => queueOption('rejoin')}>Rejoin</button>}
          {queue.options.includes('cancel') && <IconButton icon="close" label="Cancel" onClick={() => queueOption('cancel')} />}
        </div>}
        {queue.assignment && <p role="status">Matched. {queue.assignment.opponentLabel}</p>}

        {composition.queueEntries.length > 0 && <ul className="online-entries" aria-label="Queue entries">
          {composition.queueEntries.map(entry => <li key={entry.id}>
            <span className="online-entry-context">{queueEntryContext(entry)}</span>
            <span className="online-entry-state">{entry.state.detail || entry.state.phase}</span>
            <IconButton icon="moves" label={queueEntryControlLabel(entry, 'show')} onClick={() => entry.focus()} />
            <IconButton icon="close" label={queueEntryControlLabel(entry, 'cancel')} disabled={busy} onClick={() => void entry.cancel()} />
          </li>)}
        </ul>}
      </section>

      <section className="online-path online-friend-path" aria-label="Play with a friend">
        <div className="online-path-heading">
          <div>
            <h3>Friend</h3>
            <p className="online-path-note" aria-label="Use a link or a code." />
          </div>
        </div>
        <div className="online-friend-grid">
        <section className="online-panel online-friend-panel" aria-label="Invite a friend">
        <div className="button-row" role="group" aria-label="Invitation kind">
          <button className={`button ${friendKind === 'link' ? 'primary' : 'quiet'}`} type="button" aria-pressed={friendKind === 'link'} onClick={() => setFriendKind('link')}>Link</button>
          <button className={`button ${friendKind === 'challenge' ? 'primary' : 'quiet'}`} type="button" aria-pressed={friendKind === 'challenge'} disabled={!composition.accountSignedIn} onClick={() => setFriendKind('challenge')}>Challenge</button>
        </div>
        {friendKind === 'challenge' && <label className="online-field">Account
          <input value={friendRecipient} aria-label="Recipient account" onChange={event => setFriendRecipient(event.target.value)} />
        </label>}
        {composition.features.friends && !composition.accountSignedIn && <p role="status">Sign in for a named challenge.</p>}
        <div className="button-row" role="group" aria-label="Inviter color">
          <button className={`button ${friendSeat === 'white' ? 'primary' : 'quiet'}`} type="button" aria-pressed={friendSeat === 'white'} onClick={() => setFriendSeat('white')}>White</button>
          <button className={`button ${friendSeat === 'black' ? 'primary' : 'quiet'}`} type="button" aria-pressed={friendSeat === 'black'} onClick={() => setFriendSeat('black')}>Black</button>
        </div>
        <div className="button-row" role="group" aria-label="Inviter seat">
          <button className={`button ${friendControl === 'human' ? 'primary' : 'quiet'}`} type="button" aria-pressed={friendControl === 'human'} onClick={() => setFriendControl('human')}>Human</button>
          <button className={`button ${friendControl === 'agent' ? 'primary' : 'quiet'}`} type="button" aria-pressed={friendControl === 'agent'} disabled={!ownAgent} onClick={() => setFriendControl('agent')}>Agent</button>
        </div>
        <label className="online-field">Position
          <input value={friendFen} aria-label="Starting position" placeholder="Standard" onChange={event => setFriendFen(event.target.value)} />
        </label>
        <div className="button-row online-friend-actions">
          <IconButton icon="link" label="Invite a friend" variant="default" disabled={busy || !composition.features.friends} onClick={() => void createInvitation()} />
          <IconButton icon="close" label="Cancel invitation" disabled={busy || !cancelTargetId} onClick={() => void cancelInvitation()} />
        </div>
        {invitationLink && <label className="online-field">Invitation link
          <input readOnly value={invitationLink} aria-label="Invitation link" />
        </label>}
        {ownedInvitations.length > 0 && <ul className="online-entries" aria-label="Your invitations">
          {ownedInvitations.map(view => <li key={view.invitationId}>
            <span className="online-entry-state">{ownedInvitationStateLabel(view)}</span>
            <span className="online-entry-name">{view.invitationId}</span>
            <IconButton icon="moves" label={`Show invitation ${view.invitationId}`} onClick={() => showOwnedInvitation(view)} />
            <IconButton icon="close" label={`Cancel invitation ${view.invitationId}`} disabled={busy || !ownedInvitationCancelable(view)} onClick={() => void cancelOwnedInvitation(view.invitationId)} />
          </li>)}
        </ul>}
      </section>
        <section className="online-panel online-friend-panel" aria-label="Join a friend">
        <label className="online-field">Code
          <input value={invitationCode} aria-label="Invitation code" onChange={event => setInvitationCode(event.target.value)} />
        </label>
        <div className="button-row" role="group" aria-label="Your seat">
          <button className={`button ${joinControl === 'human' ? 'primary' : 'quiet'}`} type="button" aria-pressed={joinControl === 'human'} onClick={() => setJoinControl('human')}>Human</button>
          <button className={`button ${joinControl === 'agent' ? 'primary' : 'quiet'}`} type="button" aria-pressed={joinControl === 'agent'} disabled={!ownAgent} onClick={() => setJoinControl('agent')}>Agent</button>
        </div>
        <div className="button-row online-friend-actions">
          <button className="button quiet" type="button" disabled={busy || !composition.features.friends} onClick={() => void previewInvitation()}>Preview</button>
          <IconButton icon="check" label="Accept" variant="default" disabled={busy || !ownedInvitationAcceptable(invitation, id => composition.ownsInvitation(id))} onClick={() => void acceptInvitation()} />
        </div>
        {invitation && <FriendInvitationPreview invitation={invitation} />}
      </section>
        </div>
      </section>
    </section>}

    {tab === 'games' && <section className="online-panel" aria-label="Concurrent games">
      <div className="online-destination-heading">
        <div>
          <h3>Your games</h3>
          <p>Waiting matches and active boards live here.</p>
        </div>
        <IconButton icon="plus" label="New game" onClick={() => { setTab('new'); setMessage('Choose a clock and enter the queue for another game.'); }} />
      </div>
      {queue.phase !== 'idle' && queue.phase !== 'cancelled' && <section className={`online-queue-status online-queue-status-${queue.phase}`} aria-label="Queue status">
        <div className="online-queue-status-copy">
          <span className="online-queue-live-dot" aria-hidden="true" />
          <div>
            <h3>{queue.phase === 'matched' || queue.phase === 'assigned' ? 'Match found' : queue.phase === 'expired' ? 'Queue paused' : queue.phase === 'checking-agent' ? 'Checking your setup' : 'Searching for an opponent'}</h3>
            <p>{queue.detail || 'Your game will appear here when the queue finds a match.'}</p>
          </div>
        </div>
        <div className="button-row">
          {queue.assignment && <button className="button primary" type="button" onClick={() => openGame(queue.assignment?.matchId ?? focusedId ?? '')}>Open game</button>}
          {queue.options.includes('cancel') && <button className="button quiet" type="button" onClick={() => queueOption('cancel')}>Leave queue</button>}
          {queue.options.includes('rejoin') && <button className="button primary" type="button" onClick={() => queueOption('rejoin')}>Rejoin queue</button>}
        </div>
      </section>}
      {games.length === 0 && (queue.phase === 'idle' || queue.phase === 'cancelled') && <p>No online games yet.</p>}
      <ul className="online-games">
        {games.map(game => <li key={game.matchId}>
          <button className="button quiet" type="button" onClick={() => openGame(game.matchId)} aria-current={game.matchId === focusedId ? 'true' : undefined}>
            {game.snapshot ? onlineGameTitle(game.snapshot, game.snapshot.yourSeat) : game.matchId}
          </button>
          <span className="online-game-status">{game.status === 'live' ? '' : onlineConnectionText(game.status)}</span>
        </li>)}
      </ul>
    </section>}

    {tab === 'profile' && <section className="online-panel" aria-label="Profile and history">
      <p>{games.length} online game{games.length === 1 ? '' : 's'}.</p>
      {onOpenProfile && <button className="button secondary" type="button" onClick={onOpenProfile}><Icon name="account" /><span>Public profile</span></button>}
      <label className="online-field">ID
        <input value={historyProfile} aria-label="Public profile ID" placeholder="ID" onChange={event => setHistoryProfile(event.target.value)} />
      </label>
      <div className="button-row">
        <button className="button quiet" type="button" disabled={busy} onClick={() => void readHistory()}>Public history</button>
      </div>
      <OnlineProfileRemovals
        busy={busy}
        accountSignedIn={composition.accountSignedIn}
        guestSeatAvailable={focusedId !== null && seat !== null}
        accountDeletion={accountDeletion}
        accountErasure={accountErasure}
        guestErasure={guestErasure}
        onDeleteAccount={() => void deleteOnlineAccount()}
        onEraseAccount={() => void eraseEverySharedReplay()}
        onEraseGuest={() => void eraseGuestReplays()}
      />
      {history && <OnlinePublicHistory history={history} />}
      {view && view.result !== null && <div className="button-row">
        <a className="button quiet" href={`/v1/public/matches/${encodeURIComponent(view.matchId)}/replay`} target="_blank" rel="noreferrer">Public replay</a>
        <IconButton icon="close" label="Remove public replay" disabled={busy} onClick={() => void removeReplay()} />
      </div>}
    </section>}

    {tab === 'games' && view && position && <div className="match-layout online-match">
      <section className="board-column" aria-label="Online match board">
        {rows.map(row => {
          // A signed-in player shows the avatar their profile chose; a guest
          // or an unnamed account keeps the neutral player badge. Engine and
          // agent seats read like they do on the offline screen.
          const profile = seatProfiles.get(row.label) ?? null;
          const badge = row.control && row.control.kind !== 'human'
            ? <OpponentLogo modelId={row.control.modelLabel ?? ''} />
            : profile
              ? <ProfileAvatarView avatar={profile.avatar} profileId={profile.profileId} />
              : <span className={`player-badge ${row.seat === 'white' ? 'light' : 'dark'}-piece`} aria-hidden="true"><Icon name="user" /></span>;
          return <div key={row.seat} className={`player-row ${row.seat}`}>
            {badge}
            <div className="player-meta"><div className="player-name"><strong title={row.label}>{row.label}</strong><span className="player-control">{row.controlLabel}</span></div></div>
            <time className={`clock ${reading.activeSeat === row.seat ? 'running' : ''}`} aria-label={`${row.seat} clock ${formatOnlineClock(row.seat === 'white' ? reading.whiteMs : reading.blackMs)}`}>
              {formatOnlineClock(row.seat === 'white' ? reading.whiteMs : reading.blackMs)}
            </time>
          </div>;
        })}
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
          <IconButton icon="draw" label="Offer a draw" disabled={busy || view.status !== 'active'} onClick={() => setConfirm('draw')} />
          <IconButton icon="undo" label="Offer a takeback" disabled={busy || !takebackAllowed} onClick={() => setConfirm('takeback')} />
          <IconButton icon="resign" label="Resign game" disabled={busy || view.status !== 'active'} onClick={() => setConfirm('resign')} />
          {seat && <IconButton icon="account" label="Take over" disabled={busy || view.status !== 'active'} onClick={() => void takeOverSeat()} />}
          {seat && agentLabel && <IconButton icon="change" label="Hand to agent" disabled={busy || view.status !== 'active'} onClick={() => void handOverSeatToAgent()} />}
        </nav>
        {confirm && <OnlineConfirmPanel
          action={confirm}
          busy={busy}
          {...(confirm === 'takeback' && takebackTarget !== null ? { moveNumber: takebackTarget.moveNumber } : {})}
          onConfirm={() => void sendAction(confirm)}
          onCancel={() => setConfirm(null)}
        />}
        <OnlineOwnOfferStatus view={view} offers={ownOffers} />
        <OnlineOfferPanel
          view={view}
          offers={incomingOffers}
          busy={busy}
          onAccept={offer => void acceptOffer(offer)}
          onIgnore={offer => setIgnoredOffers(current => [...current, offer.offerId])}
        />
        <OnlineRecoveryPanel
          presence={publishedPresence}
          busy={busy}
          onClaim={() => void claimWin()}
          onKeepWaiting={() => void keepWaiting()}
        />
        {agentRunner && agentDecisionText !== null &&
          <div className="online-decisions" role="group" aria-label="Agent decisions">
            <p>{agentDecisionText}</p>
            <div className="button-row">
              <button className="button" type="button" disabled={busy || view.status !== 'active'} onClick={() => void applyDecision(view.matchId, seat ?? 'white', 'retry')}>Retry</button>
              <IconButton icon="account" label="Take over" variant="default" disabled={busy || view.status !== 'active'} onClick={() => void applyDecision(view.matchId, seat ?? 'white', 'takeover')} />
            </div>
            <div className="button-row" aria-label="Switch model">
              {composition.agentCatalog.map(entry => <button className="button" type="button" key={entry.id} disabled={busy || view.status !== 'active'}
                onClick={() => void applyDecision(view.matchId, seat ?? 'white', 'switch-model', entry.id)}>{entry.label}</button>)}
            </div>
          </div>}
        {seat && ownSeatIsAgent && !boundAgentLabel && <div className="online-decisions" role="group" aria-label="Choose your agent">
          <p>Choose the agent of this seat.</p>
          <div className="button-row">
            {composition.agentCatalog.map(entry => <button className="button" type="button" key={entry.id} disabled={busy}
              onClick={() => composition.rebindAgentSeat(view.matchId, seat, entry.id)}>{entry.label}</button>)}
          </div>
        </div>}
        {view.result !== null && <div className="button-row">
          <button className="button quiet" type="button" disabled={busy} onClick={() => void proposeRematch()}>Propose rematch</button>
          <button className="button quiet" type="button" disabled={busy} onClick={() => void readRematchOffer()}>Check for a rematch</button>
          {rematchChoice === 'accept' && <IconButton icon="check" label="Accept rematch" variant="default" disabled={busy} onClick={() => void acceptRematch()} />}
          {rematchChoice === 'open' && <IconButton icon="check" label="Open the rematch" variant="default" disabled={busy} onClick={() => void acceptRematch()} />}
        </div>}
        {rematch !== null && <p className="online-rematch" role="status">{rematchStatusText(rematch, now)}</p>}
        <div className="match-status" role="status">
          <h2 className="status-heading">{status}</h2>
        </div>
      </section>
      <aside className="moves-sidebar" aria-label="Online moves">
        <div className="moves-heading"><h2>Moves</h2><span className="count" aria-label={`Move ${ply} of ${appliedMoves.length}`}>{ply}/{appliedMoves.length}</span></div>
        <MoveList moves={appliedMoves} selectedPly={ply} visible onSelect={next => setReview({ count: moveCount, ply: next })} />
        <nav className="history-controls" aria-label="Move history"><div className="button-row">
          <IconButton icon="first" label="First" onClick={() => setReview({ count: moveCount, ply: 0 })} disabled={ply === 0} aria-keyshortcuts="Home" />
          <IconButton icon="back" label="Previous" onClick={() => setReview({ count: moveCount, ply: Math.max(0, ply - 1) })} disabled={ply === 0} aria-keyshortcuts="ArrowLeft" />
          <IconButton icon="next" label="Next" onClick={() => setReview({ count: moveCount, ply: Math.min(moveCount, ply + 1) })} disabled={ply >= appliedMoves.length} aria-keyshortcuts="ArrowRight" />
          <IconButton icon="last" label="Live" onClick={() => setReview({ count: moveCount, ply: moveCount })} disabled={ply >= appliedMoves.length} aria-keyshortcuts="End" />
        </div></nav>
      </aside>
    </div>}

    {view && view.result !== null && <p className="online-result">{onlineResultText(view)}</p>}
    {/*
      The polite status stays mounted, so a screen reader announces every
      status of the screen. A failure is not repeated here: the visible error
      announces it once.
    */}
    <p className="sr-only" role="status" aria-live="polite">{message}</p>
    <span className="sr-only" aria-live="polite">{revision}</span>
  </section>;
}
