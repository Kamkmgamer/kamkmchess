/**
 * The browser-owned online agent runner (KHA-73).
 *
 * The fixtures drive the runner through its public API with a deterministic
 * provider, a deterministic lease client and a deterministic command client.
 * The lease client speaks the exact wire of the service, so the runner is
 * exercised against the documented rules and not against a private shortcut.
 *
 * The covered acceptance cases are ARC-08 (agent runner), ARC-09 (uncertain
 * provider work), MAT-08 (clock continuity), MAT-09 (control changes) and
 * MAT-10 (retry budgets). No fixture sends a provider request and no fixture
 * needs a credential, an account or a paid request.
 */
import { describe, expect, it } from 'vitest';
import {
  createOnlineProviderRunner,
  isPublicModelLabel,
  assertSharedActionSafe,
  buildRunnerLeaseBody,
  buildRunnerRequestBody,
  composeOnlineProviderHistory,
  parseRunnerLeaseAnswer,
  providerRunnerSnapshotFromView,
  ProviderRunnerServiceError,
} from '../../src/online/provider-runner';
import type {
  OnlineProviderRunner,
  ProviderRunnerCommandPort,
  ProviderRunnerLeasePort,
} from '../../src/online/provider-runner';
import { OnlineAuthError, createGuestCredential } from '../../src/online/auth';
import type { Receipt } from '../../src/online/contracts';
import { createOnlineMatchCommandClient } from '../../src/online/match-client';
import { createAuthorizedRequester } from '../../src/online/request';
import { createParticipantSession } from '../../src/online/session';
import type { OnlineMatchView } from '../../src/online/updates';
import {
  createFakeOnlineService,
  createFakeProvider,
  createFakeTimers,
  createHoldableCommandPort,
  createHoldableLeasePort,
  createMemoryPendingStore,
  deferNextRenewal,
  fakeLeaseAnswer,
  fakeMatchView,
  fakeSnapshot,
} from '../support/online-runner';
import type { FakeOnlineService, FakeProvider } from '../support/online-runner';

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`The condition (${label}) was not reached.`);
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
}

/**
 * The command client whose acknowledgement is lost.
 *
 * The command reaches the service and is applied there, but the browser never
 * learns its receipt: the three attempts of the runner lose their
 * acknowledgement. A later attempt of the same operation is answered with the
 * receipt of the service, like the replay of the owner.
 */
function losingAcknowledgement(
  base: ProviderRunnerCommandPort,
): ProviderRunnerCommandPort & { readonly receipts: Receipt[] } {
  const receipts: Receipt[] = [];
  const attempts = new Map<string, number>();
  const port: ProviderRunnerCommandPort & { readonly receipts: Receipt[] } = {
    receipts,
    async submit(action, options) {
      const operationId = options?.operationId ?? '';
      const count = (attempts.get(operationId) ?? 0) + 1;
      attempts.set(operationId, count);
      const receipt = await base.submit(action, options);
      receipts.push(receipt);
      if (count <= 3) {
        throw new ProviderRunnerServiceError('transport', 'The acknowledgement was lost.', 0);
      }
      return receipt;
    },
    ...(base.setControlEpoch === undefined ? {} : { setControlEpoch: base.setControlEpoch.bind(base) }),
    ...(base.setVersion === undefined ? {} : { setVersion: base.setVersion.bind(base) }),
  };
  return port;
}

/**
 * The command client whose transport the test controls.
 *
 * `offline` drops the command before it reaches the service, `lost` delivers
 * the command and loses its acknowledgement, and `online` answers the command.
 * A refusal of the service is never turned into a lost acknowledgement.
 */
function switchableTransport(
  base: ProviderRunnerCommandPort,
): ProviderRunnerCommandPort & { mode(next: 'offline' | 'lost' | 'online'): void } {
  let current: 'offline' | 'lost' | 'online' = 'online';
  const port: ProviderRunnerCommandPort & { mode(next: 'offline' | 'lost' | 'online'): void } = {
    async submit(action, options) {
      if (current === 'offline') {
        throw new ProviderRunnerServiceError('transport', 'The network failed.', 0);
      }
      const receipt = await base.submit(action, options);
      if (current === 'lost') {
        throw new ProviderRunnerServiceError('transport', 'The acknowledgement was lost.', 0);
      }
      return receipt;
    },
    mode(next) {
      current = next;
    },
    ...(base.setControlEpoch === undefined ? {} : { setControlEpoch: base.setControlEpoch.bind(base) }),
    ...(base.setVersion === undefined ? {} : { setVersion: base.setVersion.bind(base) }),
  };
  return port;
}

interface Harness {
  readonly service: FakeOnlineService;
  readonly provider: FakeProvider;
  readonly runner: OnlineProviderRunner;
  readonly pending: ReturnType<typeof createMemoryPendingStore>;
}

function createHarness(options: {
  readonly runnerId?: string;
  readonly matchId?: string;
  readonly control?: { readonly kind: 'human' | 'agent' | 'engine'; readonly modelLabel?: string };
}): Harness {
  const service = createFakeOnlineService({
    ...(options.matchId === undefined ? {} : { matchId: options.matchId }),
    ...(options.control === undefined ? {} : { control: options.control }),
  });
  const provider = createFakeProvider();
  const pending = createMemoryPendingStore();
  const runner = createOnlineProviderRunner({
    matchId: service.match.matchId,
    seat: service.match.seat,
    publicModelLabel: 'Test Agent',
    leases: service.leasePort(options.runnerId ?? 'runner-a'),
    commands: service.commands,
    provider,
    pending,
    idFactory: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `request-${counter}`;
      };
    })(),
  });
  return { service, provider, runner, pending };
}

describe('the online agent runner', () => {
  it('ARC-08 takes the lease of the turn, submits one move and gives the lease back', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the move is submitted');

    // The lease route is spoken exactly: one action field, no generation field.
    const acquire = service.recordedLeaseBodies[0];
    expect(acquire).toEqual({
      schemaVersion: 2,
      action: 'acquire',
      seat: 'white',
      runnerId: 'runner-a',
      turnVersion: 1,
      controlEpoch: 1,
    });
    expect(Object.keys(acquire ?? {})).not.toContain('generation');

    // The billable request is recorded before it runs and settled after it.
    expect(service.recordedRequestBodies[0]).toMatchObject({ action: 'begin', leaseId: expect.any(String), requestId: 'request-1' });
    expect(service.recordedRequestBodies.some((body) => body.action === 'clear')).toBe(true);

    // The move carries the lease and the version of the turn.
    const command = service.recordedCommands[0];
    expect(command?.action).toEqual({ kind: 'submit_move', move: 'e2e4' });
    expect(command?.expectedVersion).toBe(1);
    expect(command?.leaseId).toBe(service.lease?.leaseId ?? command?.leaseId);
    // The operation identifier has the shape the service accepts.
    expect(command?.operationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/);

    // The lease is given back when the turn ends.
    await until(() => service.recordedLeaseBodies.some((body) => body.action === 'release'), 'the lease is released');
    expect(runner.state.phase).toBe('idle');
    expect(runner.state.lastMove).toBe('e2e4');
  });

  it('ARC-08 refuses a duplicate tab that cannot take the seat of a live runner', async () => {
    const service = createFakeOnlineService();
    const firstProvider = createFakeProvider();
    const secondProvider = createFakeProvider();
    const first = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: service.commands,
      provider: firstProvider,
      pending: createMemoryPendingStore(),
    });
    const second = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-b'),
      commands: service.commands,
      provider: secondProvider,
      pending: createMemoryPendingStore(),
    });
    const snapshot = fakeSnapshot(service.match);
    first.applySnapshot(snapshot);
    second.applySnapshot(snapshot);
    await firstProvider.waitForRequest();
    await until(() => second.state.phase === 'waiting-lease', 'the second runner stands down');

    // The second tab never asked the provider and never submitted a command.
    expect(secondProvider.prompts.length).toBe(0);
    expect(service.recordedCommands.length).toBe(0);
    expect(second.state.decisions).toEqual([]);

    firstProvider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the first runner submits');
    expect(service.recordedCommands[0]?.action).toEqual({ kind: 'submit_move', move: 'e2e4' });
  });

  it('ARC-08 runs separately requested games at the same time without an owner cap', async () => {
    const first = createHarness({ matchId: 'match-0001', runnerId: 'runner-a' });
    const second = createHarness({ matchId: 'match-0002', runnerId: 'runner-b' });
    const third = createHarness({ matchId: 'match-0003', runnerId: 'runner-c' });

    first.runner.applySnapshot(fakeSnapshot(first.service.match));
    second.runner.applySnapshot(fakeSnapshot(second.service.match));
    third.runner.applySnapshot(fakeSnapshot(third.service.match));
    await Promise.all([
      first.provider.waitForRequest(),
      second.provider.waitForRequest(),
      third.provider.waitForRequest(),
    ]);
    first.provider.answer('{"move":"e2e4"}');
    second.provider.answer('{"move":"e2e4"}');
    third.provider.answer('{"move":"d2d4"}');
    await until(
      () => first.service.recordedCommands.length === 1 && second.service.recordedCommands.length === 1 && third.service.recordedCommands.length === 1,
      'every game submits its move',
    );
    expect(first.service.recordedCommands[0]?.action).toEqual({ kind: 'submit_move', move: 'e2e4' });
    expect(third.service.recordedCommands[0]?.action).toEqual({ kind: 'submit_move', move: 'd2d4' });
    // Every game owns its own lease and its own operation identifiers.
    expect(first.service.lease?.leaseId).not.toBe(second.service.lease?.leaseId);
    expect(first.service.recordedCommands[0]?.operationId)
      .not.toBe(second.service.recordedCommands[0]?.operationId);
  });

  it('ARC-09 asks the owner when the lease is lost while a provider request runs', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The lease is fenced while the request may still be running.
    service.revokeLease('recovery');
    provider.answer('{"move":"e2e4"}');
    await until(() => runner.state.phase === 'uncertain', 'the runner asks the owner');

    // The runner never submits the answer of a lost lease and never issues a
    // second provider request by itself.
    expect(service.recordedCommands.length).toBe(0);
    expect(provider.prompts.length).toBe(1);
    expect(runner.state.uncertainty?.kind).toBe('provider-request');
    expect(runner.state.decisions).toEqual(['retry', 'switch-model', 'takeover']);

    // The owner retries on purpose. The second request is an explicit choice.
    await runner.retry();
    await until(() => provider.prompts.length === 2, 'the owner asked for a second request');
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the retry submits the move');
    expect(service.recordedCommands[0]?.action).toEqual({ kind: 'submit_move', move: 'e2e4' });
  });

  it('ARC-09 asks the owner when the previous runner left a pending request behind', async () => {
    const { service, provider, runner } = createHarness({});
    // A previous runner of the same seat left a billable request behind.
    const previous = service.leasePort('runner-old');
    const lease = await previous.acquire({ controlEpoch: 1, turnVersion: 1 });
    await previous.beginRequest({ controlEpoch: 1, turnVersion: 1, leaseId: lease.leaseId, requestId: 'request-old' });
    service.revokeLease('recovery');

    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.phase === 'uncertain', 'the runner asks the owner');
    expect(provider.prompts.length).toBe(0);
    expect(runner.state.uncertainty?.requestId).toBe('request-old');
  });

  it('ARC-09 keeps the pending request of the browser across a reload', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const pending = createMemoryPendingStore();
    pending.write({
      matchId: service.match.matchId,
      seat: service.match.seat,
      requestId: 'request-lost',
      turnVersion: 1,
      controlEpoch: 1,
      startedAt: 10,
    });
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: service.commands,
      provider,
      pending,
    });
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.phase === 'uncertain', 'the runner asks the owner');
    expect(provider.prompts.length).toBe(0);
    expect(runner.state.uncertainty?.requestId).toBe('request-lost');
  });

  it('ARC-09 recovers the original receipt after a lost acknowledgement and accepts exactly one move', async () => {
    const { service, provider, runner } = createHarness({});
    // The service accepts the move, but its acknowledgement is lost.
    service.loseNextAcknowledgement();
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 2, 'the operation is sent again');
    await until(() => runner.state.phase === 'idle', 'the turn ends');

    // The retry carries the same operation identifier, so the service answers
    // with the original receipt and no second move is accepted.
    const first = service.recordedCommands[0];
    const second = service.recordedCommands[1];
    expect(first?.operationId).toBe(second?.operationId);
    expect(service.match.version).toBe(2);
    expect(provider.prompts.length).toBe(1);
  });

  it('MAT-10 spends four illegal attempts and never counts a formatting correction as one', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    // The first answer is not a move at all, so it spends the formatting
    // budget, and the following answers are illegal moves.
    provider.answer('I would rather talk about the weather.');
    await until(() => provider.prompts.length === 2, 'the correction is requested');
    provider.answer('{"move":"e2e5"}');
    await until(() => provider.prompts.length === 3, 'the second attempt');
    provider.answer('{"move":"e2e5"}');
    await until(() => provider.prompts.length === 4, 'the third attempt');
    provider.answer('{"move":"e2e5"}');
    await until(() => provider.prompts.length === 5, 'the fourth attempt');
    provider.answer('{"move":"e2e5"}');
    await until(() => service.match.illegalAttemptsSpent === 4, 'the fourth attempt is spent');

    // The budgets are independent: one formatting correction and four illegal
    // attempts.
    expect(service.match.formatCorrectionsSpent).toBe(1);
    expect(service.match.illegalAttemptsSpent).toBe(4);
    // The service ends the match on the fourth illegal attempt. The runner
    // never concedes by itself.
    expect(service.match.result?.reason).toBe('illegal_move');
    expect(service.recordedCommands.some((command) => command.action.kind === 'resign')).toBe(false);
    await until(() => runner.state.phase === 'idle', 'the runner stops after the fourth attempt');
  });

  it('MAT-10 pauses after three formatting corrections and waits for the owner', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('no move here');
    await until(() => provider.prompts.length === 2, 'the first correction');
    provider.answer('still no move');
    await until(() => provider.prompts.length === 3, 'the second correction');
    provider.answer('still no move');
    await until(() => provider.prompts.length === 4, 'the third correction');
    provider.answer('still no move');
    await until(() => runner.state.phase === 'paused', 'the runner pauses');

    expect(service.match.formatCorrectionsSpent).toBe(3);
    expect(provider.prompts.length).toBe(4);
    expect(runner.state.decisions).toEqual(['retry', 'switch-model', 'takeover']);

    // The owner retries. The spent budget is not refilled, so the next
    // unformatted answer pauses the runner again.
    await runner.retry();
    await until(() => provider.prompts.length === 5, 'the owner asked for another request');
    provider.answer('still no move');
    await until(() => runner.state.phase === 'paused', 'the runner pauses again');
    expect(service.match.formatCorrectionsSpent).toBe(3);
  });

  it('MAT-10 never concedes the game when the provider or the transport fails', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider connection dropped.');
    await until(() => runner.state.phase === 'uncertain' || runner.state.phase === 'failed', 'the runner reports the failure');

    expect(service.recordedCommands.some((command) => command.action.kind === 'resign')).toBe(false);
    expect(service.recordedCommands.some((command) => command.action.kind === 'cancel')).toBe(false);
    expect(service.match.result).toBeNull();
    // The runner never issues a second request by itself.
    expect(provider.prompts.length).toBe(1);
  });

  it('MAT-09 drops the answer of a superseded turn instead of submitting it', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The turn changes under the runner. The pending answer is stale.
    service.opponentMove('e2e4');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.phase === 'idle', 'the stale answer is dropped');
    expect(service.recordedCommands.length).toBe(0);
    expect(runner.state.lastError).toContain('superseded');
  });

  it('MAT-09 fences the late reply of a superseded controller', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The control of the seat changes while the request runs. The old
    // controller may not submit its answer.
    service.match.controlEpoch += 1;
    service.match.control = { kind: 'human' };
    service.revokeLease('control_change');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.phase === 'idle' || runner.state.phase === 'uncertain', 'the late reply is fenced');
    expect(service.recordedCommands.length).toBe(0);
  });

  it('concedes only when the model resigns on its own', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('I resign this game.');
    await until(() => service.recordedCommands.length === 1, 'the resignation is submitted');
    expect(service.recordedCommands[0]?.action).toEqual({ kind: 'resign' });
    expect(service.match.result?.reason).toBe('resignation');
  });

  it('MAT-09 fences the old runner when the control of the seat changes', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the move is submitted');
    expect(service.recordedCommands[0]?.leaseId).toBeTruthy();

    // A takeover hands the seat to the human owner.
    await runner.takeover();
    await until(() => service.match.control.kind === 'human', 'the seat is handed over');
    expect(service.recordedCommands.some((command) => command.action.kind === 'set_control')).toBe(true);
    expect(runner.state.phase).toBe('stopped');
  });

  it('MAT-09 switches the agent of the seat on the explicit request of the owner', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the first move is submitted');

    await runner.switchModel('Second Agent');
    await until(() => service.match.control.modelLabel === 'Second Agent', 'the agent is switched');
    const control = service.recordedCommands.find((command) => command.action.kind === 'set_control');
    expect(control?.action).toEqual({ kind: 'set_control', control: { kind: 'agent', modelLabel: 'Second Agent' } });
    expect(runner.state.publicModelLabel).toBe('Second Agent');
  });

  it('MAT-08 keeps the clock and the spent budgets across a control change', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e5"}');
    await until(() => service.match.illegalAttemptsSpent === 1, 'the attempt is spent');

    // The control change advances the control epoch and the spent budget is
    // not refilled.
    await runner.switchModel('Second Agent');
    await until(() => service.match.control.modelLabel === 'Second Agent', 'the agent is switched');
    expect(service.match.illegalAttemptsSpent).toBe(1);
    expect(service.match.controlEpoch).toBe(2);
  });

  it('keeps the credential, the route and the conversation out of the shared commands', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the move is submitted');

    // The private conversation reached the provider and not the service.
    expect(provider.prompts[0]?.instructions.length).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(service.recordedCommands);
    expect(serialized).not.toContain('current-match-input');
    expect(serialized).not.toContain('Test Agent');

    // Every shared action is one of the allowed actions.
    for (const command of service.recordedCommands) {
      expect(() => assertSharedActionSafe(command.action)).not.toThrow();
    }
  });

  it('refuses a shared action that carries a route identifier or an unknown field', () => {
    expect(isPublicModelLabel('Second Agent')).toBe(true);
    expect(isPublicModelLabel('openrouter/anthropic/claude-3')).toBe(false);
    expect(isPublicModelLabel('provider:model-id')).toBe(false);
    expect(() => assertSharedActionSafe({
      kind: 'set_control',
      control: { kind: 'agent', modelLabel: 'openrouter/anthropic/claude-3' },
    })).toThrow();
    expect(() => assertSharedActionSafe({
      kind: 'submit_move',
      move: 'e2e4',
      credential: 'sk-secret',
    } as never)).toThrow();
  });

  it('builds the exact lease and request bodies of the service', () => {
    expect(buildRunnerLeaseBody({
      action: 'acquire',
      seat: 'black',
      runnerId: 'runner-a',
      controlEpoch: 3,
      turnVersion: 7,
    })).toEqual({
      schemaVersion: 2,
      action: 'acquire',
      seat: 'black',
      runnerId: 'runner-a',
      turnVersion: 7,
      controlEpoch: 3,
    });
    expect(buildRunnerLeaseBody({
      action: 'renew',
      seat: 'black',
      runnerId: 'runner-a',
      controlEpoch: 3,
      leaseId: 'lease-1',
    })).toEqual({
      schemaVersion: 2,
      action: 'renew',
      seat: 'black',
      runnerId: 'runner-a',
      leaseId: 'lease-1',
      controlEpoch: 3,
    });
    expect(buildRunnerRequestBody({
      action: 'begin',
      seat: 'black',
      runnerId: 'runner-tab-01',
      leaseId: 'lease-contract-01',
      requestId: 'request-contract-01',
      controlEpoch: 3,
      turnVersion: 7,
    })).toEqual({
      schemaVersion: 2,
      action: 'begin',
      seat: 'black',
      runnerId: 'runner-tab-01',
      leaseId: 'lease-contract-01',
      requestId: 'request-contract-01',
      controlEpoch: 3,
      turnVersion: 7,
    });
    // The envelope always carries the turn version. The service reads a
    // missing version as the turn that is current now, and the shared parser of
    // the contract requires the field.
    expect(buildRunnerRequestBody({
      action: 'clear',
      seat: 'black',
      runnerId: 'runner-tab-01',
      leaseId: 'lease-contract-01',
      requestId: 'request-contract-01',
      controlEpoch: 3,
      turnVersion: null,
    })).toEqual({
      schemaVersion: 2,
      action: 'clear',
      seat: 'black',
      runnerId: 'runner-tab-01',
      leaseId: 'lease-contract-01',
      requestId: 'request-contract-01',
      controlEpoch: 3,
      turnVersion: 0,
    });
  });

  it('reads a lease answer of the service and refuses a lease of another match', () => {
    const lease = parseRunnerLeaseAnswer({
      schemaVersion: 2,
      leaseId: 'lease-contract-01',
      matchId: 'match-contract-01',
      seat: 'white',
      controlEpoch: 2,
      generation: 3,
      runnerId: 'runner-tab-01',
      status: 'active',
      acquiredAt: '2026-10-21T00:00:00Z',
      expiresAt: '2026-10-21T00:00:30Z',
      revokedAt: null,
      turnVersion: 9,
      runnerEpoch: 4,
      pendingRequestId: 'request-contract-01',
      pendingRequestStartedAt: '2026-10-21T00:00:01Z',
      revokedReason: null,
      lastRenewedAt: '2026-10-21T00:00:02Z',
    }, 'match-contract-01', 'white');
    expect(lease.turnVersion).toBe(9);
    expect(lease.runnerEpoch).toBe(4);
    expect(lease.pendingRequestId).toBe('request-contract-01');
    expect(() => parseRunnerLeaseAnswer({
      schemaVersion: 2,
      leaseId: 'lease-contract-01',
      matchId: 'match-contract-01',
      seat: 'white',
      controlEpoch: 2,
      generation: 3,
      runnerId: 'runner-tab-01',
      status: 'active',
      acquiredAt: '2026-10-21T00:00:00Z',
      expiresAt: '2026-10-21T00:00:30Z',
      revokedAt: null,
      turnVersion: 9,
      runnerEpoch: 4,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    }, 'match-other-01', 'white')).toThrow(ProviderRunnerServiceError);
  });
});

describe('the private corrections of the prompt', () => {
  it('does not send the corrections of an earlier turn again', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // A reply with an invalid format spends one formatting correction of this
    // turn.
    provider.answer('I am not JSON at all.');
    await until(() => provider.prompts.length === 2, 'the runner asks again');
    expect(provider.prompts[0]?.corrections.length).toBe(0);
    expect(provider.prompts[1]?.corrections.length).toBe(1);

    // The turn ends with an accepted move and the opponent answers.
    provider.answer('{"move":"e2e4"}');
    await until(
      () => service.recordedCommands.some((command) => command.action.kind === 'submit_move'),
      'the move is accepted',
    );
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => provider.prompts.length === 3, 'the runner plays the next turn');

    // The correction of the earlier turn is not sent again, and the history of
    // the game is complete.
    expect(provider.prompts[2]?.corrections.length).toBe(0);
    expect(provider.prompts[2]?.budgets.formatCorrectionsSpent).toBe(0);
    expect(provider.prompts[2]?.moves).toEqual(['e4', 'e5']);
  });

  it('keeps the corrections of the same turn across a switch and a takeover', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('I am not JSON at all.');
    await until(() => provider.prompts.length === 2, 'the runner asks again');
    expect(provider.prompts[1]?.corrections.length).toBe(1);

    // A model switch does not end the turn, so the correction of the turn
    // stays in the prompt of the next request.
    await runner.switchModel('Second Agent');
    await until(() => service.match.control.modelLabel === 'Second Agent', 'the agent is switched');
    // The control of the seat changed, so the runner of the old model does
    // not play the seat any more: the private selection of the seat belongs
    // to the caller, and the caller builds the runner of the new selection.
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(provider.prompts.length).toBe(2);
    expect(runner.state.publicModelLabel).toBe('Second Agent');
  });
});

describe('the answers of a lease request in flight', () => {
  it('does not resurrect the lease when a renewal answers after the match ended', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const base = service.leasePort('runner-a');
    const renewal = deferNextRenewal(base);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: renewal.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    expect(runner.state.leaseId).not.toBeNull();

    // The heartbeat of the lease is in flight.
    renewal.defer();
    timers.fire();
    await until(() => renewal.inFlight(), 'the renewal is in flight');

    // The match ends while the renewal is in flight. The lease is given back.
    service.match.result = { kind: 'win', winner: 'black', reason: 'timeout' };
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.leaseId === null, 'the lease is given back');

    // The renewal answers now. It may not resurrect the lease, arm a
    // heartbeat or ask the provider again.
    const armsBefore = timers.arms;
    const answered = fakeLeaseAnswer(service.lease);
    renewal.answer.resolve(answered ?? {
      schemaVersion: 2,
      leaseId: 'lease-unknown',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(runner.state.leaseId).toBeNull();
    expect(timers.arms).toBe(armsBefore);
    expect(timers.armed).toHaveLength(0);
    expect(provider.prompts).toHaveLength(1);
  });

  it('does not disturb the new lease when an old renewal answers', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const base = service.leasePort('runner-a');
    const renewal = deferNextRenewal(base);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: renewal.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    const firstLease = runner.state.leaseId;
    const firstLeaseAnswer = fakeLeaseAnswer(service.lease);

    // The heartbeat of the lease is in flight.
    renewal.defer();
    timers.fire();
    await until(() => renewal.inFlight(), 'the renewal is in flight');

    // The turn ends, the lease is given back, and the next turn takes a new
    // one.
    provider.answer('{"move":"e2e4"}');
    await until(
      () => service.recordedCommands.some((command) => command.action.kind === 'submit_move'),
      'the move is accepted',
    );
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => provider.prompts.length === 2, 'the runner plays the next turn');
    const secondLease = runner.state.leaseId;
    expect(secondLease).not.toBe(firstLease);

    // The old renewal answers now with the lease it was sent for. It may not
    // overwrite the new lease and it may not arm a second heartbeat.
    const armsBefore = timers.arms;
    renewal.answer.resolve(firstLeaseAnswer ?? {
      schemaVersion: 2,
      leaseId: firstLease ?? 'lease-unknown',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(runner.state.leaseId).toBe(secondLease);
    expect(timers.arms).toBe(armsBefore);
    expect(timers.armed.length).toBeLessThanOrEqual(1);
    expect(provider.prompts).toHaveLength(2);
  });
  it('keeps a stopped runner stopped when a late answer arrives', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const base = service.leasePort('runner-a');
    const renewal = deferNextRenewal(base);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: renewal.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The renewal before the submission waits for the answer of the test.
    renewal.defer();
    provider.answer('{"move":"e2e4"}');
    await until(() => renewal.inFlight(), 'the renewal is in flight');

    // The owner stops the runner while the renewal is in flight.
    await runner.stop();
    expect(runner.state.phase).toBe('stopped');

    // The renewal answers now. It may not start the runner again.
    const answered = fakeLeaseAnswer(service.lease);
    renewal.answer.resolve(answered ?? {
      schemaVersion: 2,
      leaseId: 'lease-unknown',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(runner.state.phase).toBe('stopped');

    // A later snapshot does not start the stopped runner, and no provider
    // request is issued.
    const promptsBefore = provider.prompts.length;
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(runner.state.phase).toBe('stopped');
    expect(provider.prompts).toHaveLength(promptsBefore);
  });
});

describe('the windows of a turn that the owner interrupts', () => {
  it('keeps a stopped runner stopped when the renewal before the submit answers late', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The renewal that runs before the answer is submitted waits.
    held.holdRenew();
    const leaseAnswer = fakeLeaseAnswer(service.lease);
    provider.answer('{"move":"e2e4"}');
    await until(() => held.renews.length === 1, 'the renewal is in flight');

    // The owner stops the runner while the renewal waits.
    await runner.stop();
    expect(runner.state.phase).toBe('stopped');

    // The renewal answers now. It belongs to a lease the runner gave back.
    held.renews[0]?.resolve(leaseAnswer ?? {
      schemaVersion: 2,
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The answer changes nothing: the phase, the move and the provider.
    expect(runner.state.phase).toBe('stopped');
    expect(service.recordedCommands.some((command) => command.action.kind === 'submit_move')).toBe(false);
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(provider.prompts).toHaveLength(1);
    expect(runner.state.phase).toBe('stopped');
  });

  it('keeps a stopped runner stopped when the acquisition of the lease answers late', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
    });

    held.holdAcquire();
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => held.acquires.length === 1, 'the acquisition is in flight');

    // The owner stops the runner while the acquisition waits.
    await runner.stop();
    expect(runner.state.phase).toBe('stopped');

    // The acquisition answers now.
    held.acquires[0]?.resolve(fakeLeaseAnswer({
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    }) as never);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The answer installs no lease and changes no phase.
    expect(runner.state.phase).toBe('stopped');
    expect(runner.state.leaseId).toBeNull();
    expect(timers.armed).toHaveLength(0);

    // A later snapshot does not start the stopped runner.
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(provider.prompts).toHaveLength(0);
    expect(runner.state.phase).toBe('stopped');
  });

  it('keeps no lease and no heartbeat of a finished match when the acquisition answers late', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
    });

    held.holdAcquire();
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => held.acquires.length === 1, 'the acquisition is in flight');

    // The match ends while the acquisition waits.
    service.match.result = { kind: 'win', winner: 'black', reason: 'timeout' };
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(runner.state.phase).toBe('idle');

    // The acquisition answers now. A finished match keeps no lease and no
    // heartbeat.
    held.acquires[0]?.resolve(fakeLeaseAnswer({
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    }) as never);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(runner.state.leaseId).toBeNull();
    expect(timers.armed).toHaveLength(0);
    expect(timers.arms).toBe(0);
  });

  it('keeps a stopped runner stopped when the settlement of the request answers late', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The settlement of the request record waits.
    held.holdClear();
    provider.answer('{"move":"e2e4"}');
    await until(() => held.clears.length === 1, 'the settlement is in flight');

    // The owner stops the runner while the settlement waits.
    await runner.stop();
    expect(runner.state.phase).toBe('stopped');

    held.clears[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The answer was answered and dropped on purpose, so there is nothing
    // uncertain about it: the runner stays stopped.
    expect(runner.state.phase).toBe('stopped');
    expect(runner.state.uncertainty).toBeNull();
    expect(service.recordedCommands.some((command) => command.action.kind === 'submit_move')).toBe(false);
  });

  it('keeps the uncertainty of a stop while the record of the request answers late', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending,
      timers,
      renewIntervalMs: 5000,
    });

    // The record of the request waits for the answer of the test.
    held.holdBegin();
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => held.begins.length === 1, 'the record is in flight');
    // The owner stops the runner while the record waits. The runner opens an
    // uncertainty, because the request may still be running.
    await runner.stop();
    expect(runner.state.phase).toBe('uncertain');
    expect(runner.state.uncertainty).not.toBeNull();
    // The provider was never asked: the request is sent after the record.
    expect(provider.prompts).toHaveLength(0);

    // The record answers now. It may not start the provider again and it may
    // not close the uncertainty of the stop.
    held.begins[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(runner.state.phase).toBe('uncertain');
    expect(runner.state.uncertainty).not.toBeNull();
    expect(provider.prompts).toHaveLength(0);

    // A later snapshot does not ask the provider while the uncertainty is
    // open.
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(provider.prompts).toHaveLength(0);
    expect(runner.state.phase).toBe('uncertain');
  });

  it('does not install a lease again when the lease was lost while a renewal was in flight', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const timers = createFakeTimers();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The heartbeat of the lease waits.
    held.holdRenew();
    timers.fire();
    await until(() => held.renews.length === 1, 'the renewal is in flight');

    // The lease of the seat is lost while the renewal waits.
    service.revokeLease('recovery');
    held.renews[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The lease of the seat is gone and the runner does not hold it again.
    expect(runner.state.leaseId).not.toBe('lease-late');
    expect(runner.state.phase).not.toBe('idle');
  });
});

describe('the recovery of the owner', () => {
  it('asks the provider again after the owner retried an uncertain request', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The provider request fails. The runner opens an uncertainty and offers
    // the decision of the owner.
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    expect(runner.state.uncertainty).not.toBeNull();
    expect(runner.state.decisions).toContain('retry');
    expect(provider.prompts).toHaveLength(1);

    // The owner decides: retry. The decision settles the pending record and
    // the provider is asked again.
    await runner.retry();
    await until(() => provider.prompts.length > 1, 'the provider is asked again');
    expect(runner.state.phase).not.toBe('uncertain');
  });

  it('keeps the decision of the owner when the aborted request answers late', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The owner stops the runner while the provider request runs.
    await runner.stop();
    expect(runner.state.phase).toBe('uncertain');
    expect(runner.state.uncertainty).not.toBeNull();

    // The owner decides immediately: retry. The abort of the request arrives
    // after that decision and may not swallow it.
    await runner.retry();
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(runner.state.phase).not.toBe('stopped');
    await until(() => provider.prompts.length > 1, 'the provider is asked again');
  });

  it('never asks the provider again after a provider that answered with a failure', async () => {
    const service = createFakeOnlineService();
    const prompts: unknown[] = [];
    // A provider that answers with a failure, the way the protocol adapter
    // answers a provider that returns an error.
    const provider = {
      async run(prompt: unknown): Promise<{ answerText: string; terminal: 'failed'; uncertain: boolean }> {
        prompts.push(prompt);
        return { answerText: '', terminal: 'failed', uncertain: false };
      },
    };
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
    });
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.phase === 'failed', 'the provider failed');
    expect(prompts).toHaveLength(1);
    expect(runner.state.decisions).toContain('retry');

    // A later snapshot does not ask the provider again: the phase waits for
    // the decision of the owner.
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(prompts).toHaveLength(1);
    expect(runner.state.phase).toBe('failed');
  });
});

describe('the owner actions of the runner', () => {
  it('keeps the stop of the owner when the retry settles the pending record late', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    expect(pending.read(service.match.matchId, service.match.seat)).not.toBeNull();

    // The owner retries while the settlement of the pending record waits for
    // the service.
    held.holdClear();
    const retry = runner.retry();
    await until(() => held.clears.length === 1, 'the settlement is in flight');

    // The owner stops the runner while the settlement waits.
    await runner.stop();
    expect(runner.state.phase).toBe('stopped');

    // The settlement answers now. The decision of the owner that is older may
    // not write a phase and may not start the turn again.
    held.clears[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await retry;
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(runner.state.phase).toBe('stopped');
    expect(provider.prompts).toHaveLength(1);
  });

  it('writes nothing when the runner is disposed while the retry settles the record', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending,
    });
    const states: string[] = [];
    runner.subscribe((state) => { states.push(state.phase); });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    expect(pending.read(service.match.matchId, service.match.seat)).not.toBeNull();

    held.holdClear();
    const retry = runner.retry();
    await until(() => held.clears.length === 1, 'the settlement is in flight');

    await runner.dispose();
    const statesAtDispose = states.length;

    held.clears[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await retry;
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // Nothing is written after the dispose, the provider is not asked, and
    // the honest record of the uncertain work survives.
    expect(states.length).toBe(statesAtDispose);
    expect(provider.prompts).toHaveLength(1);
    expect(pending.read(service.match.matchId, service.match.seat)).not.toBeNull();
  });

  it('does not erase a newer pending record while an older one is settled', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    const older = pending.read(service.match.matchId, service.match.seat);
    expect(older).not.toBeNull();

    held.holdClear();
    const retry = runner.retry();
    await until(() => held.clears.length === 1, 'the settlement is in flight');

    // A newer request writes a new pending record while the older one is
    // settled. The newer record is the honest one.
    pending.write({
      matchId: service.match.matchId,
      seat: service.match.seat,
      requestId: 'request-newer',
      turnVersion: 2,
      controlEpoch: 1,
      startedAt: 99,
    });
    // The owner stops the runner, so the older decision does not continue.
    await runner.stop();

    held.clears[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await retry;
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The settlement of the older record did not erase the newer one.
    expect(pending.read(service.match.matchId, service.match.seat)?.requestId).toBe('request-newer');
    expect(runner.state.phase).toBe('stopped');
  });

  it('keeps the newest decision of the owner when two actions compete', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');

    held.holdClear();
    const retry = runner.retry();
    await until(() => held.clears.length === 1, 'the settlement is in flight');

    // The owner takes the seat over while the retry waits. The takeover is the
    // newest decision.
    await runner.takeover();
    expect(runner.state.phase).toBe('stopped');
    expect(service.match.control.kind).toBe('human');

    held.clears[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-late',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await retry;
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The takeover stands: the retry neither writes a phase nor starts the
    // turn again.
    expect(runner.state.phase).toBe('stopped');
    expect(service.match.control.kind).toBe('human');
    expect(provider.prompts).toHaveLength(1);
  });

  it('stops the runner when the credential of the seat was replaced', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const port = service.leasePort('runner-a');
    const replaced: ProviderRunnerLeasePort = {
      ...port,
      runnerId: port.runnerId,
      async acquire() {
        throw new OnlineAuthError('credential-changed', 'The credential was replaced.');
      },
    };
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: replaced,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.phase === 'stopped', 'the runner stops');
    expect(provider.prompts).toHaveLength(0);

    // The runner does not ask for the lease again on every snapshot.
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(runner.state.phase).toBe('stopped');
    expect(provider.prompts).toHaveLength(0);
  });
});

describe('the fence of the service on the commands of a runner', () => {
  it('refuses a command that presents a lease which is not live', async () => {
    const service = createFakeOnlineService();
    const lease = await service.leasePort('runner-a').acquire({ controlEpoch: 1, turnVersion: 1 });
    service.revokeLease('control_change');

    // The service fences every command that presents a lease: the lease of the
    // seat is revoked, so the command never reaches the rules of the match.
    await expect(service.commands.submit(
      { kind: 'set_control', control: { kind: 'human' } },
      { expectedVersion: service.match.version, leaseId: lease?.leaseId },
    )).rejects.toThrow(/lease/i);
    expect(service.match.control.kind).toBe('agent');
  });

  it('accepts a command without a lease as the decision of the owner', async () => {
    const service = createFakeOnlineService();

    // The handoff of the seat is the authority of the owner: the service
    // accepts a command that presents no lease.
    const receipt = await service.commands.submit(
      { kind: 'set_control', control: { kind: 'human' } },
      { expectedVersion: service.match.version },
    );
    expect(receipt.outcome).toBe('accepted');
    expect(service.match.control.kind).toBe('human');
  });
});

describe('the competing owner actions of the runner', () => {
  it('applies the newest decision of the owner when a takeover competes with a switch', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');

    // The owner switches the model and takes the seat over before the service
    // answers the first command.
    commands.arm();
    const switching = runner.switchModel('Second Agent');
    await until(() => commands.held.length === 1, 'the command of the switch is in flight');
    commands.arm();
    const taking = runner.takeover();
    await until(() => commands.held.length === 2, 'the command of the takeover is in flight');

    // The service accepts the switch first and refuses the takeover with the
    // version fence.
    await commands.release(0);
    await commands.release(1);
    const switchOutcome = await switching;
    const takeoverOutcome = await taking;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The newest decision of the owner is the takeover: the seat belongs to
    // the human owner.
    expect(switchOutcome.kind).toBe('unknown');
    expect(takeoverOutcome.kind).toBe('accepted');
    expect(service.match.control.kind).toBe('human');
    expect(runner.state.phase).toBe('stopped');
    expect(service.match.version).toBe(3);
    expect(provider.prompts).toHaveLength(1);
  });

  it('applies the newest decision of the owner when two switches compete', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');

    commands.arm();
    const first = runner.switchModel('Second Agent');
    await until(() => commands.held.length === 1, 'the first command is in flight');
    commands.arm();
    const second = runner.switchModel('Test Agent');
    await until(() => commands.held.length === 2, 'the second command is in flight');

    // The service accepts the older switch first and refuses the newer one
    // with the version fence.
    await commands.release(0);
    await commands.release(1);
    const firstOutcome = await first;
    const secondOutcome = await second;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The seat plays with the model of the newest decision of the owner.
    expect(firstOutcome.kind).toBe('unknown');
    expect(secondOutcome.kind).toBe('accepted');
    expect(service.match.control.modelLabel).toBe('Test Agent');
    expect(runner.state.publicModelLabel).toBe('Test Agent');
    expect(runner.state.phase).toBe('idle');
    expect(provider.prompts).toHaveLength(1);
  });

  it('does not clear a newer pending record when a lease is taken', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    const older = pending.read(service.match.matchId, service.match.seat);
    expect(older).not.toBeNull();

    // The decision of the owner waits for the service, and a second tab of the
    // same browser records a newer request of the same seat in the meantime.
    held.holdClear();
    const retrying = runner.retry();
    await until(() => held.clears.length === 1, 'the settlement is in flight');
    pending.write({
      matchId: service.match.matchId,
      seat: service.match.seat,
      requestId: 'request-newer',
      turnVersion: 1,
      controlEpoch: 1,
      startedAt: 99,
    });
    held.clears[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-contract-01',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await retrying;
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The acquisition of a lease does not clear the newer record.
    expect(pending.read(service.match.matchId, service.match.seat)?.requestId).toBe('request-newer');
  });

  it('asks the provider once for a turn that is dropped under the runner', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: service.commands,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');

    // The owner decides: retry. The runner asks the provider again.
    await runner.retry();
    await until(() => provider.prompts.length === 2, 'the provider is asked again');
    const second = provider.prompts[1];

    // The turn changes under the runner while the second request runs. The
    // honest record of that request stays in the store.
    service.match.positionFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    service.match.sideToMove = 'black';
    service.match.version += 1;
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The decision of the owner authorised one request. The runner does not
    // ask the provider a third time for the same turn.
    expect(provider.prompts).toHaveLength(2);
    expect(pending.read(service.match.matchId, service.match.seat)).not.toBeNull();
    expect(pending.read(service.match.matchId, service.match.seat)?.requestId).toBe(second?.requestId);
  });

  it('does not authorize or delete a newer pending record that appears while the lease is taken', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');

    // The lease of the seat is not live any more and the match moved on, so
    // the handoff of the owner takes a new lease.
    service.revokeLease('control_change');
    service.match.version += 1;
    runner.applySnapshot(fakeSnapshot(service.match));

    // The owner takes the seat over. The acquisition of the lease waits for
    // the service, and a second tab of the same browser records a newer
    // request of the same seat in the meantime.
    held.holdAcquire();
    const taking = runner.takeover();
    await until(() => held.acquires.length === 1, 'the acquisition is in flight');
    pending.write({
      matchId: service.match.matchId,
      seat: service.match.seat,
      requestId: 'request-newer',
      turnVersion: 2,
      controlEpoch: 1,
      startedAt: 99,
    });
    held.acquires[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-contract-01',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 2,
      runnerId: 'runner-tab-01',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 2,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await taking;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The newer record was not decided about, so it is neither authorized nor
    // deleted by the decision of the owner, and the handoff of the owner is
    // the decision the service applied.
    expect(pending.read(service.match.matchId, service.match.seat)?.requestId).toBe('request-newer');
    expect(service.match.control.kind).toBe('human');
  });

  it('does not send the command of a superseded decision again', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    const uncertain = pending.read(service.match.matchId, service.match.seat)?.requestId;
    expect(uncertain).toBeDefined();

    // The owner switches the model. Its command waits for the service.
    commands.arm();
    const switching = runner.switchModel('Second Agent');
    await until(() => commands.held.length === 1, 'the command of the switch is in flight');

    // The owner decides again before the first command answered.
    commands.arm();
    const taking = runner.takeover();
    await until(() => commands.held.length === 2, 'the command of the takeover is in flight');

    // The answer of the first command is a lost transport.
    commands.fail(0, new Error('The network failed.'));
    await switching;
    commands.release(1);
    await taking;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The superseded decision did not send its command again, and the newer
    // decision of the owner is the one the service applied. The takeover
    // leaves the record of the uncertain work open on purpose.
    expect(commands.held).toHaveLength(2);
    const switches = service.recordedCommands.filter((command) =>
      command.action.kind === 'set_control' &&
      command.action.control.modelLabel === 'Second Agent');
    expect(switches).toHaveLength(0);
    expect(service.match.control.kind).toBe('human');
    expect(pending.read(service.match.matchId, service.match.seat)?.requestId).toBe(uncertain);
  });

  it('ends a decision that waits when the match ends', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    const uncertain = pending.read(service.match.matchId, service.match.seat)?.requestId;

    commands.arm();
    const switching = runner.switchModel('Second Agent');
    await until(() => commands.held.length === 1, 'the command of the switch is in flight');

    // The match ends while the decision of the owner waits.
    service.match.result = { kind: 'win', winner: 'black', reason: 'timeout' };
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The command of the decision answers now. The decision may not report a
    // success of a match that is over.
    await commands.release(0);
    const outcome = await switching;
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The control of the seat is the one of the service, and the record of
    // the uncertain work survives the decision that never applied.
    expect(outcome.kind).toBe('unknown');
    expect(runner.state.leaseId).toBeNull();
    expect(service.match.control.kind).toBe('agent');
    expect(pending.read(service.match.matchId, service.match.seat)?.requestId).toBe(uncertain);
  });

  it('settles no newer record when a superseded settlement waits for the service', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    const uncertain = pending.read(service.match.matchId, service.match.seat)?.requestId;
    expect(uncertain).toBeDefined();

    // The owner retries and the settlement of the record waits for the service.
    held.holdClear();
    const retrying = runner.retry();
    await until(() => held.clears.length === 1, 'the settlement is in flight');

    // A second tab of the same browser records a newer request of the seat
    // while the settlement waits.
    pending.write({
      matchId: service.match.matchId,
      seat: service.match.seat,
      requestId: 'request-newer',
      turnVersion: 1,
      controlEpoch: 1,
      startedAt: 99,
    });

    // The owner decides again. The newer decision settles the record the
    // uncertainty named, never the newer record of the other tab.
    const switching = runner.switchModel('Second Agent');
    await until(() => service.match.control.modelLabel === 'Second Agent', 'the agent is switched');

    // The settlement of the superseded decision answers now.
    held.clears[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-contract-01',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    const retried = await retrying;
    await switching;
    await new Promise((resolve) => { setTimeout(resolve, 40); });

    // The superseded decision reports that it did not apply, the newer record
    // of the other tab survives, and the runner does not ask the provider
    // again: the newer record inherits no authorization.
    expect(retried.kind).toBe('unknown');
    expect(pending.read(service.match.matchId, service.match.seat)?.requestId).toBe('request-newer');
    expect(provider.prompts).toHaveLength(1);
  });

  it('does not send the command of a superseded decision again when the owner retries a lost command', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    // The acknowledgement of the move is lost. The runner does not learn
    // whether the service applied it, and the owner decides.
    commands.failEveryAttempt(new Error('The network failed.'));
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');

    // The owner retries. The command of the lost move is sent again with the
    // same operation identifier.
    commands.failEveryAttempt(null);
    commands.arm();
    const retrying = runner.retry();
    await until(() => commands.held.length === 1, 'the resubmission is in flight');

    // The owner decides again before the resubmission answered.
    commands.arm();
    const taking = runner.takeover();
    await until(() => commands.held.length === 2, 'the command of the takeover is in flight');

    // The resubmission is answered with a lost transport. The retry of the
    // command belongs to a decision that is no longer the newest one.
    commands.fail(0, new Error('The network failed.'));
    const retried = await retrying;
    await commands.release(1);
    await taking;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The move never reached the service after the owner decided again, and
    // the newest decision of the owner is the one that counts.
    const moves = service.recordedCommands.filter((command) => command.action.kind === 'submit_move');
    expect(moves).toHaveLength(0);
    expect(retried.kind).toBe('unknown');
    expect(service.match.control.kind).toBe('human');
  });

  it('does not send the move of a stopped runner again after a lost acknowledgement', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');

    // The move is on its way to the service when the owner stops the runner.
    commands.arm();
    await until(() => commands.held.length === 1, 'the move is in flight');
    await runner.stop();

    // The acknowledgement of the move is lost. The move belongs to a turn the
    // owner ended, so it is not sent again.
    commands.fail(0, new Error('The network failed.'));
    await new Promise((resolve) => { setTimeout(resolve, 40); });

    const moves = service.recordedCommands.filter((command) => command.action.kind === 'submit_move');
    expect(moves).toHaveLength(0);
    expect(runner.state.phase).toBe('stopped');
  });

  it('keeps the command of a newer unknown decision retriable when an older command answers late', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');

    // The owner switches the model. Its command waits for the service.
    commands.arm();
    const switching = runner.switchModel('Second Agent');
    await until(() => commands.held.length === 1, 'the command of the older switch is in flight');

    // The owner switches the model again. The acknowledgement of the newer
    // command is lost, so its outcome stays unknown and the command waits for
    // the owner.
    commands.failEveryAttempt(new Error('The network failed.'));
    const newer = await runner.switchModel('Test Agent');
    expect(newer.kind).toBe('unknown');

    // The command of the older decision answers now. It was sent before the
    // newer decision, so it may not clear the bookkeeping of the newer
    // command that is still waiting for its acknowledgement.
    commands.failEveryAttempt(null);
    await commands.release(0);
    const older = await switching;
    expect(older.kind).toBe('unknown');

    // The owner retries the unknown command.
    const retried = await runner.retry();
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The newer decision is the one the service applied, and the unknown
    // command was sent again instead of being lost.
    expect(retried.kind).toBe('accepted');
    expect(service.match.control.modelLabel).toBe('Test Agent');
    const switches = service.recordedCommands.filter((command) =>
      command.action.kind === 'set_control' &&
      command.action.control.modelLabel === 'Test Agent');
    // The replay carries the envelope of the original command first. The
    // service refuses it, because the version of the match moved on while the
    // acknowledgement was missing, so the runner sends the command again with
    // the facts it knows now. Both sends are the same operation.
    expect(switches.length).toBeGreaterThan(0);
    expect(new Set(switches.map((command) => command.operationId)).size).toBe(1);
    // The service applied the switch exactly once: the older switch and the
    // newer one moved the control epoch of the match to three.
    expect(service.match.controlEpoch).toBe(3);
  });

  it('ends the takeover when the match ends while the lease is released', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');

    // The owner takes the seat over. The release of the lease waits for the
    // service.
    held.holdRelease();
    const taking = runner.takeover();
    await until(() => held.releases.length === 1, 'the release is in flight');

    // The match ends while the decision of the owner waits.
    service.match.result = { kind: 'win', winner: 'black', reason: 'timeout' };
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The release answers now. The decision of the owner may not report a
    // success of a match that is over.
    held.releases[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-contract-01',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 1,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    const outcome = await taking;
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(outcome.kind).toBe('unknown');
    expect(runner.state.phase).not.toBe('stopped');
  });

  it('settles no pending record of the service that the owner never decided about', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const held = createHoldableLeasePort(service.leasePort('runner-a'));
    const pending = createMemoryPendingStore();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: held.port,
      commands: service.commands,
      provider,
      pending,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.fail('The provider request failed.');
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    const uncertain = pending.read(service.match.matchId, service.match.seat)?.requestId;
    expect(uncertain).toBeDefined();

    // The owner stops the runner, so the lease of the seat is given back, and
    // the owner takes the seat over. The acquisition of the lease waits for
    // the service.
    await runner.stop();
    held.holdAcquire();
    const taking = runner.takeover();
    await until(() => held.acquires.length === 1, 'the acquisition is in flight');
    expect(service.lease?.pendingRequestId).toBe(uncertain);

    // The acquisition answers now.
    held.acquires[0]?.resolve(fakeLeaseAnswer(service.lease) ?? {
      schemaVersion: 2,
      leaseId: 'lease-contract-01',
      matchId: service.match.matchId,
      seat: service.match.seat,
      controlEpoch: 1,
      generation: 2,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revokedAt: null,
      turnVersion: 1,
      runnerEpoch: 1,
      pendingRequestId: null,
      pendingRequestStartedAt: null,
      revokedReason: null,
      lastRenewedAt: null,
    });
    await taking;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The takeover settled nothing: the record of the uncertain work of the
    // service and the record of the browser stay open, and the seat belongs
    // to the owner.
    expect(service.lease?.pendingRequestId).toBe(uncertain);
    expect(pending.read(service.match.matchId, service.match.seat)?.requestId).toBe(uncertain);
    expect(service.match.control.kind).toBe('human');
  });

  it('replays the command of a newer unknown decision with its operation identifier', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    // The acknowledgement of the move is lost, so the runner holds the
    // operation identifier of the command and waits for the owner.
    commands.failEveryAttempt(new Error('The network failed.'));
    await until(() => runner.state.phase === 'uncertain', 'the uncertainty is open');
    commands.failEveryAttempt(null);

    // The owner retries. The command of the retry waits for the service.
    commands.arm();
    const retrying = runner.retry();
    await until(() => commands.held.length === 1, 'the command of the retry is in flight');

    // The owner switches the model while the retry waits. The acknowledgement
    // of the switch is lost as well, so the runner holds its operation
    // identifier for the replay.
    commands.failEveryAttempt(new Error('The network failed.'));
    const switched = await runner.switchModel('Second Agent');
    expect(switched.kind).toBe('unknown');
    commands.failEveryAttempt(null);

    // The command of the older retry answers now. Its completion is stale and
    // may not clear the bookkeeping of the newer command.
    commands.answer(0, {
      schemaVersion: 2,
      matchId: service.match.matchId,
      operationId: 'operation-retry-1',
      outcome: 'accepted',
      version: service.match.version,
      controlEpoch: service.match.controlEpoch,
      decidedAt: new Date(0).toISOString(),
    });
    await retrying;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The owner retries again. The unknown command of the switch is replayed
    // with its own operation identifier, so the service applies it once.
    const retried = await runner.retry();
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    const switches = service.recordedCommands.filter((command) => command.action.kind === 'set_control');
    expect(retried.kind).toBe('accepted');
    expect(switches).toHaveLength(1);
    expect(switches[0]?.operationId).toBe(switches[0]?.operationId);
    expect(service.match.control.modelLabel).toBe('Second Agent');
    expect(provider.prompts).toHaveLength(1);
  });

  it('fences a command that presents a lease of an older epoch or an expired lease', async () => {
    const clock = Date.now();
    const service = createFakeOnlineService({ now: () => clock });
    const lease = await service.leasePort('runner-a').acquire({ controlEpoch: 1, turnVersion: 1 });

    // The control epoch of the match moves on. The lease of the seat belongs to
    // the older epoch, so the service fences every command that presents it.
    service.commands.submit({ kind: 'set_control', control: { kind: 'agent', modelLabel: 'Test Agent' } }, {
      expectedVersion: service.match.version,
    });
    await expect(service.commands.submit(
      { kind: 'set_control', control: { kind: 'human' } },
      { expectedVersion: service.match.version, leaseId: lease?.leaseId },
    )).rejects.toThrow(/lease/i);

    // The lease of an older service epoch is fenced as well: a recovery of the
    // service advances the epoch of the service.
    const second = await service.leasePort('runner-a').acquire({ controlEpoch: 2, turnVersion: 2 });
    service.advanceServiceEpoch();
    await expect(service.commands.submit(
      { kind: 'set_control', control: { kind: 'human' } },
      { expectedVersion: service.match.version, leaseId: second?.leaseId },
    )).rejects.toThrow(/lease/i);
  });

  it('changes no lease when the receipt of a move arrives after the end of the match', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');

    // The move is on its way to the service when the match ends.
    commands.arm();
    await until(() => commands.held.length === 1, 'the move is in flight');
    service.match.result = { kind: 'win', winner: 'black', reason: 'timeout' };
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The receipt of the move arrives now. A decision of a finished match
    // installs no lease and acquires none.
    commands.answer(0, {
      schemaVersion: 2,
      matchId: service.match.matchId,
      operationId: 'operation-move-1',
      outcome: 'accepted',
      version: service.match.version,
      controlEpoch: service.match.controlEpoch,
      decidedAt: new Date(0).toISOString(),
    });
    await new Promise((resolve) => { setTimeout(resolve, 40); });

    const acquires = service.recordedLeaseBodies.filter((body) => body.action === 'acquire').length;
    // The runner holds no lease, the service revoked the lease of the seat
    // with the match, and no lease is taken again after the end of the match.
    expect(runner.state.leaseId).toBeNull();
    expect(service.lease?.status).not.toBe('active');
    expect(acquires).toBe(1);
    expect(provider.prompts).toHaveLength(1);
    expect(runner.state.phase).toBe('idle');
  });

  it('keeps the decision of the owner when the rejection of the request arrives later', async () => {
    const service = createFakeOnlineService();
    const prompts: unknown[] = [];
    const rejections: Array<(error: unknown) => void> = [];
    // A provider that ignores the abort of the runner, so the rejection of the
    // request arrives after the decision of the owner.
    const provider = {
      async run(prompt: unknown): Promise<{ answerText: string; terminal: 'complete'; uncertain: boolean }> {
        prompts.push(prompt);
        if (prompts.length === 1) {
          // The first request ignores the abort of the runner. Its rejection is
          // delivered when the test releases it, so the ordering of the
          // decision and of the failure is observable.
          return new Promise((_resolve, reject) => { rejections.push(reject); });
        }
        return { answerText: '{"move":"e2e4"}', terminal: 'complete', uncertain: false };
      },
    };
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => prompts.length === 1, 'the provider is asked');

    // The owner stops the runner and decides immediately. The rejection of the
    // request arrives after that decision.
    await runner.stop();
    expect(runner.state.phase).toBe('uncertain');
    await runner.retry();

    // The rejection of the first request arrives now.
    rejections[0]?.(new Error('The network failed.'));
    await until(() => prompts.length === 2, 'the provider is asked again');

    // The decision of the owner was not swallowed by the late rejection, the
    // new request is asked exactly once, and its answer reaches the service.
    expect(runner.state.phase).not.toBe('stopped');
    expect(runner.state.uncertainty).toBeNull();
    await until(
      () => service.recordedCommands.some((command) => command.action.kind === 'submit_move'),
      'the move of the new request is submitted',
    );
    expect(service.recordedCommands.find((command) => command.action.kind === 'submit_move')?.action)
      .toEqual({ kind: 'submit_move', move: 'e2e4' });
  });
});

describe('the envelope of a replayed command', () => {
  it('replays an applied command with its original envelope after the version, the epoch and the lease moved on', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = losingAcknowledgement(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => runner.state.phase === 'uncertain', 'the runner asks the owner');

    // The service applied the move and the browser never learned it.
    expect(service.match.moves.map((move) => move.uci)).toEqual(['e2e4']);
    const lease = runner.state.leaseId;
    expect(lease).not.toBeNull();

    // Another tab of the owner changes the control of the seat. The version of
    // the match, its control epoch and the lease of the seat move on, and the
    // browser learns the new state of the match.
    service.commands.submit(
      { kind: 'set_control', control: { kind: 'agent', modelLabel: 'Second Agent' } },
      { expectedVersion: service.match.version },
    );
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.version === 3, 'the runner knows the new version');
    expect(runner.state.controlEpoch).toBe(2);
    expect(service.lease?.status).not.toBe('active');

    // The owner retries the lost move. The replay carries the envelope of the
    // original command, so the service recognises it as the same operation and
    // answers with the original receipt instead of refusing a changed payload.
    const retried = await runner.retry();
    expect(retried.kind).toBe('accepted');

    // The service applied the move exactly once and the replay changed no
    // state of the match.
    expect(service.match.moves.map((move) => move.uci)).toEqual(['e2e4']);
    expect(service.match.version).toBe(3);

    // The replay carried the envelope of the original command: the version,
    // the epoch and the lease it was sent with.
    const replay = service.recordedCommands[service.recordedCommands.length - 1];
    expect(replay?.expectedVersion).toBe(1);
    expect(replay?.controlEpoch).toBe(1);
    expect(replay?.leaseId).toBe(lease);
    // The receipt of the replay is the original receipt of the move.
    expect(commands.receipts[commands.receipts.length - 1]?.version).toBe(2);
  });

  it('keeps the envelope and the bookkeeping of a newer command while the replay of an older command waits', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands = createHoldableCommandPort(losingAcknowledgement(service.commands));
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: commands.port,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => runner.state.phase === 'uncertain', 'the runner asks the owner');
    expect(service.match.moves.map((move) => move.uci)).toEqual(['e2e4']);

    // The owner retries the lost move. The command of the retry waits for the
    // service.
    commands.arm();
    const retrying = runner.retry();
    await until(() => commands.held.length === 1, 'the command of the retry is in flight');

    // The replay carries the envelope of the original command and not the
    // facts the runner knows in the meantime.
    const held = commands.held[0];
    expect(held?.options?.expectedVersion).toBe(1);
    expect(held?.options?.controlEpoch).toBe(1);
    expect(held?.options?.leaseId).toBe(runner.state.leaseId);

    // The opponent of the seat moves on and the browser learns the new version
    // of the match.
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.version === 3, 'the runner knows the new version');

    // The owner switches the model while the replay waits. The switch is a
    // newer command and it carries the facts the runner knows now.
    const switched = await runner.switchModel('Second Agent');
    expect(switched.kind).toBe('unknown');
    const switches = service.recordedCommands.filter((command) => command.action.kind === 'set_control');
    expect(switches.length).toBeGreaterThan(0);
    expect(switches[switches.length - 1]?.expectedVersion).toBe(3);
    expect(switches[switches.length - 1]?.leaseId).toBeUndefined();

    // The command of the older replay answers now. It is stale and it may not
    // clear the bookkeeping of the newer command.
    await commands.release(0);
    await retrying;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    // The owner retries again. The newer command is replayed with its own
    // envelope, so the service applies the switch and no second move.
    const retried = await runner.retry();
    expect(retried.kind).toBe('accepted');
    expect(service.match.control.modelLabel).toBe('Second Agent');
    // The seat moved once and the opponent of the seat moved once.
    expect(service.match.moves.filter((move) => move.seat === service.match.seat).map((move) => move.uci))
      .toEqual(['e2e4']);
    // The service applied the switch of the seat exactly once.
    expect(service.match.controlEpoch).toBe(2);
  });

  it('keeps the refreshed envelope of an owner command the service refused and never answered', async () => {
    const service = createFakeOnlineService({ sideToMove: 'black' });
    const provider = createFakeProvider();
    const transport = switchableTransport(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: transport,
      provider,
      pending: createMemoryPendingStore(),
    });

    // The seat is not to move, so the runner never asks the provider.
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(provider.prompts).toHaveLength(0);

    // The owner switches the model while the transport is down. The command
    // never reaches the service, so the service never applies it.
    transport.mode('offline');
    const switched = await runner.switchModel('Second Agent');
    expect(switched.kind).toBe('unknown');
    expect(service.recordedCommands.filter((command) => command.action.kind === 'set_control')).toHaveLength(0);

    // Another tab of the owner changes the control of the seat. The canonical
    // state of the match moves on, so the envelope of the switch is stale.
    service.commands.submit(
      { kind: 'set_control', control: { kind: 'agent', modelLabel: 'Test Agent' } },
      { expectedVersion: service.match.version },
    );
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.version === 2, 'the runner knows the new version');
    expect(runner.state.controlEpoch).toBe(2);

    // The owner retries. The replay of the original command is stale, so the
    // service refuses it. The runner sends the command again with the facts it
    // knows now, and the acknowledgement of that command is lost as well.
    transport.mode('lost');
    const retried = await runner.retry();
    expect(retried.kind).toBe('unknown');
    const switches = service.recordedCommands.filter((command) =>
      command.action.kind === 'set_control' &&
      command.action.control.modelLabel === 'Second Agent');
    // The refusal of the original envelope and the attempts of the refreshed
    // envelope are one operation.
    expect(new Set(switches.map((command) => command.operationId)).size).toBe(1);
    expect(switches.filter((command) => command.expectedVersion === 1)).toHaveLength(1);
    expect(switches.filter((command) => command.expectedVersion === 2).length).toBeGreaterThan(0);
    expect(switches[switches.length - 1]?.controlEpoch).toBe(2);
    expect(switches[switches.length - 1]?.leaseId).toBeUndefined();
    // The service applied the switch, but the browser never learned it.
    expect(service.match.control.modelLabel).toBe('Second Agent');
    expect(service.match.controlEpoch).toBe(3);

    // The owner retries again. The command is replayed with the very same
    // refreshed envelope, so the service answers with the stored receipt
    // instead of accepting the switch a second time.
    transport.mode('online');
    const again = await runner.retry();
    expect(again.kind).toBe('accepted');
    const replays = service.recordedCommands.filter((command) =>
      command.action.kind === 'set_control' &&
      command.action.control.modelLabel === 'Second Agent');
    expect(replays.length).toBe(switches.length + 1);
    expect(replays[replays.length - 1]?.operationId).toBe(replays[0]?.operationId);
    expect(replays[replays.length - 1]?.expectedVersion).toBe(2);
    expect(replays[replays.length - 1]?.controlEpoch).toBe(2);
    expect(replays[replays.length - 1]?.leaseId).toBeUndefined();
    // The switch was applied exactly once and the provider was never asked.
    expect(service.match.control.modelLabel).toBe('Second Agent');
    expect(service.match.controlEpoch).toBe(3);
    expect(provider.prompts).toHaveLength(0);
  });

  it('sends the envelope of a replayed command through the real command client', async () => {
    const matchId = 'match-00000001';
    const service = createFakeOnlineService({ matchId });
    const provider = createFakeProvider();
    const session = createParticipantSession();
    session.selectGuest(createGuestCredential({
      guestId: 'guest-1',
      matchId,
      seat: 'white',
      token: 'seat-token',
    }));
    const bodies: Array<Record<string, unknown>> = [];
    const receipts = new Map<string, { readonly body: string; readonly receipt: unknown }>();
    let lost = 3;
    // The service of the test speaks the wire of the real one: it stores the
    // receipt of an accepted operation with the body of the command and
    // answers a replay of the same operation with that receipt. A replay whose
    // body moved on is a changed payload under an accepted operation
    // identifier, and the service refuses it.
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = String(init?.body);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      bodies.push(parsed);
      const operationId = String(parsed.operationId);
      const stored = receipts.get(operationId);
      let status = 200;
      let payload: unknown;
      if (stored === undefined) {
        payload = {
          schemaVersion: 2,
          matchId,
          operationId,
          outcome: 'accepted',
          version: 2,
          controlEpoch: 1,
          decidedAt: '2026-10-21T10:00:00.000Z',
        };
        receipts.set(operationId, { body, receipt: payload });
      } else if (stored.body !== body) {
        status = 409;
        payload = {};
      } else {
        payload = stored.receipt;
      }
      if (lost > 0) {
        // The command reached the service and was applied there, but the
        // browser never learned the receipt.
        lost -= 1;
        throw new TypeError('The network failed.');
      }
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const requester = createAuthorizedRequester({
      session,
      baseUrl: 'https://api.example.test',
      fetch: fetcher as unknown as typeof fetch,
    });
    const client = createOnlineMatchCommandClient({ requester, session, matchId, seat: 'white' });
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: client,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => bodies.length === 3, 'the three attempts of the move are sent');
    await until(() => runner.state.phase === 'uncertain', 'the runner asks the owner');

    // The body carries the envelope of the command: the version, the control
    // epoch and the lease of the seat.
    expect(bodies[0]).toMatchObject({
      expectedVersion: 1,
      controlEpoch: 1,
      seat: 'white',
      leaseId: service.lease?.leaseId,
    });

    // The canonical state of the match moves on while the acknowledgement of
    // the command is missing.
    runner.applySnapshot(fakeSnapshot(service.match, { version: 2 }));
    await until(() => runner.state.version === 2, 'the runner knows the new version');

    // The owner retries the lost move. The replay travels through the real
    // client and carries the very same body, so the service recognises it as
    // the same operation and answers with the original receipt.
    const retried = await runner.retry();
    expect(retried.kind).toBe('accepted');
    expect(bodies.length).toBe(4);
    expect(bodies[3]).toEqual(bodies[0]);
  });
});

describe('the recovery of an applied control change', () => {
  it('keeps playing later turns after recovering an ordinary move receipt', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const transport = switchableTransport(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: transport,
      provider,
      pending: createMemoryPendingStore(),
    });
    transport.mode('lost');
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => runner.state.phase === 'uncertain', 'the move acknowledgement is lost');

    transport.mode('online');
    expect((await runner.retry()).kind).toBe('accepted');
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => provider.prompts.length === 2, 'the same model plays its next turn');
    await runner.stop();
  });

  it('adopts the published label and the seat epoch of a recovered switch and waits for the caller', async () => {
    const service = createFakeOnlineService({ sideToMove: 'white' });
    const provider = createFakeProvider();
    const transport = switchableTransport(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: transport,
      provider,
      pending: createMemoryPendingStore(),
    });

    // The runner plays the first move of the seat and binds the control epoch
    // of the seat.
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the move is submitted');
    expect(runner.state.boundSeatControlEpoch).toBe(1);

    // The owner switches the model while the transport is down. The command
    // never reaches the service, so the service never applies it.
    transport.mode('offline');
    const switched = await runner.switchModel('Second Agent');
    expect(switched.kind).toBe('unknown');
    expect(service.match.control.modelLabel).toBe('Test Agent');

    // The canonical state of the match moves on: the opponent moves.
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.version === 3, 'the runner knows the new version');

    // The owner retries. The original envelope is stale, the refreshed
    // envelope is applied by the service and its acknowledgement is lost.
    transport.mode('lost');
    const retried = await runner.retry();
    expect(retried.kind).toBe('unknown');
    // The service applied the switch exactly once.
    expect(service.match.control.modelLabel).toBe('Second Agent');
    expect(service.match.seatControlEpoch).toBe(2);

    // The owner retries again. The service answers with the stored receipt.
    transport.mode('online');
    const again = await runner.retry();
    expect(again.kind).toBe('accepted');
    // The outcome names the control that the receipt proves.
    if (again.kind !== 'accepted') throw new Error('The replayed switch was not accepted.');
    expect(again.control?.kind).toBe('agent');
    expect(again.control?.modelLabel).toBe('Second Agent');
    expect(again.control?.controlEpoch).toBe(2);

    // The browser learned the label the service published for the seat.
    expect(runner.state.publicModelLabel).toBe('Second Agent');
    // The browser bound the control epoch of the seat that the applied
    // command produced.
    expect(runner.state.boundSeatControlEpoch).toBe(2);
    expect(runner.state.superseded).toBe(false);

    // The runner of the old model does not play the seat any more: the
    // private selection of the seat belongs to the caller, and the caller
    // builds the runner of the new selection. The runner of the old model
    // would ask the provider with the credential of the old model.
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(provider.prompts.length).toBe(1);
  });

  it('stops the agent seat when the recovered command gave the seat to the human owner', async () => {
    const service = createFakeOnlineService({ sideToMove: 'white' });
    const provider = createFakeProvider();
    const transport = switchableTransport(service.commands);
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: transport,
      provider,
      pending: createMemoryPendingStore(),
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the move is submitted');

    // The owner takes the seat over while the transport is down.
    transport.mode('offline');
    const taken = await runner.takeover();
    expect(taken.kind).toBe('unknown');
    expect(service.match.control.kind).toBe('agent');

    // The canonical state of the match moves on.
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => runner.state.version === 3, 'the runner knows the new version');

    // The owner retries. The refreshed envelope is applied by the service and
    // its acknowledgement is lost.
    transport.mode('lost');
    const retried = await runner.retry();
    expect(retried.kind).toBe('unknown');
    expect(service.match.control.kind).toBe('human');

    // The owner retries again. The service answers with the stored receipt.
    transport.mode('online');
    const again = await runner.retry();
    expect(again.kind).toBe('accepted');
    if (again.kind !== 'accepted') throw new Error('The replayed takeover was not accepted.');
    expect(again.control?.kind).toBe('human');
    // The seat belongs to the human owner now, so the browser stops playing
    // it and asks for no provider request any more.
    expect(runner.state.phase).toBe('stopped');
    expect(runner.state.publicModelLabel).toBe('Test Agent');
    expect(provider.prompts).toHaveLength(1);
  });
});

describe('the settlement of a switch that interrupted a billable request', () => {
  it('settles the request of the old epoch with a lease of the new epoch', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    // The lease is fenced while the request may still be running, so the
    // runner asks the owner and the record of the service stays open.
    service.revokeLease('recovery');
    provider.answer('{"move":"e2e4"}');
    await until(() => runner.state.phase === 'uncertain', 'the runner asks the owner');
    const uncertain = runner.state.uncertainty?.requestId;
    expect(uncertain).toBeDefined();
    expect(service.lease?.pendingRequestId).toBe(uncertain);

    // The owner switches the model of the seat. The service accepts the change
    // and revokes the lease of the seat with it.
    const outcome = await runner.switchModel('Second Agent');
    expect(outcome.kind).toBe('accepted');

    // The request of the old epoch is settled with a lease of the new epoch:
    // the lease of the seat carries no pending request any more, so the runner
    // of the new selection may play the seat.
    expect(service.lease?.pendingRequestId).toBeNull();
    // The runner of the old selection never plays the seat again.
    expect(provider.prompts).toHaveLength(1);
  });

  it('settles no newer request of the service when the switch of the owner settles the old one', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    service.revokeLease('recovery');
    provider.answer('{"move":"e2e4"}');
    await until(() => runner.state.phase === 'uncertain', 'the runner asks the owner');
    const uncertain = runner.state.uncertainty?.requestId;
    expect(uncertain).toBeDefined();

    // Another runner of the seat recorded a newer request on the lease of the
    // seat, so the request of this runner is not the one the lease carries.
    service.setPendingRequest('request-newer');

    const outcome = await runner.switchModel('Second Agent');
    expect(outcome.kind).toBe('accepted');
    // The newer request keeps its record: the decision of the owner settled
    // exactly the request it captured.
    expect(service.lease?.pendingRequestId).toBe('request-newer');
  });
});

describe('the published model binding of the runner', () => {
  it('converts the canonical match view into the state of the runner', () => {
    const view: OnlineMatchView = {
      schemaVersion: 1,
      matchId: 'match-0001',
      variant: 'orthodox',
      startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      positionFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      timeControl: { startingTimeMs: 600000, incrementMs: 1000 },
      version: 12,
      controlEpoch: 3,
      rulesPolicyVersion: 'online-rules/1',
      status: 'active',
      result: null,
      seats: [
        {
          seat: 'white',
          publicLabel: 'Owner',
          control: { kind: 'agent', modelLabel: 'Custom model' },
          // The control epoch of the seat is the canonical epoch of the
          // controller of that seat.
          controlEpoch: 7,
          illegalAttemptsSpent: 1,
          formatCorrectionsSpent: 2,
        },
        {
          seat: 'black',
          publicLabel: 'Guest',
          control: { kind: 'human' },
          controlEpoch: 1,
          illegalAttemptsSpent: 0,
          formatCorrectionsSpent: 0,
        },
      ],
      clock: {
        whiteMs: 590000,
        blackMs: 600000,
        activeSeat: 'black',
        activeSince: '2026-10-21T00:00:00Z',
        deadlineAt: '2026-10-21T00:10:00Z',
        whiteMoved: true,
        blackMoved: false,
        turnNumber: 1,
        replySeat: null,
        replyDeadlineAt: null,
      },
      moves: [],
      pendingOffers: [],
      createdAt: '2026-10-21T00:00:00Z',
      updatedAt: '2026-10-21T00:00:10Z',
      completedAt: null,
      yourSeat: 'white',
    };

    const snapshot = providerRunnerSnapshotFromView(view, 'white');
    // The per-seat epoch, the published label and the canonical counters come
    // from the seat view of the same view.
    expect(snapshot.seatControlEpoch).toBe(7);
    expect(snapshot.seatControl.modelLabel).toBe('Custom model');
    expect(snapshot.illegalAttemptsSpent).toBe(1);
    expect(snapshot.formatCorrectionsSpent).toBe(2);
    expect(snapshot.sideToMove).toBe('black');
    expect(snapshot.version).toBe(12);
    expect(snapshot.controlEpoch).toBe(3);
    expect(snapshot.clock.incrementMs).toBe(1000);
    expect(() => providerRunnerSnapshotFromView(view, 'black')).not.toThrow();
  });

  it('plays the first move of a fresh match whose initial clock arms no seat', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
    });

    // The initial clock of a fresh match arms no seat at all, so the side to
    // move comes from the canonical position.
    const view = fakeMatchView(service.match);
    expect(view.clock.activeSeat).toBeNull();
    expect(view.clock.replySeat).toBeNull();
    const snapshot = providerRunnerSnapshotFromView(view, 'white');
    expect(snapshot.sideToMove).toBe('white');

    runner.applySnapshot(snapshot);
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(
      () => service.recordedCommands.some((command) => command.action.kind === 'submit_move'),
      'the first move is submitted',
    );
    expect(service.recordedCommands.find((command) => command.action.kind === 'submit_move')?.action)
      .toEqual({ kind: 'submit_move', move: 'e2e4' });
  });

  it('plays the first move of a custom position that starts with black', async () => {
    const service = createFakeOnlineService({
      seat: 'black',
      sideToMove: 'black',
      positionFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    });
    const provider = createFakeProvider();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
    });

    const view = fakeMatchView(service.match);
    expect(view.clock.activeSeat).toBeNull();
    const snapshot = providerRunnerSnapshotFromView(view, 'black');
    expect(snapshot.sideToMove).toBe('black');

    runner.applySnapshot(snapshot);
    await provider.waitForRequest();
    provider.answer('{"move":"c7c5"}');
    await until(
      () => service.recordedCommands.some((command) => command.action.kind === 'submit_move'),
      'the first move of the custom position is submitted',
    );
    expect(service.recordedCommands.find((command) => command.action.kind === 'submit_move')?.action)
      .toEqual({ kind: 'submit_move', move: 'c7c5' });
  });

  it('gives the provider the moves of the match in the notation of the game record', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(providerRunnerSnapshotFromView(fakeMatchView(service.match), 'white'));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(
      () => service.recordedCommands.some((command) => command.action.kind === 'submit_move'),
      'the first move is accepted',
    );
    service.opponentMove('e7e5');

    const snapshot = providerRunnerSnapshotFromView(fakeMatchView(service.match), 'white');
    // The provider reads the moves of the match in the notation of the game
    // record, exactly like the request building of the offline game.
    expect(snapshot.moves).toEqual(['e4', 'e5']);
    const prompt = {
      requestId: 'request-1',
      positionFen: snapshot.positionFen,
      startingFen: snapshot.startingFen,
      sideToMove: 'white' as const,
      moves: snapshot.moves,
      clock: snapshot.clock,
      budgets: { illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      rejectedMoves: [],
      corrections: [],
      instructions: '',
      signal: new AbortController().signal,
    };
    const history = composeOnlineProviderHistory(prompt);
    const payload = JSON.parse(history.records[0]?.text ?? '{}') as { moves?: string };
    expect(payload.moves).toBe('e4 e5');
  });

  it('keeps playing after a switch to a label the service does not publish', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the move is accepted');

    await runner.switchModel('My Private Route v2');
    await until(() => service.match.control.modelLabel === 'Custom model', 'the service publishes its own label');

    // The runner adopts the published label of the service.
    expect(runner.state.publicModelLabel).toBe('Custom model');

    // The seat still owes the move, but the runner of the old model does not
    // play it: the private selection of the seat belongs to the caller, and
    // the caller builds the runner of the new selection.
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(provider.prompts.length).toBe(1);
  });

  it('adopts the published label of the seat view of the snapshot', async () => {
    const service = createFakeOnlineService({
      control: { kind: 'agent', modelLabel: 'Custom model' },
    });
    const provider = createFakeProvider();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      // The owner declared a label the service does not publish.
      publicModelLabel: 'My Private Route v2',
      leases: service.leasePort('runner-a'),
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
    });
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    expect(runner.state.publicModelLabel).toBe('Custom model');
  });

  it('stops when another controller takes the seat', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.length === 1, 'the move is accepted');

    // Another controller takes the seat. The control epoch of the seat
    // changes, and the runner of the old controller never plays again.
    service.match.seatControlEpoch += 1;
    service.match.control = { kind: 'agent', modelLabel: 'Second Agent' };
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    expect(provider.prompts).toHaveLength(1);
    expect(runner.state.superseded).toBe(true);
    expect(runner.state.lastError).toContain('Another controller');
    expect(service.recordedCommands).toHaveLength(1);
  });
});

describe('the per turn recovery budget of the runner', () => {
  it('follows the canonical counts of the service at the turn boundary', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('I would like to play e4 in this position.');
    await until(() => provider.prompts.length === 2, 'the first correction');
    provider.answer('I would like to play e4 in this position.');
    await until(() => provider.prompts.length === 3, 'the second correction');
    provider.answer('I would like to play e4 in this position.');
    await until(() => provider.prompts.length === 4, 'the third correction');
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.some((command) => command.action.kind === 'submit_move'), 'the move is accepted');

    // The service resets the budget of the seat with the accepted move.
    expect(service.match.formatCorrectionsSpent).toBe(0);
    expect(runner.state.formatCorrectionsSpent).toBe(0);

    // The next turn starts with the full budget of the service.
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => provider.prompts.length === 5, 'the next turn starts');
    provider.answer('I would like to play e4 in this position.');
    await until(() => service.match.formatCorrectionsSpent === 1, 'the first correction of the new turn');
    expect(runner.state.formatCorrectionsSpent).toBe(1);
    expect(runner.state.phase).not.toBe('paused');
  });

  it('numbers the attempts of the current turn like the service', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e7e5"}');
    await until(() => service.match.illegalAttemptsSpent === 1, 'the first attempt is spent');
    expect(runner.state.illegalAttemptsSpent).toBe(1);
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.some((command) => command.action.kind === 'submit_move'), 'the move is accepted');

    // The next turn counts from one again.
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(() => provider.prompts.length === 3, 'the next turn starts');
    provider.answer('{"move":"e7e5"}');
    await until(() => service.match.illegalAttemptsSpent === 1, 'the attempt of the new turn is spent');
    expect(runner.state.illegalAttemptsSpent).toBe(1);
  });

  it('keeps the spent budget of the turn across a control change', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e7e5"}');
    await until(() => service.match.illegalAttemptsSpent === 1, 'the attempt is spent');

    // A control change does not end the turn, so the spent budget stays.
    await runner.switchModel('Second Agent');
    await until(() => service.match.control.modelLabel === 'Second Agent', 'the agent is switched');
    expect(service.match.illegalAttemptsSpent).toBe(1);
    expect(runner.state.illegalAttemptsSpent).toBe(1);
  });
});

describe('the heartbeat of the lease', () => {
  it('arms the next renewal after a transient failure', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const port = service.leasePort('runner-a');
    let renewals = 0;
    const failing: ProviderRunnerLeasePort = {
      ...port,
      runnerId: port.runnerId,
      async renew(input) {
        renewals += 1;
        if (renewals === 2) throw new Error('the network failed');
        return port.renew(input);
      },
    };
    const timers = createFakeTimers();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: failing,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 1000,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    expect(renewals).toBe(1);
    expect(timers.armed).toHaveLength(1);

    timers.fire();
    await until(() => renewals === 2, 'the heartbeat renewal ran');
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    // The heartbeat is armed again, so one failed renewal never ends it.
    expect(timers.armed.length).toBeGreaterThan(0);
    expect(runner.state.phase).toBe('generating');
  });

  it('fails closed when the lease is about to expire', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const port = service.leasePort('runner-a');
    let renewals = 0;
    const failing: ProviderRunnerLeasePort = {
      ...port,
      runnerId: port.runnerId,
      async renew(input) {
        renewals += 1;
        // The first renewal is the one the runner makes before the provider
        // request. The heartbeat that follows fails.
        if (renewals === 2) throw new Error('the network failed');
        return port.renew(input);
      },
    };
    const timers = createFakeTimers();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: failing,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 1000,
      // The lease of the service lives for thirty seconds. The runner is
      // close to the end of it.
      now: () => Date.now() + 29_000,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    expect(timers.armed).toHaveLength(1);

    timers.fire();
    await until(() => runner.state.phase === 'waiting-lease' || runner.state.phase === 'uncertain', 'the runner fails closed');
    expect(timers.armed).toHaveLength(0);
  });

  it('never arms a renewal behind the life of the lease', async () => {
    const clock = { at: Date.now() };
    const service = createFakeOnlineService({ now: () => clock.at });
    const provider = createFakeProvider();
    const port = service.leasePort('runner-a');
    const failing: ProviderRunnerLeasePort = {
      ...port,
      runnerId: port.runnerId,
      async renew() {
        throw new Error('the network failed');
      },
    };
    const timers = createFakeTimers();
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: failing,
      commands: service.commands,
      provider,
      pending: createMemoryPendingStore(),
      timers,
      renewIntervalMs: 5000,
      now: () => clock.at,
    });

    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The lease of the service lives for thirty seconds. Every armed renewal
    // has to happen before the lease expires and has to keep the safety
    // margin of one interval.
    const margin = 5000;
    const expiry = clock.at + 30_000;
    for (let round = 0; round < 6; round += 1) {
      if (timers.armed.length === 0) break;
      const armed = timers.armed[0];
      expect(armed?.delayMs ?? 0).toBeGreaterThan(0);
      expect((armed?.delayMs ?? 0) + clock.at).toBeLessThanOrEqual(expiry - margin);
      clock.at += armed?.delayMs ?? 0;
      timers.fire();
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }

    // The runner failed closed before the lease of the service expired, even
    // though no provider answer and no snapshot arrived.
    expect(clock.at).toBeLessThan(expiry);
    expect(runner.state.phase === 'waiting-lease' || runner.state.phase === 'uncertain').toBe(true);
    expect(timers.armed).toHaveLength(0);
  });
});

describe('the stop of the runner', () => {
  it('plays again after the owner stopped the runner', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => service.recordedCommands.some((command) => command.action.kind === 'submit_move'), 'the move is accepted');
    await until(() => runner.state.phase === 'idle', 'the turn ends');

    await runner.stop();
    expect(runner.state.phase).toBe('stopped');
    expect(runner.state.decisions).toContain('retry');

    // The owner starts the runner again and the seat is to move.
    service.opponentMove('e7e5');
    runner.applySnapshot(fakeSnapshot(service.match));
    await runner.start();
    await until(() => provider.prompts.length === 2, 'the runner plays again');
    expect(runner.state.phase).toBe('generating');
  });

  it('keeps the uncertainty of a running request when the owner stops the runner', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    await runner.stop();
    expect(runner.state.phase).toBe('uncertain');
    expect(runner.state.decisions).toContain('retry');

    // The aborted provider request settles afterwards.
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(runner.state.phase).toBe('uncertain');
    expect(runner.state.uncertainty).not.toBeNull();
    expect(runner.state.decisions).toContain('retry');
  });
});

describe('the failures of the participant boundary', () => {
  it('stops the runner when the credential was refused', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    let attempts = 0;
    const commands: ProviderRunnerCommandPort = {
      async submit() {
        attempts += 1;
        throw new OnlineAuthError('credential-cleared', 'The credential was cleared.');
      },
      setControlEpoch() {
        // The fake service owns the epoch.
      },
      setVersion() {
        // The fake service owns the version.
      },
    };
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands,
      provider,
      pending: createMemoryPendingStore(),
    });
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e2e4"}');
    await until(() => runner.state.phase === 'stopped', 'the runner stops');

    // The command is not sent again and the runner does not ask for a lease
    // on every snapshot.
    expect(attempts).toBe(1);
    expect(runner.state.lastError).toContain('credential');
    runner.applySnapshot(fakeSnapshot(service.match));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(attempts).toBe(1);
  });
});

describe('the terminal state of the match', () => {
  it('releases the lease when the match is over', async () => {
    const { service, provider, runner } = createHarness({});
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();

    // The match ends without an accepted move of the seat.
    service.match.result = { kind: 'win', winner: 'black', reason: 'timeout' };
    runner.applySnapshot(fakeSnapshot(service.match));
    await until(
      () => service.recordedLeaseBodies.some((body) => body.action === 'release'),
      'the lease is released',
    );
    expect(runner.state.phase).toBe('idle');
  });
});

describe('a fenced command of the runner', () => {
  it('reports a fenced lease as a fence and spends no attempt', async () => {
    const service = createFakeOnlineService();
    const provider = createFakeProvider();
    const commands: ProviderRunnerCommandPort = {
      async submit() {
        // The service answers a fenced lease with a missing resource.
        throw new ProviderRunnerServiceError('not-found', 'The lease does not accept a command.', 404);
      },
      setControlEpoch() {
        // The fake service owns the epoch.
      },
      setVersion() {
        // The fake service owns the version.
      },
    };
    const runner = createOnlineProviderRunner({
      matchId: service.match.matchId,
      seat: service.match.seat,
      publicModelLabel: 'Test Agent',
      leases: service.leasePort('runner-a'),
      commands,
      provider,
      pending: createMemoryPendingStore(),
    });
    runner.applySnapshot(fakeSnapshot(service.match));
    await provider.waitForRequest();
    provider.answer('{"move":"e7e5"}');
    await until(() => runner.state.phase === 'idle', 'the runner reports the fence');

    // The fence is not a rules refusal, so no attempt is spent.
    expect(runner.state.lastError).toContain('lease');
    expect(runner.state.illegalAttemptsSpent).toBe(0);
    expect(service.match.illegalAttemptsSpent).toBe(0);
  });
});
