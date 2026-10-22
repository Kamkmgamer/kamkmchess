import { describe, expect, it, vi } from 'vitest';
import {
  handSeatToAgent,
  onlineAgentHandoffFeedback,
  onlineAgentHandoffPort,
  reportOnlineAgentHandoff,
} from './online-agent-handoff';
import type { OnlineAgentHandoffPort } from './online-agent-handoff';
import type { AgentDecisionOutcome, OnlineComposition } from '../online/composition';

/**
 * The hand-back of a seat to the agent of the owner (KHA-74).
 *
 * The tests prove the question the hand-back of the board toolbar answers: the
 * seat goes back to the agent through the decision of the composition, and the
 * screen never claims a seat the agent does not play.
 *
 * The screen renders through a static markup, so the callbacks of the toolbar
 * never run in a test. The tests below therefore drive the hand-back of the
 * screen itself: the same function the toolbar calls, with the same port.
 */

/** A port that records the decision of the composition. */
function portDouble(
  decision: AgentDecisionOutcome = { kind: 'accepted', publicModelLabel: 'Custom model' },
): { readonly port: OnlineAgentHandoffPort; readonly handToAgent: ReturnType<typeof vi.fn> } {
  const handToAgent = vi.fn(async () => decision);
  return { port: { handToAgent }, handToAgent };
}

describe('the hand-back of a seat of the online screen', () => {
  it('hands the seat to the agent through the decision of the composition', async () => {
    const { port, handToAgent } = portDouble();
    const outcome = await handSeatToAgent({ matchId: 'match-00000001', seat: 'white' }, port);
    expect(handToAgent).toHaveBeenCalledWith('match-00000001', 'white');
    expect(outcome.kind).toBe('accepted');
    // The screen names the public label of the seat and nothing else: no
    // routing identity and no credential of the model reaches the screen.
    expect(outcome.detail).toBe('The seat plays Custom model now.');
  });

  it('shows a refused hand-back as a visible failure and claims nothing', async () => {
    const { port } = portDouble({
      kind: 'refused',
      detail: 'The owner has no connected agent for this seat. Connect a model and hand the seat over again.',
    });
    const outcome = await handSeatToAgent({ matchId: 'match-00000001', seat: 'white' }, port);
    expect(outcome.kind).toBe('refused');
    // The reason of the composition is kept as it is, and it names what the
    // owner can do about it.
    expect(outcome.detail).toContain('Connect a model');
    const feedback = onlineAgentHandoffFeedback(outcome);
    expect(feedback.kind).toBe('failure');
  });

  it('shows an unknown hand-back as a visible failure and claims nothing', async () => {
    const { port } = portDouble({
      kind: 'unknown',
      detail: 'The hand-back was not proved. The seat may play the agent now. Hand the seat over again to prove it.',
    });
    const outcome = await handSeatToAgent({ matchId: 'match-00000001', seat: 'white' }, port);
    expect(outcome.kind).toBe('unknown');
    expect(outcome.detail).toContain('Hand the seat over again');
    const feedback = onlineAgentHandoffFeedback(outcome);
    expect(feedback.kind).toBe('failure');
  });

  it('writes the status and the failure of the hand-back to one surface at a time', () => {
    const status = vi.fn();
    const failure = vi.fn();
    const surfaces = { status, failure };
    reportOnlineAgentHandoff(surfaces, { kind: 'status', detail: 'The seat plays Custom model now.' });
    expect(status).toHaveBeenCalledWith('The seat plays Custom model now.');
    expect(failure).not.toHaveBeenCalled();
    reportOnlineAgentHandoff(surfaces, { kind: 'failure', detail: 'The service refused the hand-back.' });
    expect(failure).toHaveBeenCalledWith('The service refused the hand-back.');
  });

  it('asks the composition for the hand-back and for nothing else', async () => {
    const handSeatToAgentOfComposition = vi.fn(async () => ({ kind: 'accepted', publicModelLabel: 'Custom model' }) as AgentDecisionOutcome);
    const composition = { handSeatToAgent: handSeatToAgentOfComposition } as unknown as OnlineComposition;
    const port = onlineAgentHandoffPort(composition);
    await port.handToAgent('match-00000001', 'white');
    expect(handSeatToAgentOfComposition).toHaveBeenCalledWith('match-00000001', 'white');
  });
});
