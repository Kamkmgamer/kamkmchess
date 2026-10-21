import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildRunnerRequestEnvelope,
  OnlineContractError,
  parseRunnerRequestEnvelope,
} from '../../src/online/contracts';

// The shared wire contract of the provider request.
//
// The Go service owns the strict decoder and the shared fixture, so the
// browser reads the same fixture the service reads, emits the same body and
// refuses the same bodies.

const fixturePath = 'backend/online/testdata/online-contracts.json';

interface ContractFixture {
  readonly runnerRequest: unknown;
  readonly runnerLease: {
    readonly leaseId: string;
    readonly runnerId: string;
    readonly seat: string;
    readonly controlEpoch: number;
    readonly turnVersion: number | null;
  };
}

function loadFixture(): ContractFixture {
  const raw = readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as ContractFixture;
}

describe('the shared provider request envelope', () => {
  it('emits the body of the shared fixture', () => {
    const fixture = loadFixture();
    const lease = fixture.runnerLease;
    const emitted = buildRunnerRequestEnvelope({
      action: 'begin',
      seat: lease.seat === 'white' ? 'white' : 'black',
      runnerId: lease.runnerId,
      leaseId: lease.leaseId,
      requestId: 'request-contract-01',
      controlEpoch: lease.controlEpoch,
      turnVersion: lease.turnVersion ?? 0,
    });
    expect(emitted).toEqual(fixture.runnerRequest);
  });

  it('parses the envelope of the shared fixture', () => {
    const fixture = loadFixture();
    const envelope = parseRunnerRequestEnvelope(fixture.runnerRequest);
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.action).toBe('begin');
    expect(envelope.seat).toBe('white');
    expect(envelope.runnerId).toBe('runner-tab-01');
    expect(envelope.leaseId).toBe('lease-contract-01');
    expect(envelope.requestId).toBe('request-contract-01');
    expect(envelope.controlEpoch).toBe(2);
    expect(envelope.turnVersion).toBe(4);
  });

  it('refuses an unknown field, like the service does', () => {
    const fixture = loadFixture();
    const body = { ...(fixture.runnerRequest as Record<string, unknown>), extra: true };
    expect(() => parseRunnerRequestEnvelope(body)).toThrow(OnlineContractError);
  });

  it('refuses an unknown action, like the service does', () => {
    const fixture = loadFixture();
    const body = { ...(fixture.runnerRequest as Record<string, unknown>), action: 'cancel' };
    expect(() => parseRunnerRequestEnvelope(body)).toThrow(/invalid runner request action/);
  });

  it('refuses a wrong schema version, like the service does', () => {
    const fixture = loadFixture();
    const body = { ...(fixture.runnerRequest as Record<string, unknown>), schemaVersion: 1 };
    expect(() => parseRunnerRequestEnvelope(body)).toThrow(/unsupported schema version/);
  });

  it('refuses a blank runner or request identity, like the service does', () => {
    const fixture = loadFixture();
    const blankRunner = { ...(fixture.runnerRequest as Record<string, unknown>), runnerId: '' };
    expect(() => parseRunnerRequestEnvelope(blankRunner)).toThrow(/invalid runner identity/);
    const blankRequest = { ...(fixture.runnerRequest as Record<string, unknown>), requestId: 'bad\nidentity' };
    expect(() => parseRunnerRequestEnvelope(blankRequest)).toThrow(/invalid runner identity/);
  });
});
