# KHA-37 runner and archive API

This is the shared runner/controller API contract for the KHA-37 implementation. It keeps the existing `runGenerationTurn(options)` entry point for UI wiring.

## Controller-owned request archive

`GameController.appendModelTurnArchive(fence, entry)` is the only path used by the generation runner to persist provider traffic. Each call is a fenced serialized controller intent and one atomic IndexedDB checkpoint transaction. It must finish before the runner reports the entry as locally saved. Request bodies contain the exact encoded destination body, never `RequestInit.headers`, URL credentials, or a resolved credential value. Response entries contain exact received byte chunks, including bytes that are not understood by the current decoder.

Each append creates a new append-only archive event and chunk. The request event carries the request ID, protocol, model attribution, request kind and usage context. Response chunks remain raw byte chunks. A terminal event records completed/partial/failed/aborted status, normalized received assistant history, and provider-native usage. History messages are attributed to the producing provider/model and current line. Unknown protocol fields remain in archived raw bytes and opaque assistant records; replay treats unknown roles as quoted data and never invents private state.

An append is accepted only while its request fence remains current. A rejected or stale append cannot change the checkpoint or archive. No network wait occurs inside a storage transaction. Undo moves event references and history disposition with the retained line; immutable archive events/chunks stay available for inspection. Credential-echo detection continues to quarantine all implicated records and block export/sync.

## Results and consumption

`runGenerationTurn` continues to return `completed`, `interrupted`, `capacity-rejected`, or `not-started`. Its `persistence` value now reports the durable local state (`saved-locally`, `saved-locally-quarantined`, `not-saved`, or `not-applicable`) instead of the old placeholder. `getGenerationJournal(snapshot)` returns retained and discarded event/message references from a stored game snapshot for UI transcript/cost views. Usage is request-scoped and remains `unknown` when usage or rate data is unavailable; no fixed rates or synthetic cache claim are added.

The runner never persists credentials or headers and never retries a network request. Native/live provider calls are outside this implementation and require separate authorization.
