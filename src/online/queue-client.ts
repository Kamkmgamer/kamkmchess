/**
 * The queue HTTP adapter (KHA-74, KHA-77).
 *
 * The adapter maps the browser queue flow onto the service routes published in
 * `docs/online/matching-interfaces.md`. Every route string lives in this
 * file, so the matching worker's typed client can replace the whole adapter
 * without touching the interface or the orchestration.
 *
 * The adapter owns no queue rule. The service owns the compatibility rule,
 * the search window and the allocation. The browser only asks, and it reads
 * the shared `QueueEntry` contract of schema version 2.
 *
 * The rules this module keeps:
 *
 * - The credential travels in the request header of the authorized requester.
 *   A queue entry is an account-scoped request, so a guest seat credential
 *   cannot create one.
 * - A body carries only the fields of the shared contract. No credential, no
 *   provider route and no private identifier is ever sent.
 * - An answer of another schema version or another shape is refused instead
 *   of being guessed.
 * - The creation of an entry is the authoritative ready acceptance: the
 *   service records `readyAt` and starts the ten-second window. No search
 *   time elapses during the browser's own agent check, because the check
 *   happens before this call.
 * - A creation carries a client request identifier, so a second tab that
 *   sends the same identifier receives the same entry and creates no second
 *   game.
 */
import { parseQueueEntry } from './contracts';
import type { QueueEntry, Seat, SeatControl, TimeControl } from './contracts';
import { ONLINE_CONTRACTS_SCHEMA_VERSION } from './contracts';
import { accountScope } from './auth';
import type { AuthorizedRequester } from './request';
import type { OnlineQueueAssignment } from './readiness';

/** The routes of the queue service. */
export const ONLINE_QUEUE_ROUTES = {
  entries: '/v1/online/queue/entries',
  entry: (entryId: string) => `/v1/online/queue/entries/${encodeURIComponent(entryId)}`,
  ready: (entryId: string) => `/v1/online/queue/entries/${encodeURIComponent(entryId)}/ready`,
  cancel: (entryId: string) => `/v1/online/queue/entries/${encodeURIComponent(entryId)}/cancel`,
  keepSearching: (entryId: string) => `/v1/online/queue/entries/${encodeURIComponent(entryId)}/keep-searching`,
  match: (entryId: string) => `/v1/online/queue/entries/${encodeURIComponent(entryId)}/match`,
  fallback: (entryId: string) => `/v1/online/queue/entries/${encodeURIComponent(entryId)}/fallback`,
} as const;

/** The failure of a queue request. */
export class OnlineQueueError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'OnlineQueueError';
    this.status = status;
  }
}

export interface OnlineQueueClientOptions {
  readonly requester: AuthorizedRequester;
}

/** The assignment the service commits. */
export interface OnlineQueueAssignmentAnswer extends OnlineQueueAssignment {
  /** The seat credential of the browser engine seat, when the answer carries one. */
  readonly engineCredential: unknown | null;
}

export interface OnlineQueueClient {
  /** Creates a queue entry for the signed-in account. */
  create(request: { control: SeatControl; timeControl: TimeControl; clientRequestId?: string }): Promise<QueueEntry>;
  /** Reads one entry. */
  read(entryId: string): Promise<QueueEntry>;
  /** Accepts the ready entry and starts the search window. */
  ready(entryId: string): Promise<QueueEntry>;
  /** Cancels the entry. */
  cancel(entryId: string): Promise<QueueEntry>;
  /** Removes the automatic cutoff. */
  keepSearching(entryId: string): Promise<QueueEntry>;
  /**
   * Asks the service to pair the entry with a compatible ready entry.
   *
   * A missing candidate is not an error: it answers null.
   */
  findCompatible(entryId: string): Promise<OnlineQueueAssignment | null>;
  /** Commits the Stockfish fallback. */
  commitFallback(entryId: string): Promise<OnlineQueueAssignmentAnswer>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OnlineQueueError('The service answer is not an object.');
  }
  return value as Record<string, unknown>;
}

function parseAssignment(value: unknown): OnlineQueueAssignmentAnswer {
  const record = asRecord(value);
  const matchId = record.matchId;
  const seat = record.seat;
  const opponentLabel = record.opponentLabel;
  const control = record.control;
  if (typeof matchId !== 'string' || matchId.length === 0) {
    throw new OnlineQueueError('The service answer carries no match.');
  }
  if (seat !== 'white' && seat !== 'black') {
    throw new OnlineQueueError('The service answer carries no seat.');
  }
  if (typeof opponentLabel !== 'string') {
    throw new OnlineQueueError('The service answer carries no opponent label.');
  }
  if (typeof control !== 'object' || control === null) {
    throw new OnlineQueueError('The service answer carries no declared control.');
  }
  return {
    matchId,
    seat: seat as Seat,
    opponentLabel,
    control: control as SeatControl,
    engineCredential: record.guestCredential ?? null,
  };
}

/**
 * Creates the queue client.
 *
 * The client sends the shared request bodies and reads the shared answers.
 */
export function createOnlineQueueClient(options: OnlineQueueClientOptions): OnlineQueueClient {
  const { requester } = options;
  const scope = accountScope();

  async function post<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
    const result = await requester.request(scope, { path, method: 'POST', body });
    if (!result.ok) {
      throw new OnlineQueueError(`The service refused the queue request (${result.status}).`, result.status);
    }
    return parse(result.data);
  }

  async function get<T>(path: string, parse: (value: unknown) => T): Promise<T> {
    const result = await requester.request(scope, { path });
    if (!result.ok) {
      throw new OnlineQueueError(`The service refused the queue request (${result.status}).`, result.status);
    }
    return parse(result.data);
  }

  const parseEntry = (value: unknown): QueueEntry => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new OnlineQueueError('The queue answer is not an object.');
    }
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== ONLINE_CONTRACTS_SCHEMA_VERSION) {
      throw new OnlineQueueError('The queue answer carries another schema version.');
    }
    try {
      return parseQueueEntry(value);
    } catch (error) {
      throw new OnlineQueueError(error instanceof Error ? error.message : 'The queue answer is invalid.');
    }
  };

  return {
    create(request) {
      return post(
        ONLINE_QUEUE_ROUTES.entries,
        {
          schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
          control: request.control,
          timeControl: request.timeControl,
          ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
        },
        parseEntry,
      );
    },
    read(entryId) {
      return get(ONLINE_QUEUE_ROUTES.entry(entryId), parseEntry);
    },
    ready(entryId) {
      return post(
        ONLINE_QUEUE_ROUTES.ready(entryId),
        { schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION },
        parseEntry,
      );
    },
    cancel(entryId) {
      return post(
        ONLINE_QUEUE_ROUTES.cancel(entryId),
        { schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION },
        parseEntry,
      );
    },
    keepSearching(entryId) {
      return post(
        ONLINE_QUEUE_ROUTES.keepSearching(entryId),
        { schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION },
        parseEntry,
      );
    },
    async findCompatible(entryId) {
      const result = await requester.request(scope, {
        path: ONLINE_QUEUE_ROUTES.match(entryId),
        method: 'POST',
        body: { schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION },
      });
      if (result.status === 404) {
        // A missing candidate is not an error.
        return null;
      }
      if (!result.ok) {
        throw new OnlineQueueError(`The service refused the queue request (${result.status}).`, result.status);
      }
      const answer = parseAssignment(result.data);
      return {
        matchId: answer.matchId,
        seat: answer.seat,
        opponentLabel: answer.opponentLabel,
        control: answer.control,
      };
    },
    commitFallback(entryId) {
      return post(
        ONLINE_QUEUE_ROUTES.fallback(entryId),
        { schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION },
        parseAssignment,
      );
    },
  };
}
