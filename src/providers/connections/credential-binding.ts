import { ConnectionError } from './types';
import type { BoundConnectionCredentials, ConnectionCredentials } from './types';

const credentialsByBinding = new WeakMap<BoundConnectionCredentials, ConnectionCredentials>();
const bindingScopes = new WeakMap<BoundConnectionCredentials, BindingGeneration>();
const generationsByOwner = new WeakMap<object, BindingGenerations>();

interface BindingGeneration {
  readonly owner: object;
  readonly namespaceKey: string;
  readonly profileId: string;
  readonly ownerGeneration: object;
  readonly namespaceGeneration: object;
  readonly profileGeneration: object;
}

interface BindingGenerations {
  owner: object;
  readonly namespaces: Map<string, object>;
  readonly profiles: Map<string, object>;
}

export function createCredentialBindingOwner(): object {
  const owner = {};
  generationsByOwner.set(owner, { owner: {}, namespaces: new Map(), profiles: new Map() });
  return owner;
}

export function revokeProfileBindings(owner: object, namespaceKey: string, profileId: string): void {
  const generations = getGenerations(owner);
  const key = profileKey(namespaceKey, profileId);
  generations.profiles.set(key, {});
}

export function revokeNamespaceBindings(owner: object, namespaceKey: string): void {
  const generations = getGenerations(owner);
  generations.namespaces.set(namespaceKey, {});
}

export function revokeAllBindings(owner: object): void {
  const generations = getGenerations(owner);
  generations.owner = {};
}

export function captureCredentialBindingGeneration(
  owner: object,
  namespaceKey: string,
  profileId: string,
): BindingGeneration {
  const generations = getGenerations(owner);
  return {
    owner,
    namespaceKey,
    profileId,
    ownerGeneration: generations.owner,
    namespaceGeneration: generations.namespaces.get(namespaceKey) ?? initialGeneration,
    profileGeneration: generations.profiles.get(profileKey(namespaceKey, profileId)) ?? initialGeneration,
  };
}

export function bindCredentialValues(
  metadata: BoundConnectionCredentials,
  values: ConnectionCredentials,
  generation: BindingGeneration,
): BoundConnectionCredentials {
  if (!isCurrentBinding(generation)) throw revokedBindingError();
  const bound = Object.freeze({ ...metadata });
  bindingScopes.set(bound, generation);
  const copiedValues = {
    ...(values.apiKey === undefined ? {} : { apiKey: values.apiKey }),
    ...(values.headers === undefined ? {} : { headers: Object.freeze({ ...values.headers }) }),
  };
  credentialsByBinding.set(bound, Object.freeze(copiedValues));
  return bound;
}

export function readBoundCredentialValues(bound: BoundConnectionCredentials): ConnectionCredentials {
  const values = credentialsByBinding.get(bound);
  const scope = bindingScopes.get(bound);
  if (!values || !scope || !isCurrentBinding(scope)) throw revokedBindingError();
  return values;
}

function isCurrentBinding(scope: BindingGeneration): boolean {
  const generations = generationsByOwner.get(scope.owner);
  if (!generations) return false;
  return generations.owner === scope.ownerGeneration
    && (generations.namespaces.get(scope.namespaceKey) ?? initialGeneration) === scope.namespaceGeneration
    && (generations.profiles.get(profileKey(scope.namespaceKey, scope.profileId)) ?? initialGeneration) === scope.profileGeneration;
}

function getGenerations(owner: object): BindingGenerations {
  let generations = generationsByOwner.get(owner);
  if (!generations) {
    generations = { owner: {}, namespaces: new Map(), profiles: new Map() };
    generationsByOwner.set(owner, generations);
  }
  return generations;
}

const initialGeneration = {};

function profileKey(namespaceKey: string, profileId: string): string {
  return JSON.stringify([namespaceKey, profileId]);
}

function revokedBindingError(): ConnectionError {
  return new ConnectionError('credential-destination-mismatch', 'The local credential binding is no longer available. Assign this connection on this device.');
}
