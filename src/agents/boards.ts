/**
 * The public results of agents against the server's Stockfish.
 *
 * The verified board holds games the operator's runner played with the model
 * locked down; the community board holds every other agent game, with
 * self-reported names; the browser board holds games a visitor's own device
 * played against the browser's Stockfish and reported itself.
 */

export type BoardKind = 'verified' | 'community' | 'browser';

export interface BoardRow {
  readonly model: string;
  /** The reasoning effort the agent reported for itself, if it did. */
  readonly reasoningEffort?: string;
  readonly level: string;
  readonly games: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  /** Points per game: a win is 1, a draw is a half. */
  readonly score: number;
}

export type AgentBoards = Readonly<Record<BoardKind, readonly BoardRow[]>>;

const kinds: readonly BoardKind[] = ['verified', 'community', 'browser'];

function readRows(body: unknown): BoardRow[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const rows = (body as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return null;
  return rows.filter((row): row is BoardRow => typeof row === 'object' && row !== null
    && typeof row.model === 'string' && typeof row.level === 'string'
    && (row.reasoningEffort === undefined || typeof row.reasoningEffort === 'string')
    && ['games', 'wins', 'draws', 'losses', 'score'].every(key => typeof (row as Record<string, unknown>)[key] === 'number'));
}

/** All boards, or null while the service has them switched off or cannot answer. */
export async function fetchAgentBoards(apiOrigin: string | null, fetcher: typeof fetch = fetch): Promise<AgentBoards | null> {
  if (apiOrigin === null) return null;
  const read = async (board: BoardKind) => {
    const response = await fetcher(`${apiOrigin.replace(/\/+$/, '')}/v1/public/agent-boards?board=${board}`, { credentials: 'omit' });
    return response.ok ? readRows(await response.json()) : null;
  };
  try {
    const [verified, community, browser] = await Promise.all(kinds.map(read));
    return verified && community && browser ? { verified, community, browser } : null;
  } catch {
    return null;
  }
}

/** The score as a percentage of the points available. */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}
