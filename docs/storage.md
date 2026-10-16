# Local storage and game archives

KHA-28 owns `src/storage/` and `src/archive/`. The local database uses schema version 1 and the public DTOs live in `src/storage/types.ts` and `src/archive/types.ts`.

## Stored data

Each checkpoint contains its guest or account namespace, rules, history, both clocks, budgets, player selections, archive pointers, result state, practice state, game and request revisions, ownership epoch, and versioned extension sections. Updates preserve the existing namespace; a local checkpoint write cannot move a cached account game into the guest namespace. Rules counters remain decimal strings. The repetition ledger stores every identity and its exact occurrence count as a decimal string. A FEN alone is not a restorable checkpoint.

Archive events record event order, normalized metadata, whether receipt completed, and references to raw chunks. Chunks keep the original bytes in `Uint8Array` form with receive order, a final-chunk marker, and a SHA-256 digest. Current and discarded line references live in the checkpoint. Undo or branch changes update those references while old events and chunks remain append-only.

An outbox row holds only an operation ID, game ID and namespace, checkpoint revision, ownership epoch, state, and sync result metadata. It has no game payload, credential, token, or endpoint. A sync worker reads the committed game and builds an allowlisted export DTO after the local transaction closes.

## Commit and recovery

`GameStore.commitCheckpoint` clones archive records, computes chunk digests, and marks known credential echoes before opening its read-write transaction. It then reads the stored checkpoint and archive rows, compares the expected revision and epoch, samples decision time, and calls the synchronous decision hook. The hook returns a complete versioned checkpoint plus outbox operation IDs. The checkpoint, new event and chunk rows, and outbox rows commit together.

The hook cannot return a promise or thenable. A thrown error, invalid result, quota error, or transaction abort rejects the commit. A revision or epoch mismatch returns a conflict without calling the hook. A save is durable only after IndexedDB reports transaction completion. Seeing a journal event without a completed checkpoint transaction never counts as an accepted move.

The storage layer performs no network work in a transaction. A sync caller reads the committed state, closes that transaction, performs its request, then records success or failure in a separate short transaction. Outbox IDs are idempotent. Reusing an ID for a different checkpoint is rejected.

Quota, upgrade-blocked, upgrade-failed, and abort errors remain visible as storage errors. The caller can keep the active position in memory, but the status reports `memory-only` or `failed` until a later save completes. The adapter never truncates history or removes old branches to fit storage.

`requestPersistentStorage` reports unsupported, granted, denied, or failed. `status(gameId)` reports local durability separately from sync state. Local status is `memory-only`, `saved-locally` with a revision, or `failed` with the last saved revision. Sync status is not configured, pending, blocked, failed, or current. A local write does not imply a synced revision.

## Export, import, and credential echoes

`exportGameArchive` creates the versioned `kamkmchess.game-archive` DTO from allowlisted checkpoint fields, ordered events, and base64-encoded exact chunk bytes. `validateGameArchive` checks the format, required sections, event and chunk order, references, receive completeness, and chunk digests. `GameStore.importGameArchive` validates the full DTO before writing the checkpoint and all archive rows in one transaction. It will not overwrite an existing local game ID.

When a configured credential appears in a received event, raw chunk, or checkpoint string, the affected event/chunk and checkpoint receive the credential-free `credential-echo-quarantined` marker. If a store export recognizes an echo for the first time, it persists the aggregate checkpoint marker and blocks pending outbox rows before returning the generic export error. The exact received bytes stay local. The marker survives reload and remains even if the credential is forgotten or rotated. It blocks export and new outbox work. This ticket does not provide a UI action to clear quarantine; removing a key does not count as resolving an echo.

Credentials live outside game, export, and sync DTOs. Errors report a generic credential-echo message and never include the matched value. The storage adapter does not redact the only copy of a received response.

## Crash limits

Provider bytes first exist in the page process. A browser crash, tab close, or power loss after bytes arrive but before the transaction commits can lose those bytes. Once the transaction completes, the exact committed chunks and event order can be read back. IndexedDB can still be evicted or deleted, and private browsing may discard it when the session ends. A persistent-storage request may be denied. The application must not promise unconditional retention.

Archive import validates storage and DTO integrity, not chess legality. Before resuming a restored position, the controller must pass its rules checkpoint through the approved strict rules and repetition-ledger restore APIs. This module does not replace rules validation.

## KHA-28 verification record

The fixture commands below verify deterministic local behavior only. They do not pass the native-browser, private-session, eviction, accessibility, cloud, or live-provider acceptance runs. The matrix in `docs/spec/mvp-acceptance.json` remains `not_run` until the coordinator records those subruns.

| Trace | Method and expected result | Observed result | Artifacts |
| --- | --- | --- | --- |
| DAT-01, HIS-05 | `npm test -- src/archive/archive.test.ts src/storage/storage.test.ts`; checkpoint and exact bytes round-trip, event order and partial receipt stay visible, and aborted writes are not accepted. | Pass: 15 tests passed. Full checkpoint state, exact multibyte/duplicate-field bytes, unknown payload fields, discarded lines, lost-ack recovery, and abort/quota failure status are covered. | [archive fixtures](../src/archive/archive.test.ts), [storage fixtures](../src/storage/storage.test.ts) |
| DAT-02 | Injected IndexedDB factory and storage manager; request status reports injected results and quota/blocked-upgrade fixtures leave no false saved checkpoint. | Pass: fixture suite covers unsupported/granted/denied/failed persistence requests, blocked upgrade, quota abort, transaction abort, and memory/local/sync status. Native-browser quota/upgrade, eviction, private-session, and crash-window exercises remain unrun. | [storage fixtures](../src/storage/storage.test.ts) |
| DAT-08 | Canary echo fixtures; recognized content stays exact, export fails without leaking the canary, pending outbox work is blocked, and key removal plus reload does not clear quarantine. | Pass: fixtures cover commit-time and export-time recognition, export after key removal, and persisted quarantine reload. | [archive fixtures](../src/archive/archive.test.ts), [storage fixtures](../src/storage/storage.test.ts) |
| Build | `npm run check` runs lint, the full test suite, `npm run build`, both TypeScript projects, Vite production build, and distribution notice generation. | Pass: lint passed, 15 tests passed, typecheck passed, Vite 8.3.4 built `dist/`, and distribution notices were written. This is a local build check only. | [built entry point](../dist/index.html), `dist/assets/` |
