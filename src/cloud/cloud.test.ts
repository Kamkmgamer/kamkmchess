import { describe, expect, it, vi } from 'vitest';
import { GoCloudClient, createCloudSeedCheckpoint, matchesCloudSeed } from './client';
import { assertAccountCheckpoint, createCloudArchiveBatch } from './contracts';
import { createCloudCoordination } from './coordinator';
import { createCloudSyncManager } from './sync';
import type { GameCheckpointV1, StoredGameV1 } from '../storage/types';
import { assertArchiveReferenceIntegrity, readGameCheckpoint } from '../archive';
import type { ArchiveEventV1 } from '../storage/types';
import { IDBFactory } from 'fake-indexeddb';

describe('cloud account and sync boundaries', () => {
  it('sends bearer auth without browser credentials or redirects', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'g', revision: 1, epoch: 1, checkpoint: { ...accountCheckpoint(), ownershipEpoch: 1 }, createdAt: '', updatedAt: '' }), { status: 200 }));
    const client = new GoCloudClient({ config: { apiBaseUrl: 'https://api.example.test' }, accountId: 'account-a', getToken: async () => 'clerk-jwt', fetcher });
    await client.read('g');
    expect(fetcher).toHaveBeenCalledWith(new URL('https://api.example.test/v1/games/g'), expect.objectContaining({
      credentials: 'omit', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer clerk-jwt' }),
    }));
  });

  it('accepts a Go takeover DTO with an older checkpoint epoch but rejects future or foreign checkpoints', async () => {
    let response = { id: 'g', revision: 4, epoch: 3, checkpoint: { ...accountCheckpoint(), ownershipEpoch: 2 }, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:01Z' };
    const client = new GoCloudClient({ config: { apiBaseUrl: 'https://api.example.test' }, accountId: 'account-a', getToken: async () => 'jwt', fetcher: async () => new Response(JSON.stringify(response), { status: 200 }) });
    await expect(client.read('g')).resolves.toMatchObject({ revision: 4, epoch: 3, checkpoint: { ownershipEpoch: 2, namespace: { accountId: 'account-a' } } });
    response = { ...response, checkpoint: { ...response.checkpoint, ownershipEpoch: 4 } };
    await expect(client.read('g')).rejects.toThrow(/identity or ownership epoch/);
    response = { ...response, checkpoint: { ...response.checkpoint, ownershipEpoch: 2, namespace: { kind: 'account', accountId: 'account-b' } } };
    await expect(client.read('g')).rejects.toThrow(/identity or ownership epoch/);
  });

  it('requires HTTPS except for explicit local development hosts', () => {
    expect(() => new GoCloudClient({ config: { apiBaseUrl: 'http://api.example.test' }, accountId: 'account-a', getToken: async () => 'jwt' })).toThrow(/must use HTTPS/);
    expect(() => new GoCloudClient({ config: { apiBaseUrl: 'http://localhost:8080' }, accountId: 'account-a', getToken: async () => 'jwt' })).not.toThrow();
    expect(() => new GoCloudClient({ config: { apiBaseUrl: 'http://127.0.0.1:8080' }, accountId: 'account-a', getToken: async () => 'jwt' })).not.toThrow();
  });

  it('rejects guest or foreign namespaces, credential echoes, and quarantined archives before transport', () => {
    expect(() => assertAccountCheckpoint({ ...accountCheckpoint(), namespace: { kind: 'guest' } }, 'account-a')).toThrow(/Only the signed-in account/);
    expect(() => assertAccountCheckpoint(accountCheckpoint(), 'account-b')).toThrow(/Only the signed-in account/);
    expect(() => assertAccountCheckpoint({ ...accountCheckpoint(), extensions: { fixture: { version: 1, data: 'sk-secret' } } }, 'account-a', ['sk-secret'])).toThrow(/credential data/);
    expect(() => assertAccountCheckpoint({ ...accountCheckpoint(), archive: { ...accountCheckpoint().archive, egressStatus: 'credential-echo-quarantined' } }, 'account-a')).toThrow(/quarantined/);
  });

  it('encodes complete versioned archive events and chunks for the Go commit contract', () => {
    const game = storedGame();
    const event = { eventId: 'event-1', gameId: 'g', sequence: 0, segmentId: 's', kind: 'move-accepted', occurredAtMs: 1, receiveState: 'complete' as const, egressStatus: 'eligible' as const, payload: { moveId: 'm1' }, chunkIds: [] };
    const chunk = { chunkId: 'chunk-1', gameId: 'g', sequence: 0, receivedAtMs: 1, isFinal: true, egressStatus: 'eligible' as const, bytes: new Uint8Array([1, 2, 3]), sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' };
    const batch = createCloudArchiveBatch('g', 4, 2, game.checkpoint, [event], [chunk]);
    expect(batch).toMatchObject({ format: 'kamkmchess.cloud-archive-batch', schemaVersion: 1, baseRevision: 4, baseOwnershipEpoch: 2, checkpointRevision: 1 });
    expect(batch.events).toEqual([event]);
    expect(batch.chunks[0]).toMatchObject({ chunkId: 'chunk-1', bytesBase64: 'AQID', sha256: chunk.sha256 });
    expect(batch.chunks[0]).not.toHaveProperty('bytes');
  });

  it('creates a revision-one seed and recognizes only the exact account seed during uncertain-create recovery', () => {
    const local = accountCheckpoint();
    const withHistory: GameCheckpointV1 = {
      ...local,
      rules: { ...local.rules, moves: [{ moveId: 'm1', from: 'e2', to: 'e4', promotion: null, san: 'e4', fenBefore: local.rules.currentFen, fenAfter: local.rules.currentFen, eventId: 'event-1' }] },
      history: {
        ...local.history,
        segments: [{ ...local.history.segments[0]!, messageIds: ['msg-1', 'msg-2'] }],
        messages: [
          { messageId: 'msg-1', segmentId: 's', lineId: 'line-1', role: 'assistant', content: 'e4', eventIds: ['event-1'], disposition: 'retained' },
          { messageId: 'msg-2', segmentId: 's', lineId: 'old-line', role: 'assistant', content: 'discarded reply', eventIds: ['event-2'], disposition: 'discarded' },
        ],
      },
      archive: { ...local.archive, currentLine: { lineId: 'line-1', eventIds: ['event-1'] }, discardedLines: [{ lineId: 'old-line', eventIds: ['event-2'], discardedAtRevision: 3, reason: 'undo' }] },
    };
    const branchEvents: ArchiveEventV1[] = [
      { eventId: 'event-1', gameId: 'g', sequence: 0, segmentId: 's', kind: 'move-accepted', occurredAtMs: 1, receiveState: 'complete', egressStatus: 'eligible', payload: { moveId: 'm1' }, chunkIds: [] },
      { eventId: 'event-2', gameId: 'g', sequence: 1, segmentId: 's', kind: 'reply-received', occurredAtMs: 2, receiveState: 'complete', egressStatus: 'eligible', payload: { text: 'discarded reply' }, chunkIds: [] },
    ];
    assertArchiveReferenceIntegrity(withHistory, branchEvents, []);
    const seed = createCloudSeedCheckpoint(withHistory, 'account-a');
    expect(seed).toMatchObject({ revision: 1, ownershipEpoch: 1, rules: { moves: [] }, history: { messages: [] }, archive: { currentLine: { lineId: 'line-1', eventIds: [] }, discardedLines: [] } });
    expect(readGameCheckpoint(seed)).toEqual(seed);
    expect(seed.result).toEqual(withHistory.result);
    expect(matchesCloudSeed(withHistory, { id: 'g', revision: 1, epoch: 1, checkpoint: seed, createdAt: '', updatedAt: '' }, 'account-a')).toBe(true);
    expect(matchesCloudSeed({ ...withHistory, rules: { ...withHistory.rules, currentFen: 'different' } }, { id: 'g', revision: 1, epoch: 1, checkpoint: seed, createdAt: '', updatedAt: '' }, 'account-a')).toBe(false);
  });

  it('rejects an overlapping IndexedDB fallback sync and persists the accepted fence', async () => {
    const factory = new IDBFactory();
    const first = createCloudCoordination({ factory, databaseName: 'coord-test', locks: null });
    const second = createCloudCoordination({ factory, databaseName: 'coord-test', locks: null });
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const gate = new Promise<{ revision: number; epoch: number }>((resolve) => { finish = () => resolve({ revision: 7, epoch: 3 }); });
    const firstRun = first.run({ gameId: 'g', revision: 6, epoch: 3 }, async () => { start(); return gate; });
    await started;
    await expect(second.run({ gameId: 'g', revision: 6, epoch: 3 }, async () => 'should not run')).rejects.toThrow(/Another tab/);
    finish();
    await firstRun;
    await expect(second.run({ gameId: 'g', revision: 6, epoch: 3 }, async () => 'stale')).rejects.toThrow(/stale cloud revision/);
    expect(await second.run({ gameId: 'g', revision: 7, epoch: 3 }, async () => 'current')).toBe('current');
    first.close(); second.close();
  });

  it('allows a monotonic remote takeover fence after a conflict released the older lease', async () => {
    const factory = new IDBFactory();
    const coordinator = createCloudCoordination({ factory, databaseName: 'coord-advance-test', locks: null });
    await coordinator.run({ gameId: 'g', revision: 1, epoch: 1 }, async () => ({ revision: 1, epoch: 1 }));
    await expect(coordinator.run({ gameId: 'g', revision: 3, epoch: 2 }, async () => ({ revision: 3, epoch: 2 }))).resolves.toEqual({ revision: 3, epoch: 2 });
    await expect(coordinator.run({ gameId: 'g', revision: 2, epoch: 2 }, async () => 'stale')).rejects.toThrow(/stale cloud revision/);
    coordinator.close();
  });

  it('keeps local continuation on a server revision conflict and records a separate conflict', async () => {
    const localGame = storedGame();
    const preserveConflict = vi.fn();
    const client = {
      create: async () => { throw conflict(); },
      commit: async () => { throw conflict(); },
      readArchiveBatch: async () => ({ events: [], chunks: [] }),
      read: async () => ({ id: 'g', revision: 3, epoch: 2, checkpoint: accountCheckpoint(), createdAt: '', updatedAt: '' }),
    } as never;
    const manager = createCloudSyncManager({
      accountId: 'account-a', client,
      coordination: { run: async (_fence, action) => action(), publish: vi.fn(), subscribe: () => () => {}, close: vi.fn() },
      local: {
        read: async () => localGame, knownCredentials: async () => [], acknowledgedArchiveCursor: async () => ({ eventsThrough: null, chunksThrough: null }),
        stableOperationId: async () => 'op', prepareCloudCheckpoint: async (_id, checkpoint) => checkpoint,
        recordAcknowledgement: vi.fn(), preserveConflict, preserveAcceptedCloudSnapshot: async () => ({ eventsThrough: null, chunksThrough: null }),
        beginTakeoverAdoption: vi.fn(), pendingTakeoverAdoption: async () => null, clearTakeoverAdoption: vi.fn(), adoptAcceptedCloudSnapshot: vi.fn(async () => ({ databaseName: 'db', registryScope: 'scope' })), completeTakeoverAdoption: vi.fn(), applyOwnerDeletion: vi.fn(),
      }, online: () => true,
    });
    const result = await manager.sync('g', null, 0);
    expect(result.kind).toBe('conflict');
    expect(preserveConflict).toHaveBeenCalledWith('g', localGame, expect.objectContaining({ revision: 3 }));
  });

  it('validates and preserves the accepted current snapshot before acknowledging takeover', async () => {
    const localGame = storedGame();
    const cloudBefore = { id: 'g', revision: 3, epoch: 2, checkpoint: { ...accountCheckpoint(), ownershipEpoch: 2 }, createdAt: '', updatedAt: '' };
    const cloudAfter = { ...cloudBefore, epoch: 3, checkpoint: { ...cloudBefore.checkpoint, ownershipEpoch: 3 } };
    const archive = { format: 'kamkmchess.cloud-archive-batch', schemaVersion: 1, gameId: 'g', baseRevision: 3, baseOwnershipEpoch: 2, checkpointRevision: cloudBefore.checkpoint.revision, events: [], chunks: [] };
    const preserveAccepted = vi.fn(async () => ({ eventsThrough: null, chunksThrough: null }));
    const recordAcknowledgement = vi.fn();
    const preserveConflict = vi.fn();
    let readCount = 0;
    const client = {
      read: async () => ++readCount === 1 ? cloudBefore : cloudAfter,
      readArchiveBatch: async () => readCount <= 1 ? archive : { ...archive, baseOwnershipEpoch: 3 },
      takeover: async () => cloudAfter,
    } as never;
    const manager = createCloudSyncManager({
      accountId: 'account-a', client,
      coordination: { run: async (_fence, action) => action(), publish: vi.fn(), subscribe: () => () => {}, close: vi.fn() },
      local: {
        read: async () => localGame, knownCredentials: async () => [], acknowledgedArchiveCursor: async () => ({ eventsThrough: null, chunksThrough: null }),
        stableOperationId: async () => 'op', prepareCloudCheckpoint: async (_id, checkpoint) => checkpoint,
        recordAcknowledgement, preserveConflict, preserveAcceptedCloudSnapshot: preserveAccepted,
        beginTakeoverAdoption: vi.fn(), pendingTakeoverAdoption: async () => null, clearTakeoverAdoption: vi.fn(), adoptAcceptedCloudSnapshot: vi.fn(async () => ({ databaseName: 'db', registryScope: 'scope' })), completeTakeoverAdoption: vi.fn(), applyOwnerDeletion: vi.fn(),
      }, online: () => true,
    });
    await expect(manager.takeover('g', 3, 2)).resolves.toEqual({ kind: 'synced', revision: 3, epoch: 3 });
    expect(preserveConflict).toHaveBeenCalledWith('g', localGame, { checkpoint: cloudBefore.checkpoint, archiveBatch: archive });
    expect(preserveAccepted).toHaveBeenNthCalledWith(1, 'g', cloudBefore.checkpoint, archive);
    expect(preserveAccepted).toHaveBeenNthCalledWith(2, 'g', cloudAfter.checkpoint, { ...archive, baseOwnershipEpoch: 3 });
    expect(recordAcknowledgement).not.toHaveBeenCalled();
    expect(localGame).toEqual(storedGame());
  });

  it('recovers a crash after the server takeover and never commits the stale local branch', async () => {
    const localGame = storedGame();
    const cloudBefore = { id: 'g', revision: 3, epoch: 2, checkpoint: { ...accountCheckpoint(), ownershipEpoch: 2 }, createdAt: '', updatedAt: '' };
    const cloudAfter = { ...cloudBefore, revision: 4, epoch: 3 };
    const archive = (baseOwnershipEpoch: number) => ({ format: 'kamkmchess.cloud-archive-batch', schemaVersion: 1, gameId: 'g', baseRevision: baseOwnershipEpoch === 2 ? 3 : 4, baseOwnershipEpoch, checkpointRevision: cloudBefore.checkpoint.revision, events: [], chunks: [] });
    let pending: { expectedRevision: number; expectedEpoch: number } | null = null;
    let serverHead = cloudBefore;
    let adoptCalls = 0;
    const commit = vi.fn();
    const local = {
      read: async () => localGame, knownCredentials: async () => [], acknowledgedArchiveCursor: async () => ({ eventsThrough: null, chunksThrough: null }),
      stableOperationId: async () => 'op', prepareCloudCheckpoint: async (_id: string, checkpoint: GameCheckpointV1) => checkpoint,
      recordAcknowledgement: vi.fn(), preserveConflict: vi.fn(), preserveAcceptedCloudSnapshot: async () => ({ eventsThrough: null, chunksThrough: null }),
      beginTakeoverAdoption: async (_id: string, expectedRevision: number, expectedEpoch: number) => { pending = { expectedRevision, expectedEpoch }; },
      pendingTakeoverAdoption: async () => pending,
      clearTakeoverAdoption: async () => { pending = null; },
      adoptAcceptedCloudSnapshot: async () => { adoptCalls += 1; if (adoptCalls === 1) throw new Error('simulated crash after remote takeover'); return { databaseName: 'continued', registryScope: 'continued' }; },
      completeTakeoverAdoption: async () => { pending = null; },
      applyOwnerDeletion: vi.fn(),
    };
    const coordination = { run: async <T>(_fence: { gameId: string; revision: number; epoch: number }, action: () => Promise<T>): Promise<T> => action(), publish: vi.fn(), subscribe: () => () => {}, close: vi.fn() };
    const client = {
      read: async () => serverHead,
      readArchiveBatch: async () => archive(serverHead.epoch),
      takeover: async () => { serverHead = cloudAfter; return cloudAfter; },
      commit,
    } as never;
    const first = createCloudSyncManager({ accountId: 'account-a', client, coordination, local, online: () => true });
    await expect(first.takeover('g', 3, 2)).rejects.toThrow(/simulated crash/);
    expect(pending).toEqual({ expectedRevision: 3, expectedEpoch: 2 });
    expect(commit).not.toHaveBeenCalled();

    const second = createCloudSyncManager({ accountId: 'account-a', client, coordination, local, online: () => true });
    await expect(second.sync('g', 3, 2)).resolves.toEqual({ kind: 'synced', revision: 4, epoch: 3, adopted: true });
    expect(pending).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(local.recordAcknowledgement).not.toHaveBeenCalled();
  });

  it('returns a refreshed conflict when takeover is requested with a stale cloud fence', async () => {
    const localGame = storedGame();
    const cloudHead = { id: 'g', revision: 4, epoch: 3, checkpoint: { ...accountCheckpoint(), ownershipEpoch: 2 }, createdAt: '', updatedAt: '' };
    const preserveConflict = vi.fn();
    const recordAcknowledgement = vi.fn();
    const manager = createCloudSyncManager({
      accountId: 'account-a', client: { read: async () => cloudHead } as never,
      coordination: { run: async (_fence, action) => action(), publish: vi.fn(), subscribe: () => () => {}, close: vi.fn() },
      local: {
        read: async () => localGame, knownCredentials: async () => [], acknowledgedArchiveCursor: async () => ({ eventsThrough: null, chunksThrough: null }),
        stableOperationId: async () => 'op', prepareCloudCheckpoint: async (_id, checkpoint) => checkpoint,
        recordAcknowledgement, preserveConflict, preserveAcceptedCloudSnapshot: async () => ({ eventsThrough: null, chunksThrough: null }),
        beginTakeoverAdoption: vi.fn(), pendingTakeoverAdoption: async () => null, clearTakeoverAdoption: vi.fn(), adoptAcceptedCloudSnapshot: vi.fn(async () => ({ databaseName: 'db', registryScope: 'scope' })), completeTakeoverAdoption: vi.fn(), applyOwnerDeletion: vi.fn(),
      }, online: () => true,
    });
    const result = await manager.takeover('g', 3, 2);
    expect(result).toMatchObject({ kind: 'conflict', conflict: { cloud: { revision: 4, epoch: 3 } } });
    expect(preserveConflict).toHaveBeenCalledWith('g', localGame, { checkpoint: cloudHead.checkpoint });
    expect(recordAcknowledgement).not.toHaveBeenCalled();
  });
});

function conflict() { return Object.assign(new Error('conflict'), { status: 409 }); }
function accountCheckpoint(): GameCheckpointV1 {
  const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  return {
    schemaVersion: 1, gameId: 'g', namespace: { kind: 'account', accountId: 'account-a' }, revision: 1, ownershipEpoch: 0,
    segmentId: 's', positionRevision: 0, requestGeneration: 0, analysisGeneration: 0, updatedAtMs: 0,
    rules: { variant: 'orthodox', startingFen: initialFen, currentFen: initialFen, sideToMove: 'white', castlingRights: 'KQkq', enPassantSquare: null, halfmoveClock: '0', fullmoveNumber: '1', repetitionLedger: { version: 1, positions: [{ identity: 'start', occurrences: '1' }] }, moves: [] },
    history: { currentSegmentId: 's', segments: [{ segmentId: 's', providerId: null, modelRoutingId: null, connectionRevision: null, startedAtMs: 0, messageIds: [] }], messages: [] },
    clocks: { schemaVersion: 1, timeControl: { startingTimeMs: 60_000, incrementMs: 0 }, banksAtAnchor: { whiteMs: 60_000, blackMs: 60_000 }, activeSide: null, anchor: null, lastReconciledAtMs: 0 },
    budgets: { formattingCorrectionsRemaining: 3, illegalMoveAttemptsRemaining: { white: 3, black: 3 }, manualRetriesBySide: { white: 0, black: 0 } },
    selections: { players: { white: { kind: 'human' }, black: { kind: 'human' } } },
    archive: { egressStatus: 'eligible', currentLine: { lineId: 'l', eventIds: [] }, discardedLines: [] },
    result: { kind: 'unresolved' }, practice: { mode: 'ordinary', scored: true, sourceGameId: null, sourcePositionFen: null, originalResult: null }, extensions: {},
  };
}
function storedGame(): StoredGameV1 { return { checkpoint: accountCheckpoint(), events: [], chunks: [] }; }
