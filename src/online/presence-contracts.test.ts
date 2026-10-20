import { describe, expect, it } from 'vitest';
import {
  OnlineContractError,
  parseClaimAvailability,
  parseClaimCommand,
  parseCommand,
  parsePresenceView,
  parseRunnerLease,
  parseSeatPresence,
} from './contracts';

// The presence, claim and runner lease contracts of KHA-70, KHA-71 and
// KHA-73.
//
// The parsers are the boundary the browser trusts: a client never reads a
// field the service did not publish, and it never accepts an unknown field.

const presenceView = {
  schemaVersion: 2,
  matchId: 'match-0001',
  version: 7,
  controlEpoch: 3,
  status: 'active',
  seats: [
    {
      seat: 'white',
      state: 'connected',
      lastHeartbeatAt: '2026-10-21T10:00:00Z',
      leaseExpiresAt: '2026-10-21T10:00:15Z',
      offlineSince: null,
      keepWaitingAt: null,
    },
    {
      seat: 'black',
      state: 'offline',
      lastHeartbeatAt: '2026-10-21T09:59:00Z',
      leaseExpiresAt: '2026-10-21T09:59:15Z',
      offlineSince: '2026-10-21T09:59:15Z',
      keepWaitingAt: '2026-10-21T10:00:30Z',
    },
  ],
  serviceState: 'healthy',
  recovered: true,
  claim: {
    eligible: true,
    reason: 'eligible',
    opponentSeat: 'black',
    offlineSince: '2026-10-21T09:59:15Z',
    graceSecondsLeft: 0,
    waitingSince: '2026-10-21T10:00:30Z',
  },
  yourSeat: 'white',
};

describe('the presence view', () => {
  it('parses the allowlisted presence of both seats', () => {
    const view = parsePresenceView(presenceView);
    expect(view.matchId).toBe('match-0001');
    expect(view.seats).toHaveLength(2);
    expect(view.seats[1]?.state).toBe('offline');
    expect(view.seats[1]?.offlineSince).toBe('2026-10-21T09:59:15Z');
    expect(view.serviceState).toBe('healthy');
    expect(view.recovered).toBe(true);
    expect(view.claim.eligible).toBe(true);
    expect(view.claim.reason).toBe('eligible');
    expect(view.claim.waitingSince).toBe('2026-10-21T10:00:30Z');
    expect(view.yourSeat).toBe('white');
  });

  it('refuses an unknown field', () => {
    expect(() => parsePresenceView({ ...presenceView, participantId: 'user_1' })).toThrow(OnlineContractError);
  });

  it('refuses an unknown claim reason', () => {
    expect(() => parseClaimAvailability({ ...presenceView.claim, reason: 'because' })).toThrow(/invalid claim reason/);
  });

  it('refuses an unknown service health state', () => {
    expect(() => parsePresenceView({ ...presenceView, serviceState: 'unknown' })).toThrow(/invalid service health state/);
  });

  it('refuses an unknown presence state', () => {
    expect(() => parseSeatPresence({ seat: 'white', state: 'sleeping' })).toThrow(/invalid presence state/);
  });
});

describe('the claim command', () => {
  it('parses the closed envelope', () => {
    const command = parseClaimCommand({
      schemaVersion: 2,
      matchId: 'match-0001',
      operationId: 'operation-0001',
      expectedVersion: 7,
      seat: 'white',
      controlEpoch: 3,
    });
    expect(command.seat).toBe('white');
    expect(command.expectedVersion).toBe(7);
  });

  it('refuses an unknown field and a wrong schema version', () => {
    expect(() => parseClaimCommand({
      schemaVersion: 2,
      matchId: 'match-0001',
      operationId: 'operation-0001',
      expectedVersion: 7,
      seat: 'white',
      controlEpoch: 3,
      reason: 'abandonment',
    })).toThrow(OnlineContractError);
    expect(() => parseClaimCommand({
      schemaVersion: 1,
      matchId: 'match-0001',
      operationId: 'operation-0001',
      expectedVersion: 7,
      seat: 'white',
      controlEpoch: 3,
    })).toThrow(/unsupported schema version/);
  });
});

describe('the runner lease', () => {
  const lease = {
    schemaVersion: 2,
    leaseId: 'lease-0001',
    matchId: 'match-0001',
    seat: 'black',
    controlEpoch: 3,
    generation: 2,
    runnerId: 'runner-0001',
    status: 'active',
    acquiredAt: '2026-10-21T10:00:00Z',
    expiresAt: '2026-10-21T10:00:30Z',
    revokedAt: null,
    turnVersion: 7,
    runnerEpoch: 2,
    pendingRequestId: 'request-0001',
    pendingRequestStartedAt: '2026-10-21T10:00:10Z',
    revokedReason: null,
    lastRenewedAt: '2026-10-21T10:00:15Z',
  };

  it('parses the turn, the epoch and the uncertain request', () => {
    const parsed = parseRunnerLease(lease);
    expect(parsed.turnVersion).toBe(7);
    expect(parsed.runnerEpoch).toBe(2);
    expect(parsed.pendingRequestId).toBe('request-0001');
    expect(parsed.revokedReason).toBeNull();
  });

  it('refuses an unknown field', () => {
    expect(() => parseRunnerLease({ ...lease, credential: 'secret' })).toThrow(OnlineContractError);
  });
});

describe('the match command', () => {
  it('accepts the optional runner lease', () => {
    const command = parseCommand({
      schemaVersion: 2,
      matchId: 'match-0001',
      operationId: 'operation-0001',
      expectedVersion: 7,
      seat: 'black',
      controlEpoch: 3,
      leaseId: 'lease-0001',
      action: { kind: 'submit_move', move: 'e2e4' },
    });
    expect(command.leaseId).toBe('lease-0001');
  });

  it('accepts a command without a lease', () => {
    const command = parseCommand({
      schemaVersion: 2,
      matchId: 'match-0001',
      operationId: 'operation-0001',
      expectedVersion: 7,
      seat: 'white',
      controlEpoch: 3,
      action: { kind: 'resign' },
    });
    expect(command.leaseId).toBeUndefined();
  });

  it('refuses a malformed lease identity', () => {
    expect(() => parseCommand({
      schemaVersion: 2,
      matchId: 'match-0001',
      operationId: 'operation-0001',
      expectedVersion: 7,
      seat: 'black',
      controlEpoch: 3,
      leaseId: 'short',
      action: { kind: 'submit_move', move: 'e2e4' },
    })).toThrow(/invalid id/);
  });
});
