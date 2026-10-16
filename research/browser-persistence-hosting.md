# Browser persistence, clock recovery, and managed hosting

Research for [KHA-23](https://linear.app/kamkm/issue/KHA-23/verify-browser-persistence-clock-recovery-and-managed-sync-hosting), informing [KHA-13](https://linear.app/kamkm/issue/KHA-13/choose-the-application-architecture-and-data-boundaries). Sources accessed on 2026-10-16 UTC. This is evidence gathering, not architecture, vendor, budget, or license approval.

## Finding

A React/TypeScript/Vite static application with hosted Supabase Auth and Postgres is a plausible low-maintenance candidate. IndexedDB can atomically save a match checkpoint, archive additions, and its pending-sync record. Postgres can serialize ownership changes and reject stale writes. The browser can calculate elapsed time after refresh, suspension, or closed tabs without running a timer throughout the absence. These capabilities do not establish all the requested guarantees. [S1][S5][S7][S9]

Three limits require explicit treatment in the specification:

1. Browser storage is recoverable working storage, not an unconditional durable archive. Quota failure, eviction, user deletion, private browsing, crashes before a commit, and device loss remain possible. An absolute promise to retain every byte delivered immediately before process termination is impossible here. [S1][S2][S3][S4]
2. Browser clocks cannot establish tamper-resistant elapsed real time across arbitrary operating-system clock changes, process termination, and disconnected devices. A deadline gives continuous-time semantics under a stated time-source assumption. It does not prove the assumption. [S5]
3. Hosted compare-and-swap can guarantee one accepted cloud history. It cannot simultaneously permit authoritative disconnected play on an old writer, immediate takeover on another device, and strict one-writer play everywhere. The old disconnected writer cannot learn that its epoch was revoked. Owner approval for a behavioral compromise is still required. [S7][S9]

No vendor needs chess authority or an AI generation relay to implement storage and ownership metadata. A public static site also needs an intentional auth/email configuration, a backup and deletion procedure, browser-specific acceptance, and an owner-approved operating budget. The Free plans do not by themselves establish production availability or indefinite retention. [S10][S12][S13][S14][S15][S17][S18]

## Scope and evidence labels

**Documentation** below means a standard, published vendor policy, or inspected package/source. **Observed experiment** means the small synthetic probe reproduced in the appendix. **Application proposal** means a design to evaluate in KHA-13. A proposal is neither implemented nor accepted.

The authoritative map is [KHA-5](https://linear.app/kamkm/issue/KHA-5/find-the-way-to-the-ai-chess-mvp). I fetched it, KHA-23, KHA-13, and the following canonical resolution comments through native Linear tools:

- KHA-10, comment `64c107b9-2653-44f4-8496-2de310dbcb81`, for full received records, full attributed replay, incomplete replies, and response fencing.
- KHA-11, comment `084530f6-8495-4a8c-b5b8-bcc93f7b10ac`, for continuous clocks, Undo, guest saves, owner-only account sync, final results, and one writer.

The local context was `docs/agents/issue-tracker.md` and `CONTEXT.md` at parent commit `161622fbd213738282328485f25223625e3106db`. The task brief fixes interface A, Classic workspace, at prototype commit `6af7fa61aec5668b4e8b42c1f1ba4a89f37cda45`. This report does not reopen it or certify its accessibility. Rules-library suitability and complete dead-position/side-specific possible-mate detection belong to KHA-22. This report does not replace them with generic material tests.

The browser remains responsible for rules, match transitions, clock calculations, discovery, and direct generation. Hosted operations below concern authentication, owner access, revision/epoch fencing, and storage. AI credentials remain device-local by default. The three provider protocols, current-session compatibility-pass rules, complete replay, no automatic model fallback, and no hidden paid checks remain unchanged.

## Static application and maintenance boundary

**Documentation.** Vite produces a static production bundle. Its build target transforms syntax; it does not supply missing browser storage, locking, or lifecycle guarantees. At Vite `8.3.4`, the inspected target constants include Chrome/Edge 111, Firefox 114, Safari/iOS 16.4. Its Node requirement is `^20.19.0 || >=22.12.0`. These are tool compatibility facts, not the application's launch support declaration. [S19]

**Application proposal.** Keep React rendering separate from a browser match controller and persistence/sync adapters. React effect replay, remounts, route changes, and an auth refresh must not create another actionable controller or request. Give every transition an operation ID and monotonically increasing state/request versions. Keep storage schemas, browser-controller versions, and cloud RPC contracts versioned so an old cached tab cannot overwrite data written by a newer deployment.

The static host serves application assets. Supabase handles accounts, owner-only data, and transactional metadata. Neither Cloudflare Functions nor Vercel Functions is needed for chess or model generation. The browser uses only a publishable Supabase project key plus the signed-in user's auth token. Administrative/secret/service-role keys never enter a bundle. `VITE_*` variables are embedded in client code and must never contain provider keys or administrative credentials. [S10][S19]

This reduces server operation but leaves dependency/security updates, schema migrations, SQL/RLS review, backups and restore drills, auth abuse/deliverability, billing monitoring, domain/redirect maintenance, and native browser acceptance with the project. Pin dependencies and a supported build-time Node release. Do not interpret a package's minimum Node engine as a recommendation to run an obsolete runtime indefinitely.

A service worker is optional for loading the application while offline. It is not an always-running clock, generation process, or ownership arbiter. The service-worker specification allows termination; browser lifecycle documentation also permits freezing and discarding pages. Avoid caching auth callbacks, authenticated API responses, provider requests, or private archives as generic static assets. A deployment/cache upgrade must preserve the IndexedDB schema and stop incompatible writers. [S6][S24]

## Local atomic saves and the full archive

**Documentation.** IndexedDB read/write transactions with overlapping stores serialize. A commit atomically writes all transaction changes or none. A successful individual request is not a successful transaction. Observe the transaction's completion or abort. The specification's `strict` durability hint requests stronger flush behavior; it does not override eviction, deletion, storage hardware failure, or an uncommitted in-memory receive buffer. `relaxed` may report completion after writes reach the operating system without verifying persistent media. [S1]

**Application proposal.** A local save transaction can include:

- An immutable received-data chunk or completed response record, original provider/protocol attribution, response sequence, and completeness/status metadata.
- The active replay line's references, separately retained discarded continuations, rules state/history, accepted events, request/position versions, turn budgets, selections, clock accounting, and any final result/practice segment.
- The new local revision and an idempotent outbox entry for that exact owner/game/segment/revision.

Do not serialize only FEN, the visible move list, or rendered text. Preserve raw bytes available from the Fetch response body or original ordered events as well as normalized conversation records. Re-encoding parsed JSON can lose duplicate keys, original field order, whitespace, unknown fields, or opaque values. A streaming text decoder also needs correct multibyte handling. This archive concerns application-received bytes/events, not inaccessible TLS packets or credentials in outgoing transport headers. [S1][S20]

Keep the received archive append-only during ordinary play. Undo changes active-line references and retains the discarded continuation separately. It must not delete received records or reveal discarded moves in later model input. Treat duplicate/stale/canceled replies as archived records with status, never another move. Persist the final-result latch, current segment, and version changes with the transition that creates them.

Do not hold an IndexedDB transaction open while waiting for network or provider input. Gather a bounded chunk, then perform its short transaction. Auto-commit and inactive-transaction rules make an open transaction across unrelated asynchronous work unsuitable. Likewise, do not assume IndexedDB, network sync, and Supabase Storage object uploads form one distributed transaction. [S1]

Publish separate states for saved locally, pending sync, synced at revision, and save failure. Mark data saved locally only after transaction completion. Disk/quota/open/upgrade/abort failures need visible recovery and export options. A blocked version upgrade needs another-tab instructions; do not delete the database to fix it. Storage estimation is approximate, so success must still be checked on each transaction. [S1][S2][S3]

Full-history growth needs measured limits. Appending immutable chunks avoids rewriting the entire received history on every SSE event. Syncing only new chunks avoids quadratic transfer. Neither technique permits dropping replay content, automatic summarization, hidden history truncation, or deletion of undone continuations. A full store leaves a genuine save/capacity problem. The owner must decide whether to fund more storage, export/delete explicitly selected games, or restrict new work. The app must preserve the distinction between incomplete received content and a completed actionable answer.

There is a receive-to-commit crash window. If the browser receives a chunk and dies before committing it, this design cannot recover the exact chunk without support outside the permitted browser-only generation boundary. Nor can local storage provide a successful save when the device refuses writes. State the retention guarantee as applying to successfully committed data under the documented browser limits. If the product requires unconditional losslessness even across these failures, this candidate does not meet that requirement. This is an unresolved requirement limit, not approval to discard data.

### Capacity, eviction, and private browsing

**Documentation.** Storage belongs to the origin/storage partition. A new hostname, scheme, port, browser profile, private session, or standalone web-app context must not be assumed to share the old application's saves. Persistent storage is a request, not an entitlement. User deletion remains possible. Private storage commonly ends with the private session. [S2][S3][S4]

Published quota policies are upper bounds, not free space or a reservation:

- Chromium documentation summarized by MDN describes up to 60% of total disk per origin. Available space can prevent reaching it. This covers Chrome/Edge policy, not an experiment on either target. [S3]
- Firefox documents best-effort storage as the smaller of 10% of disk or a 10 GiB site-group limit. Persistent mode can use up to 50% of disk, capped at 8 TiB. Permission and actual disk availability still matter. [S3]
- WebKit's Safari 17/iOS 17 policy documents up to 60% per browser origin and 80% overall; embedded non-browser applications have different limits. Cross-origin frames use separate partitions and a smaller quota. Its persistence heuristic can consider Home Screen installation. These are policy maxima, not acceptance measurements. [S4]
- WebKit's ITP documentation describes deleting script-writable storage after seven days of Safari use without user interaction on the site. That is not seven elapsed calendar days. Its Home Screen discussion has a different usage counter. The cited policy is not proof that a particular current device will preserve an inactive game. [S4]

Request `navigator.storage.persist()` at an understandable save/import interaction, check `persisted()`, and display the result accurately. Firefox may show permission UI; Chromium/Safari use heuristics. `estimate()` is useful for approximate pressure warnings, not proof that the next write will succeed. Do not promise that persistence permission defeats every Safari policy. [S2][S3][S4]

Guest export/import and an account copy reduce different risks. A sync copy does not protect a guest who never imported, and a same-device download is not an independent backup against device loss. Stable production origin and explicit migrations matter. Authenticated game content must not leak through an otherwise public CDN or service-worker cache.

## Credentials, local namespaces, and sign-out

**Documentation.** Origin-local storage is readable by scripts executing with that origin's authority. Namespacing records by user ID is application organization, not an isolation boundary against XSS, a malicious extension, or someone controlling the browser profile. Supabase RLS protects server access; it does not protect a browser's local AI keys from that browser's scripts. [S2][S10]

**Application proposal.** Use a dedicated local credential store and explicit namespaces, for example a random local guest-context ID and `supabase-project/user-UUID`. Key each connection by a local ID and configuration/credential revision. Use the verified account UUID rather than email or a display label. Do not put keys in URLs, hashes, game exports, sync DTOs, telemetry, exception reports, screenshots, or debugging traces. Credential revisions can be local non-secret counters/nonces rather than fingerprints derived from key material.

Keep AI keys distinct from Supabase session tokens, which are needed for authenticated storage calls. Allowlisted game-sync fields exclude both credential stores, request headers, provider auth/query parameters, and private endpoint configuration that embeds a secret. A restored account game needs deliberate binding to a compatible connection on that device. It cannot silently reuse another account's or guest's key.

Recommended sign-out behavior for KHA-13 to adopt or adjust:

1. Fence active requests, clear in-memory credentials and private views, and stop initiating requests under the departing account. Stop generation without pausing the match deadline.
2. Remove that account's locally saved AI credentials on sign-out. This is a proposed privacy default, not an earlier owner resolution. Keep guest credentials separate; offer the required per-connection Forget and clear-all-local-credentials controls.
3. Keep unsynced game/outbox records associated with their original owner. Explain their pending status before any destructive local-data action. Never relabel them as a new guest's or next account's data. On reauthentication, verify the UUID before reading/retrying that namespace. Clearing browser data can still destroy them.
4. Serialize identity changes with local writes and async callbacks. A delayed callback from account A must not render in, bind credentials to, or upload through account B. Synchronize sign-out notices across tabs, with durable identity/version checks before commits.

Whether to retain private cached account games after sign-out is a separate retention choice. Hiding their UI does not encrypt them against someone with the same browser profile. Encrypting with a key stored alongside the data does not solve that threat. A user-held passphrase can improve at-rest separation, but adds unlock/recovery work and still cannot protect an unlocked session from same-origin malicious code. Do not claim this as implemented isolation.

Exact raw provider records create an edge case for the no-secret-sync policy. A misconfigured endpoint can echo a submitted key in an error body. Do not silently redact the sole archive and call it lossless, or upload a known key as ordinary game content. Keep that exact contaminated record local, block its sync/export path that would expose the key, and explain the conflict. Check serialized outbound payloads for known locally held secrets as an additional guard. Such checking cannot prove that arbitrary transformed secrets are absent. Avoid ever placing keys in prompts, and define this exceptional retention policy explicitly.

Use a restrictive CSP compatible with configured direct-provider destinations, bundle dependencies instead of loading arbitrary third-party scripts, render transcripts as untrusted text, and keep debug logging off. Logging should allowlist operation ID, revision, protocol, coarse status, and sanitized error category. Do not log request bodies, tokens, raw provider errors, SQL payloads, or private archives by default. A custom-endpoint feature makes a fixed `connect-src` policy an actual design constraint, not a reason to add a server AI relay.

## Local writer exclusion and fallback

**Documentation.** Web Locks coordinates cooperative agents sharing a storage bucket. An exclusive lock is not a cross-device lock. Locks terminate when agents terminate, but a frozen page can delay useful work. BroadcastChannel provides notices, not transactional exclusion. [S7][S8]

**Application proposal.** Hold an exclusive lock named for the context/game while a tab acts as its local controller. Treat the lock as a coordination aid. Every state mutation also checks a persisted local owner token, epoch, revision, segment, and request generation in the same IndexedDB transaction that writes the new state. A tab waiting for a lock is a reader and cannot issue actionable generation. Handle hidden/frozen lifecycle states deliberately; reacquire and reread before resuming. Do not pause the chess clock when releasing a browser resource. [S1][S6][S7]

If Web Locks is unavailable, a short IndexedDB read/check/write transaction can serialize owner-token claims and fenced state changes. A local lease plus notifications can aid recovery, but a heartbeat alone is unsafe: throttling or sleep can look like a dead writer. Advancing the epoch on an explicit takeover rejects the old tab's next transaction. Revalidate at dispatch and immediately before accepting a reply. A provider request already in flight may still cost money after its owner is fenced; neither a Web Lock nor abort guarantees upstream cancellation.

This fallback protects committed local state under cooperative application code. It is not a guarantee of one network request globally under arbitrary freezing. There remains a window between dispatch validation and network dispatch, and a server cannot retract an old disconnected browser's direct request. Never market an IndexedDB lease or a localStorage heartbeat as a universal distributed lock.

## Continuous clocks and recovery

**Documentation.** JavaScript timers can be throttled, suspended, or discarded. `beforeunload` is unreliable, particularly on mobile; a final unload save is insufficient. High Resolution Time separates monotonic time from the adjustable wall clock. `performance.now()` is useful for an uninterrupted process, but its origin does not survive process replacement as a persistent elapsed-time reference. MDN documents browser differences in ticking through operating-system sleep, with Windows behavior differing from other platforms. This is documentation, not sleep evidence from this task. [S5][S6]

**Application proposal.** Save remaining banks, the running side, a persisted elapsed-time anchor/deadline, the time-source basis, credited increments, and versioned events. Render from elapsed time. Do not subtract one second per timer callback or persist every display tick.

Under a stable chosen time source, the active side has `remaining(t) = bankAtAnchor - (t - anchor)`. Its effective expiry instant is `anchor + bankAtAnchor`. After absence, calculate this before enabling play or starting a request. If expired, the browser records the correct result with that effective expiry instant rather than granting time at reopen. No JavaScript must run at the expiry instant for this calculation. However, no client-side callback or cloud result row is guaranteed to appear at that instant while all clients are closed. Requiring immediate materialization would need another execution authority and would conflict with the accepted browser-only chess boundary.

For an accepted event, one serialized controller should:

1. Revalidate owner/epoch, revision, segment, side, and request eligibility, then sample/reconcile the clock.
2. Resolve an already reached deadline before an attempted move, Retry, Undo, sign-in handoff, or model switch. Only a completed eligible legal move accepted before expiry transfers the clock and receives one increment. Partial responses, stale messages, illegal moves, diagnostics, and errors receive none.
3. Persist the ordered transition, clock accounting, archive references, and final latch together. Do not publish a durable save or dispatch a follow-up move on an uncommitted checkpoint.
4. For Undo, charge the active side through the accepted Undo event, remove only increment credits attached to undone moves, and retain elapsed charges. Reject Undo if removing credits would leave either bank nonpositive, as KHA-11 requires. Advance live versions even when restoring an old FEN. Preserve the original final result during practice.

KHA-13 still needs an exact acceptance timestamp policy around asynchronous disk/cloud commits. For example, does acceptance occur when the browser validates the event or after its required persistence acknowledgment? A failed save cannot both count as a durable move and leave no saved transition. Cloud response loss likewise leaves an uncertain operation, not permission to dispatch another generation. Define and test one event order, idempotent recovery, and clock charging through that uncertainty. Do not backdate a late provider response using provider timestamps or the time its first token arrived.

Keep monotonic and wall-clock samples during a live page to detect some discrepancies. A `max(wallElapsed, monotonicElapsed, 0)` rule avoids some refunds but can cause false time losses after a forward wall-clock jump. Using only monotonic time can miss sleep on affected platforms. Across a reload there may be no independent surviving monotonic reference. Neither heuristic proves true elapsed time. Never silently reset an anchor, clamp away absence, or grant time to hide an anomaly. [S5]

Actionable alternatives for time anomalies, all requiring a clear product contract:

- Accept honest-device wall time for absence, detect anomalies where possible, and disclose that a changed clock can yield an uncertain or wrong result. This preserves a lightweight browser authority but does not satisfy adversarial timing.
- Use online server-issued ownership/commit timestamps as reference metadata and estimate offset/round-trip uncertainty in the browser. The browser still calculates chess time and outcomes. This improves cross-device alignment while online but cannot establish exact offline elapsed time, symmetric network delay, or tamper resistance. A timestamp reference is not permission for hosted chess adjudication.
- Require an online reconciliation before authoritative account play after uncertain recovery. The clock continues while recovery is blocked. This gives up some offline availability and still needs an owner decision. It does not solve disconnected guest timing absolutely.

The correct timeout result also depends on whether the opponent can possibly mate from the actual position. Generic insufficient-material tests do not establish that predicate. KHA-22 must settle supported rules or a precise requirement alternative before this architecture can claim correct timeout adjudication for every permitted custom position.

## Owner-only hosted storage and one accepted history

**Documentation.** Supabase exposes Postgres with JWT-aware RLS. An authenticated role alone is not owner-only access. Use `auth.uid()` ownership policies and constrain both old-row visibility and new-row values. Administrative keys bypass RLS and belong outside the browser. Database functions have grants and execution-security implications; a definer function can bypass caller restrictions. [S10]

**Application proposal.** Store `owner_user_id` on every game and related archive/outbox object. Revoke anonymous access. Apply owner checks to reads, inserts, updates, deletion, related rows, views, RPCs, and optional private Storage objects. Keep an auth-user reference and explicit deletion behavior. Test two users and anonymous access, forged owner IDs, relation traversal, list APIs, RPC arguments, and reused signed links. Owner-only means other application users cannot read a game. It does not mean the hosting operator cannot access plaintext stored there.

RLS alone does not impose epochs, transition order, or immutability. Do not leave a direct update/upsert path that bypasses the CAS operation. Use a narrow, reviewed transactional RPC or equivalent database guard. A definer RPC, if needed to restrict table writes, must explicitly validate the authenticated owner, use a fixed/empty search path and qualified names, and grant execution only to intended roles. An invoker function is preferable when its required grants can be constrained adequately. Neither an RPC name nor a private schema alone proves access safety. [S10]

Conceptual metadata for each account game:

```text
owner_user_id, game_id, active_segment_id
writer_instance_id, ownership_epoch, optional_lease_expires_at
revision, last_operation_id, immutable_result_reference
payload/checkpoint references, tombstone/deletion revision
```

The database operation checks the authenticated owner, expected epoch, expected revision, operation ID, and any lease condition, then stores the browser-produced checkpoint/archive references and advances the revision in one transaction. A mismatch returns a conflict without writing. Ownership acquisition/handoff advances the epoch atomically. Never use last-write-wins timestamps or FEN equality as the conflict rule.

Postgres documents that a concurrent conditional `UPDATE` at Read Committed waits for the other updater and re-evaluates its `WHERE` condition against the updated row. That supports a single-row expected-revision CAS. Several interdependent rows need one transaction, a consistent lock order, and appropriate explicit locking or serializable isolation with bounded retry of metadata operations. The browser experiment below is not a Postgres experiment. [S9]

Keep final-result records immutable through storage constraints/write guards. Practice can append a separate segment; it cannot replace the scored result. Keep deletion tombstones/version checks long enough to reject queued stale uploads, and prevent an offline client from recreating a deleted game through an unrestricted insert. Define how old backup restores interact with tombstones. The backend can enforce storage immutability without deciding whether a chess move or result is correct.

The cloud can hold opaque chess state and received records without validating chess. It can enforce access, epochs, revision order, idempotency, and final-record immutability. It cannot certify a malicious browser's move legality or time calculation under this boundary. Avoid claiming anti-cheat or server-certified results.

### Handoff, missing acknowledgments, and offline copies

Handoff must transfer or load the last accepted checkpoint and archive, advance the epoch, preserve the deadline, fence old responses, and resolve any uncertain operation before another actionable generation. Keep an operation ID so a lost response can be queried/retried idempotently. Advancing a local flag or sending a BroadcastChannel/Realtime notice is insufficient to transfer cloud authority.

A delayed old request that reaches the database after takeover must fail its epoch/revision test. A reconnecting outbox must fetch current metadata before replay. It must not overwrite a newer line, Undo, tombstone, or final result. Preserve the disconnected records as a separate local conflict record/export if they cannot join the accepted history. Do not merge chess positions or ask a model to reconcile them.

There is no atomic transaction spanning a local IndexedDB commit and a cloud transaction. Stage locally with an idempotent outbox, distinguish tentative/pending data from acknowledged state, and reconcile crashes between the two. If an implementation wants to call an offline checkpoint authoritative, its takeover restrictions must make that true. Storage acknowledgment must not be confused with permission to declare a second writer.

The owner needs to choose among these alternatives:

- **Online acknowledgment for authoritative account transitions.** Each accepted account transition needs a valid ownership epoch and successful cloud CAS. An unavailable backend blocks authoritative moves/handoff while the clock continues. Local received records and attempted work can still be saved. This offers a strong single accepted history at the cost of offline play availability and added latency. It needs explicit ownership of the move-versus-acknowledgment timestamp policy.
- **Offline play with a provisional continuation.** An offline browser can retain work, but the UI must label it provisional. Another device can take over through an epoch change. On reconnect, a diverged continuation cannot replace the accepted line or final result. This preserves useful offline activity but does not meet strict one-authoritative-writer play if both devices call their play authoritative.
- **Exclusive device ownership until release.** Refuse another device's takeover until the old owner relinquishes ownership, with a separately approved crash/lost-device recovery procedure. This limits immediate recovery. A timeout-based forced takeover reintroduces the disconnected-writer problem unless the old writer was already required to stop authoritative transitions at a safe lease boundary.

No lease length or reconnect retry erases this tradeoff. Database time can make lease evaluation consistent at the database, but an offline browser cannot verify renewed ownership. An old direct model request may complete or incur charges after takeover. Epoch fencing prevents its move from entering the accepted state; it cannot undo provider work. These are consequences to present for owner choice, not approved offline restrictions.

### Postgres records versus object storage

For bounded archives, storing chunks and metadata in Postgres permits transactional checkpoint/reference updates. Measure real archive size, index overhead, read/write load, and transfer before deciding that the database quota is sufficient. Do not convert the quota into a supported game count from an invented average.

Supabase Storage is an alternative for larger immutable chunks, with private bucket policies and opaque non-secret object names. Upload first, then transactionally publish a manifest/reference only after verification. A crash can leave unreferenced objects, so design idempotent cleanup and retention. Do not overwrite a live archive object or publish a reference before its data exists. Object upload plus Postgres metadata is not one atomic operation. A signed URL is a bearer capability until its expiry; do not expose it through logs or public UI. Storage adds an object backup/deletion path and is not automatically the simpler MVP choice. [S11][S14][S16]

The published Storage global maximum file-size setting cannot exceed 50 MB on Free. Pro and above allow configuring it up to 500 GB, subject to a lower per-bucket setting. This is an individual upload limit, separate from total storage/egress allowances. Do not assume a growing archive can remain one uploadable object, or that upgrading automatically changes the configured limit. [S11]

## Authentication and redirects

**Documentation.** The inspected `@supabase/supabase-js` and `@supabase/auth-js` `2.118.0` packages default to persisted sessions, auto-refresh, URL session detection, and `flowType: 'implicit'`. Explicitly select the desired flow instead of assuming a copied server-side example describes SPA defaults. The inspected auth source says default coordination is lockless and does not implicitly use `navigator.locks` or `processLock`; an auth library is not the match-writer lock. [S20]

PKCE is a candidate for a static SPA with browser-side code exchange, without an auth BFF. Supabase documents one-time auth codes valid for five minutes and a verifier stored where login started. The callback must reach that browser/device with the verifier. Opening a mail link in another browser, a different device, or a separate storage context can fail. Overlapping PKCE flows may overwrite a verifier under the documented default behavior. Test this against the chosen SDK configuration; do not silently disable verification to make it work. [S12]

Set the real HTTPS production `SITE_URL`, an exact allowlisted callback path, and matching email/OAuth configuration. Restrict preview/development wildcards to their intended trusted scope. The callback must survive a direct deep-link load and browser refresh. Cloudflare Pages' default SPA fallback depends on the absence of a top-level `404.html`; Vercel's Vite guide documents an explicit SPA rewrite. Cloudflare Workers Static Assets has an explicit single-page-application not-found option. [S12][S17][S18]

Do not run real sign-in for arbitrary preview deployments connected to production private data. Allowlisting a preview URL also gives code deployed there access to its callback context. Different preview origins do not inherit production local saves/credentials. For mobile mail and OAuth flows, test the return to the actual Safari/Chrome context, canceled login, expired codes, lost verifier, back/refresh, private browsing, and overlapping tabs. This report contains no authenticated redirect or OAuth-provider experiment.

Supabase's default SMTP sends only to project-team addresses, has a published two-message-per-hour limit, and offers no delivery/uptime SLA. Public email signup, verification, reset, or magic links need custom SMTP or another deliberately chosen auth route. The custom-SMTP guide initially imposes 30 messages/hour, adjustable in project settings; provider limits, cost, DNS/deliverability, abuse controls, and user-level cooldowns also apply. MAU allowance does not buy email throughput. Social login can avoid some mail paths but creates provider setup and recovery choices; do not select it without the owner. [S13]

JavaScript sign-out defaults to global scope. An ordinary per-device sign-out should explicitly request local scope if independent other-device sessions are intended. Revoking refresh tokens does not immediately invalidate already-issued access JWTs, which remain usable until expiration. Account deletion similarly needs data/ownership cleanup and cannot rely on client UI sign-out for immediate server revocation. Online fencing/revocation checks can strengthen an application action but cannot inform an offline tab instantly. [S12][S16]

## Published hosting and service costs

These are public USD list prices and allowances observed on 2026-10-16, not quotes or an approved budget. Plan definitions, taxes, regional usage, and policies can change. No service was provisioned or purchased.

### Supabase managed candidate

**Documentation.** The pricing page advertises Free at $0/month, two active projects, 50,000 monthly active users, 500 MB database size, 1 GB file storage, 5 GB egress, and 5 GB cached egress. Free projects pause after one week of inactivity. The production checklist says low activity in a seven-day period can trigger pausing and recommends Pro to avoid inactivity pauses. Free database backups are not downloadable as managed daily backups; Supabase recommends regular CLI logical exports/off-site backups. [S14][S15]

Free database size over 500 MB triggers read-only mode. This is database data size, distinct from the documented 1 GB disk allowance. The billing fair-use policy can restrict a project or organization, including pausing, read-only mode, or API rejection. Treat quotas as failure modes for ownership CAS and sign-in as well as archive sync. Never rely on synthetic keep-alive traffic as a production availability plan. [S15]

Pro starts at $25/month with one project included through the $10 compute credit, enough for one Micro instance. Additional projects start around $10/month. Published inclusions are 100,000 MAU, 8 GB disk/project, 100 GB file storage, 250 GB egress and 250 GB cached egress. Overage rates shown include $0.00325/MAU, $0.125/GB database disk, $0.0213/GB file storage, $0.09/GB uncached egress, and $0.03/GB cached egress. Pro has seven-day daily backups and seven-day log retention. The public page places uptime/priority SLA offerings on higher plans; paying for Pro is not evidence of an application uptime guarantee. [S14]

Pro's spend cap is on by default and prevents further use of covered resources after their allowance, rather than guaranteeing continued service. Compute, branching/read replicas, custom domains, provisioned disk performance, IPv4, log drains, MFA phone, and PITR are among exclusions. Thus $25 is neither an all-in hard cap nor a promise of uninterrupted sync. Standard Supabase project URLs avoid the optional $10/month custom-domain add-on unless branding/auth needs justify it. [S14][S15]

The cited production/free documentation establishes pausing and restoration through the dashboard, not an indefinite retention guarantee for a dormant free project. Before relying on long-idle account games, confirm the then-current paused-project recovery window, terms, deletion policy, and export availability. Do not promise permanent account archives from a free-tier headline.

### Cloudflare static candidate

**Documentation.** Cloudflare Pages advertises unlimited static requests/bandwidth and sites/seats across its plans. The Free build allowance is 500/month with one concurrent build, a 20-minute build timeout, 20,000 files/site, and 25 MiB maximum single static asset. These are deployable application asset limits, not permission to put private game archives in public assets. Pages Functions consume Workers allowances. [S17]

Workers Static Assets also documents free/unlimited static-asset requests. Workers Free includes 100,000 dynamic requests/day with 10 ms CPU/invocation. The paid Workers plan starts at $5/month with dynamic usage allowances/overages. A static-only deployment does not need to add dynamic workers merely to run chess or call providers. Check routing so static assets do not unnecessarily execute billed Worker code. Unlimited static delivery is not unlimited builds, database/email capacity, or a contractual availability SLA. [S17]

No static inactivity-pause policy was established by the cited Pages/Workers pricing and limit pages. That is a bounded documentation finding, not a guarantee against suspension under service terms. A site remaining online does not keep a separate Supabase Free project active or make its auth/database available.

### Vercel static candidate

**Documentation.** Hobby is $0 for personal, non-commercial use. Its current published allowances include 100 GB fast data transfer and 1,000,000 CDN requests. On exceeding many Hobby limits, use can remain unavailable until the cycle resets, often 30 days. A public/open-source project is not automatically eligible if the actual use is commercial. [S18]

Pro's current page shows $20/month and $20 included usage credit, with developer seats listed at $20/month and viewer seats free. The current pricing describes Flat Rate CDN for Pro. Do not substitute older assumptions about a fixed 1 TB Pro allowance or outdated egress overages. Dynamic services and other metered products remain separately governed. Confirm the actual team/seat and billing terms at purchase. The advertised 99.99% SLA is an Enterprise offering. [S18]

No inactivity-pause rule was established for static Hobby deployments from the cited pages; quota and fair-use restrictions still apply. Vercel provides convenient Vite deployment and previews, but those previews need the same auth-origin and private-data discipline as Cloudflare. There is no need to enable Vercel AI Gateway or any fallback/relay product for this candidate.

### Budget implications without choosing a vendor

At the published base prices, a Supabase Pro project plus free Cloudflare static hosting starts around $25/month, before email, domain, taxes, backups, and excess usage. Supabase Pro plus one Vercel Pro developer starts around $45/month on the same exclusions. Free Supabase plus free static hosting has a zero platform subscription floor, but does not establish reliable public email, inactivity availability, backups, or sufficient archive capacity. These are comparisons, not owner-approved totals or purchasing instructions. [S13][S14][S17][S18]

Measure archive growth, cloud read amplification from repeated history downloads, delta-upload size, reconnect behavior, concurrent auth refresh, backup storage, and email volume. Continuous clock display should create no per-second backend writes or AI calls. Account sync metadata and full archive capacity, rather than static HTML delivery alone, are likely budget drivers; no traffic forecast or cost benchmark was run here.

## Backups, export, and deletion

**Documentation.** Supabase Pro daily backups retain seven days, Team fourteen, and Enterprise up to thirty under the cited guide. Database backups exclude Storage object bytes. Newer projects on Supabase Postgres `15.8.1.079` and later use physical backups; do not assume every dashboard backup is a portable downloadable SQL dump. Use a separate logical export for portability. Free projects should make their own CLI exports. [S14]

PITR starts around $100/month for seven days of retention, around $200 for fourteen and $400 for twenty-eight, and requires at least Small compute. It replaces daily-backup behavior. These costs are separate from the $25 base. Restore time and data loss since a backup remain operating concerns; restoring also involves downtime. No backup, restore, or recovery-time experiment was performed. [S14]

**Application proposal.** Provide a versioned owner export containing the full match/archive, active/discarded line references, rules history, clock references/accounting, immutable results, and practice segments. Exclude AI keys, auth tokens, and secret-bearing configuration. Validate imports as untrusted data, preserve original IDs/attribution without silently overwriting an existing game, and fence any restored in-flight request. Keep separate operator backups of database data/schema/RLS/functions, Storage object bytes if used, and reproducible non-secret service configuration. Encrypt/restrict operator backups because games are private.

A deletion workflow must cover database rows, received chunks, cloud objects, account relationships, local caches/outboxes, and queued stale uploads. Use the Storage API to delete objects; deleting its SQL metadata alone leaves orphaned underlying data. Supabase also documents that an Auth user owning Storage objects cannot simply be deleted first. Cascade relationships and object cleanup need a deliberate order and retry/idempotency plan. [S16]

Deleting a row is not an immediate purge from retained backups or a recipient's prior export. Define a deletion retention window, backup access, restoration procedures that reapply deletion tombstones, and the practical inability to delete an offline device's local copy remotely. Deleting the entire Supabase project is documented as irreversible and removes its data/backups/configuration. It is not a normal per-game deletion procedure. [S14][S16]

## Packages, service terms, and self-hosting

**Inspected sources.** The registry versions below were downloaded as public npm tarballs without installing or executing their code. Each tarball's SHA-512 matched the registry's published `dist.integrity`, and its bundled license was read. These are research snapshots, not selected implementation versions. [S20]

- React `19.3.1`, MIT. Registry `gitHead` is `61aa00df822d0eb76d0362eb8b6fdd3527693efe`.
- TypeScript `7.0.2`, Apache-2.0. Registry `gitHead` is `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`. Its vendored `vscode-jsonrpc` license is MIT.
- Vite `8.3.4`, MIT for Vite core. The package also includes dependency license notices; core licensing is not a complete future bundle audit.
- `@supabase/supabase-js` `2.118.0` and `@supabase/auth-js` `2.118.0`, MIT. Both currently declare Node `>=22.0.0` in the inspected package metadata; that concerns their Node environment and does not establish browser acceptance.

The Supabase repository license is Apache-2.0 at `4593b3ffc070f372d7b452825258b9adb8a60242`. Supabase Auth is MIT at `ce9a8eee0cc042be8c7a42981a7ddae631e41d91`. Storage is Apache-2.0 at `ac6b3e57a0ed33c846192d4480bd492433f32569`. PostgreSQL has its own PostgreSQL License. These do not assert that the managed service runs those exact commits or that every self-hosted component/dependency has the same license. [S21]

MIT/Apache package permissions do not grant a free managed service, supersede Cloudflare/Vercel/Supabase service terms, or choose this project's license. Preserve required notices, inventory transitive runtime/build dependencies and any copied assets, and evaluate the eventual distribution. No legal approval or compatibility conclusion for the entire future dependency graph is made here. [S21][S22]

Supabase's self-hosting guide recommends Docker for its documented route and assigns provisioning, hardening/updates, database maintenance, availability, backups/recovery, and monitoring to the operator. Some managed platform features, including managed backups/PITR and the Management API, are absent. Self-hosting is a practical portability alternative, not equivalent low-maintenance hosting for free. A local CLI development stack is not a production operations plan. [S22]

The browser bundle can move between static hosts. Postgres SQL/data and owner archive exports improve portability. Supabase Auth redirects, session handling, Storage APIs, policies/functions, and operations still need migration work. Do not assume an export of user tables also reproduces mail delivery, OAuth settings, object bytes, DNS, or a complete running service.

## Required browser acceptance

**Documentation.** Browser compatibility data inspected at `mdn/browser-compat-data` commit `cb1b68d8df1ae499a25112fb6e78bb148b32886e` records Web Locks in Chrome 69, Firefox 96, and Safari 15.4, with Edge/Android/iOS entries following the corresponding engine entries. It records IndexedDB transaction durability in Chrome 83, Firefox 126, and Safari 15. Storage estimation reaches Safari 17. These are recorded API support versions, not selected minimum OS/browser versions or test results. Feature-detect and verify the chosen baseline. [S8]

Run native tests on every required target: Windows Chrome, Windows Edge, Windows Firefox, macOS Safari, iOS Safari, and Android Chrome. Record browser build, OS/build, actual device, normal/private/standalone context where relevant, permissions, storage status, and network conditions. Emulation, WebKit automation on another OS, API support tables, and a desktop Chromium probe cannot certify the other targets.

Acceptance needs at least:

- Atomic checkpoint/archive/outbox success and deliberate abort; failed database open, denied/unavailable storage, blocked upgrade, quota/low-disk errors, persisted permission denied, private-session closure, and explicit browser-data deletion. Check visible unsaved status and complete export without secret inclusion.
- Real backgrounding, mobile app switching, OS sleep, browser/process kill, tab closure/reopen, refresh, back/forward cache, and a wall-clock change. Verify elapsed-time reconstruction, anomaly behavior, interrupted-response fencing, and no auto-retry.
- Move/expiry/Undo/result boundary races, increment removal, incomplete streams, repeated FENs with distinct revisions, crash during save, uncertain cloud acknowledgment, expired saved games, and immutable results/practice.
- Two tabs with Web Locks and with its fallback path; freeze the current writer, explicitly take over, then revive it. Verify state fences and honest disclosure that an old provider request may continue.
- Two actual devices with ownership takeover, offline old writer, reconnect, stale outbox, account A-to-B changes, sign-out during streaming, expired auth, server outage/read-only quota, and delete followed by stale upload. Use only synthetic credentials for non-live fixtures.
- Production-origin callback routing, real browser return context, expired/used PKCE code, missing verifier, canceled/overlapping login, and auth refresh/sign-out scope. This requires later authorized provider/auth configuration.
- Accessible saved/sync/conflict/error announcements and recovery controls in the approved Classic workspace, without screen-reader announcements on every clock tick. Native accessibility acceptance remains outside this research result.

## Observed experiment and its limits

On 2026-10-16 at `00:18:29.064Z`, T3's collaborative browser ran the appendix script in an owned incognito tab at `https://example.com/`. The reported environment was:

```text
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36
platform: Win32; secure context: true
```

The browser reported `strict` transaction durability and the presence of Web Locks/persistence APIs. The script confirmed that an aborted two-store write changed neither the checkpoint nor the new archive record. A byte array containing escaped JSON, unknown fields, Arabic text, a chess symbol, and CRLF separators round-tripped exactly. Twenty competing same-version IndexedDB CAS attempts on two connections produced one accepted update. Twelve exclusive Web Lock requests had at most one callback active at a time. The script closed both database connections and deleted its named synthetic database successfully.

This was a bounded API probe, not application acceptance, a cross-tab/process test, a Postgres CAS test, a quota fill, or a durability/power-loss experiment. No persistence permission was requested. The user agent is the browser's reported identity; I did not independently establish its full product executable version. No Edge, Firefox, macOS, iOS, or Android run occurred.

The first probe attempt failed because its transaction helper rejected on a bubbled request-error event during an intentional abort, before `transaction.error` was populated. A diagnostic retry then tried to read `.name` from that null rejection and failed too. The corrected helper waits for `complete` or `abort`; the results below are from that corrected run. Those setup failures do not establish a browser transaction failure. The owned tab was closed after the successful run. No local web server or other running helper was created.

## Concise gaps and proposed defaults

Decisions still owned by KHA-13/the owner:

1. Choose the offline-authority/handoff compromise. Online CAS, provisional offline continuation, and nontransferable device ownership have materially different behavior. None is approved by this report.
2. Choose and disclose the absence/time-anomaly assumptions and the exact move/persistence-acknowledgment/expiry order. Browser-only tamper resistance and immediate closed-browser adjudication are unavailable.
3. Set budget, commercial-use expectations, hosting vendor, auth method/email provider, storage/retention limits, backup/export responsibility, recovery objectives, deletion windows, and project license. Published Free tiers do not settle these choices.
4. Set sign-out credential deletion and cached-account retention/import behavior. Preserve the chosen device-local default and never auto-bind keys across identities/devices. Resolve the rare raw-record/echoed-secret sync conflict.
5. Reconcile absolute archive losslessness with the receive-to-commit crash window and storage refusal. Do not describe data that never committed as durably saved.

Reasonable implementation proposals for later verification are IndexedDB append-only chunks plus atomic checkpoints/outbox, explicit context namespaces, Web Locks plus transactional epoch checks, owner RLS and a non-bypassable CAS operation, idempotent uploads, deletion fencing, stable HTTPS origin, exact production auth redirects, explicit PKCE configuration, sanitized diagnostics, and no timer-tick backend writes. They preserve the accepted boundaries but are not a stack selection.

Remaining evidence gaps are all six native target runs, true cross-tab/device races, crash/quota/eviction and real sleep/time changes, deployed SQL/RLS/CAS and revocation behavior, auth/SMTP/redirect acceptance, backup restoration/deletion replay, large archive benchmarks/cost forecasts, and KHA-22's complete rules/timeout predicate. No production code, provisioning, real credentials, provider calls, paid checks, tracker edits, public messages, or pushes occurred.

## Sources

All web references were fetched on 2026-10-16 UTC. Package versions and source commits are fixed below. Service pricing/policies and living documentation can change. Browser documentation is evidence of published semantics, not observed target acceptance.

[S1]: https://w3c.github.io/IndexedDB/
[S2]: https://storage.spec.whatwg.org/
[S3]: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
[S4]: https://webkit.org/blog/14403/updates-to-storage-policy/
[S5]: https://w3c.github.io/hr-time/
[S6]: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
[S7]: https://w3c.github.io/web-locks/
[S8]: https://github.com/mdn/browser-compat-data/tree/cb1b68d8df1ae499a25112fb6e78bb148b32886e/api
[S9]: https://www.postgresql.org/docs/18/transaction-iso.html
[S10]: https://supabase.com/docs/guides/database/postgres/row-level-security
[S11]: https://supabase.com/docs/guides/storage/security/access-control
[S12]: https://supabase.com/docs/guides/auth/sessions/pkce-flow
[S13]: https://supabase.com/docs/guides/auth/auth-smtp
[S14]: https://supabase.com/pricing
[S15]: https://supabase.com/docs/guides/platform/going-into-prod
[S16]: https://supabase.com/docs/guides/auth/managing-user-data
[S17]: https://developers.cloudflare.com/pages/platform/limits/
[S18]: https://vercel.com/pricing
[S19]: https://github.com/vitejs/vite/tree/v8.3.4
[S20]: https://registry.npmjs.org/@supabase/auth-js/2.118.0
[S21]: https://github.com/supabase/supabase/blob/4593b3ffc070f372d7b452825258b9adb8a60242/LICENSE
[S22]: https://supabase.com/docs/guides/self-hosting
[S24]: https://w3c.github.io/ServiceWorker/

- S1: Indexed Database API 3.0, transactions, scheduling, commit, and durability. Source snapshot [W3C IndexedDB `f70491894a213c30424e1f6cfb9466ba82d7e996`](https://github.com/w3c/IndexedDB/tree/f70491894a213c30424e1f6cfb9466ba82d7e996).
- S2: WHATWG Storage Living Standard. Source snapshot [`23f38d8feaf530b9787822e067a7eb6f953af322`](https://github.com/whatwg/storage/tree/23f38d8feaf530b9787822e067a7eb6f953af322).
- S3: MDN quota/eviction documentation. This is cross-browser documentation, used alongside WebKit's first-party policies rather than as a device experiment.
- S4: WebKit, [Updates to storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/), 2023-08-14, and [Full third-party cookie blocking and more](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/), 2020-03-24, for ITP's script-writable-storage policy. Older-policy publication dates are deliberate; current-device behavior remains untested.
- S5: High Resolution Time, source snapshot [`1f0b9faf793db3b06c8e85462448e8a812d00fb9`](https://github.com/w3c/hr-time/tree/1f0b9faf793db3b06c8e85462448e8a812d00fb9). See also MDN [`performance.now()`, ticking during sleep](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now#ticking_during_sleep), which links implementation bugs. The spec's intended monotonic semantics do not prove sleep behavior on target devices.
- S6: Chrome Page Lifecycle API. See also MDN [`beforeunload`](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event) for mobile/unload limitations.
- S7: Web Locks specification, source snapshot [`a61a77307d2a0b0928320a2ff9c897b7658a9e2e`](https://github.com/w3c/web-locks/tree/a61a77307d2a0b0928320a2ff9c897b7658a9e2e), including storage-bucket scope and lock termination.
- S8: Pinned BCD [LockManager](https://github.com/mdn/browser-compat-data/blob/cb1b68d8df1ae499a25112fb6e78bb148b32886e/api/LockManager.json), [StorageManager](https://github.com/mdn/browser-compat-data/blob/cb1b68d8df1ae499a25112fb6e78bb148b32886e/api/StorageManager.json), [IDBDatabase](https://github.com/mdn/browser-compat-data/blob/cb1b68d8df1ae499a25112fb6e78bb148b32886e/api/IDBDatabase.json), [IDBTransaction](https://github.com/mdn/browser-compat-data/blob/cb1b68d8df1ae499a25112fb6e78bb148b32886e/api/IDBTransaction.json), and [BroadcastChannel](https://github.com/mdn/browser-compat-data/blob/cb1b68d8df1ae499a25112fb6e78bb148b32886e/api/BroadcastChannel.json).
- S9: PostgreSQL 18 [transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html) and [explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html). This is database semantics research, not evidence of a provisioned Supabase database version.
- S10: Supabase [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) and [database functions](https://supabase.com/docs/guides/database/functions), including execution grants and definer/search-path implications.
- S11: Supabase [Storage access control](https://supabase.com/docs/guides/storage/security/access-control) and [file-size limits](https://supabase.com/docs/guides/storage/uploads/file-limits).
- S12: Supabase [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), and [sign-out scopes/JWT expiry](https://supabase.com/docs/guides/auth/signout).
- S13: Supabase [SMTP](https://supabase.com/docs/guides/auth/auth-smtp) and [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits).
- S14: Supabase [pricing](https://supabase.com/pricing), [billing](https://supabase.com/docs/guides/platform/billing-on-supabase), and [backups/PITR](https://supabase.com/docs/guides/platform/backups). Fetched pricing HTML SHA-256 `23319ba8372e389c9815330078b4a929bc5e313f00abf4b0626de1bd701c4188`.
- S15: Supabase [production checklist](https://supabase.com/docs/guides/platform/going-into-prod), [database-size/read-only behavior](https://supabase.com/docs/guides/platform/database-size), [spend cap](https://supabase.com/docs/guides/platform/spend-cap), and [billing fair-use FAQ](https://supabase.com/docs/guides/platform/billing-faq).
- S16: Supabase [user management/deletion](https://supabase.com/docs/guides/auth/managing-user-data), [Storage deletion](https://supabase.com/docs/guides/storage/management/delete-objects), and [project deletion source at `4593b3ffc070f372d7b452825258b9adb8a60242`](https://github.com/supabase/supabase/blob/4593b3ffc070f372d7b452825258b9adb8a60242/apps/docs/content/guides/platform/delete-project.mdx).
- S17: Cloudflare [Pages product](https://www.cloudflare.com/products/pages/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Pages routing](https://developers.cloudflare.com/pages/configuration/serving-pages/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), and [Static Assets routing](https://developers.cloudflare.com/workers/static-assets/). Fetched limits HTML SHA-256 `8cb16d5d05e9fdfd9db96bad5b1619e458fa226921720b0beb8256590d91bf35`; Workers pricing HTML `3754a845a119dc7f64227fb3dc434fb2d6d4c0e89bd379a0eaceaf7f90b7cfb1`.
- S18: Vercel [pricing](https://vercel.com/pricing), [Hobby](https://vercel.com/docs/plans/hobby), [fair use](https://vercel.com/docs/limits/fair-use-guidelines), and [Vite deployment/SPA rewrites](https://vercel.com/docs/frameworks/frontend/vite). Fetched pricing HTML SHA-256 `090198ce8e034489b4f39aca3c48e4fc717540380ee581456bcce3ac5988f777`.
- S19: Vite `8.3.4` [build guide](https://github.com/vitejs/vite/blob/v8.3.4/docs/guide/build.md), [target constants](https://github.com/vitejs/vite/blob/v8.3.4/packages/vite/src/node/constants.ts), [registry metadata](https://registry.npmjs.org/vite/8.3.4), and [environment-variable documentation](https://vite.dev/guide/env-and-mode).
- S20: Exact registry records and linked tarballs for [React `19.3.1`](https://registry.npmjs.org/react/19.3.1), [TypeScript `7.0.2`](https://registry.npmjs.org/typescript/7.0.2), [Vite `8.3.4`](https://registry.npmjs.org/vite/8.3.4), [supabase-js `2.118.0`](https://registry.npmjs.org/@supabase/supabase-js/2.118.0), and [auth-js `2.118.0`](https://registry.npmjs.org/@supabase/auth-js/2.118.0). Inspected tarball files include `package/LICENSE`, Vite `package/LICENSE.md`, TypeScript's vendored license, supabase-js `src/lib/constants.ts`, and auth-js `src/GoTrueClient.ts` and `src/lib/locks.ts`.
- S21: Pinned [Supabase license](https://github.com/supabase/supabase/blob/4593b3ffc070f372d7b452825258b9adb8a60242/LICENSE), [Auth license](https://github.com/supabase/auth/blob/ce9a8eee0cc042be8c7a42981a7ddae631e41d91/LICENSE), [Storage license](https://github.com/supabase/storage/blob/ac6b3e57a0ed33c846192d4480bd492433f32569/LICENSE), and [PostgreSQL License](https://www.postgresql.org/about/licence/). Client package licenses are in the exact S20 tarballs.
- S22: Supabase [self-hosting guide](https://supabase.com/docs/guides/self-hosting) and [managed-service terms](https://supabase.com/terms). Vendor service plans/eligibility are separately covered by S14, S17, and S18.
- S24: W3C [Service Workers, lifetime](https://w3c.github.io/ServiceWorker/#service-worker-lifetime). Its execution lifetime does not promise an always-on timer or network request.

The HTML checksums identify downloaded research snapshots. This single-file report retains the relevant prices/limits as extracted facts, not the complete downloaded pages. They are not independently retrievable archival URLs. Recheck current prices/policies before selecting or buying a service.

## Appendix: reproducible bounded browser probe

Run only in a disposable browser context with a secure origin. The script creates and deletes only `kha23-synthetic-20261016`. It uses no credentials, external network requests, persistence-permission request, large quota allocation, or provider generation. It tests two connections in one page, not separate tabs.

```javascript
(async () => {
  const name = "kha23-synthetic-20261016";
  const request = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = t => new Promise(resolve => {
    t.oncomplete = () => resolve("complete");
    t.onabort = () => resolve("abort");
  });
  await request(indexedDB.deleteDatabase(name));
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore("state");
    opening.result.createObjectStore("archive");
  };
  const db = await request(opening);
  const db2 = await request(indexedDB.open(name, 1));
  const read = (store, key) => request(
    db.transaction(store).objectStore(store).get(key)
  );
  const out = {
    utc: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    secure: isSecureContext,
    locks: !!navigator.locks,
    persistApi: !!navigator.storage?.persist
  };
  try {
    let tx = db.transaction(["state", "archive"], "readwrite", {
      durability: "strict"
    });
    let p = done(tx);
    out.durability = tx.durability;
    tx.objectStore("state").put({ revision: 0, epoch: 1 }, "game");
    tx.objectStore("archive").put("original", "received");
    await p;
    tx = db.transaction(["state", "archive"], "readwrite");
    p = done(tx);
    tx.objectStore("state").put({ revision: 99 }, "game");
    tx.objectStore("archive").put("partial", "discarded");
    tx.abort();
    out.abortEvent = await p;
    out.abortAtomic = (await read("state", "game")).revision === 0
      && await read("archive", "discarded") === undefined;
    const raw = new TextEncoder().encode(
      'data: {"unknown":{"opaque":"\\u0000","plan":"مرحبا ♟"},"choices":[0,1]}\r\n\r\n'
    );
    tx = db.transaction(["state", "archive"], "readwrite", {
      durability: "strict"
    });
    p = done(tx);
    tx.objectStore("archive").put(raw, "raw");
    tx.objectStore("state").put({ revision: 1, epoch: 1, active: [] }, "game");
    await p;
    out.rawBytesEqual = Array.from(await read("archive", "raw")).join()
      === Array.from(raw).join();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      new Promise((resolve, reject) => {
        const t = (i % 2 ? db : db2).transaction("state", "readwrite");
        const s = t.objectStore("state");
        let accepted = false;
        s.get("game").onsuccess = e => {
          const v = e.target.result;
          if (v.revision === 1 && v.epoch === 1) {
            s.put({ ...v, revision: 2, epoch: 2 }, "game");
            accepted = true;
          }
        };
        t.oncomplete = () => resolve(accepted);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
    ));
    out.concurrentCasAccepted = results.filter(Boolean).length;
    out.state = await read("state", "game");
    if (navigator.locks) {
      let live = 0, max = 0;
      await Promise.all(Array.from({ length: 12 }, () =>
        navigator.locks.request(name, async () => {
          max = Math.max(max, ++live);
          await new Promise(r => setTimeout(r, 2));
          --live;
        })
      ));
      out.maxConcurrentLockHolders = max;
    }
  } finally {
    db.close();
    db2.close();
    out.cleanup = await request(indexedDB.deleteDatabase(name)) === undefined;
  }
  return out;
})()
```

Corrected-run output, with the user agent stated above:

```json
{
  "utc": "2026-10-16T00:18:29.064Z",
  "platform": "Win32",
  "secure": true,
  "locks": true,
  "persistApi": true,
  "durability": "strict",
  "abortEvent": "abort",
  "abortAtomic": true,
  "rawBytesEqual": true,
  "concurrentCasAccepted": 1,
  "state": { "revision": 2, "epoch": 2, "active": [] },
  "maxConcurrentLockHolders": 1,
  "cleanup": true
}
```
