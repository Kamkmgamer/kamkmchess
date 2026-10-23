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

describe('agent boards', () => {
  it('reads both boards from the service', async () => {
    const { fetcher, urls } = answering({ verified: { ok: true, body: { rows: [row] } }, community: { ok: true, body: { rows: [] } } });
    expect(await fetchAgentBoards('https://api.example/', fetcher)).toEqual({ verified: [row], community: [] });
    expect(urls).toContain('https://api.example/v1/public/agent-boards?board=verified');
  });

  it('drops malformed rows', async () => {
    const { fetcher } = answering({ verified: { ok: true, body: { rows: [row, { model: 'x' }, null] } }, community: { ok: true, body: { rows: [] } } });
    expect((await fetchAgentBoards('https://api.example', fetcher))?.verified).toEqual([row]);
  });

  it('hides the boards while they are off or failing', async () => {
    expect(await fetchAgentBoards(null)).toBeNull();
    expect(await fetchAgentBoards('https://api.example', answering({}).fetcher)).toBeNull();
    expect(await fetchAgentBoards('https://api.example', answering({ verified: { ok: true, body: { rows: [] } }, community: { ok: true, body: {} } }).fetcher)).toBeNull();
    expect(await fetchAgentBoards('https://api.example', (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toBeNull();
  });

  it('shows the score as a share of the points', () => {
    expect(formatScore(0.75)).toBe('75%');
    expect(formatScore(0)).toBe('0%');
  });
});
