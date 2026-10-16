import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { exportGameArchive } from '../archive';
import { openGameStore } from './index';
import type { ArchiveChunkV1, ArchiveEventV1, CommitDecisionV1, GameCheckpointV1 } from './index';

function makeCheckpoint(revision = 1, updatedAtMs = 100): GameCheckpointV1 {
  return {
    schemaVersion: 1,
    gameId: 'storage-game',
    namespace: { kind: 'guest' },
    revision,
    ownershipEpoch: 0,
    segmentId: 'segment-1',
    positionRevision: revision,
    requestGeneration: 2,
    analysisGeneration: 1,
    updatedAtMs,
    rules: {
      variant: 'orthodox',
      startingFen: 'start-fen',
      currentFen: 'current-fen',
      sideToMove: 'white',
      castlingRights: 'KQkq',
      enPassantSquare: null,
      halfmoveClock: '900719925474099312345',
      fullmoveNumber: '9007199254740993',
      repetitionLedger: {
        version: 1,
        positions: [{ identity: 'position:full-state', occurrences: '9007199254740995' }],
      },
      moves: [
        {
          moveId: 'move-1',
          from: 'e2',
          to: 'e4',
          promotion: null,
          san: 'e4',
          fenBefore: 'start-fen',
          fenAfter: 'current-fen',
          eventId: 'event-1',
        },
      ],
    },
    history: {
      currentSegmentId: 'segment-1',
      segments: [
        {
          segmentId: 'segment-1',
          providerId: 'fixture-provider',
          modelRoutingId: 'fixture-model',
          connectionRevision: 2,
          startedAtMs: 10,
          messageIds: ['message-1'],
        },
      ],
      messages: [
        {
          messageId: 'message-1',
          segmentId: 'segment-1',
          lineId: 'line-current',
          role: 'assistant',
          content: 'full history stays attached',
          eventIds: ['event-1'],
          disposition: 'retained',
        },
      ],
    },
    clocks: {
      schemaVersion: 1,
      timeControl: { startingTimeMs: 900000, incrementMs: 10000 },
      banksAtAnchor: { whiteMs: 810000, blackMs: 800000 },
      activeSide: 'black',
      anchor: { wallTimeMs: 90, monotonicMs: 8 },
      lastReconciledAtMs: 99,
    },
    budgets: {
      formattingCorrectionsRemaining: 1,
      illegalMoveAttemptsRemaining: { white: 4, black: 2 },
      manualRetriesBySide: { white: 0, black: 1 },
    },
    selections: {
      players: {
        white: { kind: 'human' },
        black: {
          kind: 'model',
          providerId: 'fixture-provider',
          connectionId: 'connection-1',
          configurationRevision: 2,
          modelRoutingId: 'fixture-model',
          protocol: 'responses',
          diagnostic: 'passed-current-session',
        },
      },
    },
    archive: {
      egressStatus: 'eligible',
      currentLine: { lineId: 'line-current', eventIds: ['event-1'] },
      discardedLines: [],
    },
    result: { kind: 'unresolved' },
    practice: {
      mode: 'ordinary',
      scored: true,
      sourceGameId: null,
      sourcePositionFen: null,
      originalResult: null,
    },
    extensions: {},
  };
}

function makeEvent(chunkIds: string[], sequence = 1): ArchiveEventV1 {
  return {
    eventId: 'event-1',
    gameId: 'storage-game',
    sequence,
    segmentId: 'segment-1',
    kind: 'reply-received',
    occurredAtMs: 90,
    receiveState: 'complete',
    egressStatus: 'eligible',
    payload: { text: 'fixture response' },
    chunkIds,
  };
}

function makeChunk(chunkId: string, sequence: number, text: string, isFinal = true): ArchiveChunkV1 {
  return {
    chunkId,
    gameId: 'storage-game',
    sequence,
    receivedAtMs: 90 + sequence,
    isFinal,
    egressStatus: 'eligible',
    bytes: new TextEncoder().encode(text),
    sha256: '',
  };
}

function databaseName(): string {
  return `storage-fixture-${Math.random().toString(36).slice(2)}`;
}

describe('IndexedDB checkpoint commits', () => {
  it('persists the complete checkpoint, exact raw chunks, and outbox before resolving', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const store = await openGameStore({ databaseName: name, factory, now: () => 101, syncConfigured: true });
    const initial = makeCheckpoint();
    expect((await store.status(initial.gameId)).local).toEqual({ kind: 'memory-only' });
    const result = await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, 'exact bytes: \u96ea')],
      knownCredentials: [],
      decide: (decisionTimeMs) => ({
        checkpoint: { ...initial, updatedAtMs: decisionTimeMs },
        outboxOperationIds: ['operation-1'],
      }),
    });

    expect(result.kind).toBe('committed');
    let retryDecisionCalled = false;
    const retryAfterLostAcknowledgment = await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, 'exact bytes: \u96ea')],
      knownCredentials: [],
      decide: () => {
        retryDecisionCalled = true;
        return { checkpoint: initial, outboxOperationIds: ['operation-1'] };
      },
    });
    expect(retryAfterLostAcknowledgment).toEqual({
      kind: 'revision-conflict',
      actualRevision: 1,
      actualEpoch: 0,
    });
    expect(retryDecisionCalled).toBe(false);
    const saved = await store.readGame(initial.gameId);
    expect(saved?.checkpoint.updatedAtMs).toBe(101);
    expect(saved?.checkpoint.rules.halfmoveClock).toBe('900719925474099312345');
    expect(saved?.checkpoint.rules.fullmoveNumber).toBe('9007199254740993');
    expect(saved?.checkpoint.rules.repetitionLedger.positions[0]?.occurrences).toBe('9007199254740995');
    expect(new TextDecoder().decode(saved?.chunks[0]?.bytes)).toBe('exact bytes: \u96ea');
    expect((await store.readOutboxOperation('operation-1'))?.checkpointRevision).toBe(1);
    expect((await store.status(initial.gameId)).local).toEqual({ kind: 'saved-locally', revision: 1 });

    await store.markOutboxSynced('operation-1', 12);
    expect((await store.readOutboxOperation('operation-1'))?.state).toBe('synced');
    expect((await store.status(initial.gameId)).sync).toEqual({ kind: 'current', syncedRevision: 12 });
    store.close();

    const reopened = await openGameStore({ databaseName: name, factory, now: () => 102 });
    expect((await reopened.readGame(initial.gameId))?.checkpoint).toEqual(saved?.checkpoint);
    reopened.close();
  });

  it('aborts atomically when the decision hook throws or returns a thenable', async () => {
    const store = await openGameStore({ databaseName: databaseName(), factory: new IDBFactory() });
    const initial = makeCheckpoint();

    await expect(
      store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: null,
        expectedEpoch: 0,
        events: [makeEvent(['chunk-1'])],
        chunks: [makeChunk('chunk-1', 1, 'uncommitted')],
        knownCredentials: [],
        decide: () => {
          throw new Error('fault injection');
        },
      }),
    ).rejects.toMatchObject({ code: 'transaction-aborted' });
    expect(await store.readGame(initial.gameId)).toBeNull();
    expect(await store.readOutboxOperation('operation-1')).toBeNull();
    expect((await store.status(initial.gameId)).local).toMatchObject({
      kind: 'failed',
      savedRevision: null,
      failure: { code: 'transaction-aborted' },
    });

    const foreignThenable = { then: () => undefined };
    await expect(
      store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: null,
        expectedEpoch: 0,
        events: [],
        chunks: [],
        knownCredentials: [],
        // @ts-expect-error runtime contract rejects thenables even when JavaScript bypasses TypeScript
        decide: () => foreignThenable,
      }),
    ).rejects.toMatchObject({ code: 'invalid-data' });
    expect(await store.readGame(initial.gameId)).toBeNull();
    store.close();
  });

  it('commits the move or expiry event selected at decision time with the sampled effective time', async () => {
    const scenarios = [
      { decisionTimeMs: 1250, expectedKind: 'move-accepted', eventId: 'decision-move' },
      { decisionTimeMs: 2600, expectedKind: 'timeout', eventId: 'decision-timeout' },
    ] as const;

    for (const scenario of scenarios) {
      const name = databaseName();
      const factory = new IDBFactory();
      const initial = makeCheckpoint();
      const store = await openGameStore({ databaseName: name, factory, now: () => scenario.decisionTimeMs });
      await store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: null,
        expectedEpoch: 0,
        events: [makeEvent(['chunk-1'])],
        chunks: [makeChunk('chunk-1', 1, 'received before decision')],
        knownCredentials: [],
        decide: () => ({ checkpoint: initial, outboxOperationIds: [] }),
      });

      const committed = await store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: 1,
        expectedEpoch: 0,
        events: [{ ...makeEvent(['chunk-decision'], 2), eventId: 'provider-event-2' }],
        chunks: [makeChunk('chunk-decision', 2, 'prepared decision-linked bytes')],
        knownCredentials: [],
        decide: (decisionTimeMs) => {
          const isMove = decisionTimeMs < 2000;
          const eventId = isMove ? 'decision-move' : 'decision-timeout';
          const event: ArchiveEventV1 = {
            eventId,
            gameId: initial.gameId,
            sequence: 3,
            segmentId: 'segment-1',
            kind: isMove ? 'move-accepted' : 'timeout',
            occurredAtMs: decisionTimeMs,
            receiveState: 'complete',
            egressStatus: 'eligible',
            payload: { sampledDecisionTimeMs: decisionTimeMs },
            chunkIds: ['chunk-1', 'chunk-decision'],
          };
          const checkpoint: GameCheckpointV1 = {
            ...initial,
            revision: 2,
            positionRevision: 2,
            updatedAtMs: decisionTimeMs,
            archive: {
              ...initial.archive,
              currentLine: { lineId: 'line-current', eventIds: ['event-1', 'provider-event-2', eventId] },
            },
            ...(isMove
              ? {
                  rules: {
                    ...initial.rules,
                    currentFen: 'decision-move-position',
                    sideToMove: 'black' as const,
                    moves: [
                      ...initial.rules.moves,
                      {
                        moveId: 'move-decision',
                        from: 'e7',
                        to: 'e5',
                        promotion: null,
                        san: 'e5',
                        fenBefore: initial.rules.currentFen,
                        fenAfter: 'decision-move-position',
                        eventId,
                      },
                    ],
                  },
                }
              : {
                  result: {
                    kind: 'final' as const,
                    winner: 'white' as const,
                    reason: 'timeout' as const,
                    eventId,
                    decidedAtMs: decisionTimeMs,
                  },
                }),
          };
          const decision: CommitDecisionV1 = {
            checkpoint,
            events: [event],
            outboxOperationIds: [`outbox-${eventId}`],
          };
          return decision;
        },
      });
      expect(committed.kind).toBe('committed');
      expect(committed.kind === 'committed' ? committed.decisionTimeMs : null).toBe(scenario.decisionTimeMs);
      store.close();

      const reloaded = await openGameStore({ databaseName: name, factory });
      const saved = await reloaded.readGame(initial.gameId);
      const savedEvent = saved?.events.find((event) => event.eventId === scenario.eventId);
      expect(savedEvent?.kind).toBe(scenario.expectedKind);
      expect(savedEvent?.occurredAtMs).toBe(scenario.decisionTimeMs);
      expect(savedEvent?.payload).toEqual({ sampledDecisionTimeMs: scenario.decisionTimeMs });
      expect(saved?.checkpoint.archive.currentLine.eventIds).toEqual([
        'event-1',
        'provider-event-2',
        scenario.eventId,
      ]);
      expect(saved?.events.find((event) => event.eventId === scenario.eventId)?.chunkIds).toEqual([
        'chunk-1',
        'chunk-decision',
      ]);
      expect(saved?.chunks.find((chunk) => chunk.chunkId === 'chunk-decision')?.bytes).toEqual(
        new TextEncoder().encode('prepared decision-linked bytes'),
      );
      if (scenario.expectedKind === 'move-accepted') {
        expect(saved?.checkpoint.rules.moves.at(-1)?.eventId).toBe(scenario.eventId);
      } else {
        expect(saved?.checkpoint.result).toEqual({
          kind: 'final',
          winner: 'white',
          reason: 'timeout',
          eventId: scenario.eventId,
          decidedAtMs: scenario.decisionTimeMs,
        });
      }
      reloaded.close();
    }
  });

  it('aborts prepared archive additions when the fenced decision throws', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const initial = makeCheckpoint();
    const store = await openGameStore({ databaseName: name, factory, now: () => 1450 });
    await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, 'already committed')],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: [] }),
    });

    await expect(
      store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: 1,
        expectedEpoch: 0,
        events: [{ ...makeEvent(['chunk-2'], 2), eventId: 'event-prepared' }],
        chunks: [makeChunk('chunk-2', 2, 'must roll back')],
        knownCredentials: [],
        decide: () => {
          throw new Error('decision fixture failure');
        },
      }),
    ).rejects.toMatchObject({ code: 'transaction-aborted' });

    const saved = await store.readGame(initial.gameId);
    expect(saved?.checkpoint.revision).toBe(1);
    expect(saved?.events.map((event) => event.eventId)).toEqual(['event-1']);
    expect(saved?.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-1']);
    expect((await store.status(initial.gameId)).local).toMatchObject({
      kind: 'failed',
      savedRevision: 1,
      failure: { code: 'transaction-aborted' },
    });
    store.close();
  });

  it('rejects duplicate, out-of-order, wrong-game, and dangling decision events atomically', async () => {
    const invalidDecisions: Array<{
      eventId: string;
      chunkIds: string[];
      gameId?: string;
      sequence?: number;
    }> = [
      {
        eventId: 'event-1',
        chunkIds: [],
      },
      {
        eventId: 'event-dangling',
        chunkIds: ['chunk-not-stored'],
      },
      {
        eventId: 'event-out-of-order',
        chunkIds: [],
        sequence: 2,
      },
      {
        eventId: 'event-wrong-game',
        chunkIds: [],
        gameId: 'another-game',
      },
    ];

    for (const [index, invalidEvent] of invalidDecisions.entries()) {
      const name = databaseName();
      const factory = new IDBFactory();
      const initial = makeCheckpoint();
      const store = await openGameStore({ databaseName: name, factory, now: () => 1600 });
      await store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: null,
        expectedEpoch: 0,
        events: [makeEvent(['chunk-1'])],
        chunks: [makeChunk('chunk-1', 1, 'already committed')],
        knownCredentials: [],
        decide: () => ({ checkpoint: initial, outboxOperationIds: [] }),
      });
      const decisionEvent: ArchiveEventV1 = {
        eventId: invalidEvent.eventId,
        gameId: invalidEvent.gameId ?? initial.gameId,
        sequence: invalidEvent.sequence ?? 3,
        segmentId: 'segment-1',
        kind: 'move-accepted',
        occurredAtMs: 1600,
        receiveState: 'complete',
        egressStatus: 'eligible',
        payload: {},
        chunkIds: invalidEvent.chunkIds,
      };
      const next = {
        ...initial,
        revision: 2,
        positionRevision: 2,
        archive: {
          ...initial.archive,
          currentLine: { lineId: 'line-current', eventIds: ['event-1', invalidEvent.eventId] },
        },
      };
      await expect(
        store.commitCheckpoint({
          gameId: initial.gameId,
          expectedRevision: 1,
          expectedEpoch: 0,
          events: [{ ...makeEvent(['chunk-2'], 2), eventId: `prepared-${index}` }],
          chunks: [makeChunk('chunk-2', 2, 'must roll back')],
          knownCredentials: [],
          decide: () => ({ checkpoint: next, events: [decisionEvent], outboxOperationIds: [`invalid-${index}`] }),
        }),
      ).rejects.toMatchObject({ code: 'invalid-data' });

      const saved = await store.readGame(initial.gameId);
      expect(saved?.checkpoint.revision).toBe(1);
      expect(saved?.events.map((event) => event.eventId)).toEqual(['event-1']);
      expect(saved?.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-1']);
      expect(await store.readOutboxOperation(`invalid-${index}`)).toBeNull();
      store.close();
    }
  });

  it('rejects unprepared raw chunks attached to a decision event', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const initial = makeCheckpoint();
    const store = await openGameStore({ databaseName: name, factory, now: () => 1680 });
    await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, 'already committed')],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: [] }),
    });

    const invalidEvent = {
      ...makeEvent([], 2),
      eventId: 'decision-with-raw-chunk',
      bytes: new TextEncoder().encode('must stay outside the transaction'),
    };
    const next = {
      ...initial,
      revision: 2,
      positionRevision: 2,
      archive: {
        ...initial.archive,
        currentLine: { lineId: 'line-current', eventIds: ['event-1', invalidEvent.eventId] },
      },
    };

    await expect(
      store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: 1,
        expectedEpoch: 0,
        events: [{ ...makeEvent(['chunk-2'], 2), eventId: 'prepared-event' }],
        chunks: [makeChunk('chunk-2', 2, 'prepared content')],
        knownCredentials: [],
        decide: () => ({ checkpoint: next, events: [invalidEvent], outboxOperationIds: ['raw-chunk-outbox'] }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-data' });

    const saved = await store.readGame(initial.gameId);
    expect(saved?.checkpoint.revision).toBe(1);
    expect(saved?.events.map((event) => event.eventId)).toEqual(['event-1']);
    expect(saved?.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-1']);
    expect(await store.readOutboxOperation('raw-chunk-outbox')).toBeNull();
    store.close();
  });

  it('quarantines a call-time credential echo in decided metadata and blocks export after reload', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const initial = makeCheckpoint();
    const store = await openGameStore({ databaseName: name, factory, now: () => 1725, syncConfigured: true });
    await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, 'safe initial bytes')],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: [] }),
    });

    const knownCredentials = ['api-key-decision-canary-1725'];
    const commitPromise = store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: 1,
      expectedEpoch: 0,
      events: [],
      chunks: [],
      knownCredentials,
      decide: (decisionTimeMs) => {
        const eventId = 'decision-credential-echo';
        return {
          checkpoint: {
            ...initial,
            revision: 2,
            positionRevision: 2,
            updatedAtMs: decisionTimeMs,
            archive: {
              ...initial.archive,
              currentLine: { lineId: 'line-current', eventIds: ['event-1', eventId] },
            },
          },
          events: [
            {
              eventId,
              gameId: initial.gameId,
              sequence: 2,
              segmentId: 'segment-api-key-decision-canary-1725',
              kind: 'move-accepted',
              occurredAtMs: decisionTimeMs,
              receiveState: 'complete',
              egressStatus: 'eligible',
              payload: { rawMetadata: 'recognized reply' },
              chunkIds: [],
            },
          ],
          outboxOperationIds: ['quarantined-decision-outbox'],
        };
      },
    });
    knownCredentials.splice(0, knownCredentials.length);
    expect((await commitPromise).kind).toBe('committed');
    const saved = await store.readGame(initial.gameId);
    expect(saved?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(saved?.events[1]?.segmentId).toBe('segment-api-key-decision-canary-1725');
    expect(saved?.events[1]?.payload).toEqual({ rawMetadata: 'recognized reply' });
    expect(saved?.events[1]?.egressStatus).toBe('credential-echo-quarantined');
    expect((await store.readOutboxOperation('quarantined-decision-outbox'))?.state).toBe('blocked');
    store.close();

    const reloaded = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    await expect(reloaded.exportGameArchive(initial.gameId, [])).rejects.toMatchObject({ code: 'credential-echo' });
    expect((await reloaded.readOutboxOperation('quarantined-decision-outbox'))?.state).toBe('blocked');
    expect((await reloaded.status(initial.gameId)).sync.kind).toBe('blocked');
    reloaded.close();
  });

  it('round-trips versioned clock anchors, optional host offsets, and paused null state', async () => {
    const factory = new IDBFactory();
    const clockCases: GameCheckpointV1['clocks'][] = [
      {
        schemaVersion: 1,
        timeControl: { startingTimeMs: 900000, incrementMs: 10000 },
        banksAtAnchor: { whiteMs: 810000, blackMs: 800000 },
        activeSide: 'black',
        anchor: { monotonicMs: 8, wallTimeMs: 90, hostOffsetMs: 350 },
        lastReconciledAtMs: 99,
      },
      {
        schemaVersion: 1,
        timeControl: { startingTimeMs: 900000, incrementMs: 10000 },
        banksAtAnchor: { whiteMs: 810000, blackMs: 800000 },
        activeSide: 'white',
        anchor: { monotonicMs: 11, wallTimeMs: 101 },
        lastReconciledAtMs: 102,
      },
      {
        schemaVersion: 1,
        timeControl: { startingTimeMs: 900000, incrementMs: 10000 },
        banksAtAnchor: { whiteMs: 900000, blackMs: 900000 },
        activeSide: null,
        anchor: null,
        lastReconciledAtMs: 0,
      },
    ];

    for (let index = 0; index < clockCases.length; index += 1) {
      const source = await openGameStore({ databaseName: databaseName(), factory, now: () => 101 });
      const checkpoint = { ...makeCheckpoint(), gameId: `clock-game-${index}`, clocks: clockCases[index]! };
      const result = await source.commitCheckpoint({
        gameId: checkpoint.gameId,
        expectedRevision: null,
        expectedEpoch: 0,
        events: [{ ...makeEvent(['chunk-1']), gameId: checkpoint.gameId }],
        chunks: [{ ...makeChunk('chunk-1', 1, 'clock archive'), gameId: checkpoint.gameId }],
        knownCredentials: [],
        decide: () => ({ checkpoint, outboxOperationIds: [] }),
      });
      expect(result.kind).toBe('committed');
      expect((await source.readGame(checkpoint.gameId))?.checkpoint.clocks).toEqual(clockCases[index]);

      const archive = await source.exportGameArchive(checkpoint.gameId, []);
      const destination = await openGameStore({ databaseName: databaseName(), factory });
      const imported = await destination.importGameArchive(JSON.parse(JSON.stringify(archive)));
      expect(imported.checkpoint.clocks).toEqual(clockCases[index]);
      source.close();
      destination.close();
    }
  });

  it('reports an injected quota abort as unsaved and leaves no partial archive', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    let injectQuotaOnEventAppend = false;
    const originalOpen = factory.open.bind(factory);
    factory.open = ((databaseName: string, version?: number) => {
      const request = originalOpen(databaseName, version);
      request.addEventListener('success', () => {
        const database = request.result;
        const originalTransaction = database.transaction.bind(database);
        Object.defineProperty(database, 'transaction', {
          configurable: true,
          value: (storeNames: string | string[], mode?: IDBTransactionMode) => {
            const transaction = originalTransaction(storeNames as string[], mode);
            if (!injectQuotaOnEventAppend || mode !== 'readwrite') return transaction;
            injectQuotaOnEventAppend = false;
            const originalObjectStore = transaction.objectStore.bind(transaction);
            transaction.objectStore = ((storeName: string) => {
              const objectStore = originalObjectStore(storeName);
              if (storeName !== 'events') return objectStore;
              const originalAdd = objectStore.add.bind(objectStore);
              objectStore.add = ((value: unknown, key?: IDBValidKey) => {
                const append = key === undefined ? originalAdd(value) : originalAdd(value, key);
                queueMicrotask(() => {
                  (transaction as IDBTransaction & { error: DOMException | null }).error = new DOMException(
                    'Fixture quota failure',
                    'QuotaExceededError',
                  );
                  transaction.abort();
                });
                return append;
              }) as typeof objectStore.add;
              return objectStore;
            }) as IDBTransaction['objectStore'];
            return transaction;
          },
        });
      });
      return request;
    }) as IDBFactory['open'];
    const store = await openGameStore({ databaseName: name, factory });
    const initial = makeCheckpoint();
    injectQuotaOnEventAppend = true;

    await expect(
      store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: null,
        expectedEpoch: 0,
        events: [makeEvent(['chunk-1'])],
        chunks: [makeChunk('chunk-1', 1, 'quota-aborted')],
        knownCredentials: [],
        decide: () => ({ checkpoint: initial, outboxOperationIds: ['quota-operation'] }),
      }),
    ).rejects.toMatchObject({ code: 'quota' });

    expect(await store.readGame(initial.gameId)).toBeNull();
    expect(await store.readOutboxOperation('quota-operation')).toBeNull();
    expect((await store.status(initial.gameId)).local).toMatchObject({
      kind: 'failed',
      savedRevision: null,
      failure: { code: 'quota' },
    });
    expect((await store.status('another-game')).lastFailure).toBeNull();
    store.close();
  });

  it('keeps a recognized credential echo quarantined across key removal, close, and reload', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const firstStore = await openGameStore({ databaseName: name, factory });
    const initial = makeCheckpoint();
    const first = makeChunk('chunk-1', 1, 'prefix api-key-');
    const second = makeChunk('chunk-2', 2, 'canary-739 suffix');
    second.isFinal = true;
    const result = await firstStore.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1', 'chunk-2'])],
      chunks: [first, second],
      knownCredentials: ['api-key-canary-739'],
      decide: (decisionTimeMs) => ({
        checkpoint: { ...initial, updatedAtMs: decisionTimeMs },
        outboxOperationIds: ['blocked-operation'],
      }),
    });

    expect(result.kind).toBe('committed');
    const local = await firstStore.readGame(initial.gameId);
    expect(local?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(local?.events[0]?.egressStatus).toBe('credential-echo-quarantined');
    expect(local?.chunks.map((chunk) => chunk.egressStatus)).toEqual([
      'credential-echo-quarantined',
      'credential-echo-quarantined',
    ]);
    expect((await firstStore.readOutboxOperation('blocked-operation'))?.state).toBe('blocked');
    await expect(firstStore.markOutboxSynced('blocked-operation', 1)).rejects.toMatchObject({
      code: 'invalid-data',
    });
    await expect(exportGameArchive(local!, ['api-key-canary-739'])).rejects.toMatchObject({
      code: 'credential-echo',
    });
    expect(new TextDecoder().decode(local?.chunks[0]?.bytes) + new TextDecoder().decode(local?.chunks[1]?.bytes)).toBe(
      'prefix api-key-canary-739 suffix',
    );
    firstStore.close();

    const reloaded = await openGameStore({ databaseName: name, factory });
    const restored = await reloaded.readGame(initial.gameId);
    await expect(exportGameArchive(restored!, [])).rejects.toMatchObject({ code: 'credential-echo' });
    await expect(reloaded.exportGameArchive(initial.gameId, [])).rejects.toMatchObject({ code: 'credential-echo' });
    expect(restored?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    reloaded.close();
  });

  it('persists quarantine first recognized by export and blocks a pending outbox after reload', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const firstStore = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    const base = makeCheckpoint();
    const exactHistory = 'received secret echo: api-key-canary-739';
    const initial: GameCheckpointV1 = {
      ...base,
      history: {
        ...base.history,
        messages: base.history.messages.map((message) => ({ ...message, content: exactHistory })),
      },
    };
    const exactBytes = 'raw bytes are preserved exactly: \u96ea';
    await firstStore.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, exactBytes)],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: ['pending-before-recognition'] }),
    });

    await expect(firstStore.exportGameArchive(initial.gameId, ['api-key-canary-739'])).rejects.toMatchObject({
      code: 'credential-echo',
    });
    expect((await firstStore.readGame(initial.gameId))?.checkpoint.archive.egressStatus).toBe(
      'credential-echo-quarantined',
    );
    expect((await firstStore.readOutboxOperation('pending-before-recognition'))?.state).toBe('blocked');
    expect(new TextDecoder().decode((await firstStore.readGame(initial.gameId))?.chunks[0]?.bytes)).toBe(exactBytes);
    expect((await firstStore.readGame(initial.gameId))?.checkpoint.history.messages[0]?.content).toBe(exactHistory);
    firstStore.close();

    const reloaded = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    await expect(reloaded.exportGameArchive(initial.gameId, [])).rejects.toMatchObject({
      code: 'credential-echo',
    });
    expect((await reloaded.status(initial.gameId)).sync.kind).toBe('blocked');
    expect((await reloaded.readOutboxOperation('pending-before-recognition'))?.state).toBe('blocked');
    reloaded.close();
  });

  it('snapshots credentials at export entry and keeps the recognized echo quarantined after key removal', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const firstStore = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    const initial = makeCheckpoint();
    const exactBytes = 'raw provider echo: api-key-canary-739 and snow 雪';
    await firstStore.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, exactBytes)],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: ['mutation-export-operation'] }),
    });

    const credentials = ['api-key-canary-739'];
    const exportPromise = firstStore.exportGameArchive(initial.gameId, credentials);
    credentials.splice(0, credentials.length);
    await expect(exportPromise).rejects.toMatchObject({ code: 'credential-echo' });

    const quarantined = await firstStore.readGame(initial.gameId);
    expect(quarantined?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(quarantined?.events[0]?.egressStatus).toBe('credential-echo-quarantined');
    expect(quarantined?.chunks[0]?.egressStatus).toBe('credential-echo-quarantined');
    expect(new TextDecoder().decode(quarantined?.chunks[0]?.bytes)).toBe(exactBytes);
    expect((await firstStore.readOutboxOperation('mutation-export-operation'))?.state).toBe('blocked');
    firstStore.close();

    const reloaded = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    await expect(reloaded.exportGameArchive(initial.gameId, [])).rejects.toMatchObject({
      code: 'credential-echo',
    });
    expect((await reloaded.readOutboxOperation('mutation-export-operation'))?.state).toBe('blocked');
    expect((await reloaded.status(initial.gameId)).sync.kind).toBe('blocked');
    expect(new TextDecoder().decode((await reloaded.readGame(initial.gameId))?.chunks[0]?.bytes)).toBe(exactBytes);
    reloaded.close();
  });

  it('snapshots credentials at import entry and persists quarantine before later outbox work', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const initial = makeCheckpoint();
    const exactBytes = 'imported provider echo: api-key-canary-739 and snow 雪';
    const archive = await exportGameArchive(
      { checkpoint: initial, events: [makeEvent(['chunk-1'])], chunks: [makeChunk('chunk-1', 1, exactBytes)] },
      [],
    );
    const store = await openGameStore({ databaseName: name, factory, syncConfigured: true });

    const credentials = ['api-key-canary-739'];
    const importPromise = store.importGameArchive(JSON.parse(JSON.stringify(archive)), credentials);
    credentials.splice(0, credentials.length);
    await importPromise;

    const imported = await store.readGame(initial.gameId);
    expect(imported?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(imported?.events[0]?.egressStatus).toBe('credential-echo-quarantined');
    expect(imported?.chunks[0]?.egressStatus).toBe('credential-echo-quarantined');
    expect(new TextDecoder().decode(imported?.chunks[0]?.bytes)).toBe(exactBytes);

    const nextCheckpoint: GameCheckpointV1 = {
      ...initial,
      revision: 2,
      positionRevision: 2,
      updatedAtMs: 102,
    };
    const commit = await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: 1,
      expectedEpoch: 0,
      events: [],
      chunks: [],
      knownCredentials: [],
      decide: (decisionTimeMs) => ({
        checkpoint: { ...nextCheckpoint, updatedAtMs: decisionTimeMs },
        outboxOperationIds: ['blocked-after-import'],
      }),
    });
    expect(commit.kind).toBe('committed');
    expect((await store.readOutboxOperation('blocked-after-import'))?.state).toBe('blocked');
    store.close();

    const reloaded = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    await expect(reloaded.exportGameArchive(initial.gameId, [])).rejects.toMatchObject({
      code: 'credential-echo',
    });
    expect((await reloaded.readOutboxOperation('blocked-after-import'))?.state).toBe('blocked');
    expect((await reloaded.status(initial.gameId)).sync.kind).toBe('blocked');
    expect(new TextDecoder().decode((await reloaded.readGame(initial.gameId))?.chunks[0]?.bytes)).toBe(exactBytes);
    reloaded.close();
  });

  it('persists a credential echo found only in event metadata and keeps it blocked after key removal', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const firstStore = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    const initial = makeCheckpoint();
    const exactBytes = 'raw event body contains no credential: 雪';
    const event = { ...makeEvent(['chunk-1']), kind: 'api-key-canary-739' };
    await firstStore.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [event],
      chunks: [makeChunk('chunk-1', 1, exactBytes)],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: ['metadata-echo-operation'] }),
    });

    await expect(firstStore.exportGameArchive(initial.gameId, ['api-key-canary-739'])).rejects.toMatchObject({
      code: 'credential-echo',
      message: expect.not.stringContaining('api-key-canary-739'),
    });
    const local = await firstStore.readGame(initial.gameId);
    expect(local?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(local?.events[0]?.kind).toBe('api-key-canary-739');
    expect(local?.events[0]?.egressStatus).toBe('credential-echo-quarantined');
    expect(local?.chunks[0]?.egressStatus).toBe('credential-echo-quarantined');
    expect(new TextDecoder().decode(local?.chunks[0]?.bytes)).toBe(exactBytes);
    expect((await firstStore.readOutboxOperation('metadata-echo-operation'))?.state).toBe('blocked');
    firstStore.close();

    const reloaded = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    await expect(reloaded.exportGameArchive(initial.gameId, [])).rejects.toMatchObject({ code: 'credential-echo' });
    expect((await reloaded.readOutboxOperation('metadata-echo-operation'))?.state).toBe('blocked');
    expect((await reloaded.status(initial.gameId)).sync.kind).toBe('blocked');
    expect(new TextDecoder().decode((await reloaded.readGame(initial.gameId))?.chunks[0]?.bytes)).toBe(exactBytes);
    reloaded.close();
  });

  it('persists commit-time quarantine of existing rows and blocks pending and failed outbox work', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const store = await openGameStore({ databaseName: name, factory, now: () => 1800, syncConfigured: true });
    const initial = makeCheckpoint();
    const credential = 'credential-canary-alias-r2';
    const event = makeEvent(['chunk-1', 'chunk-2']);
    const chunks = [
      makeChunk('chunk-1', 1, 'received: credential-canary-', false),
      makeChunk('chunk-2', 2, 'alias-r2 and snow 雪'),
    ];
    expect(new TextDecoder().decode(chunks[0]!.bytes) + new TextDecoder().decode(chunks[1]!.bytes)).toBe(
      'received: credential-canary-alias-r2 and snow 雪',
    );

    await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [event],
      chunks,
      knownCredentials: [],
      decide: () => ({
        checkpoint: initial,
        outboxOperationIds: ['old-pending', 'old-failed', 'old-synced'],
      }),
    });
    await store.markOutboxFailed('old-failed', 'network');
    await store.markOutboxSynced('old-synced', 1);
    const beforeRecognition = await store.readGame(initial.gameId);

    const result = await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: 1,
      expectedEpoch: 0,
      events: [],
      chunks: [],
      knownCredentials: [credential],
      decide: (decisionTimeMs) => ({
        checkpoint: { ...initial, revision: 2, updatedAtMs: decisionTimeMs },
        outboxOperationIds: ['new-blocked'],
      }),
    });
    expect(result.kind).toBe('committed');

    const afterRecognition = await store.readGame(initial.gameId);
    expect(afterRecognition?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(afterRecognition?.events).toEqual(
      beforeRecognition?.events.map((savedEvent) => ({ ...savedEvent, egressStatus: 'credential-echo-quarantined' })),
    );
    expect(afterRecognition?.chunks).toEqual(
      beforeRecognition?.chunks.map((savedChunk) => ({ ...savedChunk, egressStatus: 'credential-echo-quarantined' })),
    );
    expect((await store.readOutboxOperation('old-pending'))).toMatchObject({
      state: 'blocked',
      blockedReason: 'credential-echo',
      failureCode: null,
    });
    expect((await store.readOutboxOperation('old-failed'))).toMatchObject({
      state: 'blocked',
      blockedReason: 'credential-echo',
      failureCode: null,
    });
    expect(await store.readOutboxOperation('old-synced')).toMatchObject({
      state: 'synced',
      syncedRevision: 1,
      blockedReason: null,
    });
    expect(await store.readOutboxOperation('new-blocked')).toMatchObject({
      state: 'blocked',
      blockedReason: 'credential-echo',
    });
    store.close();

    const reloaded = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    const afterReload = await reloaded.readGame(initial.gameId);
    expect(afterReload?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(afterReload?.events).toEqual(afterRecognition?.events);
    expect(afterReload?.chunks).toEqual(afterRecognition?.chunks);
    expect(await reloaded.readOutboxOperation('old-pending')).toMatchObject({ state: 'blocked' });
    expect(await reloaded.readOutboxOperation('old-failed')).toMatchObject({ state: 'blocked' });
    expect(await reloaded.readOutboxOperation('old-synced')).toMatchObject({ state: 'synced', syncedRevision: 1 });
    expect(await reloaded.readOutboxOperation('new-blocked')).toMatchObject({ state: 'blocked' });
    await expect(reloaded.exportGameArchive(initial.gameId, [])).rejects.toMatchObject({ code: 'credential-echo' });
    reloaded.close();
  });

  it('rolls back existing-row quarantine and outbox blocks when a later commit aborts', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const store = await openGameStore({ databaseName: name, factory, now: () => 1900, syncConfigured: true });
    const initial = makeCheckpoint();
    const credential = 'credential-canary-abort-r2';
    const event = makeEvent(['chunk-1']);
    const chunk = makeChunk('chunk-1', 1, `received ${credential}`);
    await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [event],
      chunks: [chunk],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: ['abort-pending', 'abort-failed'] }),
    });
    await store.markOutboxFailed('abort-failed', 'network');
    const beforeAbort = await store.readGame(initial.gameId);

    await expect(
      store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: 1,
        expectedEpoch: 0,
        events: [],
        chunks: [],
        knownCredentials: [credential],
        decide: (decisionTimeMs) => ({
          checkpoint: { ...initial, revision: 2, updatedAtMs: decisionTimeMs },
          outboxOperationIds: ['abort-pending'],
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-data' });

    const afterAbort = await store.readGame(initial.gameId);
    expect(afterAbort?.checkpoint.revision).toBe(1);
    expect(afterAbort?.checkpoint.archive.egressStatus).toBe('eligible');
    expect(afterAbort?.events).toEqual(beforeAbort?.events);
    expect(afterAbort?.chunks).toEqual(beforeAbort?.chunks);
    expect(await store.readOutboxOperation('abort-pending')).toMatchObject({ state: 'pending' });
    expect(await store.readOutboxOperation('abort-failed')).toMatchObject({
      state: 'failed',
      failureCode: 'network',
    });
    store.close();

    const reloaded = await openGameStore({ databaseName: name, factory, syncConfigured: true });
    const afterAbortReload = await reloaded.readGame(initial.gameId);
    expect(afterAbortReload?.checkpoint.revision).toBe(1);
    expect(afterAbortReload?.checkpoint.archive.egressStatus).toBe('eligible');
    expect(afterAbortReload?.events).toEqual(beforeAbort?.events);
    expect(afterAbortReload?.chunks).toEqual(beforeAbort?.chunks);
    expect(await reloaded.readOutboxOperation('abort-pending')).toMatchObject({ state: 'pending' });
    expect(await reloaded.readOutboxOperation('abort-failed')).toMatchObject({ state: 'failed' });
    reloaded.close();
  });

  it('rejects stale revision or ownership epoch without calling the decision hook', async () => {
    const store = await openGameStore({ databaseName: databaseName(), factory: new IDBFactory(), now: () => 100 });
    const initial = makeCheckpoint();
    await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, 'first')],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: [] }),
    });
    let decisionCalled = false;
    const stale = await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [],
      chunks: [],
      knownCredentials: [],
      decide: () => {
        decisionCalled = true;
        return { checkpoint: initial, outboxOperationIds: [] };
      },
    });
    expect(stale).toEqual({ kind: 'revision-conflict', actualRevision: 1, actualEpoch: 0 });
    expect(decisionCalled).toBe(false);
    store.close();
  });

  it('classifies an invalid archive reference as invalid data and aborts every write', async () => {
    const store = await openGameStore({ databaseName: databaseName(), factory: new IDBFactory(), now: () => 100 });
    const valid = makeCheckpoint();
    const invalid: GameCheckpointV1 = {
      ...valid,
      archive: { ...valid.archive, currentLine: { lineId: 'line-current', eventIds: ['missing-event'] } },
    };

    await expect(
      store.commitCheckpoint({
        gameId: invalid.gameId,
        expectedRevision: null,
        expectedEpoch: 0,
        events: [makeEvent(['chunk-1'])],
        chunks: [makeChunk('chunk-1', 1, 'must roll back')],
        knownCredentials: [],
        decide: () => ({ checkpoint: invalid, outboxOperationIds: ['invalid-archive-operation'] }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-data' });

    expect(await store.readGame(invalid.gameId)).toBeNull();
    expect(await store.readOutboxOperation('invalid-archive-operation')).toBeNull();
    expect((await store.status(invalid.gameId)).local).toMatchObject({ kind: 'failed', savedRevision: null });
    store.close();
  });

  it('keeps account ownership on checkpoint updates and outbox records', async () => {
    const name = databaseName();
    const factory = new IDBFactory();
    const store = await openGameStore({ databaseName: name, factory, now: () => 100 });
    const initial = { ...makeCheckpoint(), namespace: { kind: 'account' as const, accountId: 'account-uuid' } };
    await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, 'account game')],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: ['account-operation'] }),
    });

    await expect(
      store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: 1,
        expectedEpoch: 0,
        events: [],
        chunks: [],
        knownCredentials: [],
        decide: (decisionTimeMs) => ({
          checkpoint: {
            ...initial,
            namespace: { kind: 'guest' },
            revision: 2,
            positionRevision: 2,
            updatedAtMs: decisionTimeMs,
          },
          outboxOperationIds: ['guest-operation'],
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-data' });

    const reloaded = await openGameStore({ databaseName: name, factory });
    expect((await reloaded.readGame(initial.gameId))?.checkpoint.namespace).toEqual(initial.namespace);
    expect((await reloaded.readOutboxOperation('account-operation'))?.namespace).toEqual(initial.namespace);
    expect(await reloaded.readOutboxOperation('guest-operation')).toBeNull();
    store.close();
    reloaded.close();
  });

  it('rolls back checkpoint, journal, chunks, and outbox when a queued write violates idempotency', async () => {
    const store = await openGameStore({ databaseName: databaseName(), factory: new IDBFactory(), now: () => 100 });
    const initial = makeCheckpoint();
    await store.commitCheckpoint({
      gameId: initial.gameId,
      expectedRevision: null,
      expectedEpoch: 0,
      events: [makeEvent(['chunk-1'])],
      chunks: [makeChunk('chunk-1', 1, 'first')],
      knownCredentials: [],
      decide: () => ({ checkpoint: initial, outboxOperationIds: ['same-operation'] }),
    });

    const nextEvent = { ...makeEvent(['chunk-2'], 2), eventId: 'event-2' };
    const nextChunk = makeChunk('chunk-2', 2, 'second');
    await expect(
      store.commitCheckpoint({
        gameId: initial.gameId,
        expectedRevision: 1,
        expectedEpoch: 0,
        events: [nextEvent],
        chunks: [nextChunk],
        knownCredentials: [],
        decide: (decisionTimeMs) => ({
          checkpoint: { ...initial, revision: 2, positionRevision: 2, updatedAtMs: decisionTimeMs },
          outboxOperationIds: ['same-operation'],
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-data' });

    const restored = await store.readGame(initial.gameId);
    expect(restored?.checkpoint.revision).toBe(1);
    expect(restored?.events.map((event) => event.eventId)).toEqual(['event-1']);
    expect(restored?.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-1']);
    expect((await store.readOutboxOperation('same-operation'))?.checkpointRevision).toBe(1);
    store.close();
  });

  it('imports a complete versioned archive atomically and rejects a second overwrite', async () => {
    const sourceCheckpoint = makeCheckpoint();
    const sourceEvent = makeEvent(['chunk-1']);
    const sourceChunk = makeChunk('chunk-1', 1, 'import bytes: \u96ea');
    const archive = await exportGameArchive(
      { checkpoint: sourceCheckpoint, events: [sourceEvent], chunks: [sourceChunk] },
      [],
    );
    const store = await openGameStore({ databaseName: databaseName(), factory: new IDBFactory() });

    const imported = await store.importGameArchive(JSON.parse(JSON.stringify(archive)));
    expect(imported.checkpoint).toEqual(sourceCheckpoint);
    expect(new TextDecoder().decode(imported.chunks[0]?.bytes)).toBe('import bytes: \u96ea');
    expect(await store.readGame(sourceCheckpoint.gameId)).toEqual(imported);
    await expect(store.importGameArchive(archive)).rejects.toMatchObject({ code: 'revision-conflict' });
    expect((await store.readGame(sourceCheckpoint.gameId))?.checkpoint.revision).toBe(1);
    store.close();
  });

  it('reports persistent-storage support and grant status without claiming a save', async () => {
    const store = await openGameStore({ databaseName: databaseName(), factory: new IDBFactory() });
    expect(await store.requestPersistentStorage({})).toBe('unsupported');
    expect(
      await store.requestPersistentStorage({
        persist: async () => true,
        persisted: async () => true,
      }),
    ).toBe('granted');
    expect((await store.status('not-yet-saved')).local).toEqual({ kind: 'memory-only' });
    expect((await store.status('not-yet-saved')).persistentStorage).toBe('granted');
    expect(await store.requestPersistentStorage({ persist: async () => false })).toBe('denied');
    expect(await store.requestPersistentStorage({ persist: async () => Promise.reject(new Error('fixture')) })).toBe(
      'failed',
    );
    store.close();
  });

  it('reports a blocked database upgrade instead of returning a store', async () => {
    const factory = {
      open: () => {
        const request: Pick<IDBOpenDBRequest, 'onblocked'> = { onblocked: null };
        queueMicrotask(() =>
          request.onblocked?.call(request as IDBOpenDBRequest, {} as IDBVersionChangeEvent),
        );
        return request as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;

    await expect(openGameStore({ databaseName: databaseName(), factory })).rejects.toMatchObject({
      code: 'upgrade-blocked',
    });
  });
});
