import { describe, expect, it } from 'vitest';
import fixtureRaw from '../../backend/online/testdata/online-contracts.json?raw';
import {
  ONLINE_CONTRACTS_SCHEMA_VERSION,
  ONLINE_DEFAULT_RULES_POLICY_VERSION,
  ONLINE_PUBLIC_PROJECTION_SCHEMA_VERSION,
  OnlineContractError,
  parseCandidate,
  parseCommand,
  parseDeletionMarker,
  parsePublicProjection,
  parseQueueEntry,
  parseReceipt,
  parseRunnerLease,
  parseTimeoutFacts,
} from './contracts';

const fixture = JSON.parse(fixtureRaw) as {
  schemaVersion: number;
  command: unknown;
  candidate: unknown;
  timeoutFacts: unknown;
  receipt: unknown;
  publicProjection: unknown;
  queueEntry: unknown;
  runnerLease: unknown;
  deletionMarker: unknown;
};

function clone<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe('online shared contracts', () => {
  it('accepts checkmate only for the mover, with the opponent next to move', () => {
    const base = parseCandidate(fixture.candidate);
    const mate = {
      ...base,
      move: { ...base.move, seat: 'white', uci: 'h6g7', san: 'Qg7#', resultingFen: '6k1/6Q1/5K2/8/8/8/8/8 b - - 1 1' },
      result: { kind: 'win', winner: 'white', reason: 'checkmate' },
    };
    expect(parseCandidate(mate).result?.winner).toBe('white');
    expect(() => parseCandidate({ ...mate, result: { ...mate.result, winner: 'black' } })).toThrow(OnlineContractError);
    expect(() => parseCandidate({ ...mate, result: { ...mate.result, reason: 'resignation' } })).toThrow(OnlineContractError);
    expect(() => parseCandidate({ ...mate, move: { ...mate.move, resultingFen: '6k1/6Q1/5K2/8/8/8/8/8 w - - 1 1' } })).toThrow(OnlineContractError);
  });

  it('parses the shared Go/TypeScript fixture', () => {
    const command = parseCommand(fixture.command);
    expect(command.schemaVersion).toBe(ONLINE_CONTRACTS_SCHEMA_VERSION);
    expect(command.action.kind).toBe('create_match');
    if (command.action.kind === 'create_match') {
      expect(command.action.setup.timeControl.startingTimeMs).toBe(300_000);
      expect(command.action.setup.seats.white.publicLabel).toBe('Alice');
      expect(command.action.setup.seats.black.participant.id).toBe('user_b');
    }

    const candidate = parseCandidate(fixture.candidate);
    expect(candidate.evaluatedVersion).toBe(1);
    expect(candidate.move?.uci).toBe('e2e4');

    const timeout = parseTimeoutFacts(fixture.timeoutFacts);
    expect(timeout.expiredSeat).toBe('black');
    expect(timeout.winner).toBe('white');

    const receipt = parseReceipt(fixture.receipt);
    expect(receipt.outcome).toBe('accepted');
    expect(receipt.event?.kind).toBe('match_created');

    const projection = parsePublicProjection(fixture.publicProjection);
    expect(projection.schemaVersion).toBe(ONLINE_PUBLIC_PROJECTION_SCHEMA_VERSION);
    expect(projection.moves.map((move) => move.san)).toEqual(['e4']);
    expect(projection.result.winner).toBe('white');
    expect(projection.rulesPolicyVersion).toBe(ONLINE_DEFAULT_RULES_POLICY_VERSION);

    const queue = parseQueueEntry(fixture.queueEntry);
    expect(queue.status).toBe('waiting');
    expect(queue.control.kind).toBe('agent');

    const lease = parseRunnerLease(fixture.runnerLease);
    expect(lease.status).toBe('active');
    expect(lease.controlEpoch).toBe(2);

    const marker = parseDeletionMarker(fixture.deletionMarker);
    expect(marker.kind).toBe('replay_removal');
    expect(marker.matchId).toBe('match-contract-01');
  });

  it('is stable across a JSON round trip', () => {
    const first = parseCommand(fixture.command);
    const second = parseCommand(clone(first));
    expect(second).toEqual(first);
    const projection = parsePublicProjection(fixture.publicProjection);
    expect(parsePublicProjection(clone(projection))).toEqual(projection);
  });

  it('rejects unknown envelope or action fields instead of storing arbitrary state', () => {
    const command = fixture.command as Record<string, unknown>;
    expect(() => parseCommand({ ...command, sql: 'delete from online_matches' })).toThrow(OnlineContractError);
    const action = command.action as Record<string, unknown>;
    expect(() => parseCommand({ ...command, action: { ...action, state: { apiKey: 'secret' } } })).toThrow(OnlineContractError);
    expect(() => parseCommand({ ...command, action: { kind: 'resign', token: 'secret' } })).toThrow(OnlineContractError);
  });

  it('rejects unsafe or ambiguous action payloads', () => {
    const command = fixture.command as Record<string, unknown>;
    expect(() =>
      parseCommand({
        ...command,
        action: { kind: 'submit_move', move: 'E2E4' },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseCommand({
        ...command,
        action: { kind: 'set_control', control: { kind: 'agent', modelLabel: 'owner@example.com' } },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseCommand({
        ...command,
        action: {
          kind: 'create_match',
          setup: {
            variant: 'orthodox',
            startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            timeControl: { startingTimeMs: 300000, incrementMs: 0 },
            seats: {
              white: {
                participant: { kind: 'account', id: 'same-owner' },
                publicLabel: 'Alice',
                control: { kind: 'human' },
              },
              black: {
                participant: { kind: 'account', id: 'same-owner' },
                publicLabel: 'Bob',
                control: { kind: 'human' },
              },
            },
          },
        },
      }),
    ).toThrow(OnlineContractError);
  });

  it('rejects a public projection carrying private identity or route fields', () => {
    const projection = fixture.publicProjection as Record<string, unknown>;
    expect(() => parsePublicProjection({ ...projection, ownerId: 'clerk_user_secret' })).toThrow(OnlineContractError);
    expect(() => parsePublicProjection({ ...projection, providerEndpoint: 'https://private.example' })).toThrow(OnlineContractError);
    const participants = projection.participants as unknown[];
    const first = participants[0] as Record<string, unknown>;
    expect(() =>
      parsePublicProjection({
        ...projection,
        participants: [{ ...first, participant: { kind: 'account', id: 'clerk_user_secret' } }, participants[1]],
      }),
    ).toThrow(OnlineContractError);
  });

  it('rejects inconsistent terminal results and queue controls', () => {
    const receipt = fixture.receipt as Record<string, unknown>;
    expect(() =>
      parseReceipt({
        ...receipt,
        result: { kind: 'draw', winner: 'white', reason: 'agreement' },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseReceipt({
        ...receipt,
        result: { kind: 'win', winner: null, reason: 'resignation' },
      }),
    ).toThrow(OnlineContractError);
    const queue = fixture.queueEntry as Record<string, unknown>;
    expect(() =>
      parseQueueEntry({
        ...queue,
        control: { kind: 'engine', modelLabel: 'Stockfish' },
      }),
    ).toThrow(OnlineContractError);
  });

  it('rejects unsupported versions and malformed hashes', () => {
    const command = fixture.command as Record<string, unknown>;
    expect(() => parseCommand({ ...command, schemaVersion: 2 })).toThrow(OnlineContractError);
    const candidate = fixture.candidate as Record<string, unknown>;
    expect(() => parseCandidate({ ...candidate, evaluatedInputHash: 'not-a-hash' })).toThrow(OnlineContractError);
    expect(() => parseCandidate({ ...candidate, schemaVersion: 2 })).toThrow(OnlineContractError);
  });

  it('rejects a timeout adjudication for the flagged seat or unbound facts', () => {
    const facts = fixture.timeoutFacts as Record<string, unknown>;
    expect(() => parseTimeoutFacts({ ...facts, winner: 'black' })).toThrow(OnlineContractError);
    expect(() => parseTimeoutFacts({ ...facts, schemaVersion: 2 })).toThrow(OnlineContractError);
    expect(() => parseTimeoutFacts({ ...facts, evaluatedVersion: 0 })).toThrow(OnlineContractError);
    expect(() => parseTimeoutFacts({ ...facts, winner: null })).not.toThrow();
    expect(parseTimeoutFacts({ ...facts, winner: null }).winner).toBeNull();
  });
});
