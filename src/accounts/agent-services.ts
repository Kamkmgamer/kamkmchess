/**
 * The provider services of the own agent.
 *
 * The compatibility diagnostic of a model resolves the connection, the
 * credential and the disclosure of a **namespace**. The service of a namespace
 * is therefore the service that belongs to it: the diagnostic of a signed-in
 * account must never read the credentials of the guest connections, not even
 * when both use the same profile id.
 */
import type { OpponentService } from '../opponents/index.js';
import type { ConnectionNamespace } from '../providers/connections/index.js';

export interface AgentServiceSet {
  /** The service of the guest connections. */
  readonly guest: OpponentService | Promise<OpponentService>;
  /**
   * The service of the active account.
   *
   * It is null when the account has no service yet, so the caller fails
   * closed instead of reading another identity's connections.
   */
  readonly account?: OpponentService | Promise<OpponentService> | null;
}

/**
 * The service that belongs to a namespace.
 *
 * The answer is null when the namespace has no service, so the caller never
 * falls back to the service of another identity.
 */
export function agentServiceForNamespace(
  services: AgentServiceSet,
  namespace: ConnectionNamespace,
): OpponentService | Promise<OpponentService> | null {
  if (namespace.kind === 'guest') return services.guest;
  return services.account ?? null;
}
