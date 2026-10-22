# Casual online play implementation roadmap

Created 2026-10-20 from the [approved specification](https://linear.app/kamkm/document/casual-online-chess-specification-f9bcbe764d42) and [acceptance matrix](https://linear.app/kamkm/document/online-play-acceptance-scenarios-6fb40e1bd9cb).

[KHA-63: Implement casual online chess, player agents and public profiles](https://linear.app/kamkm/issue/KHA-63/implement-casual-online-chess-player-agents-and-public-profiles) contains 22 unassigned Backlog tickets in four milestones, connected by 39 native blocking relationships. The [planning map](https://linear.app/kamkm/issue/KHA-54) remains complete. Linear is canonical for subsequent assignments, status and evidence.

All 60 implementation scenarios have ticket coverage. The two prior planning approvals, UX-01 and REL-01, remain recorded in the accepted packet. No implementation scenario passed by creating this backlog.

## Available first

- [KHA-64: Preserve offline play and add draw/resign icon controls](https://linear.app/kamkm/issue/KHA-64/preserve-offline-play-and-add-drawresign-icon-controls). The current offline game keeps its layout and behavior, with draw and resign available beside the existing board tools.
- [KHA-65: Add shared online state, transactional commands and operation receipts](https://linear.app/kamkm/issue/KHA-65/add-shared-online-state-transactional-commands-and-operation-receipts). Online matches have a versioned durable contract and one Go transaction writer, separate from private single-owner sync.
- [KHA-66: Run the pinned chess rules in a private Node worker](https://linear.app/kamkm/issue/KHA-66/run-the-pinned-chess-rules-in-a-private-node-worker). The Go authority can evaluate online positions through the same pinned chessops/application policy used by local play.

## Implementation boundaries

Reuse existing Clerk sign-in, Go/PostgreSQL private storage and backup machinery, direct browser providers, pure rules wrappers and the Classic workspace. The online service owns shared state, ordering and clocks through the Go writer and private pinned Node/chessops worker; private/local modes retain browser authority.

Preserve the offline layout and behavior, add draw/resign icon actions, and use clear icons with accessible names/tooltips. The separate Declared models list is removed; appropriate model metadata remains.

One explicit signed-in queue entry authorizes one automatic game. There is no arbitrary cap on explicit concurrent entries, agents or games. Match compatible time controls and use the agreed ten-second Stockfish fallback contract. Provider calls and secrets remain in the owner's browser.

Dependencies express prerequisites, while the milestones group outcomes. Public profiles can proceed once participant authorization is ready. Feature implementation and local/native/live verification are distinct work. Every ticket records scope, acceptance IDs and required evidence on an identified commit.

## Online foundations and offline preservation

| Ticket | Outcome | Blocked by |
| --- | --- | --- |
| [KHA-64: Preserve offline play and add draw/resign icon controls](https://linear.app/kamkm/issue/KHA-64/preserve-offline-play-and-add-drawresign-icon-controls) | The current offline game keeps its layout and behavior, with draw and resign available beside the existing board tools. | None |
| [KHA-65: Add shared online state, transactional commands and operation receipts](https://linear.app/kamkm/issue/KHA-65/add-shared-online-state-transactional-commands-and-operation-receipts) | Online matches have a versioned durable contract and one Go transaction writer, separate from private single-owner sync. | None |
| [KHA-66: Run the pinned chess rules in a private Node worker](https://linear.app/kamkm/issue/KHA-66/run-the-pinned-chess-rules-in-a-private-node-worker) | The Go authority can evaluate online positions through the same pinned chessops/application policy used by local play. | None |
| [KHA-67: Authorize online participants and revocable guest seats](https://linear.app/kamkm/issue/KHA-67/authorize-online-participants-and-revocable-guest-seats) | Only a current participant session can command or subscribe to its online seat. | [KHA-65](https://linear.app/kamkm/issue/KHA-65) |
| [KHA-68: Implement authoritative online moves, clocks and match outcomes](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes) | Both participants see one accepted move order, continuous clocks and one final result. | [KHA-65](https://linear.app/kamkm/issue/KHA-65), [KHA-66](https://linear.app/kamkm/issue/KHA-66), [KHA-67](https://linear.app/kamkm/issue/KHA-67) |
| [KHA-69: Deliver finite authenticated updates with snapshot and polling recovery](https://linear.app/kamkm/issue/KHA-69/deliver-finite-authenticated-updates-with-snapshot-and-polling) | Clients recover the current online state after dropped events, token renewal, tab changes or API restarts. | [KHA-67](https://linear.app/kamkm/issue/KHA-67), [KHA-68](https://linear.app/kamkm/issue/KHA-68) |
| [KHA-70: Implement online presence and optional abandonment claims](https://linear.app/kamkm/issue/KHA-70/implement-online-presence-and-optional-abandonment-claims) | A connected opponent may use the full clock; a continuous minute offline enables an optional win claim. | [KHA-68](https://linear.app/kamkm/issue/KHA-68), [KHA-69](https://linear.app/kamkm/issue/KHA-69) |
| [KHA-71: Recover online service interruptions without false abandonment results](https://linear.app/kamkm/issue/KHA-71/recover-online-service-interruptions-without-false-abandonment-results) | API or rules-service interruption preserves prior results and resumes unfinished games with one canonical recovery adjustment. | [KHA-68](https://linear.app/kamkm/issue/KHA-68), [KHA-69](https://linear.app/kamkm/issue/KHA-69) |

## Friend play and browser-owned agents

| Ticket | Outcome | Blocked by |
| --- | --- | --- |
| [KHA-73: Run browser-owned online agents with turn leases and safe handoffs](https://linear.app/kamkm/issue/KHA-73/run-browser-owned-online-agents-with-turn-leases-and-safe-handoffs) | One current browser runner controls an agent seat for each turn, while separately requested games can run concurrently. | [KHA-70](https://linear.app/kamkm/issue/KHA-70) |
| [KHA-74: Build the online board workspace and concurrent-game navigation](https://linear.app/kamkm/issue/KHA-74/build-the-online-board-workspace-and-concurrent-game-navigation) | Accepted structure A supports online play and parallel games while the existing offline game remains intact. | [KHA-64](https://linear.app/kamkm/issue/KHA-64), [KHA-73](https://linear.app/kamkm/issue/KHA-73) |
| [KHA-75: Implement friend invitations, account challenges and mutual rematches](https://linear.app/kamkm/issue/KHA-75/implement-friend-invitations-account-challenges-and-mutual-rematches) | Two people can arrange a casual friend game as humans or through their own agents, including guests joining by link. | [KHA-72](https://linear.app/kamkm/issue/KHA-72), [KHA-74](https://linear.app/kamkm/issue/KHA-74) |
| [KHA-76: Match compatible queue entries atomically at the ten-second cutoff](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff) | Each signed-in ready queue entry commits exactly one compatible game or the agreed fallback assignment. | [KHA-73](https://linear.app/kamkm/issue/KHA-73) |
| [KHA-77: Build queue readiness and Stockfish fallback flows](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows) | Play yourself and Watch your agent play reach an automatic match, with clear readiness and fallback recovery. | [KHA-74](https://linear.app/kamkm/issue/KHA-74), [KHA-76](https://linear.app/kamkm/issue/KHA-76) |

## Public profiles, history and data removal

| Ticket | Outcome | Blocked by |
| --- | --- | --- |
| [KHA-72: Build public usernames, avatars and explicit guest linking](https://linear.app/kamkm/issue/KHA-72/build-public-usernames-avatars-and-explicit-guest-linking) | Accounts have a stable public profile identity without exposing their private sign-in identity. | [KHA-67](https://linear.app/kamkm/issue/KHA-67) |
| [KHA-78: Publish allowlisted online history and public replays](https://linear.app/kamkm/issue/KHA-78/publish-allowlisted-online-history-and-public-replays) | Completed online games have public results and replays with accurate declared control, while private local data stays private. | [KHA-72](https://linear.app/kamkm/issue/KHA-72), [KHA-73](https://linear.app/kamkm/issue/KHA-73) |
| [KHA-79: Implement account anonymization, explicit replay erasure and safe restore](https://linear.app/kamkm/issue/KHA-79/implement-account-anonymization-explicit-replay-erasure-and-safe) | Ordinary account deletion anonymizes shared games, while a verified removal request erases shared replays from both histories. | [KHA-78](https://linear.app/kamkm/issue/KHA-78) |

## Online acceptance and staged rollout

| Ticket | Outcome | Blocked by |
| --- | --- | --- |
| [KHA-80: Verify integrated online races, recovery and privacy boundaries](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) | A reproducible local integration suite proves the shared contracts under competing clients, workers and failures. | [KHA-71](https://linear.app/kamkm/issue/KHA-71), [KHA-75](https://linear.app/kamkm/issue/KHA-75), [KHA-77](https://linear.app/kamkm/issue/KHA-77), [KHA-79](https://linear.app/kamkm/issue/KHA-79) |
| [KHA-81: Verify native desktop accessibility and offline regression](https://linear.app/kamkm/issue/KHA-81/verify-native-desktop-accessibility-and-offline-regression) | The implemented flows work with native desktop keyboard, pointer and screen readers. | [KHA-71](https://linear.app/kamkm/issue/KHA-71), [KHA-75](https://linear.app/kamkm/issue/KHA-75), [KHA-77](https://linear.app/kamkm/issue/KHA-77), [KHA-79](https://linear.app/kamkm/issue/KHA-79) |
| [KHA-82: Verify native mobile touch and screen-reader online play](https://linear.app/kamkm/issue/KHA-82/verify-native-mobile-touch-and-screen-reader-online-play) | The implemented offline and online flows are usable on iOS and Android with touch and native screen readers. | [KHA-71](https://linear.app/kamkm/issue/KHA-71), [KHA-75](https://linear.app/kamkm/issue/KHA-75), [KHA-77](https://linear.app/kamkm/issue/KHA-77), [KHA-79](https://linear.app/kamkm/issue/KHA-79) |
| [KHA-83: Verify online hosting, credential isolation and sustainable capacity](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity) | The existing Vercel/Apache/Go/PostgreSQL host is verified for the new online service before enablement. | [KHA-80](https://linear.app/kamkm/issue/KHA-80) |
| [KHA-84: Complete online acceptance handoff and opt-in friend rollout](https://linear.app/kamkm/issue/KHA-84/complete-online-acceptance-handoff-and-opt-in-friend-rollout) | An evidence-backed, reversible opt-in friend release can be enabled after the recorded release decision. | [KHA-81](https://linear.app/kamkm/issue/KHA-81), [KHA-82](https://linear.app/kamkm/issue/KHA-82), [KHA-83](https://linear.app/kamkm/issue/KHA-83) |
| [KHA-85: Enable public agent matchmaking after friend rollout review](https://linear.app/kamkm/issue/KHA-85/enable-public-agent-matchmaking-after-friend-rollout-review) | Public agent matchmaking is enabled only after the friend cohort and queue-specific operating evidence are accepted. | [KHA-84](https://linear.app/kamkm/issue/KHA-84) |

## Acceptance trace

The table maps each of the 60 unrun implementation scenarios to tickets carrying that requirement. A feature ticket and a later verification ticket can reference the same scenario; verification references do not duplicate implementation scope. Full scenario wording and evidence status remain in the approved acceptance matrix.

| Scenario | Tickets |
| --- | --- |
| FRI-01: Invitation paths | [KHA-75](https://linear.app/kamkm/issue/KHA-75/implement-friend-invitations-account-challenges-and-mutual-rematches) |
| FRI-02: Independent seats | [KHA-75](https://linear.app/kamkm/issue/KHA-75/implement-friend-invitations-account-challenges-and-mutual-rematches) |
| FRI-03: Visible setup | [KHA-75](https://linear.app/kamkm/issue/KHA-75/implement-friend-invitations-account-challenges-and-mutual-rematches) |
| FRI-04: Mutual rematch | [KHA-75](https://linear.app/kamkm/issue/KHA-75/implement-friend-invitations-account-challenges-and-mutual-rematches) |
| QUE-01: Account and consent | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-85](https://linear.app/kamkm/issue/KHA-85/enable-public-agent-matchmaking-after-friend-rollout-review) |
| QUE-02: Compatible pairing | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff) |
| QUE-03: Concurrent games | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-85](https://linear.app/kamkm/issue/KHA-85/enable-public-agent-matchmaking-after-friend-rollout-review) |
| QUE-04: Multi-tab entry | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff) |
| QUE-05: Readiness start | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-77](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows) |
| QUE-06: Readiness failure | [KHA-77](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows) |
| QUE-07: Background eligibility | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-77](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows) |
| QUE-08: Selection change | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-77](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows) |
| QUE-09: Deadline equality | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries), [KHA-85](https://linear.app/kamkm/issue/KHA-85/enable-public-agent-matchmaking-after-friend-rollout-review) |
| QUE-10: Atomic allocation | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| QUE-11: Stockfish assignment | [KHA-77](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows), [KHA-85](https://linear.app/kamkm/issue/KHA-85/enable-public-agent-matchmaking-after-friend-rollout-review) |
| QUE-12: Fallback failure | [KHA-77](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows), [KHA-85](https://linear.app/kamkm/issue/KHA-85/enable-public-agent-matchmaking-after-friend-rollout-review) |
| QUE-13: Fixed opponent | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-77](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| QUE-14: Queue position isolation | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-77](https://linear.app/kamkm/issue/KHA-77/build-queue-readiness-and-stockfish-fallback-flows) |
| MAT-01: Opening clock | [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes) |
| MAT-02: First-move cancellation | [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| MAT-03: Accepted move ordering | [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| MAT-04: Expiry boundary | [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| MAT-05: Connected stalling | [KHA-70](https://linear.app/kamkm/issue/KHA-70/implement-online-presence-and-optional-abandonment-claims) |
| MAT-06: Optional offline claim | [KHA-70](https://linear.app/kamkm/issue/KHA-70/implement-online-presence-and-optional-abandonment-claims) |
| MAT-07: Reconnect race | [KHA-70](https://linear.app/kamkm/issue/KHA-70/implement-online-presence-and-optional-abandonment-claims), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| MAT-08: Clock continuity | [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes), [KHA-73](https://linear.app/kamkm/issue/KHA-73/run-browser-owned-online-agents-with-turn-leases-and-safe-handoffs) |
| MAT-09: Control changes | [KHA-73](https://linear.app/kamkm/issue/KHA-73/run-browser-owned-online-agents-with-turn-leases-and-safe-handoffs), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| MAT-10: Retry budgets | [KHA-73](https://linear.app/kamkm/issue/KHA-73/run-browser-owned-online-agents-with-turn-leases-and-safe-handoffs), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| MAT-11: Draw and takeback | [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| MAT-12: Immutable result | [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| HIS-01: Public identity | [KHA-72](https://linear.app/kamkm/issue/KHA-72/build-public-usernames-avatars-and-explicit-guest-linking) |
| HIS-02: Guest identity | [KHA-72](https://linear.app/kamkm/issue/KHA-72/build-public-usernames-avatars-and-explicit-guest-linking) |
| HIS-03: Included history | [KHA-78](https://linear.app/kamkm/issue/KHA-78/publish-allowlisted-online-history-and-public-replays) |
| HIS-04: Replay access | [KHA-78](https://linear.app/kamkm/issue/KHA-78/publish-allowlisted-online-history-and-public-replays) |
| HIS-05: Control attribution | [KHA-78](https://linear.app/kamkm/issue/KHA-78/publish-allowlisted-online-history-and-public-replays) |
| HIS-06: Routing privacy | [KHA-78](https://linear.app/kamkm/issue/KHA-78/publish-allowlisted-online-history-and-public-replays), [KHA-83](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity) |
| HIS-07: Assurance | [KHA-78](https://linear.app/kamkm/issue/KHA-78/publish-allowlisted-online-history-and-public-replays), [KHA-83](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity) |
| HIS-08: Account deletion | [KHA-79](https://linear.app/kamkm/issue/KHA-79/implement-account-anonymization-explicit-replay-erasure-and-safe) |
| HIS-09: Explicit removal | [KHA-79](https://linear.app/kamkm/issue/KHA-79/implement-account-anonymization-explicit-replay-erasure-and-safe) |
| HIS-10: Private archives | [KHA-78](https://linear.app/kamkm/issue/KHA-78/publish-allowlisted-online-history-and-public-replays), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries), [KHA-83](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity) |
| ARC-01: Rules parity | [KHA-66](https://linear.app/kamkm/issue/KHA-66/run-the-pinned-chess-rules-in-a-private-node-worker) |
| ARC-02: Single writer | [KHA-65](https://linear.app/kamkm/issue/KHA-65/add-shared-online-state-transactional-commands-and-operation-receipts), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| ARC-03: Fresh decision time | [KHA-65](https://linear.app/kamkm/issue/KHA-65/add-shared-online-state-transactional-commands-and-operation-receipts), [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| ARC-04: Operation receipts | [KHA-65](https://linear.app/kamkm/issue/KHA-65/add-shared-online-state-transactional-commands-and-operation-receipts), [KHA-68](https://linear.app/kamkm/issue/KHA-68/implement-authoritative-online-moves-clocks-and-match-outcomes), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| ARC-05: Token and membership | [KHA-67](https://linear.app/kamkm/issue/KHA-67/authorize-online-participants-and-revocable-guest-seats), [KHA-69](https://linear.app/kamkm/issue/KHA-69/deliver-finite-authenticated-updates-with-snapshot-and-polling), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries), [KHA-83](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity) |
| ARC-06: Guest credential | [KHA-67](https://linear.app/kamkm/issue/KHA-67/authorize-online-participants-and-revocable-guest-seats), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries), [KHA-83](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity) |
| ARC-07: Stream recovery | [KHA-69](https://linear.app/kamkm/issue/KHA-69/deliver-finite-authenticated-updates-with-snapshot-and-polling), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| ARC-08: Agent runner | [KHA-73](https://linear.app/kamkm/issue/KHA-73/run-browser-owned-online-agents-with-turn-leases-and-safe-handoffs), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| ARC-09: Uncertain provider work | [KHA-73](https://linear.app/kamkm/issue/KHA-73/run-browser-owned-online-agents-with-turn-leases-and-safe-handoffs), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| ARC-10: Late timer | [KHA-76](https://linear.app/kamkm/issue/KHA-76/match-compatible-queue-entries-atomically-at-the-ten-second-cutoff), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| ARC-11: Service outage | [KHA-71](https://linear.app/kamkm/issue/KHA-71/recover-online-service-interruptions-without-false-abandonment-results), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries) |
| ARC-12: Backup removal | [KHA-79](https://linear.app/kamkm/issue/KHA-79/implement-account-anonymization-explicit-replay-erasure-and-safe), [KHA-80](https://linear.app/kamkm/issue/KHA-80/verify-integrated-online-races-recovery-and-privacy-boundaries), [KHA-83](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity) |
| ARC-13: Host verification | [KHA-83](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity) |
| ARC-14: Capacity gate | [KHA-83](https://linear.app/kamkm/issue/KHA-83/verify-online-hosting-credential-isolation-and-sustainable-capacity), [KHA-85](https://linear.app/kamkm/issue/KHA-85/enable-public-agent-matchmaking-after-friend-rollout-review) |
| UX-02: Native accessible play | [KHA-81](https://linear.app/kamkm/issue/KHA-81/verify-native-desktop-accessibility-and-offline-regression), [KHA-82](https://linear.app/kamkm/issue/KHA-82/verify-native-mobile-touch-and-screen-reader-online-play) |
| UX-03: Concise states | [KHA-64](https://linear.app/kamkm/issue/KHA-64/preserve-offline-play-and-add-drawresign-icon-controls), [KHA-74](https://linear.app/kamkm/issue/KHA-74/build-the-online-board-workspace-and-concurrent-game-navigation), [KHA-81](https://linear.app/kamkm/issue/KHA-81/verify-native-desktop-accessibility-and-offline-regression), [KHA-82](https://linear.app/kamkm/issue/KHA-82/verify-native-mobile-touch-and-screen-reader-online-play) |
| UX-04: Concurrent navigation | [KHA-74](https://linear.app/kamkm/issue/KHA-74/build-the-online-board-workspace-and-concurrent-game-navigation), [KHA-81](https://linear.app/kamkm/issue/KHA-81/verify-native-desktop-accessibility-and-offline-regression), [KHA-82](https://linear.app/kamkm/issue/KHA-82/verify-native-mobile-touch-and-screen-reader-online-play) |
| UX-05: Preserved offline game | [KHA-64](https://linear.app/kamkm/issue/KHA-64/preserve-offline-play-and-add-drawresign-icon-controls), [KHA-81](https://linear.app/kamkm/issue/KHA-81/verify-native-desktop-accessibility-and-offline-regression), [KHA-82](https://linear.app/kamkm/issue/KHA-82/verify-native-mobile-touch-and-screen-reader-online-play) |
| UX-06: Removed attribution panel | [KHA-74](https://linear.app/kamkm/issue/KHA-74/build-the-online-board-workspace-and-concurrent-game-navigation), [KHA-78](https://linear.app/kamkm/issue/KHA-78/publish-allowlisted-online-history-and-public-replays), [KHA-81](https://linear.app/kamkm/issue/KHA-81/verify-native-desktop-accessibility-and-offline-regression), [KHA-82](https://linear.app/kamkm/issue/KHA-82/verify-native-mobile-touch-and-screen-reader-online-play) |
| REL-02: Release separation | [KHA-84](https://linear.app/kamkm/issue/KHA-84/complete-online-acceptance-handoff-and-opt-in-friend-rollout), [KHA-85](https://linear.app/kamkm/issue/KHA-85/enable-public-agent-matchmaking-after-friend-rollout-review) |

## Evidence and rollout

KHA-80 records local integrated race/recovery/privacy evidence. KHA-81 and KHA-82 record actual desktop and mobile assistive-technology evidence. KHA-83 records authorized staging/host, privacy/credential, restore and measured capacity evidence. Existing MVP verification is a baseline and does not pass these new scenarios.

KHA-84 reconciles the evidence and the separate opt-in friend release decision. KHA-85 follows the friend cohort with the public-queue release decision and operating checks. Approval, access or real-device prerequisites are resolved when those tickets are executed. Creating tickets starts no deployment or paid provider work.

## Preserved sources

- Approved specification/acceptance snapshot on `planning/online-play-handoff`, commit `7023260a8d11678a521d73dc8b1e0cd3c8d37b5d`.
- Accepted prototype A with owner corrections on `prototype/online-play-map`, commit `367ad78069571ff053002e1aaf74e8aad4bf1ec1`, with corrected HTML attached to [KHA-61](https://linear.app/kamkm/issue/KHA-61).
- Local curated backlog snapshots are `docs/spec/online-play-implementation-plan.md` and `docs/spec/online-play-implementation-tickets.json` on `planning/online-play-handoff`.
