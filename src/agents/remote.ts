import { publicConfig } from '../public-config.js';

export const remoteEndpoint = `${publicConfig.apiBaseUrl ?? window.location.origin}/v1/mcp`;

/** The server forgot this client's session (restart or idle expiry). */
class ExpiredSession extends Error {}

const UNAVAILABLE = 'The MCP server is unavailable. Enable it before starting an agent game.';

/** One MCP session per caller. Seat tokens stay out of request URLs. */
export class ChessMcpClient {
  private session = '';
  private seat?: Record<string, unknown>;
  private nextId = 0;
  private async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(remoteEndpoint, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.nextId, method, params }),
    });
    if (!response.ok) {
      if (response.status === 404 && this.session) throw new ExpiredSession();
      throw new Error(response.status === 404 ? UNAVAILABLE : 'The chess server could not answer. Try again.');
    }
    this.session = response.headers.get('Mcp-Session-Id') ?? this.session;
    const body = await response.json() as { result?: Record<string, unknown>; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result ?? {};
  }
  private async invoke(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.session) await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kamkm-human', version: '1' } });
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result.isError) throw new Error((result.content as { text: string }[])[0]?.text ?? 'The server refused that action.');
    return result.structuredContent as Record<string, unknown>;
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let result: Record<string, unknown>;
    try {
      result = await this.invoke(name, args);
    } catch (error) {
      if (!(error instanceof ExpiredSession)) throw error;
      this.session = '';
      try {
        if (name !== 'join_seat' && this.seat) await this.invoke('join_seat', this.seat);
        result = await this.invoke(name, args);
      } catch (retry) {
        throw retry instanceof ExpiredSession ? new Error(UNAVAILABLE) : retry;
      }
    }
    if (name === 'join_seat') this.seat = args;
    return result;
  }
}

export function seatPrompt(seatUrl: string, endpoint = remoteEndpoint): string {
  const url = new URL(seatUrl);
  const side = url.searchParams.get('side');
  const token = new URLSearchParams(url.hash.slice(1)).get('seat');
  const watch = new URL(url); watch.hash = ''; watch.searchParams.delete('side');
  return `Play as ${side} in this existing chess game: ${seatUrl}\nUse the Streamable HTTP MCP server ${endpoint} for all gameplay. Do not use browser tools, GUI clicks, or computer use. Connect the MCP server if needed. You can also POST MCP JSON-RPC requests from your HTTP client. Call get_rules, then join_seat with model_name set to your exact model and resume_token: "${token}". Do not call start_game. Share this viewing URL with your human immediately: ${watch.href}\nUse get_board, make_move and wait_for_turn until the game ends. Wait while status is waiting-for-players or opponent-turn. Black must answer White's first move within 15 seconds. Choose moves yourself without engines or analysis tools. Keep the seat token private; share only the viewing URL with spectators.`;
}
