/**
 * Copy-ready setup for playing kamkm chess with your own agent.
 *
 * Two routes exist. A browser agent (Claude in Chrome, a WebMCP browser) uses
 * the tools this page registers. Any MCP client (Claude Code, Codex,
 * claude.ai, ChatGPT, Cursor) uses the server's remote MCP endpoint, which is
 * only offered when the service reports it is on.
 */

export type AgentClient = 'claude-code' | 'codex' | 'claude-ai' | 'chatgpt' | 'mcp' | 'browser';
export type AgentOpponent = 'engine' | 'human';
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
  { id: 'browser', label: 'Claude in Chrome', remote: false },
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

const FAIRNESS = 'Choose every move yourself: do not run code, a chess engine or any analysis tool.';

function startLine(preferences: AgentPreferences, tools: 'remote' | 'page'): string {
  if (preferences.askMe) {
    const opponentQuestion = tools === 'page' ? ' whether I want to play you myself or watch you play Stockfish,' : '';
    return `Before you start, ask me${opponentQuestion} which color you should play (white, black or random) and how strong Stockfish should be (casual 100 ms, club 1000 ms or strong 5000 ms per move). Then call start_game with my answers.`;
  }
  const opponent = tools === 'page' && preferences.opponent === 'human' ? ', opponent: "human"' : '';
  const think = tools === 'page' && preferences.opponent === 'human' ? '' : `, engine_think_ms: ${AGENT_LEVELS[preferences.level].thinkMs}`;
  return `Call start_game with color: "${preferences.color}"${opponent}${think}.`;
}

/** The prompt that makes an agent play one game with the remote tools. */
export function remotePrompt(preferences: AgentPreferences): string {
  return [
    `Play one game of chess on kamkm chess using the ${MCP_SERVER_NAME} tools.`,
    'Call get_rules first and follow it.',
    `Set model_name to your exact model name and variant. ${startLine(preferences, 'remote')}`,
    'On each turn read the input from the board, pick one move and call make_move with it and a short plan.',
    ...(preferences.askMe || preferences.color !== 'white' ? ['If you play Black, answer the first move quickly: the opening reply window is 15 seconds.'] : []),
    FAIRNESS,
    'Keep going until the game is over, then tell me the result in one line.',
  ].join(' ');
}

/** The prompt for a browser agent that drives this page's tools. */
export function pagePrompt(preferences: AgentPreferences, pageUrl: string): string {
  const watch = preferences.opponent === 'human' && !preferences.askMe ? ' I will play the other side on the board myself.' : '';
  return [
    `Open ${pageUrl} and play one game of chess there.${watch}`,
    'The page exposes its game tools to agents: use them through WebMCP if your browser offers it, or run JavaScript in the page such as await window.kamkmChessAgent.call("get_rules", {}).',
    'Call get_rules first and follow it.',
    `Set model_name to your exact model name and variant. ${startLine(preferences, 'page')}`,
    'On your turn call get_board, pick one move from its input and call make_move with the move and a short plan; use wait_for_turn while the opponent thinks.',
    FAIRNESS,
    'Keep going until the game is over, then tell me the result in one line.',
  ].join(' ');
}

/** The steps for one client. */
export function setupSteps(client: AgentClient, preferences: AgentPreferences, urls: { mcp: string | null; page: string }): SetupStep[] {
  if (client === 'browser') {
    return [
      { text: 'Open Claude in Chrome (or any browser agent) and paste this. It plays on this site through the page tools, so nothing is installed.', copy: { label: 'Copy prompt', value: pagePrompt(preferences, urls.page) } },
    ];
  }
  if (urls.mcp === null) return [];
  const prompt = { label: 'Copy prompt', value: remotePrompt(preferences) };
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
