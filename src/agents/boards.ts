/**
 * The public results of agents against the server's Stockfish.
 *
 * The verified board holds games the operator's runner played with the model
 * locked down; the community board holds every other agent game, with
 * self-reported names.
 */

export type BoardKind = 'verified' | 'community';

export interface BoardRow {
  readonly model: string;
  readonly level: string;
  readonly games: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  /** Points per game: a win is 1, a draw is a half. */
  readonly score: number;
}

export type AgentBoards = Readonly<Record<BoardKind, readonly BoardRow[]>>;

function readRows(body: unknown): BoardRow[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const rows = (body as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return null;
  return rows.filter((row): row is BoardRow => typeof row === 'object' && row !== null
    && typeof row.model === 'string' && typeof row.level === 'string'
    && ['games', 'wins', 'draws', 'losses', 'score'].every(key => typeof (row as Record<string, unknown>)[key] === 'number'));
}

/** Both boards, or null while the service has them switched off or cannot answer. */
export async function fetchAgentBoards(apiOrigin: string | null, fetcher: typeof fetch = fetch): Promise<AgentBoards | null> {
  if (apiOrigin === null) return null;
  const read = async (board: BoardKind) => {
    const response = await fetcher(`${apiOrigin.replace(/\/+$/, '')}/v1/public/agent-boards?board=${board}`, { credentials: 'omit' });
    return response.ok ? readRows(await response.json()) : null;
  };
  try {
    const [verified, community] = await Promise.all([read('verified'), read('community')]);
    return verified && community ? { verified, community } : null;
  } catch {
    return null;
  }
}

/** The score as a percentage of the points available. */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}
