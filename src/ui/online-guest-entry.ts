/**
 * The guest entry of the online screen (KHA-75).
 *
 * A published invitation link opens the online screen in a browser that has
 * no account shell. The account shell publishes the private model catalog of
 * the owner, and the guest path has no shell, so the entry publishes it here.
 *
 * The rules this module keeps:
 *
 * - The online composition of the guest path owns the browser owned
 *   connection store and the namespace of the guest. The agent of an
 *   accepted seat therefore runs through the store of this browser and never
 *   through the store of another identity.
 * - The private catalog is read from that store. Nothing of it reaches the
 *   service, and the public label of an entry is the only thing the service
 *   ever learns about a model.
 * - The offline game keeps its own layout. The entry opens the online screen
 *   and nothing else.
 */
import { createOnlineComposition } from '../online/composition.js';
import type { OnlineComposition } from '../online/composition.js';
import { readPrivateAgentCatalog } from '../accounts/agent-catalog.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';
import type { ModelSelection } from '../controller/index.js';
import type { OnlineAgentCheck } from '../online/readiness.js';

export interface GuestOnlineCompositionOptions {
  /** The trusted service origin. */
  readonly baseUrl: string;
  /** The local search string of the page. */
  readonly search?: string;
  /** The transport of the service. The global transport is used when it is absent. */
  readonly fetch?: typeof fetch;
  /** The browser owned connection store of this browser. */
  readonly connectionStore: Promise<ConnectionStore>;
  /** The namespace of the connections of the guest. */
  readonly namespace: ConnectionNamespace;
  /** Prepares the browser Stockfish 19 Lite engine. */
  readonly prepareEngine?: () => Promise<void>;
  /** The own-agent readiness check of a selected model. */
  readonly checkModel?: (selection: ModelSelection) => Promise<OnlineAgentCheck>;
}

/**
 * Creates the online composition of a guest browser.
 *
 * The composition owns the connection store and the namespace of the guest.
 * Without them the browser never runs the agent of an accepted seat, because
 * the agent seat resolves its provider destination and its credential from
 * that store.
 */
export function createGuestOnlineComposition(options: GuestOnlineCompositionOptions): OnlineComposition {
  return createOnlineComposition({
    baseUrl: options.baseUrl,
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.prepareEngine ? { prepareEngine: options.prepareEngine } : {}),
    ...(options.checkModel ? { checkModel: options.checkModel } : {}),
    connectionStore: options.connectionStore,
    resolveNamespace: () => options.namespace,
  });
}

/**
 * Publishes the private model catalog of the guest to the composition.
 *
 * The catalog names every model the owner may play. The composition resolves
 * a choice of a seat by the private identity of the catalog entry, so two
 * private models that share a public label stay two models.
 */
export async function publishGuestAgentCatalog(
  online: OnlineComposition,
  options: { readonly connectionStore: Promise<ConnectionStore>; readonly namespace: ConnectionNamespace },
): Promise<void> {
  const entries = await readPrivateAgentCatalog(options);
  online.setAgentCatalog(entries.map(entry => ({ id: entry.id, label: entry.label, selection: entry.selection })));
  // The own agent of the guest is the first connected model. The screen asks
  // the owner for another one when the seat of a match needs it.
  const chosen = entries[0] ?? null;
  online.setAgent(chosen ? { label: chosen.label, selection: chosen.selection } : null);
}
