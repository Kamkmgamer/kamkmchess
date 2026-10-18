# KHA-38 opponent API handoff

The service is implemented in `src/opponents/service.ts`. UI code should import only from `src/opponents/index.ts`.

## Construction

```ts
new OpponentService({
  connections: ConnectionStore,
  namespace: ConnectionNamespace,
  fetch: (url, init) => Promise<Response>,
  sessionId?: string,
  now?: () => number,
  idFactory?: () => string,
})
```

Construction and selection staging do not send requests. A new instance gets a random session ID by default, so a reload/device change cannot reuse this instance's diagnostic evidence. Tests may inject IDs and time.

## Catalog and exact IDs

- `refreshCatalog(profileId: string, signal?: AbortSignal): Promise<CatalogViewV1>` explicitly checks the saved catalog route through `ConnectionStore` and `checkConnection`, following provider pagination up to its page limit. It records partial/stale snapshots so old advertised entries remain visible with their state. A failed refresh preserves previous entries; a complete refresh marks removed IDs `not-advertised`. `cooldownUntilMs` is derived from provider `retry-after` evidence when available. A missing catalog remains manually selectable.
- `getCatalog(profileId: string): Promise<CatalogViewV1>` reads the scoped cached snapshot without network access.
- `addManualModel(profileId: string, modelId: string): Promise<string>` validates with `createManualModelReference`; empty or surrounding-whitespace IDs reject. Case, punctuation, and Unicode are retained as entered. Catalog display metadata adds no capability claim.

`CatalogViewV1` exposes `profileId`, catalog `state`, entries with advertised/stale/not-advertised state, checked/success timestamps, optional next URL/error, cooldown time, this service instance's manual IDs, and an empty `capabilityClaims` tuple.

## Diagnostic

```ts
runCompatibilityDiagnostic(
  input: { profileId: string; modelId: string },
  signal?: AbortSignal,
): Promise<DiagnosticResultV1>
```

This is the only service method that sends a generation request. It requires current disclosure consent, a bound credential, and a route classified as normal or conditional research. It sends exactly one non-stream-retried request with a synthetic prior assistant plan containing a unique `KAMKM-PRIOR-PLAN-*` token, followed by a unique `KAMKM-COMPAT-*` prompt asking for fixed `e2e4`, retrieval of the preceding plan token, and the response marker. The prior-plan token occurs only in the prior assistant record, never in the latest user request. It uses the existing protocol encoder/stream decoder and a separate 256-token diagnostic budget. No diagnostic text or budget enters match history or controller state. Local failures before fetch report `requestCount: 0`; a fetch attempt reports one request and is never automatically retried.

`DiagnosticResultV1.evidence` records `state`, exact `requestedModelId`, optional `reportedModelId`, profile/configuration revision, credential revision, protocol, service session ID, diagnostic ID, request count, completion time and explanation. `passed-current-session` means only that this exact request returned the expected structured coordinate and both unique markers through the observed route. `capabilityClaims` stays empty; an alias/report does not certify all backends. Temporary errors do not pass. `prepareSelection` requires a pass matching the exact current profile revision, credential revision, protocol, model ID and service session.

## Queued candidate handoff

- `setCommittedSelection(identity: OpponentIdentityV1 | null): void` and `setProducingSelection(identity: OpponentIdentityV1 | null): void` initialize the service's view of controller attribution.
- `prepareSelection({ profileId, modelId }): Promise<HandoffSnapshotV1>` requires current passing evidence. It queues/replaces a candidate, or cancels the queue when the unchanged committed identity is reselected. It does not alter the controller's selection.
- `producingReplySettled(): HandoffSnapshotV1` moves the queued candidate to `awaiting-first-reply` after the old producing request settles.
- `settleCandidateReply(candidateId, { answerText, complete, content, position? }): ProducingReplyV1` classifies a completed candidate reply with the shared move parser. Only an interpretable move or explicit resignation qualifies the identity for application. A formatting failure leaves the candidate failed/blocked. The controller must still atomically apply selection and normal move/refusal/illegal effects with its request fence; this service does not own controller authority.
- `failCandidate(candidateId, reason)` marks the candidate blocked. `recoverCandidate('retry' | 'replace' | 'resume-prior')` supports explicit retry or prior-model recovery. `getSnapshot()` reads the state; `subscribe(listener)` observes updates and returns an unsubscribe function.

`HandoffSnapshotV1` separates `committed`, `queued`, and `producing` identities. The UI should render controller committed state as authoritative and use the service snapshot for staging/diagnostic detail. Controller work is required to add a serialized, fenced model-switch intent that applies the service-qualified candidate; do not call `setCommittedSelection` as a substitute for controller persistence.
