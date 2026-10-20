/**
 * The participant command client (KHA-74, KHA-77).
 *
 * One online match is changed by versioned commands. The service owns the
 * legality, the clocks and the outcomes; the browser proposes an action and
 * reads the receipt.
 *
 * The rules this module keeps:
 *
 * - The command body is exactly the shared `Command` contract of schema
 *   version 2. The browser never invents a field and never sends state the
 *   service did not ask for.
 * - The credential travels in the request header of the authorized requester.
 *   The client never puts a credential into a path, a query string or a body.
 * - Every command carries an operation identifier, so a retry of the same
 *   operation answers with the same receipt instead of acting twice.
 * - The expected version is the version the browser last saw. A stale command
 *   is refused by the service, never silently applied.
 * - The answer is parsed with the shared receipt parser. A receipt of another
 *   match is refused.
 */
import { parseReceipt } from './contracts';
import type { OnlineAction, Receipt, Seat, SeatControl } from './contracts';
import { ONLINE_CONTRACTS_SCHEMA_VERSION } from './contracts';
import { matchSeatScope } from './auth';
import type { AuthorizedRequester } from './request';
import type { ParticipantSession } from './session';

/** The path of the participant command route. */
export function onlineCommandsPath(matchId: string): string {
  return `/v1/online/matches/${encodeURIComponent(matchId)}/commands`;
}

/** The failure of a command. */
export type OnlineCommandErrorCode =
  | 'invalid-receipt'
  | 'wrong-match'
  | 'http-error'
  | 'refused';

/** A command that the service did not accept. */
export class OnlineCommandError extends Error {
  readonly code: OnlineCommandErrorCode;
  readonly status: number;

  constructor(code: OnlineCommandErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'OnlineCommandError';
    this.code = code;
    this.status = status;
  }
}

export interface OnlineMatchCommandOptions {
  readonly requester: AuthorizedRequester;
  readonly session: ParticipantSession;
  readonly matchId: string;
  readonly seat: Seat;
  /** The control epoch the browser last saw. Defaults to one. */
  readonly controlEpoch?: number;
  /** The version the browser last saw. Defaults to one. */
  readonly expectedVersion?: number;
  /** Creates the operation identifier of a command. */
  readonly createOperationId?: () => string;
}

/** The options of one command. */
export interface OnlineCommandSubmitOptions {
  /** The idempotency identifier of the operation. */
  readonly operationId?: string;
  /** The version the command expects. */
  readonly expectedVersion?: number;
  /**
   * The runner lease of an agent or engine seat.
   *
   * The service requires the lease on every command of such a seat.
   */
  readonly leaseId?: string;
}

/** The participant command client of one match. */
export interface OnlineMatchCommandClient {
  /** The match this client acts on. */
  readonly matchId: string;
  /** The seat this client acts for. */
  readonly seat: Seat;
  /** The version the next command expects. */
  readonly expectedVersion: number;
  /** Records the version of an accepted snapshot. */
  setVersion(version: number): void;
  /** Records the control epoch of an accepted snapshot. */
  setControlEpoch(epoch: number): void;
  /** Proposes one action. */
  submit(action: OnlineAction, options?: OnlineCommandSubmitOptions): Promise<Receipt>;
  /** Proposes a move in UCI notation. */
  move(uci: string, options?: OnlineCommandSubmitOptions): Promise<Receipt>;
  /** Resigns the seat. */
  resign(options?: OnlineCommandSubmitOptions): Promise<Receipt>;
  /** Cancels the match. It aborts before the seat's first move and resigns afterwards. */
  cancel(options?: OnlineCommandSubmitOptions): Promise<Receipt>;
  /** Offers a draw. */
  offerDraw(options?: OnlineCommandSubmitOptions): Promise<Receipt>;
  /** Accepts a draw offer. */
  acceptDraw(offerId: string, options?: OnlineCommandSubmitOptions): Promise<Receipt>;
  /** Offers an exact takeback. */
  offerTakeback(targetVersion: number, options?: OnlineCommandSubmitOptions): Promise<Receipt>;
  /** Accepts a takeback offer. */
  acceptTakeback(offerId: string, options?: OnlineCommandSubmitOptions): Promise<Receipt>;
  /** Changes the declared control of the seat. */
  setControl(control: SeatControl, options?: OnlineCommandSubmitOptions): Promise<Receipt>;
}

function defaultOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `op${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * Creates the command client of one match.
 *
 * The client owns no chess authority. It proposes an action and reports the
 * receipt the service answered.
 */
export function createOnlineMatchCommandClient(options: OnlineMatchCommandOptions): OnlineMatchCommandClient {
  const { requester, matchId, seat } = options;
  const scope = matchSeatScope(matchId, seat);
  const path = onlineCommandsPath(matchId);
  const createOperationId = options.createOperationId ?? defaultOperationId;
  let expectedVersion = options.expectedVersion ?? 1;
  let controlEpoch = options.controlEpoch ?? 1;

  async function submit(
    action: OnlineAction,
    submitOptions: OnlineCommandSubmitOptions = {},
  ): Promise<Receipt> {
    const version = submitOptions.expectedVersion ?? expectedVersion;
    const command = {
      schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
      matchId,
      operationId: submitOptions.operationId ?? createOperationId(),
      expectedVersion: version,
      seat,
      controlEpoch,
      // The lease is only carried when the seat holds one. The field is
      // optional, so a human seat keeps the exact command shape.
      ...(submitOptions.leaseId ? { leaseId: submitOptions.leaseId } : {}),
      action,
    };
    const result = await requester.request(scope, { path, method: 'POST', body: command });
    if (!result.ok) {
      throw new OnlineCommandError('refused', `The service refused the command (${result.status}).`, result.status);
    }
    let receipt: Receipt;
    try {
      receipt = parseReceipt(result.data);
    } catch (error) {
      throw new OnlineCommandError('invalid-receipt', error instanceof Error ? error.message : 'The receipt is invalid.');
    }
    if (receipt.matchId !== matchId) {
      throw new OnlineCommandError('wrong-match', 'The receipt belongs to another match.');
    }
    if (receipt.version > expectedVersion) expectedVersion = receipt.version;
    if (receipt.controlEpoch > controlEpoch) controlEpoch = receipt.controlEpoch;
    return receipt;
  }

  return {
    matchId,
    seat,
    get expectedVersion() {
      return expectedVersion;
    },
    setVersion(version) {
      if (Number.isSafeInteger(version) && version > 0) expectedVersion = version;
    },
    setControlEpoch(epoch) {
      if (Number.isSafeInteger(epoch) && epoch > 0) controlEpoch = epoch;
    },
    submit,
    move(uci, moveOptions) {
      return submit({ kind: 'submit_move', move: uci }, moveOptions);
    },
    resign(resignOptions) {
      return submit({ kind: 'resign' }, resignOptions);
    },
    cancel(cancelOptions) {
      return submit({ kind: 'cancel' }, cancelOptions);
    },
    offerDraw(drawOptions) {
      return submit({ kind: 'offer_draw' }, drawOptions);
    },
    acceptDraw(offerId, acceptOptions) {
      return submit({ kind: 'accept_draw', offerId }, acceptOptions);
    },
    offerTakeback(targetVersion, takebackOptions) {
      return submit({ kind: 'offer_takeback', targetVersion }, takebackOptions);
    },
    acceptTakeback(offerId, acceptOptions) {
      return submit({ kind: 'accept_takeback', offerId }, acceptOptions);
    },
    setControl(control, controlOptions) {
      return submit({ kind: 'set_control', control }, controlOptions);
    },
  };
}
