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
| `POST /v1/account/deletion` | account session | Ordinary account deletion (anonymize shared games) |
| `POST /v1/account/removal` | account session | Explicit verified removal (erase shared replays) |
| `POST /v1/guest-seats/removal` | guest seat credential | Explicit verified removal for a guest seat owner |
| `POST /v1/account/model-labels` | account session | Register an owner-chosen public label for a private routing ID |

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
      "control": { "kind": "human", "declaration": "declared" },
      "finalControl": { "kind": "agent", "modelLabel": "GPT-4o", "declaration": "declared" }
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
  control change never relabels an earlier move. `participants[].finalControl` is the control
  at the end of the match.
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
| Account deletion | `{"confirm":"delete-account"}` | `{ "schemaVersion": 1, "status": "applied", "anonymizedMatches": 3, "removedMatches": 0 }` |
| Explicit removal (account) | `{"confirm":"erase-shared-replays"}` | `{ "schemaVersion": 1, "removalId": "rm_...", "status": "applied", "removedMatches": 3, "liveDeletedAt": "...", "liveDeleteDueAt": "...", "recoverySanitizeDueAt": "..." }` |
| Explicit removal (guest) | `{"confirm":"erase-shared-replays"}` | same shape as the account answer |
| Public model label | `{"publicLabel":"My chess model"}` | `{ "schemaVersion": 1, "labelId": "kl_...", "publicLabel": "My chess model" }` |

* The two deletion flows are separate on purpose. Account deletion anonymizes the shared games
  and keeps them. Explicit removal erases the shared replays from both histories and from the
  public URL.
* Every flow is idempotent. A repeated request answers with the same result and never counts a
  result twice.
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

## Typed browser modules

* `src/online/history.ts` – `parsePublicReplay`, `parseProfileHistory`, `fetchPublicReplay`,
  `fetchProfileHistory`, `publicReplayPath`, `compactControlLabel`.
* `src/online/privacy.ts` – `requestAccountDeletion`, `requestExplicitRemoval`,
  `requestGuestRemoval`, `registerPublicModelLabel` and their response parsers.

Both modules are pure: they take a `fetch` implementation and never read a credential themselves.
The account and guest calls go through the existing authorized requester in `src/online/request.ts`
with `accountScope()` and `matchSeatScope(matchId, seat)`.
