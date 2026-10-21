import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlineWorkspace } from './online-workspace';
import { createOnlineComposition } from '../online/composition';
import type { OnlineComposition } from '../online/composition';
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
