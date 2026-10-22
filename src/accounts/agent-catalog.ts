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
 * 2. The label of an entry is a public name the service knows. A name the
 *    service does not know is a private routing identity or an alias of the
 *    owner, so it is published as the neutral name and never as itself. The
 *    name the provider advertises stays with the owner and is never
 *    published.
 */
import type { ModelSelection } from '../controller/index.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';
import { controllerRevisionForConfig } from '../ui/opponent-selection.js';

/** The neutral public name of a model whose public name the service does not know. */
export const NEUTRAL_AGENT_LABEL = 'Custom model';

/**
 * The public model names the service knows.
 *
 * The list mirrors the allowlist of the service (the migration
 * `0013_online_public_history.sql`): the key is the model key the service
 * looks up, the value is the public name it publishes. A model that is not
 * here is a private routing identity until its owner chooses a public label,
 * so it is published as the neutral name.
 */
const KNOWN_PUBLIC_MODEL_LABELS: Readonly<Record<string, string>> = {
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o mini',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4.1-mini': 'GPT-4.1 mini',
  'gpt-5': 'GPT-5',
  'gpt-5-mini': 'GPT-5 mini',
  'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
  'claude-3-5-haiku': 'Claude 3.5 Haiku',
  'claude-3-7-sonnet': 'Claude 3.7 Sonnet',
  'claude-sonnet-4': 'Claude Sonnet 4',
  'claude-opus-4': 'Claude Opus 4',
  'gemini-1.5-pro': 'Gemini 1.5 Pro',
  'gemini-1.5-flash': 'Gemini 1.5 Flash',
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
  'grok-2': 'Grok 2',
  'grok-2-latest': 'Grok 2 latest',
  'kimi-k2': 'Kimi K2',
  'llama-3.3-70b': 'Llama 3.3 70B',
  'deepseek-r1': 'DeepSeek R1',
  'qwen3-235b': 'Qwen3 235B',
  'stockfish-19-lite': 'Stockfish 19 Lite (browser)',
};

/**
 * The public label of one model.
 *
 * The model key is looked up in the list the service knows. An unknown key is
 * a private routing identity, so the neutral name is published instead of it.
 */
export function publicAgentLabel(modelKey: string): string {
  const key = modelKey.trim().toLowerCase();
  return KNOWN_PUBLIC_MODEL_LABELS[key] ?? NEUTRAL_AGENT_LABEL;
}

/** One connected model of the owner. */
export interface PrivateAgentEntry {
  /**
   * The stable private identity of the selection.
   *
   * The id never leaves the browser and is never derived from a public label.
   */
  readonly id: string;
  /** The public label of the model. The service knows this name. */
  readonly label: string;
  /**
   * The name the provider advertises.
   *
   * It is shown to the owner only. It never reaches the service, so a name
   * that is not public may be shown here.
   */
  readonly displayName: string;
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
  const candidates: { profile: Awaited<ReturnType<ConnectionStore['getProfile']>>; modelId: string; displayName: string; label: string }[] = [];
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
        // The name the provider advertises is shown to the owner only.
        displayName: (entry.displayName ?? '').trim() || entry.id,
        // The public label is the name the service knows. An unknown model is
        // published as the neutral name.
        label: publicAgentLabel(entry.id),
      });
    }
  }
  return candidates.map(candidate => {
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
      label: candidate.label,
      displayName: candidate.displayName,
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

/**
 * The catalog entry of a binding.
 *
 * A binding is reported by its public label. The label resolves an entry only
 * when it is unique, so two private models that share a public label are
 * never confused with each other.
 */
export function privateAgentEntryForBinding(
  entries: readonly PrivateAgentEntry[],
  binding: string | null,
): PrivateAgentEntry | null {
  if (!binding) return null;
  const byId = entries.find(entry => entry.id === binding);
  if (byId) return byId;
  const byLabel = entries.filter(entry => entry.label === binding);
  return byLabel.length === 1 ? byLabel[0]! : null;
}

/**
 * Whether the owner may put a model on the seat.
 *
 * The answer compares the private identities, never the labels: the model
 * that already plays the seat is not offered again, and every other model of
 * the owner stays available, also the one that plays the new games.
 *
 * A seat whose binding cannot be resolved to one entry (two private models
 * share a public label) keeps every model available: the rebind is the
 * explicit choice of the owner and it is idempotent.
 */
export function seatChoiceAvailable(input: {
  /** The model the owner wants to play on the seat. */
  readonly entry: PrivateAgentEntry;
  /** The model the seat plays now, if it plays one. */
  readonly bound: PrivateAgentEntry | null;
  /** True when the binding of the seat names more than one model. */
  readonly ambiguous?: boolean;
}): boolean {
  if (!input.bound || input.ambiguous) return true;
  return input.bound.id !== input.entry.id;
}
