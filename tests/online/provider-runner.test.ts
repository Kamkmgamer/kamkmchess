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
  parseRunnerLeaseAnswer,
  ProviderRunnerServiceError,
} from '../../src/online/provider-runner';
import type { OnlineProviderRunner } from '../../src/online/provider-runner';
import {
  createFakeOnlineService,
  createFakeProvider,
  createMemoryPendingStore,
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
    expect(service.match.result?.reason).toBe('illegal-move');
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
      runnerId: 'runner-a',
      leaseId: 'lease-1',
      requestId: 'request-1',
      controlEpoch: 3,
      turnVersion: 7,
    })).toEqual({
      schemaVersion: 2,
      action: 'begin',
      seat: 'black',
      runnerId: 'runner-a',
      leaseId: 'lease-1',
      requestId: 'request-1',
      controlEpoch: 3,
      turnVersion: 7,
    });
  });

  it('reads a lease answer of the service and refuses a lease of another match', () => {
    const lease = parseRunnerLeaseAnswer({
      schemaVersion: 2,
      leaseId: 'lease-1',
      matchId: 'match-0001',
      seat: 'white',
      controlEpoch: 2,
      generation: 3,
      runnerId: 'runner-a',
      status: 'active',
      acquiredAt: '2026-10-21T00:00:00Z',
      expiresAt: '2026-10-21T00:00:30Z',
      revokedAt: null,
      turnVersion: 9,
      runnerEpoch: 4,
      pendingRequestId: 'request-1',
      pendingRequestStartedAt: '2026-10-21T00:00:01Z',
      revokedReason: null,
      lastRenewedAt: '2026-10-21T00:00:02Z',
    }, 'match-0001', 'white');
    expect(lease.turnVersion).toBe(9);
    expect(lease.runnerEpoch).toBe(4);
    expect(lease.pendingRequestId).toBe('request-1');
    expect(() => parseRunnerLeaseAnswer({ leaseId: 'lease-1' }, 'match-0002', 'white')).toThrow(ProviderRunnerServiceError);
  });
});
