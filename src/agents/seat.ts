import type { ModelSelection } from '../controller/index.js';
import type { PlayerSelectionV1 } from '../storage/index.js';

/** Reserved provider ID for a seat played by an agent through this page's tools. */
export const PAGE_AGENT_PROVIDER = 'page-agent';
export const AGENT_DEFAULT_NAME = 'Agent';
/** Agents act through tool calls that take seconds each, so agent games default to the longest clock. */
export const AGENT_TIME_CONTROL = { minutes: 180, incrementSeconds: 60 } as const;

export function isAgentSelection(selection: PlayerSelectionV1): selection is ModelSelection & { providerId: typeof PAGE_AGENT_PROVIDER } {
  // Like browser engines, agents reuse the v1 automated-player record under a reserved provider ID,
  // so the controller, storage and archives need no new seat kind.
  return selection.kind === 'model' && selection.providerId === PAGE_AGENT_PROVIDER;
}

export function createAgentSelection(): ModelSelection {
  return { kind: 'model', providerId: PAGE_AGENT_PROVIDER, connectionId: 'page-tools', configurationRevision: 1,
    modelRoutingId: AGENT_DEFAULT_NAME, protocol: 'custom', diagnostic: 'passed-current-session' };
}

/** Agent names are self-reported; keep them short and printable before they reach the board. */
export function cleanAgentName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 60);
  return name.length > 0 ? name : null;
}
