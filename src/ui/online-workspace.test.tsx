import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlineWorkspace } from './online-workspace';
import { createOnlineComposition } from '../online/composition';
import type { OnlineComposition } from '../online/composition';
import type { ProviderRunnerPhase, ProviderRunnerState } from '../online/provider-runner';
import type { OnlineMatchView } from '../online/updates';

function matchView(overrides: Partial<OnlineMatchView> = {}): OnlineMatchView {
  return {
    schemaVersion: 2,
    matchId: 'match-00000001',
    variant: 'orthodox',
    startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    positionFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
    version: 1,
    controlEpoch: 1,
    rulesPolicyVersion: 'online-rules/1',
    status: 'active',
    result: null,
    seats: [
      { seat: 'white', publicLabel: 'Alice', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Bob', control: { kind: 'agent', modelLabel: 'GPT-4o' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
    clock: {
      whiteMs: 300_000,
      blackMs: 300_000,
      activeSeat: 'white',
      activeSince: '2026-10-21T10:00:00.000Z',
      deadlineAt: null,
      whiteMoved: false,
      blackMoved: false,
      turnNumber: 1,
      replySeat: null,
      replyDeadlineAt: null,
    },
    moves: [],
    pendingOffers: [],
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    completedAt: null,
    yourSeat: 'white',
    ...overrides,
  };
}

/** A composition that never reaches a service. */
function offlineComposition(): OnlineComposition {
  return createOnlineComposition({
    baseUrl: 'https://api.example.test',
    fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  });
}

describe('the online workspace screen (UX-03, UX-04)', () => {
  it('offers the compact sections and keeps the offline game untouched', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} />);
    expect(markup).toContain('aria-label="Online play"');
    expect(markup).toContain('aria-label="New play"');
    expect(markup).toContain('aria-label="Games"');
    expect(markup).toContain('aria-label="Profile and history"');
    expect(markup).toContain('aria-label="Close online play"');
    // A signed-out browser has no games and no queue.
    expect(markup).toContain('No online games yet.');
    composition.dispose();
  });

  it('keeps the queue closed while the service closed the surface', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    expect(markup).toContain('Play yourself');
    expect(markup).toContain('Watch agent');
    // The service closed the queue, so the entry actions stay disabled.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Play yourself<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Watch agent<\/button>/);
    composition.dispose();
  });

  it('offers the queue entry actions when the service opened the surface', () => {
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      features: { friends: true, queue: true },
      fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    });
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    expect(markup).toMatch(/<button[^>]*>Play yourself<\/button>/);
    // Without an agent the agent entry stays unavailable.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Watch agent<\/button>/);
    composition.dispose();
  });

  it('shows the concurrent games of the owner', () => {
    const composition = offlineComposition();
    const view = matchView();
    composition.workspace.attach({
      matchId: view.matchId,
      seat: 'white',
      credential: {
        kind: 'guest',
        guestId: 'guest-1',
        matchId: view.matchId,
        seat: 'white',
        issue: async () => 'token',
      },
    });
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} />);
    expect(markup).toContain('match-00000001');
    composition.dispose();
  });

  it('never renders a declared-models block', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} />);
    expect(markup).not.toContain('Declared');
    expect(markup).not.toContain('declared models');
    composition.dispose();
  });

  it('renders every explicit queue entry with its own controls', async () => {
    const composition = offlineComposition();
    await composition.enterQueue({ control: { kind: 'human' }, timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 } });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl: { startingTimeMs: 180_000, incrementMs: 2_000 } }, { intent: 'new' });
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    // Every entry is listed, and every entry has its own focus and cancel
    // control with an accessible name.
    expect(markup).toContain('aria-label="Queue entries"');
    expect(markup).toContain('aria-label="Show queue entry queue-1"');
    expect(markup).toContain('aria-label="Cancel queue entry queue-1"');
    expect(markup).toContain('aria-label="Show queue entry queue-2"');
    expect(markup).toContain('aria-label="Cancel queue entry queue-2"');
    composition.dispose();
  });
});

/**
 * A composition whose agent seat is in the given phase.
 *
 * The workspace reads the state of the runner of the seat, so the screen
 * renders the decisions of the runner exactly as it renders them for a real
 * runner.
 */
function compositionWithRunner(phase: ProviderRunnerPhase): OnlineComposition {
  const view = matchView({
    seats: [
      { seat: 'white', publicLabel: 'Alice', control: { kind: 'agent', modelLabel: 'Custom model' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Bob', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
  });
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/updates')
      ? { schemaVersion: 1, cursor: 1, snapshot: view }
      : view;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const composition = createOnlineComposition({ baseUrl: 'https://api.example.test', fetch: fetcher });
  return new Proxy(composition, {
    get(target, property, receiver) {
      if (property === 'agentRunnerState') {
        return () => ({ phase } as ProviderRunnerState);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Lets the workspace learn the canonical view of the match. */
async function untilSnapshot(composition: OnlineComposition): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (composition.workspace.state('match-00000001')?.snapshot === null && Date.now() < deadline) {
    await new Promise<void>(resolve => { setTimeout(resolve, 10); });
  }
}

describe('the decisions of the agent seat', () => {
  it('renders the decisions of a stopped runner with an honest note', async () => {
    const composition = compositionWithRunner('stopped');
    composition.workspace.attach({
      matchId: 'match-00000001',
      seat: 'white',
      credential: {
        kind: 'guest',
        guestId: 'guest-1',
        matchId: 'match-00000001',
        seat: 'white',
        issue: async () => 'token',
      },
    });
    await untilSnapshot(composition);
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} />);
    // The runner offers its decisions in the phase `stopped`, so the
    // interface renders them and names the phase honestly.
    expect(markup).toContain('aria-label="Agent decisions"');
    expect(markup).toContain('The agent is stopped.');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(markup).toMatch(/<button[^>]*>Take over<\/button>/);
    composition.dispose();
  });

  it('offers no decision of the agent in a phase the runner does not wait in', async () => {
    const composition = compositionWithRunner('idle');
    composition.workspace.attach({
      matchId: 'match-00000001',
      seat: 'white',
      credential: {
        kind: 'guest',
        guestId: 'guest-1',
        matchId: 'match-00000001',
        seat: 'white',
        issue: async () => 'token',
      },
    });
    await untilSnapshot(composition);
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} />);
    expect(markup).not.toContain('aria-label="Agent decisions"');
    composition.dispose();
  });
});
