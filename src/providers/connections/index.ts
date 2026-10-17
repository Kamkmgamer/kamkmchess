export { createConnectionProfile, getConnectionEndpoints, reviseConnectionProfile, validateEndpointUrl } from './profile';
export type { ConnectionProfileChanges, CreateConnectionProfileInput, CustomConnectionInput, PresetConnectionInput } from './profile';
export { createManualModelReference } from './model-id';
export type { ManualModelReference } from './model-id';
export { classifyConnectionRoute } from './route-scope';
export type { ConnectionRouteEvidence, ConnectionRouteKind, ConnectionRouteScope } from './route-scope';
export { checkConnection } from './catalog';
export type { CatalogCheckResult, CatalogModel, CheckConnectionOptions } from './catalog';
export { updateCatalogSnapshot } from './catalog-cache';
export { createFirstRequestDisclosure, hasCurrentDisclosureConsent, recordDisclosureChoice } from './disclosure';
export type { DisclosureChoice, DisclosureLink, FirstRequestDisclosure } from './disclosure';
export type {
  CatalogPagination,
  CachedCatalogEntry,
  CachedCatalogEntryState,
  CachedCatalogError,
  CachedCatalogState,
  ConnectionAuth,
  ConnectionCredentials,
  ConnectionEndpoints,
  ConnectionCatalogSnapshot,
  ConnectionErrorCode,
  ConnectionHeader,
  ConnectionNamespace,
  ConnectionProfile,
  ConnectionProtocol,
  ConnectionProvider,
} from './types';
export { ConnectionError } from './types';
export { prepareCatalogRequest, prepareGenerationRequest } from './requests';
export type { PreparedProviderRequest } from './requests';
export { createConnectionStore, namespaceKey, openConnectionStore } from './store';
export type { ConnectionStore } from './store';
export type { OpenConnectionStoreOptions } from './indexeddb';
export type {
  BoundConnectionCredentials,
  ConnectionPersistence,
  CredentialResolution,
  DisclosureDecision,
  DisclosureDecisionRecord,
  StoredCredentialRecord,
} from './types';
