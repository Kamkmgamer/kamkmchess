import { describe, expect, it, vi } from 'vitest';
import {
  ONLINE_PUBLIC_REPLAY_SCHEMA_VERSION,
  compactControlLabel,
  fetchOnlineProfileHistory,
  fetchOnlinePublicReplay,
  parseOnlineProfileHistory,
  parseOnlinePublicReplay,
  profileHistoryPath,
  publicReplayPath,
} from './history';

const REPLAY = {
  schemaVersion: 2,
  matchId: 'match-public-1',
  variant: 'orthodox',
  startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  timeControl: { startingTimeMs: 300000, incrementMs: 2000 },
  gameKind: 'friend',
  scored: true,
  attribution: { source: 'declared', providerVerified: false },
  participants: [
    { seat: 'white', publicLabel: 'Alice', control: { kind: 'human', declaration: 'declared' } },
    {
      seat: 'black',
      publicLabel: 'Bob',
      control: { kind: 'agent', modelLabel: 'GPT-4o', declaration: 'declared' },
    },
  ],
  moves: [
    {
      version: 2,
      seat: 'white',
      uci: 'e2e4',
      san: 'e4',
      control: { kind: 'human', declaration: 'declared' },
    },
    {
      version: 3,
      seat: 'black',
      uci: 'e7e5',
      san: 'e5',
      control: { kind: 'agent', modelLabel: 'GPT-4o', declaration: 'declared' },
    },
  ],
  terminal: {
    kind: 'resign',
    seat: 'black',
    control: { kind: 'agent', modelLabel: 'GPT-4o', declaration: 'declared' },
  },
  result: { kind: 'win', winner: 'white', reason: 'resignation' },
  rulesPolicyVersion: 'online-rules/1',
  completedAt: '2026-10-21T10:00:00Z',
};

describe('public replay contract', () => {
  it('reads the declared control of every accepted move and of the terminal action', () => {
    const replay = parseOnlinePublicReplay(REPLAY);
    expect(replay.schemaVersion).toBe(ONLINE_PUBLIC_REPLAY_SCHEMA_VERSION);
    expect(replay.moves[0]?.control.kind).toBe('human');
    expect(replay.moves[1]?.control.modelLabel).toBe('GPT-4o');
    expect(replay.terminal?.control.modelLabel).toBe('GPT-4o');
    expect(replay.attribution).toEqual({ source: 'declared', providerVerified: false });
  });

  it('refuses a provider verified attribution', () => {
    expect(() =>
      parseOnlinePublicReplay({
        ...REPLAY,
        attribution: { source: 'declared', providerVerified: true },
      }),
    ).toThrow(/provider verified/);
  });

  it('refuses an unknown field and a missing field', () => {
    expect(() => parseOnlinePublicReplay({ ...REPLAY, routingId: 'private-route' })).toThrow(/unexpected field/);
    const { attribution, ...withoutAttribution } = REPLAY;
    void attribution;
    expect(() => parseOnlinePublicReplay(withoutAttribution)).toThrow(/missing field/);
  });

  it('refuses an abort that claims to be scored', () => {
    expect(() =>
      parseOnlinePublicReplay({
        ...REPLAY,
        scored: true,
        result: { kind: 'abort', winner: null, reason: 'abort' },
      }),
    ).toThrow(/abort is never scored/);
  });

  it('refuses a control that declares a model for a human seat', () => {
    const participants = REPLAY.participants.map((participant, index) =>
      index === 0 ? { ...participant, control: { kind: 'human', modelLabel: 'GPT-4o', declaration: 'declared' } } : participant,
    );
    expect(() => parseOnlinePublicReplay({ ...REPLAY, participants })).toThrow(/human control has no model/);
  });

  it('renders a compact label instead of a declared models list', () => {
    expect(compactControlLabel({ kind: 'human', declaration: 'declared' })).toBe('Human');
    expect(compactControlLabel({ kind: 'agent', modelLabel: 'GPT-4o', declaration: 'declared' })).toBe('Agent · GPT-4o');
    expect(
      compactControlLabel({ kind: 'engine', modelLabel: 'Stockfish 19 Lite (browser)', declaration: 'declared' }),
    ).toBe('Engine · Stockfish 19 Lite (browser)');
  });

  it('builds the public paths', () => {
    expect(publicReplayPath('match-public-1')).toBe('/v1/public/matches/match-public-1/replay');
    expect(profileHistoryPath('kp_public_1')).toBe('/v1/public/profiles/kp_public_1/history');
  });
});

describe('public profile history contract', () => {
  const HISTORY = {
    schemaVersion: 1,
    profileId: 'kp_public_1',
    totals: { wins: 3, draws: 1, losses: 2, aborts: 1, scored: 6 },
    games: [
      {
        matchId: 'match-public-1',
        replayPath: '/v1/public/matches/match-public-1/replay',
        gameKind: 'friend',
        outcome: 'win',
        scored: true,
        opponentLabel: 'Bob',
        completedAt: '2026-10-21T10:00:00Z',
      },
      {
        matchId: 'match-public-2',
        replayPath: '/v1/public/matches/match-public-2/replay',
        gameKind: 'queue',
        outcome: 'abort',
        scored: false,
        opponentLabel: 'Deleted player',
        completedAt: '2026-10-20T10:00:00Z',
      },
    ],
  };

  it('reads the games and the aggregate totals', () => {
    const history = parseOnlineProfileHistory(HISTORY);
    expect(history.games).toHaveLength(2);
    expect(history.games[1]?.outcome).toBe('abort');
    expect(history.games[1]?.scored).toBe(false);
    expect(history.totals.scored).toBe(6);
  });

  it('refuses an unknown outcome', () => {
    const games = HISTORY.games.map((game, index) => (index === 0 ? { ...game, outcome: 'victory' } : game));
    expect(() => parseOnlineProfileHistory({ ...HISTORY, games })).toThrow(/unsupported outcome/);
  });
});

describe('signed-out public reads', () => {
  it('reads a replay without a credential', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(REPLAY), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const replay = await fetchOnlinePublicReplay('match-public-1', {
      baseUrl: 'https://api.example',
      fetch: fetcher as unknown as typeof fetch,
    });
    expect(replay.matchId).toBe('match-public-1');
    expect(calls[0]).toBe('https://api.example/v1/public/matches/match-public-1/replay');
  });

  it('reads a profile history without a credential', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        schemaVersion: 1,
        profileId: 'kp_public_1',
        totals: { wins: 0, draws: 0, losses: 0, aborts: 0, scored: 0 },
        games: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const history = await fetchOnlineProfileHistory('kp_public_1', {
      baseUrl: 'https://api.example',
      fetch: fetcher as unknown as typeof fetch,
    });
    expect(history.games).toHaveLength(0);
  });

  it('fails when the service refuses the read', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 }));
    await expect(
      fetchOnlinePublicReplay('match-public-1', {
        baseUrl: 'https://api.example',
        fetch: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/answered 404/);
  });
});
