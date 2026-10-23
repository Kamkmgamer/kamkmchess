import { cleanAgentName } from './seat.js';

export type AgentSide = 'white' | 'black';

/** One agent turn, opened by the match while its controller fence is held. */
export interface AgentTurn {
  readonly turnId: string;
  readonly gameId: string;
  readonly side: AgentSide;
  /** The same compact JSON input an API model receives for this turn. */
  readonly input: unknown;
}

export interface AgentReply {
  readonly answerText: string;
}

export type AgentOutcome =
  | { readonly kind: 'accepted'; readonly move: string }
  | { readonly kind: 'illegal'; readonly message: string; readonly attemptsRemaining: number; readonly lost: boolean }
  | { readonly kind: 'format'; readonly message: string; readonly paused: boolean }
  | { readonly kind: 'resigned' }
  | { readonly kind: 'not-accepted'; readonly message: string };

export interface AgentGameView {
  readonly gameId: string;
  readonly agentSides: readonly AgentSide[];
  readonly sideToMove: AgentSide;
  readonly fen: string;
  readonly moves: string;
  readonly status: 'active' | 'finished' | 'waiting';
  readonly result: string | null;
  readonly clock: { readonly whiteMs: number; readonly blackMs: number; readonly incrementMs: number } | null;
}

export interface AgentStartOptions {
  readonly color: AgentSide | 'random';
  readonly opponent: 'engine' | 'human';
  readonly engineThinkMs: number;
}

/** What the open match page lets agents see and do. */
export interface AgentHost {
  view(): AgentGameView | null;
  /** Starts and opens the game, resolving with its ID. */
  startGame(options: AgentStartOptions): Promise<string>;
}

interface PendingTurn {
  readonly turn: AgentTurn;
  readonly resolve: (reply: AgentReply) => void;
  outcome: ((outcome: AgentOutcome) => void) | null;
}

const NAME_KEY = 'kamkmchess.agent-names.v1';
const storage = (): Storage | null => typeof window === 'undefined' ? null : window.localStorage;

/**
 * The page-lifetime meeting point between the match and an agent's tool calls.
 *
 * The match offers a turn and waits; a tool call answers it and waits for the
 * controller's verdict. Nothing here decides legality, clocks or results.
 */
export class AgentBridge {
  private host: AgentHost | null = null;
  private pending: PendingTurn | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly names = new Map<string, string>();

  attachHost(host: AgentHost): () => void {
    this.host = host;
    this.notify();
    return () => { if (this.host === host) { this.host = null; this.notify(); } };
  }

  view(): AgentGameView | null { return this.host?.view() ?? null; }

  startGame(options: AgentStartOptions): Promise<string> {
    if (!this.host) return Promise.reject(new Error('Open the kamkm chess game page (/play) to start a game.'));
    return this.host.startGame(options);
  }

  /** The current turn if the agent is to move in the open game. */
  currentTurn(): AgentTurn | null {
    const turn = this.pending?.turn ?? null;
    return turn && turn.gameId === this.view()?.gameId ? turn : null;
  }

  /** Called by the match: resolves when the agent replies, rejects when the turn is fenced. */
  offerTurn(turn: AgentTurn, signal: AbortSignal): Promise<AgentReply> {
    return new Promise<AgentReply>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason ?? new DOMException('Agent turn stopped.', 'AbortError')); return; }
      const pending: PendingTurn = { turn, resolve: (reply) => { signal.removeEventListener('abort', abort); resolve(reply); }, outcome: null };
      const abort = () => {
        if (this.pending === pending) this.pending = null;
        pending.outcome?.({ kind: 'not-accepted', message: 'The turn was stopped before the move was saved.' });
        this.notify();
        reject(signal.reason ?? new DOMException('Agent turn stopped.', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending = pending;
      this.notify();
    });
  }

  /** Called by the match once the controller has judged the reply of `turnId`. */
  settle(turnId: string, outcome: AgentOutcome): void {
    const pending = this.pending;
    if (pending?.turn.turnId !== turnId) return;
    this.pending = null;
    pending.outcome?.(outcome);
    this.notify();
  }

  /** Called by a tool: answer the open turn and wait for the controller's verdict. */
  submit(reply: AgentReply): Promise<AgentOutcome> {
    const pending = this.pending;
    if (!pending || pending.turn.gameId !== this.view()?.gameId) {
      return Promise.reject(new Error('It is not your turn. Call wait_for_turn first.'));
    }
    if (pending.outcome) return Promise.reject(new Error('A move for this turn is already being checked.'));
    return new Promise<AgentOutcome>((resolve) => {
      pending.outcome = resolve;
      pending.resolve(reply);
    });
  }

  /** Resolves when `ready` holds, the bridge changes and `ready` holds, or the timeout passes. */
  waitFor(ready: () => boolean, timeoutMs: number): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = (value: boolean) => { clearTimeout(timer); this.listeners.delete(check); resolve(value); };
      const check = () => { if (ready()) done(true); };
      const timer = setTimeout(() => done(ready()), timeoutMs);
      this.listeners.add(check);
    });
  }

  /** The match calls this after every committed change. */
  notify(): void { for (const listener of [...this.listeners]) listener(); }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  reportedName(gameId: string): string | null {
    const known = this.names.get(gameId);
    if (known !== undefined) return known;
    try {
      const names = JSON.parse(storage()?.getItem(NAME_KEY) ?? '{}') as Record<string, unknown>;
      return cleanAgentName(names[gameId]);
    } catch { return null; }
  }

  reportName(gameId: string, value: unknown): string | null {
    const name = cleanAgentName(value);
    if (name === null) return null;
    this.names.set(gameId, name);
    try {
      const names = JSON.parse(storage()?.getItem(NAME_KEY) ?? '{}') as Record<string, string>;
      // Keep the most recent games only; names are a display convenience, not game data.
      const kept = Object.entries({ ...names, [gameId]: name }).slice(-50);
      storage()?.setItem(NAME_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch { /* A name that cannot be remembered still applies to this page. */ }
    this.notify();
    return name;
  }
}

export const agentBridge = new AgentBridge();
