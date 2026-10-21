# Online history, public replay and privacy contract (KHA-78, KHA-79)

Owner-approved planning contract: `docs/spec/online-play-handoff.md` (profiles, history and
removal) and `docs/spec/online-play-acceptance.json` (`HIS-03` … `HIS-10`, `ARC-12`, `UX-06`).

This note is the interface contract between the backend history/privacy owner and the browser
owner. It states the routes, the wire shapes, and the rules the UI must honour. It records
implemented behaviour only; it claims no native, host or acceptance sign-off.

## Routes

| Route | Credential | Purpose |
| --- | --- | --- |
| `GET /v1/public/matches/{matchID}/replay` | none (signed-out readable) | Public replay of a completed online match |
| `GET /v1/online/matches/{matchID}/replay` | none (signed-out readable) | Same payload; canonical replay URL |
| `GET /v1/public/profiles/{profileID}/history` | none (signed-out readable) | Public game history and aggregate totals of one profile |
| `POST /v1/privacy/account/deletion` | account session | Ordinary account deletion (anonymize shared games) |
| `POST /v1/privacy/account/removal` | account session | Explicit verified removal (erase shared replays) |
| `POST /v1/privacy/guest/removal` | guest seat credential | Explicit verified removal for a guest seat owner |
| `POST /v1/privacy/account/model-labels` | account session | Register an owner-chosen public label for a model opponent |

Live reads stay participant-only: `GET /v1/online/matches/{matchID}` and
`GET /v1/online/matches/{matchID}/updates` still require a participant credential.

## Public replay payload (`schemaVersion: 2`)

```jsonc
{
  "schemaVersion": 2,
  "matchId": "m_...",
  "variant": "orthodox",
  "startingFen": "rnbqkbnr/... w KQkq - 0 1",
  "timeControl": { "startingTimeMs": 300000, "incrementMs": 2000 },
  "gameKind": "friend" | "queue" | "fallback",
  "scored": true,
  "attribution": { "source": "declared", "providerVerified": false },
  "participants": [
    {
      "seat": "white",
      "publicLabel": "Alice",
      "control": { "kind": "human", "declaration": "declared" }
    }
  ],
  "moves": [
    {
      "version": 2,
      "seat": "white",
      "uci": "e2e4",
      "san": "e4",
      "control": { "kind": "human", "declaration": "declared" }
    }
  ],
  "terminal": {
    "kind": "resign",
    "seat": "black",
    "control": { "kind": "agent", "modelLabel": "GPT-4o", "declaration": "declared" }
  },
  "result": { "kind": "win", "winner": "white", "reason": "resignation" },
  "rulesPolicyVersion": "online-rules/1",
  "completedAt": "2026-10-21T10:00:00Z"
}
```

Rules the browser must honour:

* `attribution.source` is `declared` and `attribution.providerVerified` is always `false`. A model
  label or the browser Stockfish label is a declaration, never a provider attestation. Do not
  render it as verified.
* A `control` object carries `kind` (`human`, `agent`, `engine`), an optional `modelLabel`, and
  `declaration: "declared"`. `modelLabel` is a public label only: an allowlisted public model
  name or an owner-chosen public label. It is never a private routing ID, a secret-bearing
  alias, a connection nickname, an endpoint, or a credential.
* The per-move `control` is the control that was in effect for that accepted move. A later
  control change never relabels an earlier move. `participants[].control` is the control of that
  seat at the end of the match.
* There is no separate "Declared models" list. Render compact labels (for example `Human`,
  `Agent · GPT-4o`, `Engine · Stockfish 19 Lite (browser)`) from the metadata above.
* `scored` is `false` for an abort. An abort is published as an unscored game and is not counted
  as a win, draw or loss.
* `gameKind` is `friend`, `queue` or `fallback`. A fallback game has the browser Stockfish seat.

## Public profile history payload (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "profileId": "kp_...",
  "totals": { "wins": 3, "draws": 1, "losses": 2, "aborts": 1, "scored": 6 },
  "games": [
    {
      "matchId": "m_...",
      "replayPath": "/v1/public/matches/m_.../replay",
      "gameKind": "friend",
      "outcome": "win" | "draw" | "loss" | "abort",
      "scored": true,
      "opponentLabel": "Bob",
      "completedAt": "2026-10-21T10:00:00Z"
    }
  ]
}
```

* One entry per account and game. A result is counted once.
* Local, private and practice saves are never in this list. Only completed online friend, queue
  and fallback games are.
* After an ordinary account deletion the opponent sees `opponentLabel: "Deleted player"`.
* After an explicit removal the shared game leaves both histories. The opponent keeps the
  aggregate totals only.

## Privacy flows

| Flow | Body | Answer |
| --- | --- | --- |
| Account deletion | `{"confirm":"delete-account"}` | `{ "schemaVersion": 1, "removalId": "rm_...", "scope": "account_deletion", "status": "applied", "anonymizedMatches": 3, "removedMatches": 0, "verifiedAt": "...", "liveDeletedAt": "...", "liveDeleteDueAt": "...", "recoverySanitizeDueAt": "..." }` |
| Explicit removal (account) | `{"confirm":"erase-shared-replays"}` | the same shape with `"scope": "explicit_removal"` and the erased match count in `removedMatches` |
| Explicit removal (guest) | `{"confirm":"erase-shared-replays"}` | the same shape as the account answer |
| Public model label | `{"publicLabel":"My chess model"}` | `{ "schemaVersion": 1, "labelId": "kl_...", "publicLabel": "My chess model" }` |

* The two deletion flows are separate on purpose. Account deletion anonymizes the shared games
  and keeps them. Explicit removal erases the shared replays from both histories and from the
  public URL.
* Every flow is idempotent. A repeated request never counts a result twice, never removes a game
  twice, and never creates a second removal record. The removed account is fenced inside the same
  transaction, so a retry with a revoked session is refused and the stored removal is unchanged.
* A guest uses the guest seat credential header `X-Guest-Seat-Token`; the server derives the
  guest identity from it. A guest never names an account.
* `publicLabel` is the only value the browser sends when it registers a public model label. The
  mapping from a private routing identity to that label stays in the browser: the server never
  receives a routing identifier, an endpoint, a connection nickname, or a credential. A label that
  looks like a credential is refused.
* A declared control carries the public label itself. The server publishes a declared label only
  when it is a known public model name or a label the owner registered. Any other declared value
  is replaced by the neutral label `Custom model` before it is stored, so a private routing
  identity never reaches a shared table, a receipt, or a public payload.
* The browser owns every provider secret and every provider request. The server never receives
  them.

## Removal ledger, retention and restore

* Every removal is recorded in a durable removal ledger (`online_removal_ledger`) and in a
  removal request (`online_removal_requests`). The request is unique per subject and scope, so a
  repeated request never creates a second removal.
* The subject of a removal is its **one-way reference**, never the identifier. The reference is
  `sha256("kamkm.online.removal.v1:" + identifier)` and it is derived in SQL as well, so a removal
  finds the rows of its subject without the identifier ever being stored in the removal tables, the
  deletion marker, the removal ledger or the encrypted backup bundle. The removal tables, the
  marker and the ledger therefore never retain the identifier of a removed person.
* The legacy deletion marker (`online_deletion_markers`) is written in the same transaction. The
  seat guard and the replay guard of the base schema require that marker, so the anonymization and
  the erasure are only accepted when a recorded marker exists.
* The live service data and the public projections are removed inside the removal transaction, so
  they are gone long before the twenty-four hour target. The answer states `liveDeleteDueAt` and
  `liveDeletedAt`.
* The recovery copies are sanitized within thirty days. The answer states
  `recoverySanitizeDueAt`. The removal ledger travels inside the encrypted backup bundle, and a
  restore replays it before the restored database serves traffic.
* The restore gate (`online_restore_gates`) blocks the service while a restored database has not
  released its gate. The service refuses to **start** while the removal ledger is not applied in
  the database, and every request is checked again while it runs. A restore releases the gate only
  after the removal ledger was replayed and the replay was verified.
* The **durable restore fence** lives outside the restored database, in a file the restore writes
  before it imports anything. The path is configured once, with `ONLINE_RESTORE_FENCE_PATH`, and
  both the API and the restore tool use it: the API reads it in `serverapp.Load` and checks it
  before it starts and on every request, the restore tool writes it with `--fence` (which
  defaults to the same environment variable) and refuses an applied restore without it. The path
  has to be a **shared persistent location**: a per container or per host path would let two
  instances disagree about the state of a restore, and the file has to be readable by the account of
  the API and of the restore tool. The fence survives the schema replacement of
  the restore and a crash of the restore process, so a restore that dies between the import and
  the replay leaves the service closed instead of a restored database that lost the newest
  removals.
* The fence is **bound to its restore**: it names the restore and the digest of the removal ledger
  the restore has to apply. The fence file is created exclusively, so two restores that start at the
  same time cannot both own it: the second one is refused instead of overwriting the fence of the
  first. The same restore with the same ledger is idempotent, the same restore with another ledger
  is refused, and the fence is closed only by its owner and only for the ledger it names. The fence
  is on disk, so it survives the restart of the service: a service that starts after a crashed
  restore sees the fence and refuses to serve.
* The restore **opens the fence before the import** and closes it only after the removal ledger was
  replayed and the applied ledger was verified to hold every record the restore had to apply. A
  restore that cannot replay its removals is refused before it touches the database.
* The **subject level removal record** (`online_removal_subjects`, `subjectRef`) records that a
  subject was removed, whatever it played and whatever private data it held. It names no match
  and it stores the one-way reference of the subject, never the identifier. It travels in the
  encrypted bundle with the match bound records, it is merged with the newer rotation copies and
  it is replayed after a restore. Without it, a restore of an older backup - where the deletion
  table of the account is absent - would bring the private data back and let the old session of
  the account work again.
* The removal ledger is keyed by the **match, the kind and the subject**, so two participants of
  one match are two removals and both are sealed into the bundle.
* The **per match removal of a public replay** (`remove_public_replay`) revokes the published
  replay of that match, and the publisher does not publish it again. It is not a removal of the
  participant: the participant keeps its seat, its history and its other games.
* The operator tooling (`khabackup`) seals the removal ledger into the bundle, writes the fence,
  restores, replays the ledger, verifies the replay, records the restore, releases the gate and
  closes the fence. A ledger that cannot be read is an error, never an empty ledger.

## The private single-owner data of a deleted account

* An ordinary account deletion and an explicit removal both remove the account's **private
  single-owner data**: its own games, their archive chunks, their archive events and its
  operation receipts. Only the payload-free deletion tombstones and the idempotency receipts
  remain, exactly like the private store's own delete path.
* The unrelated owners are never touched, and the browser's own copies of the games are outside
  the server's reach.
* The account is **fenced**: its sessions are revoked, and the private API refuses its reads and
  its writes through the account gate, which the private store consults inside every write
  transaction. An old verified session token therefore cannot read or write the private archive of
  a deleted account.
* The removal of the private data is replayed after a restore exactly like the online removal: the
  restored private rows are removed again, and the account is fenced again.
* The private endpoint is never widened to guests, and the guest path of the private store stays
  unreachable.

## Lock protocol

The flows that act on the same participant take the same locks, in the same order:

1. the account scope locks, in ascending order (`backend/locks`, the shared account scope lock);
2. the match row locks, in ascending match identifier order.

* The trusted allocation of a seat, the removal of a participant, the creation of a public
  profile and every private write of an account take the same account scope lock, so an
  allocation, a removal and a private write of one participant are ordered instead of racing. A
  private write therefore cannot insert a new game after the removal committed.
* The publication of a public replay and the removal of the same match take the same match row
  lock, so a first publication and a removal are never interleaved: either the removal is recorded
  first and the publication refuses to publish, or the publication publishes first and the removal
  revokes or anonymizes the published payload.
* The account scope lock always precedes the match row lock, so the two paths cannot deadlock.

## The auxiliary personal data of a removed subject

The friend surface and the queue surface keep their own records of the people they belong to.
A removed subject must not stay identifiable in any of them, so the removal sanitizes them as
well:

* an **unused invitation** of the removed account is deleted, so its preview can never name the
  removed owner;
* a challenge **addressed to** the removed account keeps its row (it belongs to the inviter) and
  loses its recipient;
* an invitation that already produced a match keeps its row (the match refers to it) and loses
  the identity of the inviter;
* an **acceptance** that never produced a match is deleted, and the acceptance of a match loses the
  identity of the acceptor;
* a **rematch offer** keeps its row and loses the identity of the proposer and of the acceptor;
* a **waiting queue entry** is deleted, and an entry that already produced a match keeps its row
  and loses the owner identifier, the declared model label and the client supplied idempotency
  key; the allocation of that entry loses the public label and the declared model label of the
  removed participant and keeps the label of the other one.

The capability hashes of the friend records are cleared with the identity: the revocable ownership
secret of the inviter and the acceptance key of the acceptor are hashes, never identifiers, and
they are destroyed so the capability cannot be used any more. The server identifiers of the rows
(the invitation, the acceptance, the rematch offer and the allocation) survive, because the match
and the allocation refer to them; they name no subject. The operation receipts and the accepted
events keep the participant-bound fingerprint of the accepted commands: they are service-held, are
never public, and the declared label they carry is an allowlisted public label.

The records of the other participants are never touched, the per match removal of a public replay
is not one of these removals (it removes the replay of one match and keeps the participant), and
the aggregate result totals of the opponent are untouched.

The redaction of the queue tables is a narrow path that migration `0018` opens: the owner
identifier of an entry and the public label of an allocation change only when a removal request of
that account exists. Everything else about an entry, an allocation and a match stays immutable.

## Known limitations

* The rows that predate a removal (the seat, the public profile row, the session revocation, the
  private game rows) keep the identifier of the subject, because the service looks them up by it.
  They are service-held, never public, and they are not in the public payload, the public replay
  or the public history. The removal tables, the deletion marker, the removal ledger and the
  encrypted backup bundle carry only the one-way reference.
* The private game rows of a removed account keep the identifier in the tombstone, because the
  private store looks the tombstone up by owner. The payload is gone.
* The public profile row of a deleted account stays as an anonymous shell: the base schema keeps
  the profile identifier and the account reference immutable. The chosen name, the chosen avatar
  and every public history row of the account are removed, the profile seam refuses the deleted
  account, and the profile routes refuse to publish a name for it again.
* The declared label of a model opponent is published only when it is a known public model name or
  a label the owner registered before the control was declared. Every other declared value is
  stored as the neutral label `Custom model`.

## Integration notes for the foundation and the queue owners

* **Shared account scope lock.** The allocation, the removal and the profile creation take the
  account scope lock of `backend/locks` (`LockAccountScope`, `AccountScope`). The key derivation
  is `pg_advisory_xact_lock(hashtext('kamkmchess.account.' + kind + ':' + id))`, the same one the
  online service uses, so the flows are ordered against each other. The scope string is the kind
  and the identifier, so an account and a guest never share a scope.
* **Removed participants.** The removal tables carry the one-way reference of the subject. The
  check that refuses a seat for a removed participant must therefore compare the reference:
  `backend/subject` provides `AccountRemovedSQL` and `GuestRemovedSQL` for exactly that. A
  removal *request* means the participant is gone; the removal of the public replay of a single
  match is not a removal request and never closes a seat anywhere.
* **Restore gate.** The online service already reads `online_restore_gates` for its mutations. The
  public reads and the service start are gated as well: the service refuses to start while the
  removal ledger is not applied, and every request answers with `restore_pending` until the gate
  is released.
* **Restore lifecycle.** `khabackup restore --apply` restores the bundle, replays the removal
  ledger, records the restore, verifies the replay and releases the gate. A restore that cannot
  replay the ledger leaves the gate closed and the service closed.

## Typed browser modules

* `src/online/history.ts` – `parseOnlinePublicReplay`, `parseOnlineProfileHistory`,
  `fetchOnlinePublicReplay`, `fetchOnlineProfileHistory`, `publicReplayPath`,
  `profileHistoryPath`, `compactControlLabel`.
* `src/online/privacy.ts` – `requestAccountDeletion`, `requestExplicitRemoval`,
  `requestGuestRemoval`, `registerPublicModelLabel` and their response parsers.

Both modules are pure: they take a `fetch` implementation and never read a credential themselves.
The account and guest calls go through the existing authorized requester in `src/online/request.ts`
with `accountScope()` and `matchSeatScope(matchId, seat)`.

The public reads are signed-out reads: `fetchOnlinePublicReplay` and `fetchOnlineProfileHistory`
take a `baseUrl` and an optional `fetch`, refuse an answer that is not the allowlisted payload,
and never send a credential.
