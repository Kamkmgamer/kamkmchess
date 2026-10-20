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
import { createOnlineProviderRunner, createProtocolProviderPort } from './provider-runner';
import type {
  OnlineProviderRunner,
  ProviderRunnerCommandPort,
  ProviderRunnerLeasePort,
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
import type { Seat } from './contracts';
import type { OnlineMatchView } from './updates';

/**
 * Maps the canonical match state onto the runner snapshot.
 *
 * The side to move is the seat that owes the opening reply, else the seat the
 * active clock names, else the side the canonical position names. The runner
 * acts on the same turn the service does.
 */
export function providerRunnerSnapshot(view: OnlineMatchView, seat: Seat): ProviderRunnerSnapshot & { readonly seatControlEpoch: number } {
  const seatView = view.seats.find(candidate => candidate.seat === seat);
  const replySeat = view.clock.replySeat;
  const activeSeat = view.clock.activeSeat;
  const positionSide = view.positionFen.split(' ')[1] === 'b' ? 'black' : 'white';
  const sideToMove = replySeat ?? activeSeat ?? positionSide;
  return {
    matchId: view.matchId,
    version: view.version,
    controlEpoch: view.controlEpoch,
    // The per-seat epoch of the canonical view. The match-wide epoch never
    // replaces it: the seat binding owns the epoch of the runner.
    seatControlEpoch: seatView?.controlEpoch ?? view.controlEpoch,
    status: view.status,
    sideToMove,
    positionFen: view.positionFen,
    startingFen: view.startingFen,
    moves: view.moves.map(move => move.uci),
    clock: {
      whiteMs: view.clock.whiteMs,
      blackMs: view.clock.blackMs,
      incrementMs: view.timeControl.incrementMs,
    },
    seatControl: {
      kind: seatView?.control.kind ?? 'agent',
      ...(seatView?.control.kind === 'agent' || seatView?.control.kind === 'engine'
        ? { modelLabel: seatView.control.modelLabel ?? 'Agent' }
        : {}),
    },
    illegalAttemptsSpent: seatView?.illegalAttemptsSpent ?? 0,
    formatCorrectionsSpent: seatView?.formatCorrectionsSpent ?? 0,
  };
}

export interface OnlineAgentProviderOptions {
  /** The connection store that owns the browser credentials. */
  readonly connectionStore: Promise<ConnectionStore>;
  /** The namespace of the connection store. */
  readonly namespace: ConnectionNamespace;
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
      const connections = await options.connectionStore;
      const profile = await connections.getProfile(options.namespace, options.selection.connectionId);
      if (!profile) throw new Error('The model connection was removed.');
      const credentials = await connections.resolveCredentials(options.namespace, profile);
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
    ...(options.instructions ? { instructions: options.instructions } : {}),
  });
}
