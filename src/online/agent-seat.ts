/**
 * The browser agent seat (KHA-73, KHA-77).
 *
 * An online agent seat is played by the browser. The provider runner of
 * `src/online/provider-runner.ts` owns the turn: it takes the lease, asks
 * the provider, submits the answer and settles the uncertain work. This
 * module is the browser half of that: it maps the canonical match state onto
 * the runner snapshot, resolves the provider destination from the browser
 * owned connection store, and creates the runner of one seat.
 *
 * The rules this module keeps:
 *
 * - The credential never leaves the browser. The provider destination and
 *   its headers are resolved here, from the connection store.
 * - The public label of the agent is the only identity the service receives.
 *   The private routing identity stays in the browser.
 * - The runner of one seat is per match and per seat. Two games run at the
 *   same time with two runners and two leases.
 */
import { createOnlineProviderRunner, createProtocolProviderPort, providerRunnerSnapshotFromView } from './provider-runner';
import type {
  OnlineProviderRunner,
  ProviderRunnerCommandPort,
  ProviderRunnerLeasePort,
  ProviderRunnerPendingStore,
  ProviderRunnerProviderPort,
  ProviderRunnerSnapshot,
  ProviderRunnerTarget,
} from './provider-runner';
import { getConnectionEndpoints } from '../providers/connections/profile.js';
import { readBoundCredentialValues } from '../providers/connections/credential-binding.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';
import type { ConnectionProtocol } from '../providers/connections/types.js';
import type { ProviderProtocol } from '../providers/protocols/types.js';
import type { ModelSelection } from '../controller/index.js';
import { onlineSideToMove } from './turn';
import type { Seat } from './contracts';
import type { OnlineMatchView } from './updates';

/**
 * Maps the canonical match state onto the runner snapshot.
 *
 * The mapping itself belongs to the provider runner: it owns the epochs, the
 * spent budgets and the declared control of the seat. The workspace adds one
 * thing: the side to move of the opening.
 *
 * The service arms no main clock before the first move and no clock at all
 * during the opening reply window, so the canonical answer can be empty in
 * both moments. The turn rule of `src/online/turn.ts` is the same rule the
 * interface and the browser engine use, so the runner, the interface and the
 * engine always agree about whose turn it is.
 */
export function providerRunnerSnapshot(view: OnlineMatchView, seat: Seat): ProviderRunnerSnapshot {
  const snapshot = providerRunnerSnapshotFromView(view, seat);
  const sideToMove = snapshot.sideToMove ?? onlineSideToMove(view);
  return { ...snapshot, sideToMove };
}

export interface OnlineAgentProviderOptions {
  /** The connection store that owns the browser credentials. */
  readonly connectionStore: Promise<ConnectionStore>;
  /**
   * The namespace of the connections of the active identity.
   *
   * The namespace is resolved when the request is built, so the provider
   * uses the connections of the signed-in account and never the guest
   * connections of another identity.
   */
  readonly resolveNamespace?: () => ConnectionNamespace;
  /** The namespace of the connections, when it never changes. */
  readonly namespace?: ConnectionNamespace;
  /** The private selection of the agent. It never leaves the browser. */
  readonly selection: ModelSelection;
}

/**
 * Builds the provider client of one agent.
 *
 * The destination and its credential headers are resolved from the browser
 * owned connection store for every request, so a rotated credential is used
 * at once.
 */
export function createAgentProviderPort(options: OnlineAgentProviderOptions): ProviderRunnerProviderPort {
  return createProtocolProviderPort({
    async resolveTarget(): Promise<ProviderRunnerTarget> {
      const namespace = options.resolveNamespace?.() ?? options.namespace ?? { kind: 'guest' };
      const connections = await options.connectionStore;
      const profile = await connections.getProfile(namespace, options.selection.connectionId);
      if (!profile) throw new Error('The model connection was removed.');
      const credentials = await connections.resolveCredentials(namespace, profile);
      if (credentials.status !== 'bound') {
        throw new Error('The model connection is not authorized.');
      }
      const values = readBoundCredentialValues(credentials.credentials);
      const endpoints = getConnectionEndpoints(profile);
      const headers: Record<string, string> = {};
      if (values.apiKey) headers.authorization = `Bearer ${values.apiKey}`;
      for (const [name, value] of Object.entries(values.headers ?? {})) headers[name.toLowerCase()] = value;
      for (const header of profile.headers) {
        // A header of the profile either carries its own value or names the
        // credential field that holds it.
        const named = 'value' in header ? header.value : values.headers?.[header.name];
        if (typeof named === 'string') headers[header.name.toLowerCase()] = named;
      }
      return {
        protocol: toProviderProtocol(profile.protocol),
        model: options.selection.modelRoutingId,
        url: endpoints.generationUrl,
        headers,
        generation: { maxOutputTokens: 512, temperature: 0.2 },
      };
    },
  });
}

/** Maps a connection protocol onto the protocol of the shared encoders. */
function toProviderProtocol(protocol: ConnectionProtocol): ProviderProtocol {
  if (protocol === 'messages') return 'anthropic-messages';
  return protocol;
}

export interface OnlineAgentSeatOptions {
  readonly matchId: string;
  readonly seat: Seat;
  /** The public label of the agent this seat plays. */
  readonly publicModelLabel: string;
  /** The lease client of this seat. */
  readonly leases: ProviderRunnerLeasePort;
  /** The command client of this match. */
  readonly commands: ProviderRunnerCommandPort;
  /** The provider client of this agent. */
  readonly provider: ProviderRunnerProviderPort;
  /**
   * The pending record of the seat.
   *
   * The record belongs to the seat and not to one runner, so a runner that
   * replaces another one still sees the request that may be running and never
   * asks the provider for a second answer by itself.
   */
  readonly pending?: ProviderRunnerPendingStore;
  /** The instructions of the match. */
  readonly instructions?: string;
}

/**
 * Creates the browser runner of one agent seat.
 *
 * The runner owns the turn. The interface only feeds it the canonical state
 * and shows its decisions.
 */
export function createOnlineAgentSeat(options: OnlineAgentSeatOptions): OnlineProviderRunner {
  return createOnlineProviderRunner({
    matchId: options.matchId,
    seat: options.seat,
    publicModelLabel: options.publicModelLabel,
    leases: options.leases,
    commands: options.commands,
    provider: options.provider,
    ...(options.pending ? { pending: options.pending } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
  });
}
