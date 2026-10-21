/**
 * The private model catalog of the owner.
 *
 * The catalog is read from the browser owned connection store: every saved
 * connection of the namespace whose credential is bound, and every model that
 * connection currently advertises. Nothing here reaches the service.
 *
 * Two rules make the catalog safe:
 *
 * 1. The identity of an entry is its own stable private id. The id is a local
 *    hash of the connection, the configuration revision, the routing id and the
 *    protocol. It is never a public label and never a public routing id, so
 *    two private models that the service canonicalizes to the same public
 *    label stay two different models.
 * 2. The label of an entry is a public-safe display name. It is derived from
 *    the name the provider advertises, never from a routing id, a connection
 *    nickname or a credential. Two entries that would share a label get a
 *    local ordinal, so the label stays usable as a local key while the
 *    service still publishes its own canonical form of it.
 */
import type { ModelSelection } from '../controller/index.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';
import { controllerRevisionForConfig } from '../ui/opponent-selection.js';

/** The neutral public name of a model whose provider advertises no name. */
export const NEUTRAL_AGENT_LABEL = 'Custom model';

/** One connected model of the owner. */
export interface PrivateAgentEntry {
  /**
   * The stable private identity of the selection.
   *
   * The id never leaves the browser and is never derived from a public label.
   */
  readonly id: string;
  /** The public-safe label the owner sees. */
  readonly label: string;
  /** The private selection. It never leaves the browser. */
  readonly selection: ModelSelection;
  /** The connection the model belongs to. */
  readonly connectionId: string;
}

export interface PrivateAgentCatalogOptions {
  /** The browser owned connection store. */
  readonly connectionStore: Promise<ConnectionStore>;
  /** The namespace the connections live in. */
  readonly namespace: ConnectionNamespace;
}

/**
 * The stable private identity of one selection.
 *
 * The identity is a hash of the private facts of the selection, so it stays
 * the same across reloads and it never carries a public name.
 */
export function privateAgentId(selection: ModelSelection): string {
  const material = [
    selection.connectionId,
    String(selection.configurationRevision),
    selection.modelRoutingId,
    selection.protocol,
  ].join('\u0000');
  let hash = 0xcbf29ce484222325n;
  for (const character of material) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `agent-${hash.toString(16).padStart(16, '0')}`;
}

/**
 * Keeps a label inside the shape a shared model label may have.
 *
 * A route, a path or a credential never survives this filter.
 */
export function publicSafeAgentLabel(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9 ._'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : '';
}

/**
 * The unique labels of the catalog.
 *
 * The first entry of a name keeps the name. The next ones get a local
 * ordinal, so two private models never share one local key.
 */
export function uniqueAgentLabels(names: readonly string[]): string[] {
  const used = new Set<string>();
  const labels: string[] = [];
  for (const name of names) {
    const base = name.length > 0 ? name : NEUTRAL_AGENT_LABEL;
    let label = base;
    let ordinal = 1;
    while (used.has(label)) {
      ordinal += 1;
      const suffix = ` ${ordinal}`;
      label = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    }
    used.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * Reads the private model catalog of the owner.
 *
 * A connection without a bound credential is not offered: the browser could
 * not play it. A model that the provider no longer advertises is not offered
 * either.
 */
export async function readPrivateAgentCatalog(options: PrivateAgentCatalogOptions): Promise<readonly PrivateAgentEntry[]> {
  const store = await options.connectionStore;
  const profiles = [...await store.listProfiles(options.namespace)]
    .sort((left, right) => left.id.localeCompare(right.id));
  const candidates: { profile: Awaited<ReturnType<ConnectionStore['getProfile']>>; modelId: string; name: string }[] = [];
  for (const profile of profiles) {
    const credentials = await store.resolveCredentials(options.namespace, profile);
    if (credentials.status !== 'bound') continue;
    const snapshot = await store.getCatalogSnapshot(options.namespace, profile);
    if (!snapshot) continue;
    const advertised = snapshot.entries
      .filter(entry => entry.state === 'advertised')
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const entry of advertised) {
      candidates.push({
        profile,
        modelId: entry.id,
        name: publicSafeAgentLabel(entry.displayName ?? '') || NEUTRAL_AGENT_LABEL,
      });
    }
  }
  const labels = uniqueAgentLabels(candidates.map(candidate => candidate.name));
  return candidates.map((candidate, index) => {
    const profile = candidate.profile!;
    const selection: ModelSelection = {
      kind: 'model',
      providerId: profile.provider,
      connectionId: profile.id,
      configurationRevision: controllerRevisionForConfig(profile.configRevision),
      modelRoutingId: candidate.modelId,
      protocol: profile.protocol,
      diagnostic: 'not-run',
    };
    return {
      id: privateAgentId(selection),
      label: labels[index]!,
      selection,
      connectionId: profile.id,
    };
  });
}

/**
 * The catalog entry of one selection.
 *
 * The answer is null when the selection is not connected any more, so the
 * owner is asked to choose again instead of playing a removed model.
 */
export function privateAgentEntryFor(
  entries: readonly PrivateAgentEntry[],
  selection: ModelSelection | null,
): PrivateAgentEntry | null {
  if (!selection) return null;
  const id = privateAgentId(selection);
  return entries.find(entry => entry.id === id) ?? null;
}
