/**
 * Copy-ready setup for playing kamkm chess with your own agent.
 *
 * All clients use the server's remote MCP endpoint. Browser gameplay is not
 * offered as a fallback when that endpoint is unavailable.
 */

export type AgentClient = 'claude-code' | 'codex' | 'claude-ai' | 'chatgpt' | 'mcp' | 'browser';
export type AgentOpponent = 'engine' | 'human' | 'agent';
export type AgentColor = 'white' | 'black' | 'random';
export type AgentLevel = 'casual' | 'club' | 'strong';

export interface AgentPreferences {
  readonly opponent: AgentOpponent;
  readonly color: AgentColor;
  readonly level: AgentLevel;
  /** Let the agent ask the person for color and level before it starts. */
  readonly askMe: boolean;
}

export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = { opponent: 'engine', color: 'white', level: 'club', askMe: false };

export const AGENT_LEVELS: Readonly<Record<AgentLevel, { label: string; thinkMs: number }>> = {
  casual: { label: 'Casual', thinkMs: 100 },
  club: { label: 'Club', thinkMs: 1000 },
  strong: { label: 'Strong', thinkMs: 5000 },
};

export const AGENT_CLIENTS: readonly { id: AgentClient; label: string; remote: boolean }[] = [
  { id: 'claude-code', label: 'Claude Code', remote: true },
  { id: 'codex', label: 'Codex', remote: true },
  { id: 'claude-ai', label: 'claude.ai', remote: true },
  { id: 'chatgpt', label: 'ChatGPT', remote: true },
  { id: 'mcp', label: 'Cursor / any MCP', remote: true },
];

export const MCP_SERVER_NAME = 'kamkm-chess';

/** The remote endpoint of a service origin. */
export function mcpUrl(apiOrigin: string): string {
  return `${apiOrigin.replace(/\/+$/, '')}/v1/mcp`;
}

/** One step of a setup: words to read and, optionally, text to copy. */
export interface SetupStep {
  readonly text: string;
  readonly copy?: { readonly label: string; readonly value: string };
}

const FAIRNESS = 'Choose every move yourself: do not run code to analyze moves, a chess engine or any analysis tool. Code used only to call MCP is allowed.';

function startLine(preferences: AgentPreferences, tools: 'remote' | 'page'): string {
  if (preferences.askMe) {
    const opponentQuestion = tools === 'page' ? ' whether I want to play you myself or watch you play Stockfish,' : '';
    return `Before you start, ask me${opponentQuestion} which color you should play (white, black or random) and how strong Stockfish should be (casual 100 ms, club 1000 ms or strong 5000 ms per move). Then call start_game with my answers.`;
  }
  const opponent = preferences.opponent !== 'engine' ? `, opponent: "${preferences.opponent}"` : '';
  const think = preferences.opponent !== 'engine' ? '' : `, engine_think_ms: ${AGENT_LEVELS[preferences.level].thinkMs}`;
  return `Call start_game with color: "${preferences.color}"${opponent}${think}.`;
}

/** The prompt that makes an agent play one game with the remote tools. */
export function remotePrompt(preferences: AgentPreferences, endpoint = 'https://chess.khalil.mageed.net/v1/mcp'): string {
  return [
    `Play one game of chess on kamkm chess using the ${MCP_SERVER_NAME} tools.`,
    `Use the Streamable HTTP MCP server at ${endpoint}. Connect it if needed. Use MCP for every move. Do not use GUI, browser tools or computer use. If your host cannot connect a server, POST MCP JSON-RPC requests from an HTTP client.`,
    'Call get_rules first and follow it.',
    `Set model_name to your exact model name and variant. ${startLine(preferences, 'remote')}`,
    'Immediately share the returned watch_url with me so I can open it and watch you play. Keep resume_token private.',
    ...(preferences.opponent !== 'engine' ? ['Send me the opponent_url to give to the other player or their agent. Wait for them to join before playing. Each invitation controls only its assigned color.'] : []),
    'On each turn read the input from the board, pick one move and call make_move with it and a short plan.',
    ...(preferences.askMe || preferences.color !== 'white' ? ['If you play Black, answer the first move quickly: the opening reply window is 15 seconds.'] : []),
    FAIRNESS,
    'Keep going until the game is over, then tell me the result in one line.',
  ].join(' ');
}

/** The prompt for a browser agent that drives this page's tools. */
export function pagePrompt(preferences: AgentPreferences, pageUrl: string): string {
  return remotePrompt(preferences, `${new URL(pageUrl).origin}/v1/mcp`);
}

/** The steps for one client. */
export function setupSteps(client: AgentClient, preferences: AgentPreferences, urls: { mcp: string | null; page: string }): SetupStep[] {
  if (urls.mcp === null) return [];
  const prompt = { label: 'Copy prompt', value: remotePrompt(preferences, urls.mcp) };
  const url = urls.mcp;
  switch (client) {
    case 'claude-code':
      return [
        { text: 'Add the chess server once, in a terminal:', copy: { label: 'Copy command', value: `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}` } },
        { text: 'Then start claude and paste:', copy: prompt },
      ];
    case 'codex':
      return [
        { text: 'Add the chess server once, in a terminal:', copy: { label: 'Copy command', value: `codex mcp add ${MCP_SERVER_NAME} --url ${url}` } },
        { text: 'Then start codex and paste:', copy: prompt },
      ];
    case 'claude-ai':
      return [
        { text: 'In claude.ai open Settings, then Connectors, then Add custom connector. Name it kamkm chess and use this URL:', copy: { label: 'Copy URL', value: url } },
        { text: 'Turn the connector on in a new chat and paste:', copy: prompt },
      ];
    case 'chatgpt':
      return [
        { text: 'In ChatGPT open Settings, then Apps & Connectors, turn on Developer mode under Advanced, and create a connector with this URL and no authentication:', copy: { label: 'Copy URL', value: url } },
        { text: 'Choose it in a new chat and paste:', copy: prompt },
      ];
    case 'mcp':
    case 'browser':
      return [
        { text: 'Add a remote (Streamable HTTP) MCP server. In Cursor, add this to .cursor/mcp.json:', copy: { label: 'Copy config', value: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url } } }, null, 2) } },
        { text: 'Then ask your agent:', copy: prompt },
      ];
  }
}

/** True when the service reports the remote MCP endpoint is on. */
export async function fetchMcpAvailability(apiOrigin: string | null, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (apiOrigin === null) return false;
  try {
    const response = await fetcher(`${apiOrigin.replace(/\/+$/, '')}/v1/online/features`, { credentials: 'omit' });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && (body as Record<string, unknown>).mcp === true;
  } catch {
    return false;
  }
}
