# Casual online chess specification

Owner-approved planning contract, 2026-10-20, incorporating the owner's corrections to the reviewed prototype.

This packet is the proposed implementation contract for [Find the way to casual online chess, player agents, and profiles](https://linear.app/kamkm/issue/KHA-54). Linear resolution comments remain canonical. It does not claim implemented multiplayer, completed acceptance, live readiness, or authorization to deploy or spend.

## What the owner decided directly

- Friend play supports human/human, human/another owner's agent, and agent/agent. Shareable links allow guests; named challenges require accounts.
- Public queue entrants sign in, choose their time control, and request one automatically assigned game. Agent entries can face humans or other agents. People can create any number of concurrent agent/game entries.
- Match only identical starting time and increment, use random colors and the standard position. A compatible agent match wins at the exact ten-second fallback boundary.
- Tabs share an entry unless the owner explicitly joins another game. Responsive background sessions remain eligible.
- Failed agent readiness blocks the entry and offers an explicit human alternative. Failed Stockfish preparation does not block agent search.
- Canceling before a side's own first accepted move aborts, even if the other side moved. After that side has moved, cancellation is resignation.
- Connected participants may use their whole chess clock, including deliberately waiting. After one continuous minute offline, prompt the other participant to claim a win or keep waiting.
- Owners can take over from their agents or switch models between moves, with clocks running and attribution recorded.
- Ordinary account deletion anonymizes retained games. Explicit data removal also removes shared replays from both online histories, leaving only anonymous result aggregates for the opponent.
- Keep the existing offline game and its layout; add draw and resign as icons. Use icons for every action that can be represented clearly, with accessible names and hover labels.
- Remove the separate Declared models per-move block shown in the prototype. This removes that presentation, while keeping the agreed model identity metadata.
- The owner accepted the remaining proposed direction after these corrections. Routine details use the documented defaults.

## Canonical sources

1. [Friend invitations and setup](https://linear.app/kamkm/issue/KHA-55), resolution comment `e1b8b5c5-f984-43bd-a098-48d1b4aeeab4`.
2. [Agent queue and fallback](https://linear.app/kamkm/issue/KHA-56), resolution comment `207829d6-e172-45f5-8cb8-c9f174991a49`.
3. [Shared match rules](https://linear.app/kamkm/issue/KHA-57), resolution comment `3e8cfcd2-64f8-4d6c-9188-0101fd6d122b`.
4. [Public identity, attribution and history](https://linear.app/kamkm/issue/KHA-58), resolution comment `2e276699-471e-4b43-a0dc-d1114b41dbad`.
5. [Hosting investigation](https://linear.app/kamkm/issue/KHA-59), resolution comment `65e2e118-034b-456a-a722-148e99bf0fe1`. Preserved report on `research/online-play-hosting`, commit `40f158a9376ecd236e15243f33acc524da309896`, `research/online-play-hosting.md`.
6. [Multiplayer authority and private agents](https://linear.app/kamkm/issue/KHA-60), resolution comment `d86dd0c7-13d9-4f8a-b411-5aa4ae8a2639`.
7. [Interface validation](https://linear.app/kamkm/issue/KHA-61), A accepted with the offline-preservation, icon-action and replay-block corrections recorded on 2026-10-20.
8. [Specification agreement](https://linear.app/kamkm/issue/KHA-62), owner accepted the proposed handoff with the 2026-10-20 interface corrections included.

## Existing offline play

Preserve the existing local setup, rules, clocks, direct AI/engine behavior, recovery, Undo, keyboard move review, board tools and move sidebar. Online authority, subscriptions, matchmaking and abandonment rules apply only to online matches. Add draw and resign icons to the existing board tools, keeping the corresponding result/confirmation actions explicit and preventing stale moves after a final result. Offline draw does not silently import an online service or change the existing independent model-move contract.

Use a clear draw symbol and a flag for resign. Keep accessible action names, hover labels, visible focus and existing pointer/touch targets. Other actions use icons wherever the meaning is clear; meaningful labels and confirmation copy remain accessible. This is a required local UI extension in the implementation handoff, not a claim that these controls already exist in production.

## Friend matches

Support a one-use shareable link or a challenge to an account. Invitations last 12 hours; the inviter may cancel. A recipient may ignore a challenge; no decline action is required. Acceptance consumes it once.

Each participant chooses human or their own agent. The inviter selects color, minutes/increment and starting position; the invitee sees them before accepting. No built-in Stockfish seat is offered in friend setup. Link metadata shows the inviter's public name or Guest, color, clock and custom board when applicable, without prematurely claiming the final human/agent pairing.

No separate Ready step is introduced. The first accepted move starts play; the responding side has 15 seconds to reply, otherwise abort. Apply this by side to move when a custom FEN starts with Black.

The default clock interpretation spends neither main clock before that side's first move. Once the opening reply commits, the next side's clock runs. Add the configured increment once per accepted move. This explicit interpretation must be tested; it is a specification default, not an observed online behavior.

Rematches need both participants' acceptance, create a new match and reverse colors. Carry forward the setup; proposed time changes require agreement before clocks start.

## Queue and concurrency

An entry is one person's request for one game. Play yourself requests a human seat; Watch your agent play requests the selected agent. Human/human and same-owner pairings are ineligible. Prefer the oldest compatible ready entry.

One owner can create multiple entries/games using the same or different agents. Normal multi-tab navigation shows the same entry. Creating another entry is explicit, and completing a game never silently authorizes another.

Lock the entry's seat/model/time settings while waiting. A selection change cancels and rejoins after readiness with a fresh window. A model's concurrency/provider limits can fail readiness or requests, but the product adds no arbitrary owner-game cap.

A responsive ready browser is required. Agent readiness additionally validates the selected connection/model. A failure blocks and offers Retry or explicit Play yourself. No hidden human or engine substitution occurs.

The ready entry's authoritative acceptance starts a ten-second search window. Stockfish 19 Lite prepares in the browser. Its failure does not prevent search; at the deadline an unavailable fallback offers Retry or Keep searching. Retry readies the engine and checks once more for a compatible agent before committing fallback. Keep searching explicitly removes the automatic cutoff.

A compatible entry available by the deadline, including equality, takes priority. Allocation/cancellation/fallback are serialized and each entry is consumed once. A delayed timer uses the original cutoff and resolves due allocations in order. Tentative reservations cannot hold entries waiting for human approval or extend the window.

Fallback uses the chosen human/agent seat against browser Stockfish 19 Lite with the same time control, random colors and standard position. Identify it as Stockfish. The deadline selects the opponent; it is not a guarantee of board rendering or first move by ten seconds.

Assignment fixes the opponent. Late candidates, engine readiness or reconnected tabs cannot replace it. A new search requires another explicit entry.

## Shared play and recovery

The service owns accepted legality, turns, clocks, queue allocations and final outcomes for online matches. Local/private modes retain their existing browser authority.

Only legal moves for the current side and revision can advance the game. Duplicate operations return the same receipt, and stale/late/wrong-seat intents cannot add increments. Sample authoritative decision time after lock acquisition. Reconcile expiry before accepting an action; no client timestamp can backdate a move.

Reuse the current chessops/app rules policy, including strict FEN/counters, repetition, third-repetition and 100-halfmove draw endings, checkmate precedence, material and bounded timeout handling. Preserve the October 18 rules amendment rather than restoring exhaustive interactive proof search.

Clocks keep running during ordinary thought, generation, Stop, Retry, provider failure, control changes, takeback discussions, navigation and peer disconnects.

After both sides have moved, one continuous minute offline enables the other participant's optional Claim win action. Keep waiting does not concede a result. A reconnect accepted before the claim withdraws eligibility; a later disconnect begins a fresh minute. Connected stalling never enables this action. Earlier terminal outcomes remain final.

Cancellation before the canceling side has ever made an accepted move aborts; afterward it resigns. A takeback does not erase that historical first-move fact.

Control changes apply against a shared version between accepted moves. Fence any old provider request before the new controller can submit. Human takeover, handoff to an agent, and model/connection switches preserve elapsed time and recovery budgets. Record declared control per accepted move.

Default parser behavior remains four illegal attempts per turn before the existing illegal-move loss, plus three independent automatic formatting corrections. Further formatting failure waits for owner recovery. Explicit model resignation concedes; a transport/provider error alone does not.

Draw offers and exact takeback targets require mutual consent; neither pauses clocks. A stale takeback offer cannot rewind later moves. No refunded time, duplicate increments, reset spent budgets or deletion of discarded private archives. Automatic draw rules remain in force.

Final results cannot be undone. Analysis/practice is separate, and a rematch is a new game.

## Profiles, history and removal

Use stable public profile identity with editable unique usernames and chosen avatars. Never publish Clerk email, legal name or authentication identifiers by default. A guest is labeled Guest, with no profile, and account linking is explicit and proves seat ownership.

Publish completed online friend, queue and fallback replays and casual results. Mark aborts separately without a scored result. Count one final result per account/game; describe human/agent/mixed control and fallback clearly. Existing local/private saves and practice are excluded.

The public replay is an allowlisted projection of position, accepted moves, result, time control, public participants and declared control timeline. It is readable without signing in after completion. Live access remains participant-only; public live spectating is not part of this effort.

Known public model names/IDs may be shown; custom routing needs a chosen public label rather than automatic exposure of private route IDs. Attribution is declared, not provider-attested. Do not relabel earlier moves when control changes.

Opponents and replay visitors cannot read another owner's AI requests, reasoning, conversation or private connection data. Browser-local credentials never enter shared match or replay storage.

Ordinary account deletion removes profile/personal data and the deleted owner's service-held private data while retaining shared games as Deleted player. Remove identifying historical snapshots and personal aliases as well as profile links.

An explicit verified removal request also removes shared replays from both online histories and public URLs/projections. Keep only anonymous opponent result aggregates. A guest can request removal using retained participant ownership credentials.

Default operating targets: remove service-held live data and public projections within 24 hours of request verification; remove/sanitize old recovery copies within 30 days. Reapply the newest removal ledger before any restored backup serves traffic. Previously downloaded external copies cannot be recalled. These targets are required future behavior, not certification of current operations.

## Architecture

Reuse Vercel for the frontend, Apache/Go for the direct API, private PostgreSQL and Clerk. Add no new paid hosting service.

Go validates authenticated commands and is the sole transaction writer. PostgreSQL holds shared matches/seats, event versions and receipts, deadlines, queue entries, runner leases, public projections and deletion markers.

A private Node/TypeScript rules process reuses the pinned existing chessops and pure application wrappers. It receives a versioned board/rules input, has no public endpoint or provider/archive secrets, and cannot write authoritative match state. Go commits a candidate only against the same version with fresh clock reconciliation.

Deliver commands by authenticated HTTPS POST, updates by direct fetch-SSE, with bounded polling as compatibility fallback. Use finite streams no longer than 20 seconds or auth expiry, fresh token acquisition, heartbeats and durable cursors/snapshots. Idle streams hold no database connection. Verify Apache flushing, deadlines, CORS/CSP and host capacity before enabling.

Clerk verification checks identity/session/origin/expiry and then match membership. Guest control uses revocable seat-scoped credentials issued on invitation acceptance. Invitation possession after consumption grants no match control.

Use one browser runner lease per agent seat/turn, independently across unlimited explicit games. Every move/result/control action is versioned and idempotent. Initially use five-second application heartbeats and 15-second liveness leases; browser suspension can make an agent unavailable.

On a runner loss with an uncertain provider request, do not automatically duplicate paid work. Offer Retry, switch or takeover while the clock runs. Exactly-once accepted moves are guaranteed by the contract; exactly-once external billing is not.

A service outage is not opponent abandonment. Planned restarts persist a suspension boundary. Unexpected recovery derives a conservative interruption interval from durable health checkpoints and accepted match activity, adjusts unfinished active deadlines once, fences old service/runner epochs and publishes canonical recovery state. Already final results stay final.

## Approved interface

The disposable prototype is kept on branch `prototype/online-play-map` in the separate `online-play-prototype` checkout. Its paths are `src/ui/prototypes/online-play.html` and `src/ui/prototypes/online-play-brief.md`. Run `node scripts/serve-online-prototype.mjs`, then open http://127.0.0.1:5188/?variant=A.

A is the accepted direction for the online views. It extends the current board-and-moves workspace with compact access to new play, concurrent games and profile/history. Offline play keeps its existing layout and controls, with draw/resign icons added. The prototype uses icon-only product actions with accessible names and hover labels. The separate Declared models per-move list is removed. B and C remain archived comparisons. The structure switcher and synthetic simulation controls are prototype-only.

The prototype demonstrates states, not real provider execution, legal chess input, clocks, server persistence or acceptance. Existing keyboard/touch/screen-reader and 20-word screen conventions remain implementation requirements, including 10-word engine screens. The owner reacted to the concrete prototype on 2026-10-20 and accepted the proposed direction with the corrections now incorporated.

## Acceptance, evidence and launch sequence

[online-play-acceptance.json](online-play-acceptance.json) records 62 traced scenarios and their evidence status. Two human-review scenarios are approved in planning; the 60 implementation scenarios remain `not_run`. Prototype interactions and owner agreement do not count as completed production acceptance.

Available planning evidence is the dated hosting report, canonical decision exchange, and inspected prototype captures/flow checks. Historical owner-only deployment tests do not establish multiplayer readiness.

Sequence implementation through local shared-schema/rules conformance, identity/transport/queue, browser agents, public projections/deletion and restore, integrated race/recovery tests, native desktop/mobile accessibility, and authorized staging/capacity verification. Then opt-in friend play, followed by public queue after separate release approval.

No paid upgrades, provider spending, infrastructure provisioning or production launch is authorized by specification approval.

## Review status

- Friend, queue, match, privacy/history and architecture decisions are recorded in Linear.
- The owner accepted A with the explicit 2026-10-20 offline/icon/replay corrections, now incorporated in the prototype and this packet.
- The planning specification is agreed; the map is ready to close after its resolution pointers are recorded.
- Implementation, native acceptance, live staging/capacity/deletion verification and public launch remain future work.
