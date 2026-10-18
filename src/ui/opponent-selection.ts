import type { ModelSelection } from '../controller/index.js';
import type { OpponentIdentityV1 } from '../opponents/index.js';

export function controllerRevisionForConfig(revision: string): number {
  let hash = 0xcbf29ce484222325n;
  for (const character of revision) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return Number(hash & 0x1fffffffffffffn);
}

export function matchesOpponentSelection(identity: OpponentIdentityV1 | null | undefined, selection: ModelSelection): boolean {
  return identity !== null && identity !== undefined && identity.profileId === selection.connectionId &&
    identity.modelId === selection.modelRoutingId && identity.protocol === selection.protocol &&
    controllerRevisionForConfig(identity.configRevision) === selection.configurationRevision;
}
