# Shared online state and command contracts

This note records the boundaries, schema, and transaction rules added by
[KHA-65](https://linear.app/kamkm/issue/KHA-65/add-shared-online-state-transactional-commands-and-operation-receipts).
It describes the local foundation only: there is no public HTTP route, stream, queue allocator, or
deployment change in this slice. Acceptance scenarios `ARC-02`, `ARC-03`, and `ARC-04` remain
`not_run` until the integrated service and staging exercise exist.

## Ownership boundary

Shared online matches are separate from the private single-owner sync archive:

| Concern | Private archive (`0001_storage.sql`) | Shared online state (`0002_online.sql`) |
| --- | --- | --- |
| Owner | One account or guest namespace | Two independent participants |
| Writer | Existing Go storage API | `backend/online` transaction service |
| Visibility | Owner-only | Participant-only live state; allowlisted completed replay |
| Retention | Existing sync/deletion rules | Online removal markers and projections |
| Foreign keys | Existing private relationships | None into private tables |

`backend/online` never reads or writes `games`, `archive_chunks`, `archive_events`, `operations`, or
`deletion_tombstones`. The online tables have no foreign keys into those tables. Provider
credentials, raw provider requests, model conversations, private endpoints, and owner archives are
not part of any shared row or public projection.

## Schema

Migration `backend/migrations/0002_online.sql` is additive and versioned through
`kamkmchess_schema_migrations`. It creates:

- `online_matches`: match identity, schema version, orthodox variant, starting/current FEN, time
  control, monotonic `version`, `control_epoch`, rules-policy version, input hash, status, terminal
  result and `result_version`, completion time, and timestamps.
- `online_seats`: one row per seat with the authenticated participant reference, chosen public
  label, declared control, and the seat's control epoch.
- `online_clocks`: both time banks, the active seat and start time, authoritative deadline, whether
  each side has moved, and the turn number.
- `online_moves`: append-only accepted moves, keyed by match and match version, with UCI, SAN,
  resulting FEN, and the authoritative decision/accepted time.
- `online_events`: append-only versioned event log for creation, moves, resignation, abort, control
  change, timeout, and replay removal.
- `online_operation_receipts`: scoped operation ID, 32-byte request fingerprint, original result
  bytes, resulting version/epoch, and acceptance time.
- `online_queue_entries`: queue-entry schema and read contract only; allocation commands are not
  implemented.
- `online_runner_leases`: per-seat runner lease schema and read contract only; acquisition and
  revocation commands are not implemented. A partial unique index allows one `active` lease per
  match and seat.
- `online_public_projections`: allowlisted completed-replay JSON plus a result hash and one-way
  revocation fields.
- `online_deletion_markers`: append-only removal/anonymization ledger.

Database checks constrain IDs, FEN lengths, UCI shape, time-control ranges, control labels, result
consistency, and clock/projection/lease consistency. Move, event, receipt, and marker rows are
immutable. A guard trigger rejects changes to match identity, creation time, terminal status,
completion time, and a non-null result; a delete trigger preserves accepted match rows. The latched
`result_version` cannot be changed after the result exists. A later event such as replay removal
cannot move it.

## Command contract

`backend/online/contracts.go` and `src/online/contracts.ts` mirror schema version `1`. A command is a
closed union:

| Action | Payload | Authority |
| --- | --- | --- |
| `create_match` | variant, starting FEN, time control, both seats | Creator must own the claimed seat; expected version `0`, control epoch `1` |
| `submit_move` | lower-case UCI | Claimed seat owner; active match; expected version and control epoch |
| `resign` | none | Claimed seat owner; active match |
| `abort` | none | Claimed seat owner; only before that side's first accepted move |
| `set_control` | declared human/agent/engine control | Claimed seat owner; active match; increments control epoch |
| `remove_public_replay` | `owner_request` or `erasure_request` | A participant after a terminal result; clears the public projection |

Unknown fields, unknown action kinds, arbitrary state blobs, SQL, client timestamps, credentials,
and private route data are rejected. The authenticated participant is a server-supplied argument to
`Service.Execute`; it is never read from the command body. Public labels reject control characters,
`@`, and `://` so an accidental Clerk email or endpoint cannot be published.

## Receipts and idempotency

The request fingerprint hashes the contract version, match ID, operation ID, expected version,
seat, control epoch, authenticated actor, and canonical action payload. Acceptance stores the
original receipt bytes under `(scope_kind, scope_id, operation_id)`.

- An identical retry returns the stored bytes unchanged and marks the result as a duplicate; the
  match is not advanced again.
- A changed payload, seat, expected version, control epoch, or actor reusing an accepted operation ID
  fails with `ErrOperationReuse`.
- Receipt rows are immutable. A lost acknowledgement therefore cannot create a second accepted
  transition.
- For an existing match, duplicate lookup happens again under the match lock, so a retry racing the
  original writer still converges on the stored receipt.
- Move preflight reads the consistent snapshot before checking receipts. An original operation
  visible in that snapshot therefore has a visible receipt before stale-version or terminal-state
  rejection can run.

## Acceptance transaction

For an existing match the writer:

1. Begins a transaction and selects the match row `FOR UPDATE`.
2. Samples `clock_timestamp()` in a separate statement **after** the lock is held, floored at the
   last accepted timestamp so a backward host-clock adjustment cannot reverse event time. A single
   `FOR UPDATE` query that also evaluates `clock_timestamp()` is deliberately avoided because the
   expression may run before a lock wait.
3. Loads the clock, seats, and moves; checks for an existing receipt under the lock.
4. Verifies seat ownership before expiry can mutate the match. If the deadline has passed, releases
   the transaction and evaluates the bounded timeout policy through the private rules process.
   A second lock verifies the same position/version/epoch and expired seat before committing the
   material-dependent win or draw and receipt. Missing timeout policy fails closed.
5. Otherwise verifies the expected match version, control epoch and side to move.
6. Applies the typed transition, writes the append-only move/event rows, updates the match and clock,
   publishes an allowlisted projection on a terminal result, writes the receipt, and commits.

For a new match, the pinned rules worker first validates the starting FEN and exact counters with
no database transaction held. Invalid positions return `ErrInvalidContract`; already-terminal
positions return `ErrActionNotAllowed`. Missing or failed setup evaluation returns `ErrUnavailable`
without saving any match state. An accepted creation retry returns its stored receipt without
requiring the worker again.

After validation, the writer samples the decision time and inserts the match, seats, initial clock,
creation event, and receipt in one transaction. A unique conflict from a concurrent create resolves
to the stored receipt when the operation is identical, otherwise `ErrAlreadyExists`.

No client timestamp is trusted. Elapsed time is computed from the stored active start to the
authoritative decision time. Resignation, abort and timeout settle the active bank before clearing
the active deadline; an expired bank is zero. These events add no increment. Increment is applied
once per accepted move. The first-move/opening-reply window and full draw/takeback behaviour belong
to KHA-68 and are not claimed here.

## Rules candidate fencing

`RulesInput` is a versioned, private view of the rules-relevant state: policy version, match ID,
version, control epoch, starting/current FEN, optional proposed move, time control, accepted moves,
and active seat. Its SHA-256 hash covers all of those fields plus the match version and control
epoch.

A move command may call an external evaluator with no transaction or row lock held. The returned
candidate is accepted only when all of the following still match under the fresh lock:

- evaluated match version equals the locked version and the command's expected version;
- evaluated input hash equals the locked rules-input hash;
- control epoch equals the locked epoch;
- candidate seat and UCI equal the command;
- candidate move shape and any terminal result pass contract validation.

A stale candidate fails with `ErrStaleCandidate` and writes nothing. The evaluator has no database
handle in this package; the Go writer remains the only committer.

`rulesworker.NewOnlineEvaluator` implements the setup, move and timeout evaluator contracts using the
private pinned Node process. Real-process/PostgreSQL fixtures exercise this composition. HTTP
bootstrap and participant credential verification are later integrations. Internal match/receipt
read helpers require authorization by their server callers; they are not public routes.

`GetMatchForParticipant` and `GetReceiptForParticipant` provide membership-scoped reads. They return
`ErrNotFound` for non-members as well as missing matches, while unrestricted helpers remain trusted
internal interfaces. Command decoding requires EOF after the JSON value. Accepted move and public
replay SAN use a bounded notation check rather than the broader public-label validator.

Match snapshots use one repeatable-read transaction for the match, seats, clock and move list.

## Public projection and removal

`BuildPublicProjection` emits only the allowlisted replay fields: starting position, time control,
public participants and declared controls, accepted moves, final result, rules-policy version, and
completion time. It excludes owner IDs, participant references, operation IDs, private routes,
credentials, conversation, and archive references.

`remove_public_replay` is available only after a terminal result. It clears the projection JSON to `{}`,
records a revocation time and marker ID, and appends a `replay_removal` deletion marker. Projection
lookup then returns `ErrNotFound`. The projection guard allows this one-way transition only; the
projection identity and payload are otherwise immutable, and revoked rows cannot be deleted or
un-revoked. The match result remains immutable for anonymous aggregate history.

The marker ID is the accepted command fingerprint, which includes the match scope. Separate
matches can therefore reuse an operation ID without colliding in the global deletion ledger.

Public projection reads also validate the requested match identity and the stored result hash.

## Runtime roles and isolation

The migration creates, when the migration role has `CREATEROLE`:

- `kamkm_online_api`: schema `USAGE` plus `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the online
  tables only.
- `kamkm_online_rules`: schema `USAGE` with all table and sequence privileges revoked. It cannot
  read or write online state or the private archive, and has no public command surface.

`PUBLIC` privileges are revoked on every online table. Role creation and grants are best effort so a
restricted migration role can still apply the additive schema. Integration tests skip the grant
assertions explicitly when the roles are unavailable; a skipped assertion is never reported as a
pass.

## Deferred work

- Authenticated HTTP commands, fetch-SSE delivery, Clerk/guest authorization, and match membership
  (KHA-67 and KHA-68).
- Queue allocation, lease acquisition/revocation commands, matchmaking, cutoffs, and fallback.
- First-move opening clocks, 15-second reply abort, draw/takeback, abandonment claims, and full
  outcome adjudication (KHA-68).
- Per-move declared-control timeline in replays and public attribution presentation.
- Retention automation, backup replay of the removal ledger, staging verification, and deployment.
