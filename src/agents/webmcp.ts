import type { AgentBridge } from './bridge.js';
import { callAgentTool, createAgentTools } from './tools.js';
import type { AgentTool } from './tools.js';

interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute(input: Record<string, unknown>): Promise<string>;
}
interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): unknown;
}

/** The plain-JavaScript surface for agents that script the page, such as Claude in Chrome. */
export interface PageAgentApi {
  readonly version: 1;
  readonly tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[];
  call(name: string, input?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

declare global {
  interface Window { kamkmChessAgent?: PageAgentApi }
}

function modelContext(): ModelContext | null {
  // Chrome's WebMCP preview has exposed the API on both objects while the proposal settles.
  const candidates = [(document as unknown as { modelContext?: unknown }).modelContext, (navigator as unknown as { modelContext?: unknown }).modelContext];
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && typeof (candidate as ModelContext).registerTool === 'function') return candidate as ModelContext;
  }
  return null;
}

/**
 * Exposes the agent tools through WebMCP when the browser supports it, and always on
 * `window.kamkmChessAgent`. Returns a function that removes both.
 */
export function registerAgentTools(bridge: AgentBridge, tools: readonly AgentTool[] = createAgentTools(bridge)): () => void {
  const unregister = new AbortController();
  const context = modelContext();
  if (context) {
    for (const tool of tools) {
      try {
        const registered = context.registerTool({
          name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          execute: async (input) => JSON.stringify(await callAgentTool(tools, tool.name, input)),
        }, { signal: unregister.signal });
        if (registered instanceof Promise) registered.catch(() => undefined);
      } catch { /* An unsupported preview build still leaves the window API. */ }
    }
  }
  const api: PageAgentApi = {
    version: 1,
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call: (name, input = {}) => callAgentTool(tools, name, input),
  };
  window.kamkmChessAgent = api;
  return () => {
    unregister.abort();
    if (window.kamkmChessAgent === api) delete window.kamkmChessAgent;
  };
}
