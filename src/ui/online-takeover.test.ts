import { describe, expect, it, vi } from 'vitest';
import { onlineSeatRunsAgent, onlineTakeoverPort, onlineTakeoverRoute, takeOverOnlineSeat } from './online-takeover';
import type { OnlineTakeoverPort, OnlineTakeoverSeat } from './online-takeover';
import type { AgentDecisionOutcome, OnlineComposition } from '../online/composition';
import type { SeatControl } from '../online/contracts';
import type { OnlineMatchCommandClient } from '../online/match-client';

/**
 * The takeover of a seat of the online screen (KHA-74).
 *
 * The tests prove the question the takeover of the board toolbar answers:
 * a seat the browser plays with its own agent is taken over through the
 * decision of the composition, so the runner of the seat, its lease and its
 * private binding end with the takeover. Every other seat keeps the direct
 * control change of the service.
 *
 * The screen renders through a static markup, so the callbacks of the
 * toolbar never run in a test. The tests below therefore drive the takeover
 * of the screen itself: the same function the toolbar calls, with the same
 * port, and they prove that a takeover of a managed agent seat never issues
 * a competing direct control change.
 */

/** A seat of the owner with the given control. */
function takeoverSeat(control: SeatControl | null, browserRunsAgent = false): OnlineTakeoverSeat {
  return {
    matchId: 'match-00000001',
    seat: 'white',
    control,
    version: 7,
    controlEpoch: 3,
    browserRunsAgent,
  };
}

/** A command client that records the control changes it is asked for. */
function commandClientDouble(): { readonly client: OnlineMatchCommandClient; readonly setControl: ReturnType<typeof vi.fn> } {
  const setControl = vi.fn(async () => ({ schemaVersion: 1 }) as unknown as Awaited<ReturnType<OnlineMatchCommandClient['setControl']>>);
  const client = {
    matchId: 'match-00000001',
    seat: 'white',
    expectedVersion: 1,
    setVersion: vi.fn(),
    setControlEpoch: vi.fn(),
    submit: vi.fn(),
    move: vi.fn(),
    resign: vi.fn(),
    cancel: vi.fn(),
    offerDraw: vi.fn(),
    acceptDraw: vi.fn(),
    offerTakeback: vi.fn(),
    acceptTakeback: vi.fn(),
    setControl,
  } as unknown as OnlineMatchCommandClient;
  return { client, setControl };
}

/** A port that records which path the takeover took. */
function portDouble(
  decision: AgentDecisionOutcome = { kind: 'accepted', publicModelLabel: 'Custom model' },
): {
  readonly port: OnlineTakeoverPort;
  readonly agentDecision: ReturnType<typeof vi.fn>;
  readonly commandClient: ReturnType<typeof vi.fn>;
  readonly setControl: ReturnType<typeof vi.fn>;
} {
  const agentDecision = vi.fn(async () => decision);
  const { client, setControl } = commandClientDouble();
  const commandClient = vi.fn(() => client);
  return { port: { agentDecision, commandClient }, agentDecision, commandClient, setControl };
}

describe('the takeover of a seat of the online screen', () => {
  it('takes a seat the browser plays with its own agent over through the decision of the composition', async () => {
    const { port, agentDecision, commandClient, setControl } = portDouble();
    const outcome = await takeOverOnlineSeat(
      takeoverSeat({ kind: 'agent', modelLabel: 'Custom model' }, true),
      port,
    );
    // The decision of the composition owns the takeover of the seat: it stops
    // the runner, releases the lease and drops the private binding.
    expect(agentDecision).toHaveBeenCalledTimes(1);
    expect(agentDecision).toHaveBeenCalledWith('match-00000001', 'white');
    // The browser never changes the control of the seat itself as well: a
    // second command would leave the runner and the lease of the seat alive.
    expect(commandClient).not.toHaveBeenCalled();
    expect(setControl).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'accepted', detail: 'The seat is yours.' });
  });

  it('never issues a competing control change when the service refuses the takeover', async () => {
    const { port, agentDecision, setControl } = portDouble({ kind: 'refused', detail: 'The service refused the takeover.' });
    const outcome = await takeOverOnlineSeat(
      takeoverSeat({ kind: 'agent', modelLabel: 'Custom model' }, true),
      port,
    );
    expect(agentDecision).toHaveBeenCalledTimes(1);
    expect(setControl).not.toHaveBeenCalled();
    // The refusal is reported as a refusal: the seat does not belong to the
    // owner yet.
    expect(outcome).toEqual({ kind: 'refused', detail: 'The service refused the takeover.' });
  });

  it('reports an unknown takeover honestly and changes nothing itself', async () => {
    const { port, agentDecision, setControl } = portDouble({ kind: 'unknown', detail: 'A newer decision of the owner ended the takeover.' });
    const outcome = await takeOverOnlineSeat(
      takeoverSeat({ kind: 'agent', modelLabel: 'Custom model' }, true),
      port,
    );
    expect(agentDecision).toHaveBeenCalledTimes(1);
    expect(setControl).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'unknown', detail: 'A newer decision of the owner ended the takeover.' });
  });

  it('keeps the direct control change for a seat of a human', async () => {
    const { port, agentDecision, commandClient, setControl } = portDouble();
    const outcome = await takeOverOnlineSeat(takeoverSeat({ kind: 'human' }), port);
    // A human seat has no runner of this browser, so the service changes the
    // control of the seat directly.
    expect(agentDecision).not.toHaveBeenCalled();
    expect(commandClient).toHaveBeenCalledWith('match-00000001', 'white');
    expect(setControl).toHaveBeenCalledTimes(1);
    expect(setControl).toHaveBeenCalledWith({ kind: 'human' });
    expect(outcome).toEqual({ kind: 'accepted', detail: 'The seat is yours.' });
  });

  it('keeps the direct control change for a seat of the browser engine', async () => {
    const { port, agentDecision, commandClient, setControl } = portDouble();
    const outcome = await takeOverOnlineSeat(takeoverSeat({ kind: 'engine' }), port);
    expect(agentDecision).not.toHaveBeenCalled();
    expect(commandClient).toHaveBeenCalledWith('match-00000001', 'white');
    expect(setControl).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'accepted', detail: 'The seat is yours.' });
  });

  it('keeps the direct control change for an agent seat this browser does not play', async () => {
    const { port, agentDecision, commandClient, setControl } = portDouble();
    const outcome = await takeOverOnlineSeat(
      takeoverSeat({ kind: 'agent', modelLabel: 'Custom model' }, false),
      port,
    );
    // The agent of that seat belongs to the service and to another player, so
    // the browser changes the control and touches nothing of it.
    expect(agentDecision).not.toHaveBeenCalled();
    expect(commandClient).toHaveBeenCalledWith('match-00000001', 'white');
    expect(setControl).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'accepted', detail: 'The seat is yours.' });
  });

  it('names the version and the epoch of the canonical view on the direct control change', async () => {
    const { port, setControl } = portDouble();
    const client = port.commandClient('match-00000001', 'white');
    await takeOverOnlineSeat(takeoverSeat({ kind: 'human' }), port);
    // The command names the state the service published, so a command of a
    // state the service already left is refused instead of applied.
    expect(client?.setVersion).toHaveBeenCalledWith(7);
    expect(client?.setControlEpoch).toHaveBeenCalledWith(3);
    expect(setControl).toHaveBeenCalledTimes(1);
  });

  it('refuses the takeover of a seat the browser may not control', async () => {
    const agentDecision = vi.fn(async () => ({ kind: 'accepted', publicModelLabel: 'Custom model' }) as AgentDecisionOutcome);
    const outcome = await takeOverOnlineSeat(takeoverSeat({ kind: 'human' }), {
      agentDecision,
      commandClient: () => null,
    });
    expect(agentDecision).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'refused', detail: 'The seat is not authorized.' });
  });

  it('asks the composition for the decision of the takeover and never for a command client', async () => {
    const { client, setControl } = commandClientDouble();
    const agentDecision = vi.fn(async () => ({ kind: 'accepted', publicModelLabel: 'Custom model' }) as AgentDecisionOutcome);
    const commandClient = vi.fn(() => client);
    const composition = { agentDecision, commandClient } as unknown as OnlineComposition;
    const outcome = await takeOverOnlineSeat(
      takeoverSeat({ kind: 'agent', modelLabel: 'Custom model' }, true),
      onlineTakeoverPort(composition),
    );
    // The takeover of a managed agent seat is a decision of the composition,
    // so the runner of the seat, its lease and its private binding end with
    // the decision.
    expect(agentDecision).toHaveBeenCalledTimes(1);
    expect(agentDecision).toHaveBeenCalledWith('match-00000001', 'white', 'takeover');
    // The browser never asks for the command client of the seat, so it never
    // changes the control of the seat itself as well.
    expect(commandClient).not.toHaveBeenCalled();
    expect(setControl).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'accepted', detail: 'The seat is yours.' });
  });

  it('keeps the command client of the composition for a seat without a runner', async () => {
    const { client, setControl } = commandClientDouble();
    const agentDecision = vi.fn(async () => ({ kind: 'accepted', publicModelLabel: 'Custom model' }) as AgentDecisionOutcome);
    const commandClient = vi.fn(() => client);
    const composition = { agentDecision, commandClient } as unknown as OnlineComposition;
    const outcome = await takeOverOnlineSeat(takeoverSeat({ kind: 'human' }), onlineTakeoverPort(composition));
    expect(agentDecision).not.toHaveBeenCalled();
    expect(commandClient).toHaveBeenCalledWith('match-00000001', 'white');
    expect(setControl).toHaveBeenCalledWith({ kind: 'human' });
    expect(outcome).toEqual({ kind: 'accepted', detail: 'The seat is yours.' });
  });
});

describe('the route of a takeover', () => {
  it('routes a seat the browser plays with its own agent to the decision of the composition', () => {
    expect(onlineTakeoverRoute(takeoverSeat({ kind: 'agent', modelLabel: 'Custom model' }, true))).toBe('agent-decision');
  });

  it('routes every other seat to the direct control change', () => {
    expect(onlineTakeoverRoute(takeoverSeat({ kind: 'human' }))).toBe('direct-control');
    expect(onlineTakeoverRoute(takeoverSeat({ kind: 'engine' }))).toBe('direct-control');
    expect(onlineTakeoverRoute(takeoverSeat(null))).toBe('direct-control');
    expect(onlineTakeoverRoute(takeoverSeat({ kind: 'agent', modelLabel: 'Custom model' }, false))).toBe('direct-control');
  });
});

describe('the seat the browser plays with its own agent', () => {
  it('needs an agent seat and the private selection of the owner', () => {
    // The service declares the seat as an agent seat and the browser holds
    // the private selection of it, so the browser owns the runner, the lease
    // and the binding of the seat.
    expect(onlineSeatRunsAgent({ kind: 'agent', modelLabel: 'Custom model' }, true)).toBe(true);
    // Without the private selection of the owner the browser plays no agent
    // of the seat, so the takeover keeps the direct control change.
    expect(onlineSeatRunsAgent({ kind: 'agent', modelLabel: 'Custom model' }, false)).toBe(false);
    expect(onlineSeatRunsAgent({ kind: 'human' }, true)).toBe(false);
    expect(onlineSeatRunsAgent({ kind: 'engine' }, true)).toBe(false);
    expect(onlineSeatRunsAgent(null, true)).toBe(false);
  });
});
