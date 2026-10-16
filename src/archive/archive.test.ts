import { describe, expect, it } from 'vitest';
import { exportGameArchive, validateGameArchive } from './index';
import type { ArchiveSnapshotV1 } from './types';
import type { GameCheckpointV1 } from '../storage';

function base64Text(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function checkpoint(): GameCheckpointV1 {
  return {
    schemaVersion: 1,
    gameId: 'game-1',
    namespace: { kind: 'guest' },
    revision: 7,
    ownershipEpoch: 2,
    segmentId: 'segment-1',
    positionRevision: 5,
    requestGeneration: 3,
    analysisGeneration: 1,
    updatedAtMs: 1234,
    rules: {
      variant: 'orthodox',
      startingFen: 'start-fen',
      currentFen: 'current-fen',
      sideToMove: 'white',
      castlingRights: 'KQkq',
      enPassantSquare: null,
      halfmoveClock: '0',
      fullmoveNumber: '3',
      repetitionLedger: {
        version: 1,
        positions: [{ identity: 'position-1', occurrences: '2' }],
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
          connectionRevision: 4,
          startedAtMs: 1000,
          messageIds: ['message-1'],
        },
      ],
      messages: [
        {
          messageId: 'message-1',
          segmentId: 'segment-1',
          lineId: 'line-current',
          role: 'assistant',
          content: 'A plan with \u96ea.',
          eventIds: ['event-1'],
          disposition: 'retained',
        },
      ],
    },
    clocks: {
      schemaVersion: 1,
      timeControl: { startingTimeMs: 900000, incrementMs: 10000 },
      banksAtAnchor: { whiteMs: 800000, blackMs: 780000 },
      activeSide: 'white',
      anchor: { wallTimeMs: 1200, monotonicMs: 20 },
      lastReconciledAtMs: 1200,
    },
    budgets: {
      formattingCorrectionsRemaining: 2,
      illegalMoveAttemptsRemaining: { white: 4, black: 3 },
      manualRetriesBySide: { white: 1, black: 0 },
    },
    selections: {
      players: {
        white: { kind: 'human' },
        black: {
          kind: 'model',
          providerId: 'fixture-provider',
          connectionId: 'connection-1',
          configurationRevision: 4,
          modelRoutingId: 'fixture-model',
          protocol: 'chat-completions',
          diagnostic: 'passed-current-session',
        },
      },
    },
    archive: {
      egressStatus: 'eligible',
      currentLine: { lineId: 'line-current', eventIds: ['event-1'] },
      discardedLines: [
        {
          lineId: 'line-discarded',
          eventIds: ['event-discarded'],
          discardedAtRevision: 6,
          reason: 'undo',
        },
      ],
    },
    result: { kind: 'unresolved' },
    practice: {
      mode: 'ordinary',
      scored: true,
      sourceGameId: null,
      sourcePositionFen: null,
      originalResult: null,
    },
    extensions: {
      'future-analysis': { version: 3, data: { unknownField: ['preserve', 7] } },
    },
  };
}

function archiveSnapshot(rawBytes: Uint8Array): ArchiveSnapshotV1 {
  return {
    checkpoint: checkpoint(),
    events: [
      {
        eventId: 'event-2',
        gameId: 'game-1',
        sequence: 8,
        segmentId: 'segment-1',
        kind: 'reply-received',
        occurredAtMs: 1250,
        receiveState: 'complete',
        egressStatus: 'eligible',
        payload: { unrecognized: { fields: ['keep', 'all'] } },
        chunkIds: ['chunk-2'],
      },
      {
        eventId: 'event-1',
        gameId: 'game-1',
        sequence: 4,
        segmentId: 'segment-1',
        kind: 'reply-received',
        occurredAtMs: 1100,
        receiveState: 'complete',
        egressStatus: 'eligible',
        payload: { text: '\u96ea' },
        chunkIds: ['chunk-1'],
      },
      {
        eventId: 'event-discarded',
        gameId: 'game-1',
        sequence: 6,
        segmentId: 'segment-1',
        kind: 'reply-received',
        occurredAtMs: 1180,
        receiveState: 'complete',
        egressStatus: 'eligible',
        payload: { line: 'discarded branch' },
        chunkIds: [],
      },
      {
        eventId: 'event-partial',
        gameId: 'game-1',
        sequence: 10,
        segmentId: 'segment-1',
        kind: 'reply-received',
        occurredAtMs: 1300,
        receiveState: 'partial',
        egressStatus: 'eligible',
        payload: { incomplete: true },
        chunkIds: ['chunk-3'],
      },
    ],
    chunks: [
      {
        chunkId: 'chunk-2',
        gameId: 'game-1',
        sequence: 9,
        receivedAtMs: 1250,
        isFinal: true,
        egressStatus: 'eligible',
        bytes: rawBytes,
        sha256: 'filled-by-export',
      },
      {
        chunkId: 'chunk-1',
        gameId: 'game-1',
        sequence: 5,
        receivedAtMs: 1100,
        isFinal: true,
        egressStatus: 'eligible',
        bytes: new TextEncoder().encode('{"text":"\u96ea","text":"\u4e8c","extra":"\u00df"}'),
        sha256: 'filled-by-export',
      },
      {
        chunkId: 'chunk-3',
        gameId: 'game-1',
        sequence: 11,
        receivedAtMs: 1300,
        isFinal: false,
        egressStatus: 'eligible',
        bytes: new TextEncoder().encode('truncated payload'),
        sha256: 'filled-by-export',
      },
    ],
  };
}

describe('versioned game archive export', () => {
  it('round-trips exact multibyte bytes, event order, unknown fields, and discarded lines', async () => {
    const archive = await exportGameArchive(
      archiveSnapshot(new TextEncoder().encode('reply: \u03a9 \ud83d\udc34')),
      [],
    );
    const decoded = await validateGameArchive(JSON.parse(JSON.stringify(archive)));

    expect(decoded.events.map((event) => event.sequence)).toEqual([4, 6, 8, 10]);
    expect(decoded.events[0]?.payload).toEqual({ text: '\u96ea' });
    expect(decoded.events[1]?.payload).toEqual({ line: 'discarded branch' });
    expect(decoded.events[2]?.payload).toEqual({ unrecognized: { fields: ['keep', 'all'] } });
    expect(decoded.events[3]?.receiveState).toBe('partial');
    expect(decoded.checkpoint.archive.discardedLines[0]?.eventIds).toEqual(['event-discarded']);
    expect(decoded.checkpoint.extensions['future-analysis']).toEqual({
      version: 3,
      data: { unknownField: ['preserve', 7] },
    });
    expect(base64Text(decoded.chunks[0]!.bytesBase64)).toBe('{"text":"\u96ea","text":"\u4e8c","extra":"\u00df"}');
    expect(base64Text(decoded.chunks[1]!.bytesBase64)).toBe('reply: \u03a9 \ud83d\udc34');
    expect(decoded.chunks.map((chunk) => chunk.sequence)).toEqual([5, 9, 11]);
  });

  it('preserves a shared ancestor event on current and discarded lines', async () => {
    const snapshot = archiveSnapshot(new TextEncoder().encode('shared history'));
    snapshot.checkpoint.archive.currentLine.eventIds.push('event-shared-prefix');
    snapshot.checkpoint.archive.discardedLines[0]!.eventIds.push('event-shared-prefix');
    snapshot.checkpoint.history.messages.push({
      messageId: 'message-discarded',
      segmentId: 'segment-1',
      lineId: 'line-discarded',
      role: 'assistant',
      content: 'discarded branch reply',
      eventIds: ['event-discarded', 'event-shared-prefix'],
      disposition: 'discarded',
    });
    snapshot.events.push({
      eventId: 'event-shared-prefix',
      gameId: 'game-1',
      sequence: 5,
      segmentId: 'segment-1',
      kind: 'move-accepted',
      occurredAtMs: 1150,
      receiveState: 'complete',
      egressStatus: 'eligible',
      payload: { shared: true },
      chunkIds: [],
    });

    const archive = await exportGameArchive(snapshot, []);
    const decoded = await validateGameArchive(JSON.parse(JSON.stringify(archive)));
    expect(decoded.checkpoint.archive.currentLine.eventIds).toContain('event-shared-prefix');
    expect(decoded.checkpoint.archive.discardedLines[0]?.eventIds).toContain('event-shared-prefix');
    expect(decoded.checkpoint.history.messages[1]?.eventIds).toEqual(['event-discarded', 'event-shared-prefix']);
  });

  it('rejects dangling lines, cross-line events, mismatched disposition, and duplicate line IDs', async () => {
    const create = () => archiveSnapshot(new TextEncoder().encode('line reference fixture'));
    const cases = [
      (snapshot: ArchiveSnapshotV1) => {
        snapshot.checkpoint.history.messages[0]!.lineId = 'line-missing';
      },
      (snapshot: ArchiveSnapshotV1) => {
        snapshot.checkpoint.history.messages[0]!.eventIds = ['event-discarded'];
      },
      (snapshot: ArchiveSnapshotV1) => {
        snapshot.checkpoint.history.messages[0]!.disposition = 'discarded';
      },
      (snapshot: ArchiveSnapshotV1) => {
        snapshot.checkpoint.archive.discardedLines[0]!.lineId = 'line-current';
      },
    ];
    for (const mutate of cases) {
      const snapshot = create();
      mutate(snapshot);
      await expect(exportGameArchive(snapshot, [])).rejects.toMatchObject({ code: 'invalid-archive' });
    }
  });

  it('keeps a recognized credential echo intact locally and blocks export without revealing it', async () => {
    const bytes = new TextEncoder().encode('raw provider reply contains api-key-canary-739');
    const snapshot = archiveSnapshot(bytes);

    await expect(exportGameArchive(snapshot, ['api-key-canary-739'])).rejects.toMatchObject({
      code: 'credential-echo',
      message: expect.not.stringContaining('api-key-canary-739'),
    });
    await expect(exportGameArchive(snapshot, ['api-key-canary-739'])).rejects.toThrow(
      /credential echo/i,
    );
    expect(snapshot.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    await expect(exportGameArchive(snapshot, [])).rejects.toMatchObject({ code: 'credential-echo' });
    expect(new TextDecoder().decode(snapshot.chunks[0]!.bytes)).toBe(
      'raw provider reply contains api-key-canary-739',
    );
  });

  it('quarantines recognized credential echoes in normalized history content', async () => {
    const snapshot = archiveSnapshot(new TextEncoder().encode('safe raw bytes'));
    snapshot.checkpoint.history.messages[0]!.content = 'normalized reply contains api-key-canary-739';

    await expect(exportGameArchive(snapshot, ['api-key-canary-739'])).rejects.toMatchObject({
      code: 'credential-echo',
      message: expect.not.stringContaining('api-key-canary-739'),
    });
    expect(snapshot.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(snapshot.events[0]?.egressStatus).toBe('eligible');
    await expect(exportGameArchive(snapshot, [])).rejects.toMatchObject({ code: 'credential-echo' });
    expect(new TextDecoder().decode(snapshot.chunks[0]!.bytes)).toBe('safe raw bytes');
  });

  it('quarantines credential echoes in event and chunk metadata without changing local records', async () => {
    const credential = 'api-key-canary-739';
    const exactBytes = new TextEncoder().encode('safe exact raw bytes: 雪');
    const eventSnapshot = archiveSnapshot(exactBytes);
    eventSnapshot.events.find((event) => event.eventId === 'event-1')!.kind = `reply metadata ${credential}`;

    await expect(exportGameArchive(eventSnapshot, [credential])).rejects.toMatchObject({
      code: 'credential-echo',
      message: expect.not.stringContaining(credential),
    });
    expect(eventSnapshot.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(eventSnapshot.events.find((event) => event.eventId === 'event-1')?.kind).toBe(`reply metadata ${credential}`);
    expect(eventSnapshot.events.find((event) => event.eventId === 'event-1')?.egressStatus).toBe(
      'credential-echo-quarantined',
    );
    expect(eventSnapshot.chunks.find((chunk) => chunk.chunkId === 'chunk-1')?.egressStatus).toBe(
      'credential-echo-quarantined',
    );
    expect(eventSnapshot.chunks.find((chunk) => chunk.chunkId === 'chunk-2')?.egressStatus).toBe('eligible');
    expect(eventSnapshot.chunks.find((chunk) => chunk.chunkId === 'chunk-2')?.bytes).toEqual(exactBytes);

    const chunkSnapshot = archiveSnapshot(exactBytes);
    const chunk = chunkSnapshot.chunks.find((entry) => entry.chunkId === 'chunk-2')!;
    chunk.chunkId = `chunk-metadata-${credential}`;
    chunkSnapshot.events.find((event) => event.eventId === 'event-1')!.chunkIds = [];
    await expect(exportGameArchive(chunkSnapshot, [credential])).rejects.toMatchObject({
      code: 'credential-echo',
      message: expect.not.stringContaining(credential),
    });
    expect(chunkSnapshot.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(chunkSnapshot.chunks.find((entry) => entry.chunkId === `chunk-metadata-${credential}`)?.bytes).toEqual(
      exactBytes,
    );
  });

  it('checks the complete export DTO including base64 encoded raw bytes', async () => {
    const snapshot = archiveSnapshot(new TextEncoder().encode('abc'));
    const credential = 'YWJj';

    await expect(exportGameArchive(snapshot, [credential])).rejects.toMatchObject({
      code: 'credential-echo',
      message: expect.not.stringContaining(credential),
    });
    expect(snapshot.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
    expect(snapshot.chunks.find((chunk) => chunk.chunkId === 'chunk-2')?.egressStatus).toBe(
      'credential-echo-quarantined',
    );
    expect(new TextDecoder().decode(snapshot.chunks.find((chunk) => chunk.chunkId === 'chunk-2')?.bytes)).toBe('abc');
  });

  it('rejects tampered raw-chunk digests during import validation', async () => {
    const archive = await exportGameArchive(archiveSnapshot(new TextEncoder().encode('safe')), []);
    archive.chunks[0]!.sha256 = '0'.repeat(64);

    await expect(validateGameArchive(archive)).rejects.toMatchObject({ code: 'invalid-archive' });
  });
});
