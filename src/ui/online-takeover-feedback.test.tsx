import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  onlineTakeoverErrorFeedback,
  onlineTakeoverFeedback,
  reportOnlineTakeover,
} from './online-takeover-feedback';
import type { OnlineTakeoverSurfaces } from './online-takeover-feedback';
import { takeOverOnlineSeat } from './online-takeover';
import type { OnlineTakeoverPort, OnlineTakeoverSeat } from './online-takeover';
import { OnlineFailureNotice, OnlineWorkspace } from './online-workspace';
import { createOnlineComposition } from '../online/composition';
import type { AgentDecisionOutcome } from '../online/composition';
import type { SeatControl } from '../online/contracts';

/**
 * The feedback of a takeover of a seat (KHA-74).
 *
 * The tests prove the question the takeover of the board toolbar answers: a
 * takeover the service refused and a takeover whose outcome could not be
 * established are visible failures, and only a proved takeover is a status.
 * The screen renders through a static markup, so the callbacks of the toolbar
 * never run in a test. The tests below therefore drive the same functions the
 * toolbar calls, with the same outcome of the service, and they prove where
 * every outcome of a takeover reaches the owner.
 */

/** The surfaces of the screen, with the calls they received. */
function surfacesDouble(): {
  readonly surfaces: OnlineTakeoverSurfaces;
  readonly status: ReturnType<typeof vi.fn>;
  readonly failure: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn();
  const failure = vi.fn();
  return { surfaces: { status, failure }, status, failure };
}

/** The seat of the owner, as the takeover of the toolbar sees it. */
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

/** A port whose decision of the composition has the given outcome. */
function portDouble(decision: AgentDecisionOutcome): OnlineTakeoverPort {
  return {
    agentDecision: vi.fn(async () => decision),
    commandClient: vi.fn(() => null),
  };
}

/** The seat of an agent this browser plays. */
const managedAgentSeat = takeoverSeat({ kind: 'agent', modelLabel: 'Custom model' }, true);

describe('the feedback of a takeover of a seat', () => {
  it('shows a refused takeover as a visible failure and keeps the detail of the service', () => {
    const { surfaces, status, failure } = surfacesDouble();
    reportOnlineTakeover(surfaces, onlineTakeoverFeedback({
      kind: 'refused',
      detail: 'The service refused the takeover.',
    }));
    // The owner has to see that the control of the seat did not change.
    expect(failure).toHaveBeenCalledWith('The service refused the takeover.');
    // The refusal is not a status of the screen.
    expect(status).not.toHaveBeenCalled();
  });

  it('shows an unknown takeover as a visible failure and keeps the detail of the service', () => {
    const { surfaces, status, failure } = surfacesDouble();
    reportOnlineTakeover(surfaces, onlineTakeoverFeedback({
      kind: 'unknown',
      detail: 'A newer decision of the owner ended the takeover.',
    }));
    // An outcome that could not be established is not a takeover either, so
    // the owner has to see it.
    expect(failure).toHaveBeenCalledWith('A newer decision of the owner ended the takeover.');
    expect(status).not.toHaveBeenCalled();
  });

  it('keeps an accepted takeover in the polite status of the screen', () => {
    const { surfaces, status, failure } = surfacesDouble();
    reportOnlineTakeover(surfaces, onlineTakeoverFeedback({ kind: 'accepted', detail: 'The seat is yours.' }));
    // A proved takeover is a status: the screen shows no error for it.
    expect(status).toHaveBeenCalledWith('The seat is yours.');
    expect(failure).not.toHaveBeenCalled();
  });

  it('shows a thrown takeover as a visible failure and keeps the message of the browser', () => {
    const { surfaces, status, failure } = surfacesDouble();
    reportOnlineTakeover(surfaces, onlineTakeoverErrorFeedback(new Error('The service did not answer.')));
    expect(failure).toHaveBeenCalledWith('The service did not answer.');
    expect(status).not.toHaveBeenCalled();
  });

  it('shows a thrown takeover without a message as a visible failure', () => {
    const { surfaces, status, failure } = surfacesDouble();
    reportOnlineTakeover(surfaces, onlineTakeoverErrorFeedback('no message'));
    expect(failure).toHaveBeenCalledWith('The takeover was refused.');
    expect(status).not.toHaveBeenCalled();
  });
});

/**
 * The surfaces of the screen.
 *
 * The polite status of the screen is read by a screen reader alone, so a
 * refusal of the service may not be reported there: a sighted owner would
 * not learn that the control of the seat did not change. The visible failure
 * is the region the owner sees.
 */
describe('the surfaces of the online screen', () => {
  it('keeps the polite status invisible and owns a visible failure', () => {
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    });
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} />);
    // The status of the screen is read by a screen reader alone.
    expect(markup).toContain('class="sr-only" role="status"');
    // The visible failure of the screen is a region of its own.
    expect(markup).toContain('class="online-error"');
    expect(markup).toContain('role="alert"');
    composition.dispose();
  });
});

/**
 * The outcome of the service reaches the owner through the failure of the
 * screen.
 *
 * The test drives the takeover itself, so the outcome of the service is the
 * one the toolbar receives, and it proves that a refused takeover reaches the
 * visible error region of the screen and not the polite status alone.
 */
describe('the takeover of the board toolbar', () => {
  it('shows a refused takeover of the service in the visible error region', async () => {
    const outcome = await takeOverOnlineSeat(
      managedAgentSeat,
      portDouble({ kind: 'refused', detail: 'The service refused the takeover.' }),
    );
    const { surfaces, status, failure } = surfacesDouble();
    reportOnlineTakeover(surfaces, onlineTakeoverFeedback(outcome));
    // The refusal reaches the visible failure of the screen.
    expect(failure).toHaveBeenCalledWith('The service refused the takeover.');
    expect(status).not.toHaveBeenCalled();
    // The visible failure of the screen is an alert and it is not hidden in
    // the screen-reader-only text.
    const markup = renderToStaticMarkup(<OnlineFailureNotice failure="The service refused the takeover." />);
    expect(markup).toContain('<p class="online-error" role="alert">The service refused the takeover.</p>');
    expect(markup).not.toContain('sr-only');
  });

  it('shows an unknown takeover of the service in the visible error region', async () => {
    const outcome = await takeOverOnlineSeat(
      managedAgentSeat,
      portDouble({ kind: 'unknown', detail: 'The outcome of the takeover is unknown.' }),
    );
    const { surfaces, status, failure } = surfacesDouble();
    reportOnlineTakeover(surfaces, onlineTakeoverFeedback(outcome));
    expect(failure).toHaveBeenCalledWith('The outcome of the takeover is unknown.');
    expect(status).not.toHaveBeenCalled();
  });

  it('keeps an accepted takeover of the service in the status of the screen', async () => {
    const outcome = await takeOverOnlineSeat(
      managedAgentSeat,
      portDouble({ kind: 'accepted', publicModelLabel: 'Custom model' }),
    );
    const { surfaces, status, failure } = surfacesDouble();
    reportOnlineTakeover(surfaces, onlineTakeoverFeedback(outcome));
    expect(status).toHaveBeenCalledWith('The seat is yours.');
    expect(failure).not.toHaveBeenCalled();
  });
});
