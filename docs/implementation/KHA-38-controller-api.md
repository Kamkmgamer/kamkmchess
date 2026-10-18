# KHA-38 controller model handoff API

This contract adds durable, fenced mid-game model selection to the existing controller and generation runner. It is an extension of the KHA-37 runner/archive API and preserves the existing `runGenerationTurn(options)` entry point.

## Controller registry scope

`GameControllerOptions.registryScope` binds the in-memory single-writer registry key to both a stable logical store namespace and `gameId`. It defaults to `guest` for compatibility. UI composition must pass a stable namespace key (for example `JSON.stringify(namespace)`) when a guest and account store can contain the same preserved game ID. Do not use a fresh/random store instance ID: two controllers for the same physical database and namespace must still collide and prevent concurrent writers.

`prepareOwnershipTakeover(checkpoint, newEpoch)` is the pure local adoption boundary for an accepted cloud checkpoint that still carries its previous owner epoch. It returns a checkpoint with a strictly newer ownership epoch, revision, request generation, and analysis generation. It clears producing state, returns an awaiting candidate to queued state, and rebinds every adjudication query while clearing its search checkpoint and active request ID. Chess position, result, history, clocks, and archive references remain unchanged. Callers persist this returned checkpoint atomically in the destination store; the original cloud checkpoint bytes remain available in the separate cloud snapshot record.

## Persisted state and snapshot

The controller stores a version 1 `model-handoff` extension in `GameCheckpointV1.extensions`. It contains the model currently committed for the model side, the model identity used by the active request (if any), and one optional queued candidate. Each identity is a full `ModelSelection` (provider, connection, numeric connection revision, routing model ID, protocol, and current-session diagnostic state). The snapshot exposes the same status as `snapshot.modelHandoff`: `committed`, `producing`, `queued` (with `queued | awaiting-first-reply | failed`), and `failure` where applicable. On old checkpoints the extension is absent; the controller derives `committed` from the current model player selection and exposes no queued candidate.

## Intents and methods

`queue-model-selection(fence, candidate)` targets the game's model-controlled side and can be called while either player is to move, including during the human's turn. It requires an unresolved game, matching current fence, and a `passed-current-session` diagnostic. It atomically persists the candidate and a `model-selection-queued` event while sampling/reconciling the running clock. Repeating the committed selection clears a queued candidate; selecting the current queued candidate is idempotent; another valid candidate replaces it. A human move leaves the candidate queued. `cancel-model-selection(fence)` clears the candidate. `resume-prior-model(fence)` clears a failed/queued candidate and leaves the committed model selected. `retry-model-selection(fence)` returns a failed candidate to queued state. All are serialized controller mutations, not UI-authoritative updates.

`begin-model-turn` consumes `queued` as the producing model for this request but does not change the checkpoint's committed player selection. Its result includes `request.selection`. It sets `producing` and the candidate state to `awaiting-first-reply` in the same transaction as request start. The runner resolves profile/configuration and credential bindings from this returned selection, and still checks the UI-provided expected profile configuration hash before sending. Current-model turns use the committed selection. Full retained history is composed the same way for either selection.

`GenerationRunnerOptions.expectedProfileConfigRevision` accepts either the existing hash string or a `(selection) => hash` resolver. UI wiring should resolve the hash captured alongside that selection's current-session diagnostic; the runner must not derive it from `configurationRevision` or reuse the old model's hash for a different profile.

A complete, interpretable answer or refusal from the producing candidate commits the candidate selection and new history segment atomically with the model effect. An interpretable illegal move also commits selection before recording the violation; its violation counter begins at the fresh candidate turn budget. A format failure, interrupted stream, provider/profile/credential failure, or unverifiable capacity failure keeps the prior committed selection and leaves the candidate failed/blocked with a recoverable reason. Recovery is explicit through Retry, Replace (queue another candidate), or Resume prior model. No hidden diagnostic request occurs during play. A fresh explicit diagnostic remains required before a candidate can be queued.

## Fencing and history

Queue, cancel, retry, resume, request start, and model effects each use the existing serial atomic checkpoint mutation path. They sample the continuous clock and can resolve expiry/reconciliation before applying the requested intent. Stop, Undo/takeback/branching, segment replacement, expiry/finalization, restored ownership changes, and stale fences invalidate producing callbacks. A callback cannot commit candidate state after its request fence is no longer current. Undo moves archive event/history references to the discarded line using existing retention rules; immutable raw request/response archive data stays inspectable. Switching starts a new history segment only when a candidate first produces an interpretable real reply. The segment retains the prior conversation for inspection and attributes subsequent messages to the new provider/model. Model requests use [compact chess state](../spec/compact-model-input.md), including current committed moves, rather than the conversation archive.

No provider network wait is performed inside a storage transaction. Existing request body, raw response chunk, terminal usage/history, credential redaction/quarantine, and append-only archive behavior remain unchanged. Provider failures do not auto-retry or fall back to another model.

## Runner result

The normal runner result shape remains backward compatible. `begin-model-turn` supplies the producing selection, and completion/failure dispatches carry the request fence and structured answer classification needed by the controller to settle the candidate. Snapshot consumers can render committed, producing, and queued identities separately. KHA-40 UI recovery controls can call cancel/retry/resume and can replace a candidate by queueing another selection.

## Deterministic coverage

Controller/runner fixtures cover cross-provider selection, queued candidate replacement and cancellation, an old-model request completing while a candidate is queued, candidate formatting/provider failure and explicit resume, successful interpretable reply promotion, illegal reply budget reset, and Undo invalidating late callbacks while retaining discarded archive/history references. Tests use local synthetic provider streams only; no live provider calls or real diagnostic handoff are part of this contract.
