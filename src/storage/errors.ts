import type { StorageFailureCodeV1 } from './types';

export class GameStorageError extends Error {
  constructor(readonly code: StorageFailureCodeV1, message: string) {
    super(message);
    this.name = 'GameStorageError';
  }
}

export function classifyStorageFailure(error: unknown): GameStorageError {
  if (error instanceof GameStorageError) return error;
  const name =
    typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
  if (name === 'QuotaExceededError') {
    return new GameStorageError('quota', 'The browser storage quota prevented this save.');
  }
  if (name === 'AbortError') {
    return new GameStorageError('transaction-aborted', 'The browser aborted the storage transaction.');
  }
  if (name === 'VersionError' || name === 'InvalidStateError') {
    return new GameStorageError('upgrade-failed', 'The local database could not open at the required version.');
  }
  if (name === 'SecurityError' || name === 'NotSupportedError') {
    return new GameStorageError('unavailable', 'Browser storage is unavailable in this context.');
  }
  if (name === 'ConstraintError' || name === 'DataCloneError') {
    return new GameStorageError('invalid-data', 'The local database rejected this record.');
  }
  return new GameStorageError('unknown', 'The local storage operation failed.');
}
