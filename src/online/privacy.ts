/**
 * Privacy contracts for the browser (KHA-79).
 *
 * Two flows exist, and they are separate on purpose.
 *
 * An ordinary account deletion removes the account's own public identity and
 * its service-held private owner data. The shared games stay, and the deleted
 * participant appears as `Deleted player`.
 *
 * An explicit removal erases the shared replays from both online histories and
 * from the public URLs. The opponent keeps the anonymous result aggregate.
 *
 * A guest proves the ownership of its seat with the guest seat credential. The
 * request never names an account, and a guest credential never acts for an
 * account.
 *
 * The public model label is registered on its own. The mapping from a private
 * routing identity to that label stays in the browser: the service never
 * receives a routing identifier, an endpoint, a connection nickname, or a
 * credential.
 */
import { accountScope, matchSeatScope } from './auth';
import type { OnlineRequestScope } from './auth';
import type { AuthorizedRequester, AuthorizedResult } from './request';

/** The version of the privacy answer wire contract. */
export const ONLINE_PRIVACY_SCHEMA_VERSION = 1;

/** The scope of a removal. */
export type OnlineRemovalScope = 'account_deletion' | 'explicit_removal';

/** The confirmation of an ordinary account deletion. */
export const CONFIRM_ACCOUNT_DELETION = 'delete-account';

/** The confirmation of an explicit removal of the shared replays. */
export const CONFIRM_EXPLICIT_REMOVAL = 'erase-shared-replays';

/** The answer of a removal flow. */
export interface OnlineRemovalReport {
  readonly schemaVersion: number;
  readonly removalId: string;
  readonly scope: OnlineRemovalScope;
  readonly status: string;
  /** The shared games that were kept as anonymized games. */
  readonly anonymizedMatches: number;
  /** The shared games whose replay was erased. */
  readonly removedMatches: number;
  /** When the ownership of the request was proven. */
  readonly verifiedAt: string;
  /** When the live data and the public projections were removed. */
  readonly liveDeletedAt: string;
  /** The target of the live removal. */
  readonly liveDeleteDueAt: string;
  /** The target of the recovery copy sanitation. */
  readonly recoverySanitizeDueAt: string;
}

/** The public label an owner registered for their own model opponents. */
export interface OnlinePublicModelLabel {
  readonly schemaVersion: number;
  readonly labelId: string;
  readonly publicLabel: string;
}

/** The path of the ordinary account deletion route. */
export function accountDeletionPath(): string {
  return '/v1/privacy/account/deletion';
}

/** The path of the explicit removal route of an account. */
export function explicitRemovalPath(): string {
  return '/v1/privacy/account/removal';
}

/** The path of the explicit removal route of a guest. */
export function guestRemovalPath(): string {
  return '/v1/privacy/guest/removal';
}

/** The path of the public model label route. */
export function publicModelLabelPath(): string {
  return '/v1/privacy/account/model-labels';
}

/** The options of one privacy call. */
export interface OnlinePrivacyCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * Removes the account's own public identity and anonymizes its shared games.
 *
 * The call needs the signed-in account credential. The request body carries
 * the explicit confirmation only.
 */
export async function requestAccountDeletion(
  requester: AuthorizedRequester,
  options: OnlinePrivacyCallOptions = {},
): Promise<OnlineRemovalReport> {
  const result = await requester.request(accountScope(), {
    path: accountDeletionPath(),
    method: 'POST',
    body: { confirm: CONFIRM_ACCOUNT_DELETION },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parseOnlineRemovalReport(await readAuthorizedData(result));
}

/**
 * Erases the shared replays of the signed-in account.
 *
 * The call needs the signed-in account credential.
 */
export async function requestExplicitRemoval(
  requester: AuthorizedRequester,
  options: OnlinePrivacyCallOptions = {},
): Promise<OnlineRemovalReport> {
  const result = await requester.request(accountScope(), {
    path: explicitRemovalPath(),
    method: 'POST',
    body: { confirm: CONFIRM_EXPLICIT_REMOVAL },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parseOnlineRemovalReport(await readAuthorizedData(result));
}

/**
 * Erases the shared replays of a guest seat owner.
 *
 * The call needs the guest seat credential. The scope is the seat the guest
 * owns, and the server derives the guest identity from the credential.
 */
export async function requestGuestRemoval(
  requester: AuthorizedRequester,
  matchId: string,
  seat: 'white' | 'black',
  options: OnlinePrivacyCallOptions = {},
): Promise<OnlineRemovalReport> {
  const scope: OnlineRequestScope = matchSeatScope(matchId, seat);
  const result = await requester.request(scope, {
    path: guestRemovalPath(),
    method: 'POST',
    body: { confirm: CONFIRM_EXPLICIT_REMOVAL },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parseOnlineRemovalReport(await readAuthorizedData(result));
}

/**
 * Registers the public label an owner chose for their own model opponents.
 *
 * The request carries the label only. The mapping from a private routing
 * identity to that label stays in the browser.
 */
export async function registerPublicModelLabel(
  requester: AuthorizedRequester,
  publicLabel: string,
  options: OnlinePrivacyCallOptions = {},
): Promise<OnlinePublicModelLabel> {
  const result = await requester.request(accountScope(), {
    path: publicModelLabelPath(),
    method: 'POST',
    body: { publicLabel },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parseOnlinePublicModelLabel(await readAuthorizedData(result));
}

/** Parses the answer of a removal flow. */
export function parseOnlineRemovalReport(value: unknown): OnlineRemovalReport {
  const path = 'removalReport';
  const record = objectValue(value, path);
  onlyKeys(record, [
    'schemaVersion',
    'removalId',
    'scope',
    'status',
    'anonymizedMatches',
    'removedMatches',
    'verifiedAt',
    'liveDeletedAt',
    'liveDeleteDueAt',
    'recoverySanitizeDueAt',
  ], path);
  requiredKeys(record, [
    'schemaVersion',
    'removalId',
    'scope',
    'status',
    'anonymizedMatches',
    'removedMatches',
    'verifiedAt',
    'liveDeletedAt',
    'liveDeleteDueAt',
    'recoverySanitizeDueAt',
  ], path);
  const scope = stringValue(record.scope, `${path}.scope`);
  if (scope !== 'account_deletion' && scope !== 'explicit_removal') {
    throw new Error(`${path}.scope: unsupported removal scope`);
  }
  return {
    schemaVersion: integerValue(record.schemaVersion, `${path}.schemaVersion`),
    removalId: idValue(record.removalId, `${path}.removalId`),
    scope,
    status: stringValue(record.status, `${path}.status`),
    anonymizedMatches: nonNegativeInteger(record.anonymizedMatches, `${path}.anonymizedMatches`),
    removedMatches: nonNegativeInteger(record.removedMatches, `${path}.removedMatches`),
    verifiedAt: timestampValue(record.verifiedAt, `${path}.verifiedAt`),
    liveDeletedAt: timestampValue(record.liveDeletedAt, `${path}.liveDeletedAt`),
    liveDeleteDueAt: timestampValue(record.liveDeleteDueAt, `${path}.liveDeleteDueAt`),
    recoverySanitizeDueAt: timestampValue(record.recoverySanitizeDueAt, `${path}.recoverySanitizeDueAt`),
  };
}

/** Parses the answer of a public model label registration. */
export function parseOnlinePublicModelLabel(value: unknown): OnlinePublicModelLabel {
  const path = 'publicModelLabel';
  const record = objectValue(value, path);
  onlyKeys(record, ['schemaVersion', 'labelId', 'publicLabel'], path);
  requiredKeys(record, ['schemaVersion', 'labelId', 'publicLabel'], path);
  return {
    schemaVersion: integerValue(record.schemaVersion, `${path}.schemaVersion`),
    labelId: idValue(record.labelId, `${path}.labelId`),
    publicLabel: stringValue(record.publicLabel, `${path}.publicLabel`),
  };
}

/** Reads the body of an authorized answer. */
async function readAuthorizedData(result: AuthorizedResult): Promise<unknown> {
  if (!result.ok) {
    throw new Error(`The online service answered ${result.status}.`);
  }
  return result.data;
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path}: unexpected field ${key}`);
    }
  }
}

function requiredKeys(value: JsonObject, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (!(key in value)) {
      throw new Error(`${path}: missing field ${key}`);
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path}: expected a string`);
  }
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${path}: expected a safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const number = integerValue(value, path);
  if (number < 0) {
    throw new Error(`${path}: expected a non-negative integer`);
  }
  return number;
}

function timestampValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${path}: expected an ISO timestamp`);
  }
  return text;
}

function idValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(text)) {
    throw new Error(`${path}: invalid id`);
  }
  return text;
}
