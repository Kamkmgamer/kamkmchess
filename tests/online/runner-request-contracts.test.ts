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

  it('counts the identity in UTF-8 bytes, like the service does', () => {
    const fixture = loadFixture();
    // The service counts the bytes of the identity, not its characters. Sixty
    // four two-byte characters are exactly 128 bytes, the last accepted size.
    const atTheLimit = 'ü'.repeat(64);
    expect(new TextEncoder().encode(atTheLimit).length).toBe(128);
    const accepted = { ...(fixture.runnerRequest as Record<string, unknown>), runnerId: atTheLimit };
    expect(parseRunnerRequestEnvelope(accepted).runnerId).toBe(atTheLimit);
    // One byte more is refused, even though the character count is the same.
    const overTheLimit = `${atTheLimit}a`;
    expect(new TextEncoder().encode(overTheLimit).length).toBe(129);
    expect(() => parseRunnerRequestEnvelope({ ...(fixture.runnerRequest as Record<string, unknown>), runnerId: overTheLimit })).toThrow(
      /invalid runner identity/,
    );
  });

  it('refuses a control character in an identity, like the service does', () => {
    const fixture = loadFixture();
    // The service refuses the C0 controls and the delete character, and it
    // counts the code points, so a control character inside a multi-byte
    // character is refused as well.
    for (const character of ['\u0000', '\u001f', '\u007f']) {
      const body = { ...(fixture.runnerRequest as Record<string, unknown>), requestId: `request${character}identity` };
      expect(() => parseRunnerRequestEnvelope(body)).toThrow(/invalid runner identity/);
    }
  });

  it('keeps an untrimmed identity, like the service does', () => {
    const fixture = loadFixture();
    // The identity is opaque: the service never trims it, so the browser keeps
    // the spaces it was given instead of sending a different identity.
    const padded = ' runner-tab-01 ';
    const body = { ...(fixture.runnerRequest as Record<string, unknown>), runnerId: padded };
    expect(parseRunnerRequestEnvelope(body).runnerId).toBe(padded);
  });
});
