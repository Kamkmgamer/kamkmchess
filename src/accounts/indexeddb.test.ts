import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openGameStore } from '../storage';
import type { ArchiveChunkV1, ArchiveEventV1, GameCheckpointV1 } from '../storage';
import { createIndexedDbAccountData, accountGameDatabaseName } from './indexeddb';

describe('IndexedDB account game repository', () => {
  it('copies full guest archive into an account database while keeping the guest record unchanged', async () => {
    const factory = new IDBFactory();
    const guestName = 'account-import-guest-fixture';
    const accountPrefix = 'account-import-account-';
    const guest = await openGameStore({ databaseName: guestName, factory, now: () => 1000 });
    const initial = checkpoint();
    const event = archiveEvent();
    const chunk = archiveChunk();
    await guest.commitCheckpoint({
      gameId: initial.gameId, expectedRevision: null, expectedEpoch: 0, events: [event], chunks: [chunk], knownCredentials: [],
      decide: (decisionTimeMs) => ({ checkpoint: { ...initial, updatedAtMs: decisionTimeMs }, outboxOperationIds: [] }),
    });
    guest.close();

    const accounts = createIndexedDbAccountData({ factory, guestDatabaseName: guestName, accountDatabasePrefix: accountPrefix, now: () => 2000 });
    const preview = await accounts.listGuestGames();
    expect(preview).toMatchObject([{ gameId: 'same-game-id', hasDiscardedLines: true, practice: true, unsynced: true }]);
    await accounts.importGuestGame('same-game-id', 'clerk-user-a');

    const original = await accounts.listGuestGames();
    const copy = await accounts.readAccountGame('clerk-user-a', 'same-game-id');
    expect(original[0]?.gameId).toBe(copy?.checkpoint.gameId);
    expect(copy?.checkpoint).toMatchObject({ namespace: { kind: 'account', accountId: 'clerk-user-a' }, ownershipEpoch: 0, revision: 1, clocks: initial.clocks, rules: initial.rules, history: initial.history, archive: initial.archive, practice: initial.practice });
    expect(copy?.events).toEqual([event]);
    expect(copy?.chunks[0]?.bytes).toEqual(chunk.bytes);
    expect(accountGameDatabaseName('clerk-user-a', accountPrefix)).not.toBe(guestName);
    expect(await accounts.readAccountGame('clerk-user-b', 'same-game-id')).toBeNull();
    accounts.close();
  });

  it('deletes only the selected owner game records and persists a tombstone', async () => {
    const factory = new IDBFactory();
    const repo = createIndexedDbAccountData({ factory, guestDatabaseName: 'account-delete-guest', accountDatabasePrefix: 'account-delete-account-' });
    const account = await openGameStore({ factory, databaseName: accountGameDatabaseName('clerk-user-a', 'account-delete-account-') });
    const game = checkpoint({ kind: 'account', accountId: 'clerk-user-a' });
    await account.commitCheckpoint({ gameId: game.gameId, expectedRevision: null, expectedEpoch: 0, events: [archiveEvent()], chunks: [archiveChunk()], knownCredentials: [], decide: () => ({ checkpoint: game, outboxOperationIds: [] }) });
    account.close();
    await repo.deleteAccountGame('clerk-user-a', game.gameId);
    expect(await repo.readAccountGame('clerk-user-a', game.gameId)).toBeNull();
    repo.close();
  });

  it('leaves a foreign checkpoint intact when the account delete guard rejects it', async () => {
    const factory = new IDBFactory();
    const repo = createIndexedDbAccountData({ factory, guestDatabaseName: 'account-foreign-guest', accountDatabasePrefix: 'account-foreign-' });
    const wrongOwnerDatabase = accountGameDatabaseName('clerk-user-a', 'account-foreign-');
    const account = await openGameStore({ factory, databaseName: wrongOwnerDatabase });
    const source = checkpoint({ kind: 'account', accountId: 'clerk-user-b' });
    const foreign = { ...source, rules: { ...source.rules, moves: [] }, history: { ...source.history, segments: source.history.segments.map((segment) => ({ ...segment, messageIds: [] })), messages: [] }, archive: { ...source.archive, currentLine: { ...source.archive.currentLine, eventIds: [] }, discardedLines: [] } };
    await account.importGameArchive({ format: 'kamkmchess.game-archive', schemaVersion: 1, exportedAtMs: 1, checkpoint: foreign, events: [], chunks: [] }, []);
    account.close();

    await expect(repo.deleteAccountGame('clerk-user-a', foreign.gameId)).rejects.toThrow(/different identity owns/);
    const reopened = await openGameStore({ factory, databaseName: wrongOwnerDatabase });
    expect(await reopened.readGame(foreign.gameId)).not.toBeNull();
    expect(await repo.readAccountGame('clerk-user-a', foreign.gameId)).toBeNull();
    reopened.close();
    repo.close();
  });

  it('adopts accepted cloud history into a per-game epoch database without overwriting the local branch', async () => {
    const factory = new IDBFactory();
    const prefix = 'account-adopt-';
    const accountId = 'user_2AbCdEfGhIjKlMnOp';
    const repo = createIndexedDbAccountData({ factory, guestDatabaseName: 'account-adopt-guest', accountDatabasePrefix: prefix });
    const source = checkpoint({ kind: 'account', accountId });
    const original = { ...source, requestGeneration: 1, rules: { ...source.rules, moves: [] }, history: { ...source.history, segments: source.history.segments.map((segment) => ({ ...segment, messageIds: [] })), messages: [] }, archive: { ...source.archive, currentLine: { ...source.archive.currentLine, eventIds: [] }, discardedLines: [] }, extensions: { 'model-handoff': { version: 1, data: { producing: { kind: 'model', providerId: 'p', connectionId: 'c' }, queued: null } } } };
    const local = await openGameStore({ factory, databaseName: accountGameDatabaseName(accountId, prefix) });
    await local.importGameArchive({ format: 'kamkmchess.game-archive', schemaVersion: 1, exportedAtMs: 1, checkpoint: original, events: [], chunks: [] }, []);
    local.close();

    const accepted = { ...original, requestGeneration: 2, ownershipEpoch: 2 };
    const adopted = await repo.adoptCloudSnapshot(accountId, { checkpoint: accepted, events: [], chunks: [] }, 4);
    expect(adopted.databaseName).toBe(`${accountGameDatabaseName(accountId, prefix)}-cloud-${encodeURIComponent(accepted.gameId)}-4`);
    expect(adopted.registryScope).toContain(adopted.databaseName);
    expect(await repo.resolveActiveGameDatabaseName(accountId, accepted.gameId)).toBe(adopted.databaseName);
    const active = await repo.readAccountGame(accountId, accepted.gameId);
    expect(active?.checkpoint).toMatchObject({ requestGeneration: 3, analysisGeneration: 1, ownershipEpoch: 4, extensions: { 'model-handoff': { data: { producing: null, queued: null } } } });
    const oldBranch = await openGameStore({ factory, databaseName: accountGameDatabaseName(accountId, prefix) });
    expect((await oldBranch.readGame(accepted.gameId))?.checkpoint.requestGeneration).toBe(1);
    oldBranch.close();
    const continuation = await openGameStore({ factory, databaseName: adopted.databaseName });
    const additionalGame = { ...accepted, gameId: 'new-in-adopted-database' };
    await continuation.importGameArchive({ format: 'kamkmchess.game-archive', schemaVersion: 1, exportedAtMs: 2, checkpoint: additionalGame, events: [], chunks: [] }, []);
    continuation.close();
    expect(await repo.resolveActiveGameDatabaseName(accountId, additionalGame.gameId)).toBe(adopted.databaseName);
    expect((await repo.listAccountGames(accountId)).map((game) => game.gameId)).toContain(additionalGame.gameId);
    repo.close();
  });
});

function checkpoint(namespace: GameCheckpointV1['namespace'] = { kind: 'guest' }): GameCheckpointV1 {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  return {
    schemaVersion: 1, gameId: 'same-game-id', namespace, revision: 1, ownershipEpoch: 0, segmentId: 'seg', positionRevision: 1,
    requestGeneration: 0, analysisGeneration: 0, updatedAtMs: 10,
    rules: { variant: 'orthodox', startingFen: fen, currentFen: fen, sideToMove: 'white', castlingRights: 'KQkq', enPassantSquare: null, halfmoveClock: '0', fullmoveNumber: '1', repetitionLedger: { version: 1, positions: [{ identity: 'initial', occurrences: '1' }] }, moves: [{ moveId: 'move', from: 'e2', to: 'e4', promotion: null, san: 'e4', fenBefore: fen, fenAfter: fen, eventId: 'event' }] },
    history: { currentSegmentId: 'seg', segments: [{ segmentId: 'seg', providerId: null, modelRoutingId: null, connectionRevision: null, startedAtMs: 0, messageIds: [] }], messages: [{ messageId: 'msg', segmentId: 'seg', lineId: 'line-now', role: 'assistant', content: 'reply', eventIds: ['event'], disposition: 'retained' }] },
    clocks: { schemaVersion: 1, timeControl: { startingTimeMs: 60_000, incrementMs: 0 }, banksAtAnchor: { whiteMs: 30_000, blackMs: 20_000 }, activeSide: 'white', anchor: { wallTimeMs: 100, monotonicMs: 50 }, lastReconciledAtMs: 100 },
    budgets: { formattingCorrectionsRemaining: 2, illegalMoveAttemptsRemaining: { white: 2, black: 3 }, manualRetriesBySide: { white: 1, black: 0 } },
    selections: { players: { white: { kind: 'human' }, black: { kind: 'human' } } },
    archive: { egressStatus: 'eligible', currentLine: { lineId: 'line-now', eventIds: ['event'] }, discardedLines: [{ lineId: 'line-old', eventIds: [], discardedAtRevision: 1, reason: 'undo' }] },
    result: { kind: 'unresolved' }, practice: { mode: 'practice', scored: false, sourceGameId: 'source', sourcePositionFen: fen, originalResult: null }, extensions: {},
  };
}

function archiveEvent(): ArchiveEventV1 {
  return { eventId: 'event', gameId: 'same-game-id', sequence: 0, segmentId: 'seg', kind: 'reply-received', occurredAtMs: 100, receiveState: 'complete', egressStatus: 'eligible', payload: { text: 'reply' }, chunkIds: ['chunk'] };
}

function archiveChunk(): ArchiveChunkV1 {
  return { chunkId: 'chunk', gameId: 'same-game-id', sequence: 0, receivedAtMs: 100, isFinal: true, egressStatus: 'eligible', bytes: new TextEncoder().encode('raw bytes'), sha256: '' };
}
