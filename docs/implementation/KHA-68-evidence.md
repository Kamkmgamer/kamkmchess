# KHA-68 authoritative online moves, clocks and match outcomes

Locally verified on 2026-10-20 on `t3/authoritative-online-match-outcomes`.
Tested source commit: `1ea088f`.
The branch starts at `a1e069e`, which includes the KHA-64/65/66/67 foundations.

## Implemented contract

The shared writer owns the order of an online match. A participant proposes, the Go writer decides.

### Opening phase

No main bank runs before its side's first accepted move. A new match has no armed deadline. The
first accepted move adds the increment once and arms a fifteen second reply window for the other
side instead of starting that side's main clock. The accepted reply closes the window and starts the
main clock of the side to move. An unanswered reply aborts the match unscored with the reason
`opening_reply_timeout`.

The rule follows the side to move, so a custom position that starts with Black to move makes Black
the starting side and White the responder. The opening phase is a historical fact of the match: a
takeback never reopens it.

### Cancellation

`abort` became `cancel` in contract version 2. A cancellation aborts the match while the canceling
side has never had an accepted move and resigns afterwards. Whether a seat ever had an accepted move
is a historical fact stored beside the clock, so a takeback that removes the move from the current
line does not turn a later cancellation back into an abort.

### Offers, takebacks and recovery budgets

A draw offer needs the other participant's acceptance. Play that continues after an offer declines
it, so an accepted move withdraws every pending draw offer. A takeback offer names the exact
version of an accepted move whose position it would restore, or version `1` for the starting
position, and the offer is bound to the version it was made against, so later play makes it
inapplicable. Accepting a takeback restores the position and the current line, charges the side
that was thinking, and arms the restored side to move. It refunds no time, mints no increment and
resets no recovery budget. The discarded accepted moves stay in `online_moves` and are marked in
`online_discarded_moves`, so the discarded private archives survive. The increment of a discarded
move is not given back, so replaying that move after the takeback adds its increment again.

The recovery budget of a turn lives in the seat row. It resets only when that seat's own move is
accepted. A control change and a takeback never reset it. The fourth illegal attempt of a turn
loses the match for that seat. The formatting correction budget is independent and stops at three
corrections.

### Clock continuity and expiry

The main clock deadline is absolute, so generation, provider failure, Stop/Retry, control changes,
navigation, refresh and peer disconnects neither pause nor refund the chess time. Every intent
reconciles the expiry before it can change the match. The decision time is sampled after the match
and authorization locks are held and is re-sampled after external rules work, so a lock wait that
crosses a deadline is judged against the time the locks were acquired. A final result cannot be
overwritten by a later intent, a stale offer, a late rules candidate or direct SQL.

### Contract and schema changes

`backend/online/contracts.go` and `src/online/contracts.ts` moved from schema version 1 to 2.
The action union gains `cancel` (replacing `abort`), `offer_draw`, `accept_draw`, `offer_takeback`,
`accept_takeback` and `record_recovery_attempt`. The clock state gains the opening reply seat and
its deadline, the result reasons gain `opening_reply_timeout` and `illegal_move`, the event kinds
gain `draw_agreement`, `takeback_accepted`, `recovery_attempt` and `illegal_move_loss`, and the
receipt outcomes gain `opening_expired`.

Migration `backend/migrations/0004_online_match_outcomes.sql` is additive. It adds the reply
window columns, the seat recovery budget counters, `online_offers` and `online_discarded_moves`, and
relaxes the match schema version check to accept version 2. It rewrites no existing row.

The shared contract fixture `backend/online/testdata/online-contracts.json` carries one example of
every new action, and both the Go and the TypeScript suite parse it.

## Verification

`pnpm check` passed ESLint, both TypeScript projects, 746 tests across 67 files, the browser production
build, the private rules-worker build and the distribution notices.

PostgreSQL 17.11 ran in the isolated local `kamkmchess-kha67-local` container on loopback port
55467. Each database fixture created and dropped its own schema. The final commands were:

```powershell
$env:KHA41_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable'
$env:KHA41_REQUIRE_POSTGRES='1'
$env:KHA66_WORKER_ENTRY=Join-Path (Get-Location).Path 'build/rules-worker/worker.mjs'
go test -count=1 ./backend/... ./cmd/...
go vet ./backend/... ./cmd/...
```

Both commands passed. The full integration package took about 55 seconds. The checks used the real
private Node rules artifact and required PostgreSQL rather than skipping absent-database fixtures.

### New Go fixtures

`backend/integration/online_outcome_test.go` covers the ticket scenarios against real PostgreSQL.

- MAT-01: no main bank runs before its side's first accepted move, the opening move arms a fifteen
  second reply window, the accepted reply starts the next side's main clock, and the increment is
  added once. A second fixture repeats the rule for a custom position with Black to move.
- MAT-01 and MAT-04: an unanswered opening reply aborts the match unscored, the late reply does not
  become a move, the responder's bank is not charged, and a later intent cannot revive the match.
- MAT-03: a duplicate, a stale version, the wrong seat, a foreign participant and an illegal move
  advance nothing and mint no increment. The illegal move fixture uses the real private rules
  process.
- MAT-02: a cancellation before the seat's first accepted move aborts the match and stays unscored,
  and a cancellation after it resigns. A third fixture takes back the seat's own move and then
  cancels, and the result is still a resignation.
- MAT-08: a control change keeps the active seat, the active start, the deadline and both banks
  unchanged, and the clock still expires on its own deadline. A second fixture moves the start of
  the running clock into the past and shows that the next accepted move charges the elapsed time
  and adds the increment once.
- MAT-11: a draw offer does not advance the match version, does not move a clock and does not end
  the match, the offering seat cannot accept its own offer, and a seat without an offer cannot
  accept a draw. An accepted move withdraws every pending draw offer, so a declined offer cannot
  end the match later. A takeback restores the exact position and the accepted line, keeps the
  discarded accepted move rows, and refunds neither time nor an increment. A stale takeback offer
  conflicts and rewinds nothing. A takeback offer for a position outside the current line is
  refused. A finished match exposes no pending offer.
- MAT-11: the spent recovery budget of a turn survives a control change and a takeback, and only an
  accepted move of that seat starts it again. The fourth illegal attempt loses the match and the
  formatting budget is independent of it.
- MAT-12: a final result survives a later move, cancellation, draw offer, draw acceptance, takeback
  acceptance and recovery report, and the stored result cannot be rewritten by direct SQL. The
  cancellation is recorded as its own event, so the audit trail separates it from an explicit
  resignation.
- MAT-04: an expired clock settles the match even when the intent that noticed it is refused, so a
  late, stale or wrong-seat intent produces the same terminal event as a late legal move.
- MAT-11 and MAT-12: a late rules candidate evaluated against an earlier position is refused as
  stale and changes nothing.
- ARC-04: a retried offer returns the original receipt bytes and a changed payload with the same
  operation ID fails.

Existing fixtures were updated where they encoded the old opening-clock behaviour. The timeout
fixtures now reach normal play through the opening exchange before they expire a clock, and the
participant-lock race fixture now proves that a command that waits past the opening reply deadline
is adjudicated as the opening abort. A second participant-lock fixture covers the main clock
deadline. The assertions were not weakened.

`backend/online/contracts_test.go` covers the clock state machine at the package boundary. The
opening phase fixture asserts that the first accepted move arms the reply window instead of a main
clock, that the responder's bank is untouched, and that the reply starts the next side's clock.

### Deterministic time and real races

Deadlines are moved into the past with a direct update of the stored clock rows, so the expiry
fixtures do not depend on wall-clock sleeps. The lock-wait fixture keeps a real PostgreSQL race: a
second connection holds the match row, the command waits, and the deadline passes during the wait.
The participant-lock race fixture holds the credential lock across the deadline in the same way.

### Red evidence

The new fixtures were checked against the behaviour they replace. Removing the opening branch of
`ApplyAcceptedMove` fails the opening clock fixtures in both packages and the opening abort fixture.
Removing the ever-moved check of the cancellation fails both cancellation fixtures. Adding an
increment to the takeback acceptance fails the takeback fixture. The removed code was restored
after each check.

## Acceptance boundaries and limitations

- MAT-01, MAT-02, MAT-03, MAT-04, MAT-08, MAT-11 and MAT-12 have local Go and PostgreSQL evidence
  in this slice. The product acceptance matrix is unchanged; the scenarios are not marked as run
  here.
- ARC-03 has local evidence for both lock kinds and both deadlines. The match lock is covered by
  `TestPostgresOnlineLockWaitCrossesClockExpiry` for the main clock and by
  `TestPostgresOnlineUnansweredOpeningReplyAbortsTheMatch` for the opening reply window. The
  participant lock is covered by `TestPostgresOnlineCommandThatWaitsPastTheMainDeadlineTimesOut`
  for the main clock and by
  `TestPostgresOnlineCommandThatWaitsPastTheReplyDeadlineAborts` for the opening reply window.
- ARC-04 has local evidence for the existing actions and for the new offer actions.
- The fifteen second reply abort and the main clock timeout are realised when the next
  authenticated intent arrives. A deadline worker that realises them without an intent is deferred
  work, together with the finite SSE delivery of KHA-69.
- The browser agent runner that produces the recovery attempt reports is not implemented. The shared
  writer owns the budget, the reset rule and the illegal move loss; the runner that detects an
  illegal move in a model reply is downstream work.
- The abandonment claim after one continuous minute offline is not part of this slice. The clock
  keeps running through a peer disconnect, which is what this ticket required.
- The rules process refusal now decides the answer instead of the transport: an illegal or
  terminal proposal is refused with `ErrActionNotAllowed` and a history that does not match the
  evaluated position with `ErrStaleCandidate`. The HTTP status for an illegal move changes from 503
  to 409, and an invalid position changes from 503 to 400. This is a wire visible change to the
  KHA-66/67 surface.
- The public replay projection carries the current line only. A takeback removes the discarded moves
  from the replay and keeps them in the shared tables.
- Deployment, provider spending, staging verification and native accessibility were not performed.

## Review disposition

An independent review of the slice against the ticket contract found two medium and six low
findings. The medium findings are fixed: a move intent now reconciles the expiry before any other
refusal, so a late, stale or wrong-seat intent settles the match the same way as a late legal move,
and an accepted move now withdraws every pending draw offer, so a declined offer cannot end the
match later. The low findings are fixed as well: a finished match exposes no pending offer, the
cancellation is recorded as its own event, the takeback target is documented as the version of an
accepted move, the increment of a discarded move is documented as not given back, the offer shape
no longer advertises fields the server never fills, and the participant lock fixture for the main
clock deadline was restored.

OpenCode `opencode/minimax-m3.1-flash-free` handled the implementation and the verification of this
slice. The parent reviewed the contract change, the migration and the evidence.
