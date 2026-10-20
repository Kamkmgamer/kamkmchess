/**
 * The own-agent readiness check (KHA-77).
 *
 * An agent seat may enter the queue only when the selected connection and the
 * selected model are usable right now. The check runs in the browser: the
 * provider credential never leaves the browser and the service never learns
 * which route or which model the owner selected.
 *
 * The rules this module keeps:
 *
 * - The check uses the existing compatibility diagnostic of the opponent
 *   service, so the queue and the offline game agree on what "ready" means.
 * - A missing connection, a missing credential or a failed diagnostic blocks
 *   the entry. The owner may retry or play themselves.
 * - The public label of the agent is chosen by the owner and is the only
 *   thing the service ever receives.
 */
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';
import type { OpponentService } from '../opponents/index.js';
import type { ModelSelection } from '../controller/index.js';
import type { OnlineAgentCheck } from './readiness.js';

export interface OnlineAgentReadinessOptions {
  /** The opponent service that owns the compatibility diagnostic. */
  readonly opponentService: OpponentService | Promise<OpponentService>;
  /** The connection store that owns the browser credentials. */
  readonly connectionStore: Promise<ConnectionStore>;
  /** The namespace of the connection store. */
  readonly namespace: ConnectionNamespace;
}

/**
 * The readiness check of one selected model.
 *
 * The check never sends a provider request that the offline game would not
 * send: it reuses the same diagnostic.
 */
export function createAgentReadinessCheck(options: OnlineAgentReadinessOptions): (selection: ModelSelection) => Promise<OnlineAgentCheck> {
  return async (selection: ModelSelection): Promise<OnlineAgentCheck> => {
    try {
      const connections = await options.connectionStore;
      const profile = await connections.getProfile(options.namespace, selection.connectionId);
      if (!profile) {
        return { ready: false, detail: 'The model connection was removed.' };
      }
      const credentials = await connections.resolveCredentials(options.namespace, profile);
      if (credentials.status !== 'bound') {
        return { ready: false, detail: 'The model connection is not authorized.' };
      }
      const service = await options.opponentService;
      const result = await service.runCompatibilityDiagnostic({
        profileId: profile.id,
        modelId: selection.modelRoutingId,
      });
      if (result.evidence.state !== 'passed-current-session') {
        return { ready: false, detail: result.evidence.detail || 'The model check did not pass.' };
      }
      return { ready: true, detail: '' };
    } catch (error) {
      return {
        ready: false,
        detail: error instanceof Error ? error.message : 'The model check failed.',
      };
    }
  };
}
