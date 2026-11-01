import type { AgentBridge, AgentGameView, AgentOutcome } from './bridge.js';
import { AGENT_INSTRUCTIONS } from './turn.js';

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  execute(input: Record<string, unknown>): Promise<unknown>;
}

const MAX_WAIT_MS = 120_000;
const MOVE_WAIT_MS = 60_000;

export const AGENT_RULES = {
  summary: 'Standard chess, played on the open kamkm chess page. The page checks every move; you only ever see the position.',
  instructions: AGENT_INSTRUCTIONS,
  flow: [
    'start_game creates a game against Stockfish (or a person at this screen), or join_seat takes the agent seat of a game set up on the page.',
    'get_board shows the position. When status is your-turn, input is exactly what an API model would receive.',
    'make_move plays one move — optionally arming conditional premoves for a reply you are confident of — and waits for the reply; wait_for_turn waits when you play Black or the opponent is slow.',
  ],
  limits: 'Four illegal moves in one turn lose the game. Three badly formatted replies pause the game. Clocks run while you think: agent games default to 180 minutes plus 60 seconds per move.',
  fairness: 'Do not run code, a chess engine or any analysis tool. Do not ask for legal moves; none are listed.',
} as const;

type BoardStatus = 'your-turn' | 'opponent-turn' | 'finished' | 'no-game' | 'no-agent-seat';

function board(bridge: AgentBridge, view: AgentGameView | null = bridge.view()) {
  if (!view) return { status: 'no-game' as BoardStatus, hint: 'Call start_game, or set up a game with an agent seat on the page.' };
  const turn = bridge.currentTurn();
  const status: BoardStatus = view.agentSides.length === 0 ? 'no-agent-seat'
    : view.status === 'finished' ? 'finished' : turn ? 'your-turn' : 'opponent-turn';
  return {
    status, gameId: view.gameId, yourSide: view.agentSides.length === 1 ? view.agentSides[0] : view.agentSides,
    agentName: bridge.reportedName(view.gameId), fen: view.fen,
    // The full SAN history is already in `input` on the agent's turn. Keep a
    // count in the outer board envelope so every tool result does not repeat
    // the same history alongside that input.
    moveCount: view.moves.trim() === '' ? 0 : view.moves.trim().split(/\s+/).length,
    sideToMove: view.sideToMove,
    clock: view.clock, result: view.result,
    ...(turn ? { input: turn.input } : {}),
    ...(status === 'no-agent-seat' ? { hint: 'The open game has no agent seat. Call start_game for a new one.' } : {}),
  };
}

function outcomeMessage(outcome: AgentOutcome): string {
  switch (outcome.kind) {
    case 'accepted': return `Played ${outcome.move}.`;
    case 'illegal': return outcome.lost ? `${outcome.message} That was the fourth illegal move, so the game is lost.`
      : `${outcome.message} ${outcome.attemptsRemaining} illegal attempt${outcome.attemptsRemaining === 1 ? '' : 's'} left this turn. Choose again.`;
    case 'format': return outcome.paused ? `${outcome.message} The game is paused until someone presses Retry on the page.` : outcome.message;
    case 'resigned': return 'You resigned.';
    case 'not-accepted': return outcome.message;
  }
}

function waitForAgentTurnOrEnd(bridge: AgentBridge, timeoutMs: number) {
  return bridge.waitFor(() => bridge.currentTurn() !== null || bridge.view()?.status === 'finished' || !bridge.view(), timeoutMs);
}

function seconds(value: unknown, fallbackMs: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(MAX_WAIT_MS, value * 1000)) : fallbackMs;
}

export function createAgentTools(bridge: AgentBridge): AgentTool[] {
  const submit = async (answer: Record<string, unknown>) => {
    const outcome = await bridge.submit({ answerText: JSON.stringify(answer) });
    if (outcome.kind === 'accepted' || (outcome.kind === 'illegal' && !outcome.lost)) {
      if (outcome.kind === 'accepted') await waitForAgentTurnOrEnd(bridge, MOVE_WAIT_MS);
      else await waitForAgentTurnOrEnd(bridge, 5_000);
    }
    return { result: outcome.kind, message: outcomeMessage(outcome), board: board(bridge) };
  };
  return [
    {
      name: 'get_rules', description: 'Read how kamkm chess games work for agents: the move format, budgets, clocks and fairness rules. Call this first.',
      inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
      execute: () => Promise.resolve(AGENT_RULES),
    },
    {
      name: 'start_game',
      description: 'Start a new game on this page with you as the agent. The opponent is Stockfish by default, or a person at this screen.',
      inputSchema: { type: 'object', properties: {
        model_name: { type: 'string', description: 'Your exact model and variant, e.g. "Claude Opus 5.5". Shown on the board as self-reported.' },
        color: { type: 'string', enum: ['white', 'black', 'random'], default: 'white' },
        opponent: { type: 'string', enum: ['engine', 'human'], default: 'engine' },
        engine_think_ms: { type: 'integer', minimum: 100, maximum: 10000, default: 1000, description: 'Stockfish thinking time per move. Higher is stronger.' },
      }, required: ['model_name'] },
      async execute(input) {
        const color = input.color === 'black' || input.color === 'random' ? input.color : 'white';
        const opponent = input.opponent === 'human' ? 'human' : 'engine';
        const think = typeof input.engine_think_ms === 'number' && Number.isFinite(input.engine_think_ms)
          ? Math.round(Math.max(100, Math.min(10_000, input.engine_think_ms))) : 1000;
        const gameId = await bridge.startGame({ color, opponent, engineThinkMs: think });
        bridge.reportName(gameId, input.model_name);
        await waitForAgentTurnOrEnd(bridge, 5_000);
        return board(bridge);
      },
    },
    {
      name: 'join_seat', description: 'Take the agent seat of the game currently open on the page, for example one a person set up as Human versus agent.',
      inputSchema: { type: 'object', properties: { model_name: { type: 'string', description: 'Your exact model and variant. Shown as self-reported.' } }, required: ['model_name'] },
      async execute(input) {
        // A game the person just started may not have reached the page yet.
        await bridge.waitFor(() => (bridge.view()?.agentSides.length ?? 0) > 0, 5_000);
        const view = bridge.view();
        if (!view || view.agentSides.length === 0) return board(bridge, view);
        bridge.reportName(view.gameId, input.model_name);
        return board(bridge);
      },
    },
    {
      name: 'get_board', description: 'Read the open game: status, your side, the position and, on your turn, the exact input an API model would receive.',
      inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
      execute: () => Promise.resolve(board(bridge)),
    },
    {
      name: 'make_move', description: 'Play one move on your turn, optionally arming conditional pre-moves, then wait up to a minute for the opponent\'s reply.',
      inputSchema: { type: 'object', properties: {
        move: { type: 'string', description: 'Coordinate form: from and to squares, e.g. e2e4; append q, r, b or n to promote, e.g. e7e8q.' },
        plan: { type: 'string', description: 'A brief plan of at most 80 words; you will get it back next turn.' },
        premoves: {
          type: 'array', maxItems: 8,
          description: 'Optional conditional pre-moves armed with this move: when the opponent\'s next move is one of on, then is played automatically without a new turn. Use only for replies you are confident of; an armed move is dropped silently when the position no longer allows it.',
          items: {
            type: 'object', properties: {
              on: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'Opponent replies in coordinate form, e.g. ["e7e5", "b8c6"].' },
              then: { description: 'Your coordinate move, e.g. "g1f3", or {"move": "g1f3", "premoves": [...]} to plan one level deeper.' },
            }, required: ['on', 'then'],
          },
        },
      }, required: ['move'] },
      execute(input) {
        const plan = typeof input.plan === 'string' && input.plan.trim() ? input.plan.trim() : undefined;
        return submit({
          move: typeof input.move === 'string' ? input.move.trim() : input.move,
          ...(plan === undefined ? {} : { plan }),
          ...(input.premoves === undefined ? {} : { premoves: input.premoves }),
        });
      },
    },
    {
      name: 'wait_for_turn', description: 'Wait until it is your turn or the game ends, up to the timeout (default 60 seconds, at most 120).',
      inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number', minimum: 0, maximum: 120 } } }, annotations: { readOnlyHint: true },
      async execute(input) {
        await waitForAgentTurnOrEnd(bridge, seconds(input.timeout_seconds, MOVE_WAIT_MS));
        return board(bridge);
      },
    },
    {
      name: 'resign', description: 'Resign the game on your turn. This is final.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => submit({ resign: true }),
    },
  ];
}

/** Every call returns a result object; failures become readable errors instead of exceptions. */
export async function callAgentTool(tools: readonly AgentTool[], name: string, input: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, error: `Unknown tool ${name}. Tools: ${tools.map((candidate) => candidate.name).join(', ')}.` };
  try {
    const args = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    return { ok: true, result: await tool.execute(args) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
