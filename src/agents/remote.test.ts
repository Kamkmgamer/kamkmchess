import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', { location: { origin: 'https://chess.test' } });
const { ChessMcpClient } = await import('./remote.js');

interface LoggedCall { method: string; tool?: string }

describe('ChessMcpClient', () => {
  it('re-initializes an expired session, replays join_seat and retries once', async () => {
    const calls: LoggedCall[] = [];
    let expireNext = true;
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      const rpc = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { name?: string } };
      const tool = rpc.method === 'tools/call' ? rpc.params?.name : undefined;
      calls.push(tool === undefined ? { method: rpc.method } : { method: rpc.method, tool });
      if (expireNext && tool === 'get_board') {
        expireNext = false;
        return new Response('gone', { status: 404 });
      }
      const responseInit: ResponseInit = rpc.method === 'initialize' ? { headers: { 'Mcp-Session-Id': `session-${calls.length}` } } : {};
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { status: 'your-turn' } } }, responseInit);
    }));
    const client = new ChessMcpClient();
    await client.call('join_seat', { resume_token: 'secret', model_name: 'Test' });
    const board = await client.call('get_board');
    expect(board).toEqual({ status: 'your-turn' });
    expect(calls).toEqual([
      { method: 'initialize' },
      { method: 'tools/call', tool: 'join_seat' },
      { method: 'tools/call', tool: 'get_board' },
      { method: 'initialize' },
      { method: 'tools/call', tool: 'join_seat' },
      { method: 'tools/call', tool: 'get_board' },
    ]);
  });
});
