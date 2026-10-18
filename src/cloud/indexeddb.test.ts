import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createIndexedDbAccountData } from '../accounts/indexeddb';
import { createIndexedDbCloudLocal } from './indexeddb';
import type { GameCheckpointV1 } from '../storage';

describe('IndexedDB cloud local adapter', () => {
  it('persists stable operation IDs, accepted cursor metadata, snapshots, conflicts and tombstones', async () => {
    const factory = new IDBFactory();
    const accountId = 'clerk-user-a';
    const games = createIndexedDbAccountData({ factory, guestDatabaseName: 'cloud-local-guest', accountDatabasePrefix: 'cloud-local-account-' });
    const store = createIndexedDbCloudLocal({ factory, accountId, games, metadataDatabaseName: 'cloud-local-meta', idFactory: () => 'stable-op', now: () => 9 });
    const checkpoint = makeCheckpoint(accountId);
    const event = { eventId: 'event-1', gameId: 'cloud-game', sequence: 0, segmentId: 'seg', kind: 'accepted', occurredAtMs: 1, receiveState: 'complete' as const, egressStatus: 'eligible' as const, payload: { text: 'full raw history' }, chunkIds: [] };
    const snapshot = { checkpoint, events: [event], chunks: [] };
    const op1 = await store.stableOperationId('cloud-game', 3);
    const recreated = createIndexedDbCloudLocal({ factory, accountId, games, metadataDatabaseName: 'cloud-local-meta', idFactory: () => 'another-op' });
    expect(await recreated.stableOperationId('cloud-game', 3)).toBe(op1);
    await store.recordAcknowledgement('cloud-game', 5, 2, 3, { eventsThrough: 4, chunksThrough: null });
    expect(await store.readMetadata('cloud-game')).toMatchObject({ acknowledgedRevision: 5, ownershipEpoch: 2, checkpointRevision: 3, eventsThrough: 4, chunksThrough: null });

    const batch = { format: 'kamkmchess.cloud-archive-batch', schemaVersion: 1, gameId: 'cloud-game', baseRevision: 5, baseOwnershipEpoch: 2, checkpointRevision: checkpoint.revision, events: [event], chunks: [] };
    expect(await store.preserveAcceptedCloudSnapshot('cloud-game', checkpoint, batch)).toEqual({ eventsThrough: 0, chunksThrough: null });
    await store.preserveConflict('cloud-game', snapshot, { checkpoint, archiveBatch: batch });
    expect(await store.listConflicts('cloud-game')).toHaveLength(1);
    expect(await store.readAcceptedSnapshot('cloud-game')).toMatchObject({ game: { checkpoint, events: [event], chunks: [] } });
    await store.applyOwnerDeletion(accountId, 'cloud-game');
    await expect(store.read('cloud-game')).rejects.toThrow(/deletion tombstone/);
    expect(await store.listConflicts('cloud-game')).toEqual([]);
  });

  it('rejects a tampered raw chunk digest before storing an accepted snapshot', async () => {
    const factory = new IDBFactory();
    const accountId = 'user_2abcdefghijklmnop';
    const games = createIndexedDbAccountData({ factory, guestDatabaseName: 'cloud-tamper-guest', accountDatabasePrefix: 'cloud-tamper-account-' });
    const store = createIndexedDbCloudLocal({ factory, accountId, games, metadataDatabaseName: 'cloud-tamper-meta' });
    const checkpoint = makeCheckpoint(accountId);
    const batch = {
      format: 'kamkmchess.cloud-archive-batch', schemaVersion: 1, gameId: checkpoint.gameId, baseRevision: 3, baseOwnershipEpoch: 2, checkpointRevision: checkpoint.revision,
      events: [], chunks: [{ chunkId: 'chunk-1', gameId: checkpoint.gameId, sequence: 0, receivedAtMs: 1, isFinal: true, egressStatus: 'eligible', bytesBase64: 'AQID', sha256: '0'.repeat(64) }],
    };
    await expect(store.preserveAcceptedCloudSnapshot(checkpoint.gameId, checkpoint, batch)).rejects.toThrow(/digest check/);
    expect(await store.readAcceptedSnapshot(checkpoint.gameId)).toBeNull();
  });

  it('retries adoption idempotently after the continuation database was installed', async () => {
    const factory = new IDBFactory();
    const accountId = 'user_adoption_retry';
    const games = createIndexedDbAccountData({ factory, guestDatabaseName: 'adopt-retry-guest', accountDatabasePrefix: 'adopt-retry-account-' });
    const accepted = { checkpoint: makeCheckpoint(accountId), events: [], chunks: [] };
    const first = await games.adoptCloudSnapshot(accountId, accepted, 3);
    const retried = await games.adoptCloudSnapshot(accountId, accepted, 3);
    expect(retried).toEqual(first);
    expect(await games.resolveActiveGameDatabaseName(accountId, 'cloud-game')).toBe(first.databaseName);
    expect(await games.readAccountGame(accountId, 'cloud-game')).toMatchObject({ checkpoint: { ownershipEpoch: 3 } });
  });
});

function makeCheckpoint(accountId: string): GameCheckpointV1 {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  return {
    schemaVersion: 1, gameId: 'cloud-game', namespace: { kind: 'account', accountId }, revision: 3, ownershipEpoch: 2, segmentId: 'seg', positionRevision: 1, requestGeneration: 0, analysisGeneration: 0, updatedAtMs: 1,
    rules: { variant: 'orthodox', startingFen: fen, currentFen: fen, sideToMove: 'white', castlingRights: 'KQkq', enPassantSquare: null, halfmoveClock: '0', fullmoveNumber: '1', repetitionLedger: { version: 1, positions: [{ identity: 'start', occurrences: '1' }] }, moves: [] },
    history: { currentSegmentId: 'seg', segments: [{ segmentId: 'seg', providerId: null, modelRoutingId: null, connectionRevision: null, startedAtMs: 1, messageIds: [] }], messages: [] },
    clocks: { schemaVersion: 1, timeControl: { startingTimeMs: 60_000, incrementMs: 0 }, banksAtAnchor: { whiteMs: 60_000, blackMs: 60_000 }, activeSide: null, anchor: null, lastReconciledAtMs: 1 },
    budgets: { formattingCorrectionsRemaining: 3, illegalMoveAttemptsRemaining: { white: 3, black: 3 }, manualRetriesBySide: { white: 0, black: 0 } },
    selections: { players: { white: { kind: 'human' }, black: { kind: 'human' } } },
    archive: { egressStatus: 'eligible', currentLine: { lineId: 'line', eventIds: [] }, discardedLines: [] },
    result: { kind: 'unresolved' }, practice: { mode: 'ordinary', scored: true, sourceGameId: null, sourcePositionFen: null, originalResult: null }, extensions: {},
  };
}
