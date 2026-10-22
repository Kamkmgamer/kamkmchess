import { describe, expect, it } from 'vitest';

import {
  OnlineQueueError,
  QUEUE_ENTRIES_PATH,
  createQueueClient,
  isAssignedEntry,
  isExpiredEntry,
  isPendingFallbackEntry,
  parseQueueAssignment,
  queueEntryCancelPath,
  queueEntryFallbackPath,
  queueEntryHeartbeatPath,
  queueEntryKeepSearchingPath,
  queueEntryMatchPath,
  queueEntryPath,
  queueEntryReadyPath,
  queueOperationBody,
  queuePhaseOf,
} from './queue';
import type { QueueEntry } from './contracts';

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    schemaVersion: 2,
    entryId: 'qe_entry0001',
    owner: { kind: 'account', id: 'user_a' },
    control: { kind: 'agent', modelLabel: 'GPT-4o' },
    timeControl: { startingTimeMs: 300000, incrementMs: 2000 },
    status: 'waiting',
    version: 1,
    readyAt: '2026-10-21T22:00:00.000Z',
    cutoffAt: '2026-10-21T22:00:10.000Z',
    assignedMatchId: null,
    createdAt: '2026-10-21T22:00:00.000Z',
    updatedAt: '2026-10-21T22:00:00.000Z',
    ...overrides,
  };
}

/**
 * The instant the phase of an entry is read at.
 *
 * The fixture of an entry carries fixed timestamps, so the phase is read at a
 * fixed instant too. A wall clock would read the pending fallback of a
 * waiting entry as soon as the fixture grows old, and the suite would fail in
 * the future instead of at the change that broke it.
 */
const READ_AT = Date.parse('2026-10-21T21:59:00.000Z');

describe('queue routes', () => {
  it('names the queue routes of the service', () => {
    expect(QUEUE_ENTRIES_PATH).toBe('/v1/online/queue/entries');
    expect(queueEntryPath('qe_entry0001')).toBe('/v1/online/queue/entries/qe_entry0001');
    expect(queueEntryReadyPath('qe_entry0001')).toBe('/v1/online/queue/entries/qe_entry0001/ready');
    expect(queueEntryCancelPath('qe_entry0001')).toBe('/v1/online/queue/entries/qe_entry0001/cancel');
    expect(queueEntryKeepSearchingPath('qe_entry0001')).toBe('/v1/online/queue/entries/qe_entry0001/keep-searching');
    expect(queueEntryHeartbeatPath('qe_entry0001')).toBe('/v1/online/queue/entries/qe_entry0001/heartbeat');
    expect(queueEntryMatchPath('qe_entry0001')).toBe('/v1/online/queue/entries/qe_entry0001/match');
    expect(queueEntryFallbackPath('qe_entry0001')).toBe('/v1/online/queue/entries/qe_entry0001/fallback');
  });
});

describe('queue answer parsing', () => {
  it('parses a candidate assignment', () => {
    const assignment = parseQueueAssignment({
      schemaVersion: 2,
      matchId: 'm_match0001',
      seat: 'white',
      opponentLabel: 'Bob',
      control: { kind: 'agent', modelLabel: 'Claude' },
    });
    expect(assignment.seat).toBe('white');
    expect(assignment.opponentLabel).toBe('Bob');
    expect(assignment.control).toEqual({ kind: 'agent', modelLabel: 'Claude' });
    expect(assignment.guestCredential).toBeUndefined();
  });

  it('parses a fallback assignment with its engine credential', () => {
    const assignment = parseQueueAssignment({
      schemaVersion: 2,
      matchId: 'm_match0001',
      seat: 'black',
      opponentLabel: 'Stockfish 19 Lite',
      control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite' },
      guestCredential: {
        guestId: 'engine_0001',
        matchId: 'm_match0001',
        seat: 'white',
        token: 'kmgc1_secret',
        expiresAt: '2026-10-21T23:00:00.000Z',
      },
    });
    expect(assignment.guestCredential?.seat).toBe('white');
    expect(assignment.guestCredential?.token).toBe('kmgc1_secret');
  });

  it('refuses an answer with an unknown or a missing field', () => {
    expect(() =>
      parseQueueAssignment({
        schemaVersion: 2,
        matchId: 'm_match0001',
        seat: 'white',
        opponentLabel: 'Bob',
        control: { kind: 'human' },
        ownerId: 'user_b',
      }),
    ).toThrow(OnlineQueueError);
    expect(() =>
      parseQueueAssignment({
        schemaVersion: 2,
        matchId: 'm_match0001',
        seat: 'white',
        control: { kind: 'human' },
      }),
    ).toThrow(OnlineQueueError);
  });

  it('refuses a control that the service would never publish', () => {
    expect(() =>
      parseQueueAssignment({
        schemaVersion: 2,
        matchId: 'm_match0001',
        seat: 'white',
        opponentLabel: 'Bob',
        control: { kind: 'human', modelLabel: 'Claude' },
      }),
    ).toThrow(OnlineQueueError);
    expect(() =>
      parseQueueAssignment({
        schemaVersion: 2,
        matchId: 'm_match0001',
        seat: 'white',
        opponentLabel: 'Bob',
        control: { kind: 'agent' },
      }),
    ).toThrow(OnlineQueueError);
  });
});

describe('queue domain rules', () => {
  it('reads an expired entry as waiting without a ready time', () => {
    const expired = entry({ readyAt: null, cutoffAt: null });
    expect(isExpiredEntry(expired)).toBe(true);
    expect(queuePhaseOf(expired, READ_AT)).toBe('expired');
  });

  it('reads an assigned entry as assigned', () => {
    const assigned = entry({ status: 'assigned', assignedMatchId: 'm_match0001', cutoffAt: null });
    expect(isAssignedEntry(assigned)).toBe(true);
    expect(queuePhaseOf(assigned, READ_AT)).toBe('assigned');
  });

  it('reads a cancelled entry as cancelled', () => {
    expect(queuePhaseOf(entry({ status: 'cancelled', cutoffAt: null }), READ_AT)).toBe('cancelled');
  });

  it('reads a waiting entry as searching', () => {
    expect(queuePhaseOf(entry(), READ_AT)).toBe('searching');
  });

  it('reads an entry without a cutoff as searching, never as a fallback', () => {
    const kept = entry({ cutoffAt: null });
    expect(isPendingFallbackEntry(kept, READ_AT)).toBe(false);
    expect(queuePhaseOf(kept, READ_AT)).toBe('searching');
  });

  it('reads a passed cutoff as a pending fallback', () => {
    const pending = entry({ cutoffAt: '2020-01-01T00:00:00.000Z' });
    expect(isPendingFallbackEntry(pending, READ_AT)).toBe(true);
    expect(queuePhaseOf(pending, READ_AT)).toBe('pending-fallback');
  });

  it('reads the cutoff of an entry against the instant of the caller', () => {
    // The instant decides the phase, so the same entry is a search before its
    // cutoff and a pending fallback after it.
    const waiting = entry();
    expect(queuePhaseOf(waiting, Date.parse('2026-10-21T22:00:05.000Z'))).toBe('searching');
    expect(queuePhaseOf(waiting, Date.parse('2026-10-21T22:00:10.000Z'))).toBe('pending-fallback');
  });
});


describe('queue client', () => {
  function answerWith(credential: unknown) {
    return {
      schemaVersion: 2,
      matchId: 'm_match0001',
      seat: 'white',
      opponentLabel: 'Stockfish 19 Lite',
      control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite (browser)' },
      ...(credential ? { guestCredential: credential } : {}),
    };
  }

  it('calls the documented routes with the documented bodies', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const client = createQueueClient(async (request) => {
      calls.push({
        path: request.path,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (request.path.endsWith('/match')) {
        return answerWith(null);
      }
      return entry();
    });

    await client.createEntry({
      schemaVersion: 2,
      control: { kind: 'agent', modelLabel: 'GPT-4o' },
      timeControl: { startingTimeMs: 300000, incrementMs: 2000 },
      clientRequestId: 'intent-0001',
    });
    await client.ready('qe_entry0001');
    await client.cancel('qe_entry0001', { schemaVersion: 2, operationId: 'operation-0001' });
    await client.keepSearching('qe_entry0001');
    await client.heartbeat('qe_entry0001');

    expect(calls[0]?.path).toBe('/v1/online/queue/entries');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({
      schemaVersion: 2,
      control: { kind: 'agent', modelLabel: 'GPT-4o' },
      timeControl: { startingTimeMs: 300000, incrementMs: 2000 },
      clientRequestId: 'intent-0001',
    });
    expect(calls[1]?.path).toBe('/v1/online/queue/entries/qe_entry0001/ready');
    expect(calls[1]?.body).toEqual({ schemaVersion: 2 });
    expect(calls[2]?.body).toEqual({ schemaVersion: 2, operationId: 'operation-0001' });
    expect(calls[3]?.path).toBe('/v1/online/queue/entries/qe_entry0001/keep-searching');
    expect(calls[4]?.path).toBe('/v1/online/queue/entries/qe_entry0001/heartbeat');
  });

  it('keeps the credential of the browser on a routine retry', async () => {
    const calls: { body?: unknown }[] = [];
    const client = createQueueClient(async (request) => {
      calls.push({ ...(request.body === undefined ? {} : { body: request.body }) });
      return answerWith(null);
    });

    const answer = await client.fallback('qe_entry0001', { schemaVersion: 2, operationId: 'operation-0001' });

    expect(answer.guestCredential).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ schemaVersion: 2, operationId: 'operation-0001' });
  });

  it('asks for the explicit recovery when the browser holds no credential', async () => {
    const calls: { body?: unknown }[] = [];
    const client = createQueueClient(
      async (request) => {
        calls.push({ ...(request.body === undefined ? {} : { body: request.body }) });
        return answerWith(null);
      },
      { holdsEngineCredential: () => false },
    );

    const answer = await client.fallback('qe_entry0001', { schemaVersion: 2, operationId: 'operation-0001' });

    expect(answer.guestCredential).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ schemaVersion: 2, operationId: 'operation-0001', credentialRecovery: true });
  });

  it('never rotates a credential the browser still holds', async () => {
    const calls: { body?: unknown }[] = [];
    const client = createQueueClient(
      async (request) => {
        calls.push({ ...(request.body === undefined ? {} : { body: request.body }) });
        return answerWith(null);
      },
      { holdsEngineCredential: () => true },
    );

    await client.fallback('qe_entry0001', { schemaVersion: 2, operationId: 'operation-0001' });

    expect(calls).toHaveLength(1);
  });

  it('builds an operation body without an identifier', () => {
    expect(queueOperationBody()).toEqual({ schemaVersion: 2 });
    expect(queueOperationBody('operation-0001')).toEqual({ schemaVersion: 2, operationId: 'operation-0001' });
  });
});