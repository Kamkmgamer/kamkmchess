# Cloud schema

The KHA-41 migration is `supabase/migrations/20261016000100_owner_only_cloud_storage.sql`. It stores an exact versioned `GameCheckpointV1`, exact versioned `CloudArchiveBatchV1` bytes, and owner ordering metadata. PostgreSQL checks storage shape, identity, digests, and CAS ordering. It never decides chess legality, creates a chess result, or relays AI credentials.

The migration creates seven private tables and six public RPCs. All seven tables force row-level security. The RPCs are the only browser access path.

## Access and payload boundary

The browser calls public RPCs with a Supabase publishable key and the signed-in user's session. Each RPC obtains the owner from `auth.uid()`. Only the `authenticated` role can execute the six public cloud RPCs. Every private table forces row-level security with an `owner_id = auth.uid()` policy. Browser roles and `service_role` have no direct table privileges. Security-definer functions pin their search path and enable row security.

The schema contains no credential columns or endpoint configuration. Checkpoints have an exact field allowlist and empty `extensions`; the namespace must be `account` and its `accountId` must equal `auth.uid()`. The submitted checkpoint text remains unchanged, including its local epoch and client timestamps. The SQL parser rejects duplicate object keys before converting input to JSONB. It rejects unknown checkpoint and result shapes, unsupported versions, non-finite numeric values, and checkpoint quarantine markers.

Archive event payloads and raw chunk bytes are untrusted application data. SQL checks each versioned record's structural fields, egress marker, sequence range, outer batch digest, and inner chunk digest. It preserves arbitrary event payload fields and the original validated batch bytes. It cannot scan raw chunks for a user's secret values or replace KHA-28's local credential echo scan and persistent quarantine. The browser must block quarantined checkpoint, event, or chunk data before serializing a request.

SQL checks quarantine status only at the checkpoint, event, and chunk `egressStatus` fields. It preserves marker-like text in history and arbitrary event payloads as data. Exact checkpoint field allowlists reject nested endpoint and credential configuration fields.

## Revision, epoch, and result rules

`accepted_revision` is the greatest accepted local checkpoint revision. Create accepts revision N, including 31, and stores one checkpoint and its initial archive batch. The cloud ownership row starts at epoch 1 while the submitted checkpoint remains at epoch 0. A later local checkpoint adopts the acknowledged epoch. Takeover advances only the cloud epoch and leaves the stored checkpoint unchanged.

A commit checks expected epoch before expected revision. It accepts checkpoint revision M when M is greater than the accepted base, so local revisions can coalesce between cloud writes. It stores only the submitted checkpoint and does not invent the skipped rows. The checkpoint, batch, watermarks, final-result latch, ownership revision, and operation response update in one transaction.

`unresolved` and `pending-adjudication` are mutable checkpoint results. Only `result.kind = 'final'` populates `final_result`. Pending facts may change before a later final is committed. SQL compares final values as JSONB, so whitespace and object key order do not change semantic equality. A changed or cleared final fails with SQLSTATE `55000`. The final reason allowlist includes `stalemate`, which requires `winner = 'draw'` in checkpoint results, practice original results, and the separate `final_result` argument. Pending reasons retain the accepted storage list. These checks persist the client's result shape. They do not decide chess outcomes.

## Archive batches and reads

Every accepted checkpoint stores one `CloudArchiveBatchV1` envelope. Create uses a null base revision and base epoch 0. A null lower sequence bound includes sequence zero. A null upper bound represents an empty archive range. Non-null bounds describe values greater than the lower bound and at or below the upper bound. Gaps are valid. An empty commit range retains a known non-null high-water as both bounds. The exact batch bytes have an outer SHA-256 digest; each included chunk keeps its own SHA-256 over the source bytes.

The batch validator decodes the digest-bound bytes, rejects duplicate JSON keys before JSONB conversion, and checks the encoded game ID, base revision and epoch, checkpoint revision, and sequence ranges against the RPC CAS and stored watermarks. It retains the original bytes. The client does not send a second header argument that could disagree with the batch.

`cloud_read_game(game_id, after_revision, include_checkpoint, page_limit, through_revision, target_epoch, target_checkpoint_sha256)` returns a bounded page. The first call passes null target fields and receives a frozen target revision, epoch, and checkpoint digest. Later pages echo those three target fields. The function returns only batches through that target. A same-epoch cloud advance does not change the target. A takeover, deletion, or unavailable checkpoint causes a detectable conflict or tombstone so the client can restart. Reads do not return the full checkpoint history or operation ledger. A tombstone response is a payload-free deletion receipt with the delete operation ID.

`cloud_read_operation(game_id, operation_id)` resolves a lost acknowledgment for the authenticated owner. It takes the operation advisory lock and then a shared game lock. Mutations take the operation lock and then the exclusive game lock. Deletion rewrites all operation results to payload-free receipts and removes live checkpoint, batch, and archive identity rows. A lookup ordered before deletion may return its original response; the local tombstone and request fence must reject a late response. A lookup ordered after deletion and any matching retry return a deletion-safe receipt. The operation ID and request digest remain so changed input cannot reuse the ID. Tombstoned game IDs cannot be recreated.

## Public RPCs

All RPCs return JSON. Mutations require UUID operation IDs. The client must pass canonical lower-case UUIDs for cloud-eligible game and operation IDs without coercing arbitrary local strings.

| RPC | Purpose |
| --- | --- |
| `cloud_create_game(game_id, schema_version, operation_id, initial_checkpoint_dto, initial_batch_base64, initial_batch_sha256_hex)` | Stores the exact checkpoint at local revision N, starts cloud epoch 1, and atomically stores the bootstrap batch. |
| `cloud_commit_game(game_id, schema_version, expected_revision, expected_epoch, operation_id, batch_base64, batch_sha256_hex, checkpoint_dto, final_result)` | Applies a sequence delta and sparse checkpoint revision M where M is greater than the expected revision. |
| `cloud_takeover_game(game_id, schema_version, acknowledged_revision, expected_epoch, operation_id)` | Advances the cloud epoch at the latest accepted revision without rewriting the checkpoint. |
| `cloud_delete_game(game_id, schema_version, expected_revision, expected_epoch, operation_id)` | Writes a permanent tombstone, deletes live game payload, and changes all saved responses into deletion receipts. |
| `cloud_read_operation(game_id, operation_id)` | Returns one owner-scoped stored operation response, not-found, or deletion-safe receipt. |
| `cloud_read_game(game_id, after_revision, include_checkpoint, page_limit, through_revision, target_epoch, target_checkpoint_sha256)` | Returns the optional checkpoint and a bounded page for a frozen target. |

Create uses a generic SQLSTATE `23505` error when the game ID or operation ID is unavailable, so it does not reveal which identifier collided. The commit RPC reports changed input for a previously used operation ID with SQLSTATE `23505`. Failed validation, CAS, ownership, digest, or tombstone checks roll back the transaction.

## Verification status

The current source fixture is `supabase/tests/kha41_cloud_storage.sql`. It contains 132 pgTAP assertion calls covering public RPC behavior and permission boundaries with the accepted checkpoint and batch shapes. It calls `no_plan()` and `finish()`; 132 is a source count, not a declared plan.

The separate local SQL lane ran source `f8a8b2013e25c155319923f436107d30a1ed947a` unmodified with PGlite 0.5.10, PostgreSQL 18.6, and pgTAP 1.3.3. The recorded run passed all 132 assertions and 16 direct RPC probes; `npm test` exited zero. The runner applies the committed migration and fixture without transformations. The [local evidence](../implementation/KHA-41-local-evidence.md) records hashes, environment, probe observations, and earlier failures. Run it from `supabase/tests/local/` with `npm ci --ignore-scripts --no-audit --no-fund` followed by `npm test`.

Earlier source revisions exposed fixture syntax, metadata-role, request-encoding and expected-value errors, plus a schema-variable collision in the commit RPC. Those failures and their corrections remain in the evidence history. PGlite uses one in-memory connection and does not verify multi-session races.

All 79 product acceptance checks remain not run. No hosted Supabase database, real two-account denial check, deployed direct-write bypass check, multi-session race, browser bundle, backup restore, native, or assistive-technology run is claimed. No deployment or credential access was used. KHA-41 remains open for KHA-28 adapter integration and the later deployed gates.

## KHA-28 integration boundary

The SQL validator maps the accepted `GameCheckpointV1` fields directly: namespace, local revision and ownership epoch, segment and three generation values, client update time, rules, history, clocks, budgets, selections, archive references, result, practice data, and extensions. It does not rewrite checkpoint text, timestamps, generations, or the submitted epoch. Create stores local epoch 0 and cloud epoch 1; a later checkpoint may adopt the acknowledged cloud epoch. Pending results remain mutable. Only `result.kind = 'final'` populates the semantic final latch. Empty extensions are accepted; nonempty unregistered extensions fail with an explicit validation error.

This change does not add a TypeScript RPC adapter or wire cloud calls into KHA-28, KHA-42, or KHA-43. KHA-32 still needs to register any nonempty checkpoint extension mapping before the client can send it; this migration accepts empty extensions and rejects nonempty unregistered extensions. The client must validate canonical lowercase game and operation UUIDs before RPC calls. It must scan full checkpoint, event, and chunk data before serialization and retain credential-echo quarantine after key removal. SQL cannot recognize secrets in exact raw chunks. Deployed two-account and direct-write checks still need their assigned evidence runs.
