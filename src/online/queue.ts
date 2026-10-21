/**
 * The public matchmaking queue for casual online play (KHA-76).
 *
 * The queue is account-only and explicit. One entry is one person's request
 * for one game: the entry is consumed once, it produces exactly one game,
 * and completing a game never queues another one.
 *
 * This module owns the wire contract of the queue routes and the domain
 * rules of an entry. It owns no transport: `src/online/queue-client.ts` is
 * the HTTP adapter, and the workspace composes the two.
 *
 * The rules the module keeps:
 *
 * - The creation of an entry is the authoritative ready acceptance. The
 *   service records the ready time and starts the ten second window there,
 *   so no search time elapses during the browser's own readiness checks.
 * - The client request identifier makes the creation idempotent per owner. A
 *   second tab that replays the same identifier receives the same entry and
 *   creates no second game.
 * - The ready route is the explicit rejoin of an expired entry. It re-arms a
 *   fresh window and never extends a window that already runs.
 * - The keep-searching route removes the automatic cutoff. The entry then
 *   waits until it is matched, cancelled or expired.
 * - The match route asks the service to pair the entry. A missing candidate
 *   is an empty answer, not an error.
 * - The fallback route commits the browser engine. The answer carries the
 *   seat-scoped credential that lets the owner's browser move the engine, and
 *   it carries one only when the service issued one.
 *
 * The module never guesses. An expired entry is reported as expired, an
 * assigned entry as assigned, and an answer that does not parse is refused
 * instead of being repaired.
 */
import { ONLINE_CONTRACTS_SCHEMA_VERSION, parseQueueEntry } from './contracts';
import type { QueueEntry, Seat, SeatControl } from './contracts';

export { parseQueueEntry } from './contracts';
export type { QueueEntry } from './contracts';

/** The route of the queue entries. */
export const QUEUE_ENTRIES_PATH = '/v1/online/queue/entries';

/** The route of one queue entry. */
export function queueEntryPath(entryId: string): string {
  return `${QUEUE_ENTRIES_PATH}/${encodeURIComponent(entryId)}`;
}

/** The route that re-arms an entry. It is the explicit rejoin. */
export function queueEntryReadyPath(entryId: string): string {
  return `${queueEntryPath(entryId)}/ready`;
}

/** The route that removes a waiting entry. */
export function queueEntryCancelPath(entryId: string): string {
  return `${queueEntryPath(entryId)}/cancel`;
}

/** The route that removes the automatic cutoff of a waiting entry. */
export function queueEntryKeepSearchingPath(entryId: string): string {
  return `${queueEntryPath(entryId)}/keep-searching`;
}

/** The route that renews the readiness lease of a waiting entry. */
export function queueEntryHeartbeatPath(entryId: string): string {
  return `${queueEntryPath(entryId)}/heartbeat`;
}

/** The route that pairs the entry with a compatible ready entry. */
export function queueEntryMatchPath(entryId: string): string {
  return `${queueEntryPath(entryId)}/match`;
}

/** The route that commits the browser engine fallback. */
export function queueEntryFallbackPath(entryId: string): string {
  return `${queueEntryPath(entryId)}/fallback`;
}

/** The body of one explicit entry creation. */
export interface QueueCreateEntryRequest {
  readonly schemaVersion: number;
  /** The seat the owner asks for: a human seat or a selected agent seat. */
  readonly control: SeatControl;
  /** The clock of the entry. Only identical clocks are compatible. */
  readonly timeControl: { readonly startingTimeMs: number; readonly incrementMs: number };
  /** The idempotency key of the entry intent. It is optional. */
  readonly clientRequestId?: string;
}

/** The body of one mutating queue operation. */
export interface QueueOperationRequest {
  readonly schemaVersion: number;
  /** The idempotency key of the operation. It is optional. */
  readonly operationId?: string;
}

/** The seat-scoped credential of a browser engine seat. */
export interface QueueGuestCredential {
  readonly guestId: string;
  readonly matchId: string;
  readonly seat: Seat;
  readonly token: string;
  readonly expiresAt: string;
}

/** The committed allocation of one entry. */
export interface QueueAssignment {
  readonly schemaVersion: number;
  readonly matchId: string;
  /** The seat the owner of the entry plays. */
  readonly seat: Seat;
  /** The public label of the opponent. */
  readonly opponentLabel: string;
  /** The declared control of the opponent. */
  readonly control: SeatControl;
  /** The engine credential of a browser engine fallback. */
  readonly guestCredential?: QueueGuestCredential;
}

/** The phase of an entry, as the workspace reads it. */
export type QueuePhase =
  | 'preparing'
  | 'searching'
  | 'pending-fallback'
  | 'assigned'
  | 'cancelled'
  | 'expired';

/** The contract error of the queue module. */
export class OnlineQueueError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OnlineQueueError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OnlineQueueError('invalid-answer', `expected an object at ${path}`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new OnlineQueueError('invalid-answer', `unexpected field ${key} at ${path}`);
    }
  }
}

function requiredKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (!(key in value)) {
      throw new OnlineQueueError('invalid-answer', `missing field ${key} at ${path}`);
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new OnlineQueueError('invalid-answer', `expected a string at ${path}`);
  }
  return value;
}

function idValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!ID_PATTERN.test(text)) {
    throw new OnlineQueueError('invalid-answer', `invalid identifier at ${path}`);
  }
  return text;
}

function seatValue(value: unknown, path: string): Seat {
  if (value === 'white' || value === 'black') {
    return value;
  }
  throw new OnlineQueueError('invalid-answer', `expected white or black at ${path}`);
}

function timestampValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new OnlineQueueError('invalid-answer', `expected an ISO timestamp at ${path}`);
  }
  return text;
}

function controlValue(value: unknown, path: string): SeatControl {
  const object = asObject(value, path);
  onlyKeys(object, ['kind', 'modelLabel'], path);
  requiredKeys(object, ['kind'], path);
  const kind = stringValue(object.kind, `${path}.kind`);
  if (kind !== 'human' && kind !== 'agent' && kind !== 'engine') {
    throw new OnlineQueueError('invalid-answer', `invalid control kind at ${path}.kind`);
  }
  const modelLabel = object.modelLabel === undefined ? undefined : stringValue(object.modelLabel, `${path}.modelLabel`);
  if (kind === 'human' && modelLabel !== undefined) {
    throw new OnlineQueueError('invalid-answer', `a human control carries no model label at ${path}`);
  }
  if (kind !== 'human' && modelLabel === undefined) {
    throw new OnlineQueueError('invalid-answer', `the control misses its model label at ${path}`);
  }
  return modelLabel === undefined ? { kind } : { kind, modelLabel };
}

/** Parses the seat-scoped credential of a browser engine seat. */
export function parseQueueGuestCredential(value: unknown): QueueGuestCredential {
  const path = 'queueGuestCredential';
  const object = asObject(value, path);
  onlyKeys(object, ['guestId', 'matchId', 'seat', 'token', 'expiresAt'], path);
  requiredKeys(object, ['guestId', 'matchId', 'seat', 'token', 'expiresAt'], path);
  return {
    guestId: stringValue(object.guestId, `${path}.guestId`),
    matchId: idValue(object.matchId, `${path}.matchId`),
    seat: seatValue(object.seat, `${path}.seat`),
    token: stringValue(object.token, `${path}.token`),
    expiresAt: timestampValue(object.expiresAt, `${path}.expiresAt`),
  };
}

/** Parses the committed allocation of one entry. */
export function parseQueueAssignment(value: unknown): QueueAssignment {
  const path = 'queueAssignment';
  const object = asObject(value, path);
  onlyKeys(object, ['schemaVersion', 'matchId', 'seat', 'opponentLabel', 'control', 'guestCredential'], path);
  requiredKeys(object, ['schemaVersion', 'matchId', 'seat', 'opponentLabel', 'control'], path);
  const assignment: QueueAssignment = {
    schemaVersion: numberValue(object.schemaVersion, `${path}.schemaVersion`),
    matchId: idValue(object.matchId, `${path}.matchId`),
    seat: seatValue(object.seat, `${path}.seat`),
    opponentLabel: stringValue(object.opponentLabel, `${path}.opponentLabel`),
    control: controlValue(object.control, `${path}.control`),
  };
  if (object.guestCredential !== undefined) {
    return { ...assignment, guestCredential: parseQueueGuestCredential(object.guestCredential) };
  }
  return assignment;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new OnlineQueueError('invalid-answer', `expected a positive integer at ${path}`);
  }
  return value;
}

/** The entry is assigned: it produced exactly one game. */
export function isAssignedEntry(entry: QueueEntry): boolean {
  return entry.status === 'assigned';
}

/** The entry is cancelled: the owner removed it without creating a game. */
export function isCancelledEntry(entry: QueueEntry): boolean {
  return entry.status === 'cancelled';
}

/**
 * The entry expired: the owner stopped responding and the entry left the
 * eligibility. It is reported as waiting with no ready time, and only an
 * explicit rejoin brings it back.
 */
export function isExpiredEntry(entry: QueueEntry): boolean {
  return entry.status === 'waiting' && entry.readyAt === null;
}

/**
 * The entry is waiting for a compatible opponent.
 *
 * An entry without a cutoff keeps searching: the owner removed the
 * automatic fallback deadline.
 */
export function isSearchingEntry(entry: QueueEntry): boolean {
  return entry.status === 'waiting' && entry.readyAt !== null;
}

/**
 * The cutoff of the entry has passed and no candidate was available, so the
 * browser engine fallback may be committed.
 *
 * The wire status is still waiting: the fallback is not committed until the
 * browser reports a ready engine.
 */
export function isPendingFallbackEntry(entry: QueueEntry): boolean {
  return isSearchingEntry(entry) && entry.cutoffAt !== null && Date.now() >= Date.parse(entry.cutoffAt);
}

/** The phase of an entry, as the workspace reads it. */
export function queuePhaseOf(entry: QueueEntry): QueuePhase {
  if (isAssignedEntry(entry)) return 'assigned';
  if (isCancelledEntry(entry)) return 'cancelled';
  if (isExpiredEntry(entry)) return 'expired';
  if (isPendingFallbackEntry(entry)) return 'pending-fallback';
  if (isSearchingEntry(entry)) return 'searching';
  return 'preparing';
}

/** The body of a mutation without an explicit operation identifier. */
export function queueOperationBody(operationId?: string): QueueOperationRequest {
  return operationId === undefined
    ? { schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION }
    : { schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION, operationId };
}

/** The request the client needs for one call. */
export interface QueueRequest {
  /** The path of the route, relative to the service origin. */
  readonly path: string;
  readonly method: 'GET' | 'POST';
  /** The JSON body of a mutation. */
  readonly body?: unknown;
}

/** The transport the client needs. It never carries a credential itself. */
export type QueueRequester = (request: QueueRequest) => Promise<unknown>;

/** The failure of a queue request. */
export class OnlineQueueRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OnlineQueueRequestError';
  }
}

/**
 * The state the browser holds of the engine credential.
 *
 * The browser owns the credential of its engine seat. The queue never stores
 * it, so the browser is the only place that knows whether it still holds a
 * usable one.
 */
export interface QueueEngineCredentialPort {
  /** Reports whether the browser holds a usable credential of the match. */
  holdsEngineCredential(matchId: string): boolean;
}

/** The typed queue client. */
export interface QueueClient {
  /** Creates one explicit queue entry. */
  createEntry(request: QueueCreateEntryRequest): Promise<QueueEntry>;
  /** Reads the entry of the owner. */
  readEntry(entryId: string): Promise<QueueEntry>;
  /** Re-arms an entry. It is the explicit rejoin of an expired entry. */
  ready(entryId: string, request?: QueueOperationRequest): Promise<QueueEntry>;
  /** Removes a waiting entry without creating a game. */
  cancel(entryId: string, request?: QueueOperationRequest): Promise<QueueEntry>;
  /** Removes the automatic cutoff of a waiting entry. */
  keepSearching(entryId: string, request?: QueueOperationRequest): Promise<QueueEntry>;
  /** Renews the readiness lease of a waiting entry. */
  heartbeat(entryId: string, request?: QueueOperationRequest): Promise<QueueEntry>;
  /** Pairs the entry with a compatible ready entry. */
  match(entryId: string, request?: QueueOperationRequest): Promise<QueueAssignment>;
  /**
   * Commits the browser engine fallback.
   *
   * The answer carries the engine credential only when the service issued
   * one. A routine retry receives the assignment without a secret, because
   * the browser already holds the credential. When the browser holds no
   * usable credential at all, the client asks for the explicit recovery and
   * the service rotates it on purpose.
   */
  fallback(entryId: string, request?: QueueFallbackRequest): Promise<QueueAssignment>;
}

/** The body of the browser engine fallback. */
export interface QueueFallbackRequest extends QueueOperationRequest {
  /**
   * Asks the service to rotate the credential of the engine seat.
   *
   * It is the explicit recovery of an owner that lost the answer of the
   * fallback and holds no usable credential. A routine retry never sets it:
   * it would rotate the secret the browser still has.
   */
  readonly credentialRecovery?: boolean;
}

/**
 * Creates the typed queue client.
 *
 * The requester is the authorized request boundary of the workspace. It adds
 * the account credential and the origin rules, and it never sends a
 * credential in a URL or a body.
 */
export function createQueueClient(requester: QueueRequester, credentials?: QueueEngineCredentialPort): QueueClient {
  async function entry(path: string, method: 'GET' | 'POST', body?: unknown): Promise<QueueEntry> {
    const answer = await requester({ path, method, ...(body === undefined ? {} : { body }) });
    return parseQueueEntry(answer);
  }
  async function assignment(path: string, body?: unknown): Promise<QueueAssignment> {
    const answer = await requester({ path, method: 'POST', ...(body === undefined ? {} : { body }) });
    return parseQueueAssignment(answer);
  }
  return {
    createEntry(request) {
      return entry(QUEUE_ENTRIES_PATH, 'POST', request);
    },
    readEntry(entryId) {
      return entry(queueEntryPath(entryId), 'GET');
    },
    ready(entryId, request) {
      return entry(queueEntryReadyPath(entryId), 'POST', request ?? queueOperationBody());
    },
    cancel(entryId, request) {
      return entry(queueEntryCancelPath(entryId), 'POST', request ?? queueOperationBody());
    },
    keepSearching(entryId, request) {
      return entry(queueEntryKeepSearchingPath(entryId), 'POST', request ?? queueOperationBody());
    },
    heartbeat(entryId, request) {
      return entry(queueEntryHeartbeatPath(entryId), 'POST', request ?? queueOperationBody());
    },
    match(entryId, request) {
      return assignment(queueEntryMatchPath(entryId), request ?? queueOperationBody());
    },
    async fallback(entryId, request) {
      const answer = await assignment(queueEntryFallbackPath(entryId), {
        ...queueOperationBody(request?.operationId),
        ...(request?.credentialRecovery ? { credentialRecovery: true } : {}),
      });
      if (answer.guestCredential !== undefined || request?.credentialRecovery === true) {
        return answer;
      }
      // The answer carries no credential. The browser holds one, so the
      // routine retry is complete. The browser holds none - the answer of the
      // fallback was lost - and the client asks for the explicit recovery.
      if (!credentials || credentials.holdsEngineCredential(answer.matchId)) {
        return answer;
      }
      return assignment(queueEntryFallbackPath(entryId), {
        ...queueOperationBody(request?.operationId),
        credentialRecovery: true,
      });
    },
  };
}
