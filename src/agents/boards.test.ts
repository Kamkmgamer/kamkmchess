import { describe, expect, it } from 'vitest';
import { fetchAgentBoards, formatScore } from './boards.js';

const row = { model: 'Claude Haiku', level: 'casual', games: 2, wins: 1, draws: 1, losses: 0, score: 0.75 };

function answering(byBoard: Record<string, { ok: boolean; body: unknown }>) {
  const urls: string[] = [];
  const fetcher = ((url: string) => {
    urls.push(url);
    const answer = byBoard[new URL(url).searchParams.get('board') ?? ''];
    return Promise.resolve({ ok: answer?.ok ?? false, json: () => Promise.resolve(answer?.body) });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
}

function allBoards(rows: Partial<Record<string, readonly unknown[]>>): Record<string, { ok: boolean; body: unknown }> {
  return {
    verified: { ok: true, body: { rows: rows.verified ?? [] } },
    community: { ok: true, body: { rows: rows.community ?? [] } },
    browser: { ok: true, body: { rows: rows.browser ?? [] } },
  };
}

describe('agent boards', () => {
  it('reads all three boards from the service', async () => {
    const browserRow = { model: 'GPT-5 mini', reasoningEffort: 'medium', level: 'club', games: 1, wins: 1, draws: 0, losses: 0, score: 1 };
    const { fetcher, urls } = answering(allBoards({ verified: [row], browser: [browserRow] }));
    const boards = await fetchAgentBoards('https://api.example/', fetcher);
    expect(boards).toEqual({ verified: [row], community: [], browser: [browserRow] });
    expect(urls).toContain('https://api.example/v1/public/agent-boards?board=verified');
    expect(urls).toContain('https://api.example/v1/public/agent-boards?board=browser');
  });

  it('keeps a row whose effort is missing and drops malformed rows', async () => {
    const { fetcher } = answering(allBoards({ verified: [row, { model: 'x' }, null, { ...row, reasoningEffort: 3 }] }));
    expect((await fetchAgentBoards('https://api.example', fetcher))?.verified).toEqual([row]);
  });

  it('hides the boards while they are off or failing', async () => {
    expect(await fetchAgentBoards(null)).toBeNull();
    expect(await fetchAgentBoards('https://api.example', answering({}).fetcher)).toBeNull();
    expect(await fetchAgentBoards('https://api.example', answering({ verified: { ok: true, body: { rows: [] } }, community: { ok: true, body: { rows: [] } }, browser: { ok: true, body: {} } }).fetcher)).toBeNull();
    expect(await fetchAgentBoards('https://api.example', (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toBeNull();
  });

  it('shows the score as a share of the points', () => {
    expect(formatScore(0.75)).toBe('75%');
    expect(formatScore(0)).toBe('0%');
  });
});
