import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OnlineFailureNotice, OnlinePublicHistory, OnlineWorkspace } from './online-workspace';
import { enterExplicitQueueEntry } from './online-explicit-entries';
import { enterOnlineQueue } from './online-queue-entries';
import { createOnlineComposition } from '../online/composition';
import type { OnlineComposition } from '../online/composition';
import type { SeatControl, TimeControl } from '../online/contracts';
import type { OnlineProfileHistory } from '../online/history';
import type { ProviderRunnerPhase, ProviderRunnerState } from '../online/provider-runner';
import type { OnlineQueueState } from '../online/readiness';
import type { OnlineMatchView } from '../online/updates';
import type { ModelSelection } from '../controller/index';

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

/** A composition of a guest browser with the friend surface open. */
function guestComposition(): OnlineComposition {
  return createOnlineComposition({
    baseUrl: 'https://api.example.test',
    features: { friends: true, queue: false },
    fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  });
}

/** A composition of a signed-in account. */
function accountComposition(): OnlineComposition {
  return createOnlineComposition({
    baseUrl: 'https://api.example.test',
    features: { friends: true, queue: true },
    fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    accountSession: {
      identity: { accountId: 'account-00000001', token: async () => 'account-token' },
      subscribe: () => () => undefined,
    },
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
    expect(markup).toMatch(/<button[^>]*aria-label="Play yourself"[^>]*disabled=""/);
    // The agent entry is an icon action with its own accessible name.
    expect(markup).toMatch(/<button[^>]*aria-label="Watch agent"[^>]*disabled=""/);
    composition.dispose();
  });

  it('offers the queue entry actions when the service opened the surface', () => {
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      features: { friends: true, queue: true },
      fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    });
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    expect(markup).toMatch(/<button[^>]*aria-label="Play yourself"/);
    // Without an agent the agent entry stays unavailable.
    expect(markup).toMatch(/<button[^>]*aria-label="Watch agent"[^>]*disabled=""/);
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
    // control with an accessible name. The identifier of an entry carries a
    // browser scope, so the name starts with the entry of the browser.
    expect(markup).toContain('aria-label="Queue entries"');
    // The name of an entry ends with its identifier, so the name of one entry
    // never proves the name of the next one: an open name would match the
    // entry ten as well.
    expect(markup).toMatch(/aria-label="Show queue entry queue-1: [^"]+"/);
    expect(markup).toMatch(/aria-label="Cancel queue entry queue-1: [^"]+"/);
    expect(markup).toMatch(/aria-label="Show queue entry queue-2: [^"]+"/);
    expect(markup).toMatch(/aria-label="Cancel queue entry queue-2: [^"]+"/);
    composition.dispose();
  });
});

/**
 * The friend setup of the screen (KHA-75, FRI-01, FRI-02, FRI-03).
 *
 * The screen offers the whole setup of a friend game: the kind of the
 * invitation, the color of the inviter, the seat of the inviter, the custom
 * position and the seat of the browser that accepts the invitation.
 */
describe('the friend setup of the online screen', () => {
  it('offers the whole setup of a friend invitation', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    // The kind of the invitation, the color of the inviter, the seat of the
    // inviter and the seat of the acceptor are named groups.
    expect(markup).toContain('aria-label="Invitation kind"');
    expect(markup).toContain('aria-label="Inviter color"');
    expect(markup).toContain('aria-label="Inviter seat"');
    expect(markup).toContain('aria-label="Your seat"');
    // The colors and the seats are offered with a visible state.
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>White<\/button>/);
    expect(markup).toMatch(/<button[^>]*>Black<\/button>/);
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Human<\/button>/);
    // The custom position is offered, and the standard position is the
    // absence of one.
    expect(markup).toContain('aria-label="Starting position"');
    // The inviter may cancel the invitation it created, and the control is
    // unavailable while it owns no invitation.
    expect(markup).toMatch(/<button[^>]*aria-label="Cancel invitation"[^>]*disabled=""/);
    composition.dispose();
  });

  it('offers a named challenge only to a signed-in account', () => {
    const guest = guestComposition();
    const guestMarkup = renderToStaticMarkup(<OnlineWorkspace composition={guest} onClose={() => {}} initialTab="new" />);
    // A guest shares a link, so the challenge is unavailable and the reason is
    // shown.
    expect(guestMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Challenge<\/button>/);
    expect(guestMarkup).toContain('Sign in for a named challenge.');
    guest.dispose();

    const account = accountComposition();
    const accountMarkup = renderToStaticMarkup(<OnlineWorkspace composition={account} onClose={() => {}} initialTab="new" />);
    // The account may name a recipient.
    expect(accountMarkup).toMatch(/<button[^>]*>Challenge<\/button>/);
    expect(accountMarkup).not.toContain('Sign in for a named challenge.');
    account.dispose();
  });

  it('offers the own agent of the owner on a friend seat only when it is connected', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    // Without a connected model the agent seat is unavailable, so the screen
    // never claims an agent it cannot run.
    const agentButtons = markup.match(/<button[^>]*>Agent<\/button>/g) ?? [];
    expect(agentButtons).toHaveLength(2);
    expect(agentButtons.every(button => button.includes('disabled=""'))).toBe(true);
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
    expect(markup).toMatch(/<button[^>]*aria-label="Take over"/);
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

/**
 * Runs a block in a browser without the lock of the origin.
 *
 * The lock of the browser is what serializes the tabs of the owner. A
 * runtime without it cannot share one queue entry between its tabs, so the
 * queue fails closed with an actionable message.
 */
async function withoutBrowserLock(run: () => Promise<void>): Promise<void> {
  const scope = globalThis as unknown as { navigator?: { locks?: unknown } };
  const browser = scope.navigator;
  if (browser === undefined) throw new Error('The runtime has no navigator.');
  Object.defineProperty(browser, 'locks', { value: undefined, configurable: true });
  try {
    await run();
  } finally {
    delete browser.locks;
  }
}

/**
 * A composition whose queue reports a blocked entry.
 *
 * The workspace reads the state of the queue, so the screen renders the
 * reason of a blocked entry exactly as it renders it for a real queue.
 */
function compositionWithBlockedQueue(detail: string): OnlineComposition {
  const composition = offlineComposition();
  const state: OnlineQueueState = {
    phase: 'agent-failed',
    entry: null,
    detail,
    assignment: null,
    engineState: 'idle',
    cutoffAt: null,
    options: ['retry', 'play-yourself', 'cancel'],
  };
  return new Proxy(composition, {
    get(target, property, receiver) {
      if (property === 'queueState') return state;
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * The visible failure of the online screen.
 *
 * A failed action has to be seen, not only announced. The message of the
 * failure is the actionable one of the browser or of the service, so the
 * owner knows what to do about it.
 */
describe('the failure of the online screen', () => {
  it('keeps the actionable message of the browser lock', async () => {
    const requests: string[] = [];
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      features: { friends: true, queue: true },
      accountSession: {
        identity: { accountId: 'account-00000001', token: async () => 'account-token' },
        subscribe: () => () => undefined,
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch,
    });
    await withoutBrowserLock(async () => {
      const failure = await enterOnlineQueue(
        composition,
        { control: { kind: 'human' }, timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 } },
        'reuse',
      );
      // The message of the browser is the actionable one, so the owner knows
      // that another browser is needed.
      expect(failure).toBe('This browser cannot share one queue entry between its tabs. Use a browser with the Web Locks API.');
    });
    // The lock failure creates no service entry: the queue fails closed.
    expect(requests.filter(request => request.includes('/queue/entries'))).toHaveLength(0);
    composition.dispose();
  });

  it('shows the failure as a visible error and not only for a screen reader', () => {
    const failure = 'This browser cannot share one queue entry between its tabs. Use a browser with the Web Locks API.';
    const markup = renderToStaticMarkup(<OnlineFailureNotice failure={failure} />);
    // The error is announced as an alert and it carries the whole message.
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Web Locks API');
    // The error is not hidden in the screen-reader-only text of the screen.
    expect(markup).not.toContain('sr-only');
  });

  it('gives the screen a visible error region', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    // The screen owns a visible error region, so a failed action can be seen.
    expect(markup).toContain('class="online-error"');
    expect(markup).toContain('role="alert"');
    // The region of the failure is not the screen-reader-only text.
    expect(markup).not.toContain('class="sr-only" role="alert"');
    composition.dispose();
  });

  it('shows the reason of a blocked entry as a visible error', () => {
    const composition = compositionWithBlockedQueue('The agent check failed.');
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    // The reason of the blocked entry is visible, not only announced.
    expect(markup).toContain('<p class="online-error" role="alert">The agent check failed.</p>');
    // The reason is not repeated as a status of the entry.
    expect(markup).not.toContain('<p role="status">The agent check failed.</p>');
    composition.dispose();
  });
});

/**
 * A queue service that answers the entries of the owner.
 *
 * The answer carries the control and the clock of the request, so the
 * canonical state of an entry is the one the owner asked for.
 */
function queueService(): { fetcher: typeof fetch; readonly requests: string[] } {
  const requests: string[] = [];
  const entries = new Map<string, Record<string, unknown>>();
  let counter = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(`${method} ${url}`);
    let status = 404;
    let data: unknown = { error: 'not_found' };
    if (url.includes('/queue/entries') && method === 'POST' && url.endsWith('/entries')) {
      const entryId = `entry-000000${++counter}`;
      const now = Date.now();
      const entry = {
        schemaVersion: 2,
        entryId,
        owner: { kind: 'account', id: 'account-00000001' },
        control: body?.control ?? { kind: 'human' },
        timeControl: body?.timeControl ?? { startingTimeMs: 300_000, incrementMs: 2_000 },
        status: 'waiting',
        version: 1,
        readyAt: new Date(now).toISOString(),
        cutoffAt: new Date(now + 10_000).toISOString(),
        assignedMatchId: null,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      entries.set(entryId, entry);
      status = 201;
      data = entry;
    } else if (url.includes('/queue/entries') && method === 'GET') {
      // The read of an entry never allocates a second one.
      const entry = entries.get(decodeURIComponent(url.split('/').pop() ?? ''));
      if (entry !== undefined) {
        status = 200;
        data = entry;
      }
    }
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetcher: fetcher as unknown as typeof fetch, requests };
}

/**
 * The accessible names of the controls of the queue entries.
 *
 * An owner may wait with several entries at once, so the name of a control
 * has to name the entry it belongs to.
 */
describe('the accessible names of the queue entries', () => {
  it('names the controls of two entries with their own context', async () => {
    const service = queueService();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      features: { friends: true, queue: true },
      accountSession: {
        identity: { accountId: 'account-00000001', token: async () => 'account-token' },
        subscribe: () => () => undefined,
      },
      fetch: service.fetcher,
      checkModel: async () => ({ ready: true, detail: '' }),
    });
    composition.setAgent({
      label: 'GPT-4o',
      selection: {
        kind: 'model',
        providerId: 'provider-00000001',
        connectionId: 'connection-00000001',
        modelRoutingId: 'model-00000001',
        configurationRevision: 1,
        protocol: 'chat-completions',
        diagnostic: 'not-run',
      },
    });
    // One human entry with the 5+2 clock and one agent entry with the 3+2
    // clock: the two entries differ in their seat, their control and their
    // clock.
    await composition.enterQueue({ control: { kind: 'human' }, timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 } });
    await composition.enterQueue(
      { control: { kind: 'agent', modelLabel: 'GPT-4o' }, timeControl: { startingTimeMs: 180_000, incrementMs: 2_000 } },
      { intent: 'new' },
    );
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    const names = [...markup.matchAll(/aria-label="((?:Show|Cancel) queue entry [^"]+)"/g)].map(match => match[1]!);
    // Every entry has a show and a cancel control.
    expect(names).toHaveLength(4);
    const shown = names.filter(name => name.startsWith('Show '));
    expect(shown).toHaveLength(2);
    // The names of the two entries differ, so the owner tells his own entries
    // apart without reading a counter of the browser.
    expect(shown[0]).not.toBe(shown[1]);
    // The name of an entry carries its seat, its control, its clock and its
    // state, and the identifier of the entry stays in the name.
    expect(shown[0]).toContain('Human seat');
    expect(shown[0]).toContain('5+2');
    expect(shown[0]).toContain('searching');
    expect(shown[0]).toMatch(/queue-\d/);
    expect(shown[1]).toContain('Agent seat GPT-4o');
    expect(shown[1]).toContain('3+2');
    expect(shown[1]).toContain('searching');
    expect(shown[1]).toMatch(/queue-\d/);
    composition.dispose();
  });
});

/**
 * The markup of one part of the rendered screen.
 *
 * The screen renders the parts of the online screen next to each other, so
 * the count of the words of one part needs the markup of that part alone.
 * The part ends where its own closing tag closes it, and the parts nested
 * inside it stay inside it.
 */
function partMarkup(markup: string, label: string): string {
  const open = [...markup.matchAll(/<section\b[^>]*>/g)].find(match => match[0].includes(`aria-label="${label}"`));
  if (!open) throw new Error(`the screen has no part named ${label}`);
  const openAt = open.index;
  const tags = /<(\/?)section\b[^>]*>/g;
  tags.lastIndex = openAt;
  let depth = 0;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(markup)) !== null) {
    depth += tag[1] === '/' ? -1 : 1;
    if (depth === 0) return markup.slice(openAt, tag.index);
  }
  throw new Error(`the part named ${label} is never closed`);
}

/**
 * The visible words of one part of the rendered screen.
 *
 * The count follows the convention of the product.
 *
 * - The visible copy counts: the text of the screen and the placeholder of a
 *   field, because the placeholder is what the owner reads in the field.
 * - The names that only a screen reader or a hover label carries do not
 *   count: the accessible name of an icon action is not visible copy.
 * - The game data does not count: the value of a field is the data of a
 *   match, and no identifier of a match is a word of the screen.
 *
 * A visible number is a word of the screen, so a clock label such as `3+2`
 * is two words.
 */
function visibleWords(markup: string, label: string): string[] {
  const part = partMarkup(markup, label);
  const placeholders = [...part.matchAll(/placeholder="([^"]*)"/g)].map(match => match[1] ?? '');
  const text = part.replace(/<[^>]*>/g, ' ');
  return `${text} ${placeholders.join(' ')}`.match(/[a-z0-9]+/gi) ?? [];
}

/**
 * The visible copy of the new play screen (UX-03).
 *
 * The panel of the new play carries the queue of the owner and the friend
 * setup, and the convention of the screen keeps its visible copy inside
 * twenty words. The regression counts the words of the default state of the
 * panel, so a later copy change cannot claim the convention without
 * measuring it.
 */
describe('the visible copy of the new play screen', () => {
  it('keeps the visible words of the default new play state inside twenty words', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    const words = visibleWords(markup, 'New play');
    // The count of the words of the panel is the measurement of the
    // convention, and the panel of the default state stays inside it. The
    // panel counted more than twenty words before this change: the agent
    // entry was a button with a visible label and the fields of the panel
    // named themselves in two words.
    expect(words.length).toBeLessThanOrEqual(20);
    // The measurement reads the visible copy of the panel, and it reads no
    // name that only an icon action carries.
    expect(words).toContain('Friend');
    expect(words).toContain('Preview');
    expect(words).not.toContain('Play');
    expect(words).not.toContain('yourself');
    expect(words).not.toContain('Watch');
    composition.dispose();
  });

  it('keeps the actions of the panel with their names and their hover labels', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="new" />);
    // The queue of the owner keeps its four actions, and the agent entries
    // keep their own accessible names and their own hover labels.
    expect(markup).toMatch(/<button[^>]*aria-label="Play yourself"/);
    expect(markup).toMatch(/<button[^>]*aria-label="Watch agent"[^>]*title="Watch agent"/);
    expect(markup).toMatch(/<button[^>]*aria-label="Another entry"/);
    expect(markup).toMatch(/<button[^>]*aria-label="Another agent entry"[^>]*title="Another agent entry"/);
    // The friend setup keeps the kind of the invitation, the color of the
    // inviter, the seat of the inviter and the seat of the acceptor.
    expect(markup).toContain('>Link</button>');
    expect(markup).toContain('>Challenge</button>');
    expect(markup).toContain('>White</button>');
    expect(markup).toContain('>Black</button>');
    expect(markup).toContain('>Human</button>');
    expect(markup).toContain('>Agent</button>');
    // The custom position and the invitation code keep their accessible
    // names, and the code of an invitation is still read by a screen reader.
    expect(markup).toContain('aria-label="Starting position"');
    expect(markup).toContain('aria-label="Invitation code"');
    composition.dispose();
  });
});

/** The clock of the entry of the owner in the interaction tests. */
const ENTRY_CLOCK: TimeControl = { startingTimeMs: 300_000, incrementMs: 2_000 };

/** The own model of the owner in the interaction tests. */
const OWN_SELECTION: ModelSelection = {
  kind: 'model',
  providerId: 'provider-00000001',
  connectionId: 'connection-00000001',
  modelRoutingId: 'model-00000001',
  configurationRevision: 1,
  protocol: 'chat-completions',
  diagnostic: 'not-run',
};

/**
 * The entries a composition was asked for.
 *
 * The spy replaces the request of the composition, so the regression reads
 * the seat and the mode of every entry the screen asked for.
 */
function entryRecorder(composition: OnlineComposition): {
  readonly requests: { readonly control: SeatControl; readonly timeControl: TimeControl }[];
  readonly intents: (('reuse' | 'new') | undefined)[];
} {
  const requests: { readonly control: SeatControl; readonly timeControl: TimeControl }[] = [];
  const intents: (('reuse' | 'new') | undefined)[] = [];
  composition.enterQueue = async (request, options) => {
    requests.push(request);
    intents.push(options?.intent);
  };
  return { requests, intents };
}

/**
 * The explicit queue entries of the owner (KHA-74).
 *
 * One owner may wait with several entries at once, so every new entry is an
 * explicit action of the screen. The helper of the explicit entries is the
 * one path of the screen that creates a second entry: the action of the
 * agent seat asks the service for a new entry of the selected model, and the
 * default actions keep the shared entry of the browser, so the default never
 * cancels or replaces an entry of the owner on its own.
 */
describe('the explicit queue entries of the owner', () => {
  it('creates a second agent entry when the owner asks for one', async () => {
    const composition = accountComposition();
    const { requests, intents } = entryRecorder(composition);
    const failure = await enterExplicitQueueEntry(composition, 'agent', 'GPT-4o', ENTRY_CLOCK);
    expect(failure).toBeNull();
    // The entry reaches the composition with the seat of the selected model
    // and with the new mode, so the entry is a second one of its own.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.control).toEqual({ kind: 'agent', modelLabel: 'GPT-4o' });
    expect(requests[0]?.timeControl).toEqual(ENTRY_CLOCK);
    expect(intents).toEqual(['new']);
    composition.dispose();
  });

  it('creates a second human entry when the owner asks for one', async () => {
    const composition = accountComposition();
    const { requests, intents } = entryRecorder(composition);
    const failure = await enterExplicitQueueEntry(composition, 'human', 'GPT-4o', ENTRY_CLOCK);
    expect(failure).toBeNull();
    // The human entry is a second one as well, so the owner may wait with a
    // human seat and an agent seat at the same time.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.control).toEqual({ kind: 'human' });
    expect(intents).toEqual(['new']);
    composition.dispose();
  });

  it('refuses an agent entry without an own agent', async () => {
    const composition = accountComposition();
    const { requests } = entryRecorder(composition);
    const failure = await enterExplicitQueueEntry(composition, 'agent', null, ENTRY_CLOCK);
    // The screen never asks for an agent seat it cannot run, and the failure
    // is the actionable message of the owner.
    expect(failure).not.toBeNull();
    expect(requests).toHaveLength(0);
    composition.dispose();
  });

  it('offers the explicit agent entry of the screen only with an own agent', () => {
    const withoutAgent = accountComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={withoutAgent} onClose={() => {}} initialTab="new" />);
    // Without a connected model the agent entries stay unavailable, so the
    // screen never claims an agent it cannot run. The explicit agent entry
    // is the control of the helper of the explicit entries, and the helper
    // refuses the agent seat without an own agent.
    expect(markup).toMatch(/<button[^>]*aria-label="Watch agent"[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*aria-label="Another agent entry"[^>]*disabled=""/);
    withoutAgent.dispose();

    const withAgent = accountComposition();
    withAgent.setAgent({ label: 'GPT-4o', selection: OWN_SELECTION });
    const agentMarkup = renderToStaticMarkup(<OnlineWorkspace composition={withAgent} onClose={() => {}} initialTab="new" />);
    // With an own agent the explicit agent entry is available to the owner.
    expect(agentMarkup).toMatch(/<button[^>]*aria-label="Another agent entry"[^>]*title="Another agent entry"/);
    expect(agentMarkup).not.toMatch(/<button[^>]*aria-label="Another agent entry"[^>]*disabled=""/);
    // The human entry keeps its own control as well, so the owner may wait
    // with both seats at the same time.
    expect(agentMarkup).toMatch(/<button[^>]*aria-label="Another entry"[^>]*title="Another entry"/);
    expect(agentMarkup).not.toMatch(/<button[^>]*aria-label="Another entry"[^>]*disabled=""/);
    withAgent.dispose();
  });
});

/**
 * The public game history of the profile panel (KHA-78).
 *
 * The service publishes the completed games of a profile, and the screen
 * shows them. The tests read the published games of a profile, the public
 * replay of every one of them and the abort that is published without a
 * scored result.
 */

/**
 * The published games of a profile.
 *
 * The fixture carries a win, a draw and an abort, and it is the shape of the
 * answer of the service, so the same fixture is the wire answer of a read
 * and the published history of the screen.
 */
function profileHistory(overrides: Partial<OnlineProfileHistory> = {}): OnlineProfileHistory {
  return {
    schemaVersion: 1,
    profileId: 'profile-public-01',
    totals: { wins: 1, draws: 1, losses: 0, aborts: 1, scored: 2 },
    games: [
      { matchId: 'match-public-01', replayPath: '/v1/public/matches/match-public-01/replay', gameKind: 'queue', outcome: 'win', scored: true, opponentLabel: 'Bob', completedAt: '2026-10-21T10:05:00.000Z' },
      { matchId: 'match-public-02', replayPath: '/v1/public/matches/match-public-02/replay', gameKind: 'friend', outcome: 'draw', scored: true, opponentLabel: 'Deleted player', completedAt: '2026-10-21T11:00:00.000Z' },
      { matchId: 'match-public-03', replayPath: '/v1/public/matches/match-public-03/replay', gameKind: 'fallback', outcome: 'abort', scored: false, opponentLabel: 'Cara', completedAt: '2026-10-21T12:00:00.000Z' },
    ],
    ...overrides,
  };
}

/** A composition whose public read answers with the given history. */
function historyComposition(answer: unknown): OnlineComposition {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/public/profiles/')) {
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return createOnlineComposition({ baseUrl: 'https://api.example.test', fetch: fetcher });
}

describe('the public game history of the profile panel', () => {
  it('shows every published game with its opponent, its kind and its outcome', () => {
    const markup = renderToStaticMarkup(<OnlinePublicHistory history={profileHistory()} />);
    // The list is named, so the owner finds the history of the profile.
    expect(markup).toContain('aria-label="Public game history"');
    // Every game of the profile is listed with its public opponent, the kind
    // of the game and the outcome of the game.
    expect(markup).toContain('Bob · Queue · Win');
    expect(markup).toContain('Deleted player · Friend · Draw');
    expect(markup).toContain('Cara · Fallback · Abort');
    // The totals name the aborts apart from the scored results.
    expect(markup).toContain('1 wins · 1 draws · 0 losses · 1 aborts');
  });

  it('reaches the public replay of every published game', () => {
    const markup = renderToStaticMarkup(<OnlinePublicHistory history={profileHistory()} />);
    const links = [...markup.matchAll(/<a[^>]*href="([^"]+)"/g)].map(match => match[1]);
    // Every game of the profile offers the public replay the service
    // published, so the replay of a published game is reachable.
    expect(links).toEqual([
      '/v1/public/matches/match-public-01/replay',
      '/v1/public/matches/match-public-02/replay',
      '/v1/public/matches/match-public-03/replay',
    ]);
    // The name of the link names the game it opens, so a screen reader tells
    // the replays of the profile apart.
    expect(markup).toContain('aria-label="Public replay of the game against Bob"');
    expect(markup).toContain('aria-label="Public replay of the game against Cara"');
  });

  it('marks an abort as an unscored game', () => {
    const markup = renderToStaticMarkup(<OnlinePublicHistory history={profileHistory()} />);
    // The abort is named as an abort and it is never a scored result.
    expect(markup).toContain('Cara · Fallback · Abort · unscored');
    // A scored game never carries the mark of an unscored one.
    expect(markup).not.toContain('Bob · Queue · Win · unscored');
  });

  it('shows the completion time of every published game', () => {
    const markup = renderToStaticMarkup(<OnlinePublicHistory history={profileHistory()} />);
    expect(markup).toMatch(/<time[^>]*datetime="2026-10-21T10:05:00.000Z"[^>]*>2026-10-21 10:05 UTC<\/time>/i);
    expect(markup).toMatch(/<time[^>]*datetime="2026-10-21T12:00:00.000Z"[^>]*>2026-10-21 12:00 UTC<\/time>/i);
  });

  it('shows an empty history without an empty list', () => {
    const markup = renderToStaticMarkup(<OnlinePublicHistory history={profileHistory({
      totals: { wins: 0, draws: 0, losses: 0, aborts: 0, scored: 0 },
      games: [],
    })} />);
    // The screen says that the profile has no published game, and it shows no
    // empty list of games.
    expect(markup).toContain('No published games yet.');
    expect(markup).not.toContain('aria-label="Public game history"');
    expect(markup).not.toContain('<a ');
  });

  it('offers no link to a path that leaves the origin of the browser', () => {
    const markup = renderToStaticMarkup(<OnlinePublicHistory history={profileHistory({
      games: [{
        matchId: 'match-public-04',
        replayPath: '//other.example/replay',
        gameKind: 'queue',
        outcome: 'win',
        scored: true,
        opponentLabel: 'Bob',
        completedAt: '2026-10-21T13:00:00.000Z',
      }],
    })} />);
    // The game is listed, but the path is not a replay of this service, so
    // the screen offers no link to it.
    expect(markup).toContain('Bob · Queue · Win');
    expect(markup).not.toContain('<a ');
  });

  it('shows no field of the answer that the owner does not read', () => {
    const markup = renderToStaticMarkup(<OnlinePublicHistory history={profileHistory()} />);
    // The screen shows the values of the public projection and never the
    // names of the fields of the answer.
    expect(markup).not.toContain('opponentLabel');
    expect(markup).not.toContain('replayPath');
    expect(markup).not.toContain('gameKind');
    expect(markup).not.toContain('outcome');
    expect(markup).not.toContain('completedAt');
  });

  it('shows the games of the answer of the public read', async () => {
    const composition = historyComposition(profileHistory());
    // The read of the service is the only source of the history, so the
    // published games of the answer are the games of the screen.
    const answer = await composition.publicHistory.history('profile-public-01');
    expect(answer.games).toHaveLength(3);
    const markup = renderToStaticMarkup(<OnlinePublicHistory history={answer} />);
    expect(markup).toContain('Bob · Queue · Win');
    expect(markup).toContain('Cara · Fallback · Abort · unscored');
    expect(markup).toContain('href="/v1/public/matches/match-public-03/replay"');
    composition.dispose();
  });

  it('offers the public history in the profile destination of the screen', () => {
    const composition = offlineComposition();
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => {}} initialTab="profile" />);
    // The profile and the history are a destination of the screen, and the
    // public read of a profile is offered there.
    expect(markup).toContain('aria-label="Profile and history"');
    expect(markup).toContain('>Public history</button>');
    // Before a read the screen shows no game of a history.
    expect(markup).not.toContain('aria-label="Public game history"');
    composition.dispose();
  });
});
