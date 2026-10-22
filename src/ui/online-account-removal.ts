/**
 * The account removal actions of the profile panel (KHA-79).
 *
 * The panel offers three different removals, and they stay separate on
 * purpose:
 *
 * - The ordinary account deletion removes the profile and the private owner
 *   data of the online account. The shared games stay, and the deleted
 *   participant appears as `Deleted player`.
 * - The account-wide explicit removal erases the shared replays of the whole
 *   account from both online histories. It stays a separate action, and the
 *   account deletion never erases a shared replay.
 * - The guest-seat explicit removal erases the shared replays of the one seat
 *   the browser owns. It stays a separate action as well.
 *
 * The rules this module keeps:
 *
 * - The account deletion needs a signed-in account. A guest owns no account,
 *   so the panel offers a guest no account deletion, and the guest keeps the
 *   removal of the seat it owns.
 * - The account-wide explicit removal needs the signed-in account as well: it
 *   acts for the whole account, and it reaches the account removal route. A
 *   guest owns no account, so the panel offers a guest no account-wide
 *   removal, and the guest keeps the removal of the seat it owns. The two
 *   removals of a guest and of an account never share one action.
 * - The guest-seat removal stays on the guest path: it proves the ownership
 *   of the seat with the guest credential, and it never names an account.
 * - The request leaves the browser only from the confirmed step. A panel that
 *   was opened and abandoned never reaches the service.
 * - The two explicit removals ask before they act. The erasure of the shared
 *   replays is irreversible, and it removes the replays of both participants,
 *   so the confirmation names the consequence before the owner confirms it,
 *   and the owner may keep the shared replays.
 * - The flow removes the data of the online account only. It never deletes the
 *   sign-in identity of the owner, and it never touches the provider or the
 *   account infrastructure of the product.
 */
import type { OnlineRemovalReport } from '../online/privacy.js';
import type { Seat } from '../online/contracts.js';

/**
 * The privacy surface of the composition that the account deletion uses.
 *
 * The surface carries the ordinary deletion only, so the flow can never reach
 * the explicit removal of the shared replays by accident.
 */
export interface OnlineAccountRemovalSurface {
  /** Deletes the account and anonymizes the shared games. */
  deleteAccount(): Promise<OnlineRemovalReport>;
}

/** The step of the ordinary account deletion. */
export type OnlineAccountDeletionStep = 'idle' | 'asking' | 'confirmed';

/** The flow of the ordinary account deletion. */
export interface OnlineAccountDeletion {
  /** The step the flow is in. */
  readonly step: OnlineAccountDeletionStep;
  /**
   * Opens the confirmation of the panel.
   *
   * The step never reaches the service: the request is sent by the confirmed
   * step alone.
   */
  open(): void;
  /** Closes the confirmation without a request. */
  cancel(): void;
  /**
   * Confirms the deletion and sends the request.
   *
   * The request leaves the browser only from the confirmed step, so a panel
   * that was opened and abandoned never reaches the service.
   */
  confirm(): Promise<OnlineRemovalReport>;
}

/** The options of the account deletion flow. */
export interface OnlineAccountDeletionOptions {
  /** The privacy surface of the composition. */
  readonly privacy: OnlineAccountRemovalSurface;
  /** Called when the step moved, so the screen renders the new step. */
  readonly onChange?: (step: OnlineAccountDeletionStep) => void;
}

/**
 * True when the browser may delete the account.
 *
 * Only a signed-in account owns an account to delete. A guest owns a seat, and
 * the removal of that seat stays a separate action.
 */
export function onlineAccountDeletionVisible(accountSignedIn: boolean): boolean {
  return accountSignedIn;
}

/**
 * The privacy surface of the composition that the removals of the shared
 * replays use.
 *
 * The surface carries the two explicit removals, so the panel keeps the
 * account-wide removal and the guest-seat removal apart.
 */
export interface OnlineReplayRemovalSurface {
  /** Erases the shared replays of the whole signed-in account. */
  removeAccount(): Promise<OnlineRemovalReport>;
  /** Erases the shared replays of the guest seat this browser owns. */
  removeGuest(matchId: string, seat: Seat): Promise<OnlineRemovalReport>;
}

/**
 * True when the browser may erase every shared replay of its account.
 *
 * The account-wide removal acts for the whole account, so it needs the
 * signed-in account credential. A guest owns no account: the panel offers a
 * guest no account-wide removal, and the guest keeps the removal of the seat
 * it owns.
 */
export function onlineAccountReplayRemovalVisible(accountSignedIn: boolean): boolean {
  return accountSignedIn;
}

/**
 * The visible label of the account-wide removal of the shared replays.
 *
 * The label names the scope of the removal, so the owner never reads it as
 * the removal of the seat of this browser.
 */
export function onlineAccountReplayRemovalLabel(): string {
  return 'Erase every shared replay of this account';
}

/**
 * The visible label of the removal of the shared replays of the guest seat.
 *
 * The label names the scope of the removal, so the owner never reads it as
 * the account-wide removal.
 */
export function onlineGuestReplayRemovalLabel(): string {
  return 'Erase the shared replays of this guest seat';
}

/**
 * Erases the shared replays of the guest seat this browser owns.
 *
 * The path is the guest path: the request proves the ownership of the seat
 * with the guest credential, and it never names an account. The account-wide
 * removal is a different action, and it never reaches this path.
 */
export function eraseGuestSeatReplays(
  privacy: OnlineReplayRemovalSurface,
  matchId: string,
  seat: Seat,
): Promise<OnlineRemovalReport> {
  return privacy.removeGuest(matchId, seat);
}

/**
 * The scope of an explicit erasure of the shared replays.
 *
 * The account scope erases the shared replays of the whole signed-in
 * account. The guest scope erases the shared replays of the one seat the
 * browser owns. The two scopes stay apart, and the guest scope never names
 * an account.
 */
export type OnlineReplayErasureScope = 'account' | 'guest';

/** The step of an explicit erasure of the shared replays. */
export type OnlineReplayErasureStep = 'idle' | 'asking' | 'confirmed';

/**
 * The seat of the guest scope of an explicit erasure.
 *
 * The seat is read when the owner confirms, so the erasure acts for the
 * seat the browser owns at that moment.
 */
export interface OnlineReplayErasureSeat {
  /** The match of the seat. */
  readonly matchId: string;
  /** The seat of the browser in the match. */
  readonly seat: Seat;
}

/**
 * The flow of an explicit erasure of the shared replays.
 *
 * The flow owns the confirmation, exactly like the flow of the ordinary
 * account deletion. The erasure is irreversible, and it removes the shared
 * replays of both participants, so the request leaves the browser only from
 * the confirmed step.
 */
export interface OnlineReplayErasure {
  /** The scope of the erasure. */
  readonly scope: OnlineReplayErasureScope;
  /** The step the flow is in. */
  readonly step: OnlineReplayErasureStep;
  /**
   * Opens the confirmation of the erasure.
   *
   * The step never reaches the service: the request is sent by the
   * confirmed step alone.
   */
  open(): void;
  /** Closes the confirmation without a request. */
  cancel(): void;
  /**
   * Confirms the erasure and sends the request.
   *
   * The request leaves the browser only from the confirmed step, so a panel
   * that was opened and abandoned never reaches the service. The guest scope
   * needs the seat it acts for, and the caller reads that seat when the owner
   * confirms. The account scope never uses a seat.
   */
  confirm(seat?: OnlineReplayErasureSeat | null): Promise<OnlineRemovalReport>;
}

/** The options of the flow of an explicit erasure of the shared replays. */
export interface OnlineReplayErasureOptions {
  /** The scope of the erasure. */
  readonly scope: OnlineReplayErasureScope;
  /** The privacy surface of the composition. */
  readonly privacy: OnlineReplayRemovalSurface;
  /** Called when the step moved, so the screen renders the new step. */
  readonly onChange?: (step: OnlineReplayErasureStep) => void;
}

/**
 * Creates the flow of an explicit erasure of the shared replays.
 *
 * The flow owns the confirmation, so the request reaches the service only
 * when the owner confirmed it. The two scopes keep their own paths: the
 * account scope reaches the account route with the signed-in credential, and
 * the guest scope stays on the guest path with the seat credential.
 */
export function createOnlineReplayErasure(options: OnlineReplayErasureOptions): OnlineReplayErasure {
  let step: OnlineReplayErasureStep = 'idle';
  const publish = (): void => {
    options.onChange?.(step);
  };
  return {
    scope: options.scope,
    get step() {
      return step;
    },
    open() {
      if (step === 'asking') return;
      step = 'asking';
      publish();
    },
    cancel() {
      if (step !== 'asking') return;
      step = 'idle';
      publish();
    },
    async confirm(target?: OnlineReplayErasureSeat | null) {
      // The request leaves the browser only from the confirmed step: an
      // unconfirmed flow never reaches the service.
      if (step !== 'asking') throw new Error('The erasure of the shared replays was not confirmed.');
      step = 'confirmed';
      publish();
      try {
        if (options.scope === 'account') {
          // The scope is the whole account, and the request names the
          // signed-in account. A seat never narrows this scope.
          return await options.privacy.removeAccount();
        }
        if (!target) {
          throw new Error('Open a game before erasing the shared replays of a guest seat.');
        }
        // The scope is the one seat of this browser, and the request stays
        // on the guest path.
        return await eraseGuestSeatReplays(options.privacy, target.matchId, target.seat);
      } catch (error) {
        // A refused request leaves the confirmation open, so the owner may
        // try again without opening the panel again.
        step = 'asking';
        publish();
        throw error;
      }
    },
  };
}

/**
 * The note of the ordinary account deletion.
 *
 * The note tells the owner what the deletion keeps, so the account deletion
 * never reads as the erasure of the shared replays. The note stays short, so
 * the visible copy of the profile panel stays inside the twenty-word
 * convention. The full question of the deletion carries the rest.
 */
export function onlineAccountDeletionNote(): string {
  return 'Shared games stay as Deleted player.';
}

/**
 * The note of the explicit removal of the shared replays.
 *
 * The note names the effect of the erasure, so the owner tells the two
 * removals apart before it acts. The note stays short, so the visible copy
 * of the profile panel stays inside the twenty-word convention. The full
 * consequence of the erasure is in the confirmation.
 */
export function onlineReplayErasureNote(): string {
  return 'Both players lose the shared replays.';
}

/**
 * The consequence of an explicit removal of the shared replays.
 *
 * The consequence names what the erasure removes and what it leaves, so the
 * owner reads the effect before it confirms. The consequence is the same for
 * the two scopes: both participants lose the shared replays.
 */
export function onlineReplayErasureConsequence(): string {
  return 'Both players lose the shared replays. Only anonymous results stay.';
}

/**
 * The copy of the confirmation of an explicit removal of the shared replays.
 *
 * The question names the scope of the erasure, so the account-wide erasure
 * never reads as the erasure of the seat of this browser, and it names the
 * consequence of the erasure for both participants.
 */
export function onlineReplayErasureCopy(scope: OnlineReplayErasureScope): string {
  if (scope === 'account') {
    return `Erase every shared replay of this account? ${onlineReplayErasureConsequence()}`;
  }
  return `Erase the shared replays of this guest seat? ${onlineReplayErasureConsequence()}`;
}

/** The accessible name of the confirmation of an explicit removal. */
export function onlineReplayErasureConfirmGroup(): string {
  return 'Confirm the erasure of the shared replays';
}

/** The visible label of the action that confirms an explicit removal. */
export function onlineReplayErasureConfirmLabel(): string {
  return 'Erase the shared replays';
}

/** The visible label of the action that keeps the shared replays. */
export function onlineReplayErasureCancelLabel(): string {
  return 'Keep the shared replays';
}

/** The visible label of the action that opens the confirmation. */
export function onlineAccountDeletionLabel(): string {
  return 'Delete online account data';
}

/** The visible label of the action that confirms the deletion. */
export function onlineAccountDeletionConfirmLabel(): string {
  return 'Delete the account data';
}

/** The visible label of the action that keeps the account. */
export function onlineAccountDeletionCancelLabel(): string {
  return 'Keep the account data';
}

/** The accessible name of the confirmation of the account deletion. */
export function onlineAccountDeletionConfirmGroup(): string {
  return 'Confirm account deletion';
}

/**
 * The copy of the confirmation of the account deletion.
 *
 * The copy names what the deletion removes and what it keeps, so the owner
 * never reads the account deletion as the erasure of the shared replays.
 */
export function onlineAccountDeletionCopy(): string {
  return 'Delete your online account data? Your profile and private data go. Shared games stay as Deleted player.';
}

/**
 * Creates the flow of the ordinary account deletion.
 *
 * The flow owns the confirmation, so the request reaches the service only when
 * the owner confirmed it.
 */
export function createOnlineAccountDeletion(options: OnlineAccountDeletionOptions): OnlineAccountDeletion {
  let step: OnlineAccountDeletionStep = 'idle';
  const publish = (): void => {
    options.onChange?.(step);
  };
  return {
    get step() {
      return step;
    },
    open() {
      if (step === 'asking') return;
      step = 'asking';
      publish();
    },
    cancel() {
      if (step !== 'asking') return;
      step = 'idle';
      publish();
    },
    async confirm() {
      // The request leaves the browser only from the confirmed step: an
      // unconfirmed flow never reaches the service.
      if (step !== 'asking') throw new Error('The account deletion was not confirmed.');
      step = 'confirmed';
      publish();
      try {
        return await options.privacy.deleteAccount();
      } catch (error) {
        // A refused request leaves the confirmation open, so the owner may
        // try again without opening the panel again.
        step = 'asking';
        publish();
        throw error;
      }
    },
  };
}
