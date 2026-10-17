# KHA-33 guest recovery, Undo, rematch and timed practice

Ticket: [Add guest recovery, Undo, rematch and timed practice](https://linear.app/kamkm/issue/KHA-33/add-guest-recovery-undo-rematch-and-timed-practice).

The controller now exposes the local match lifecycle. `undo` restores the previous
human decision, `startPractice` opens an unscored timed segment after a model loss,
and `createRestartSetup`/`createRematchSetup` prepare a separate game.

## Undo

Each accepted human move records the previous checkpoint in the versioned
`undo-baseline` extension. `undo` restores that checkpoint's rules, repetition
ledger, budgets, selections, history and archive, keeps the discarded line in the
archive as a `discardedLines` entry with reason `undo`, and opens a new current
line. Undo is unavailable before the first human decision, after a final result,
and inside a practice segment, so it cannot cross a start or practice boundary.
`undoMove` and `takeback` are the same operation.

The clock keeps charging through the accepted event. Undo removes only the
increment credits earned by the moves it discards and restarts the restored turn
from the resulting bank. A candidate that would leave either bank nonpositive is
rejected and leaves the checkpoint unchanged. Expiry is reconciled first, so an
expired clock is never erased by Undo.

Undo advances the position, request and analysis revisions, so late work carrying
an older fence stays fenced even when the restored position repeats an earlier FEN.
Adjudication candidates stay bound to the position that raised them: Undo keeps only
accepted candidates for the current segment and drops the rest.

## Practice

`startPractice` accepts only a final model loss on a position that still has legal
moves, for reasons `resignation`, `illegal-move` and `timeout`, with the human as
the winner, and only with a passed current-session diagnostic. It opens a new
segment and line, marks the game unscored with `practice.mode: 'practice'`, keeps
the actual rules, counters and repetition ledger, and preserves the original final
result in `practice.originalResult` with its source game and position. The
practice clock starts inside the commit from the sampled decision time, and
budgets reset to their initial values. The undo baseline and any adjudication
candidates from the ended game are not carried into the new segment.

## Restart and rematch

`createRestartSetup` and `createRematchSetup` read the finished or running game's
position, model routing identity, namespace, ownership epoch and time control into
a fresh `GameControllerSetupV1`. A rematch swaps the human's color. Initializing a
second controller from that setup creates a separate game ID, archive and result;
the previous game and its running clock are untouched.

## Verification

`src/controller/lifecycle.test.ts` drives the public `GameController` API with an
injected store and time source: Undo restoration, unavailable and repeated
boundaries, clock charging and credit removal, nonpositive rejection, serialization
against queued work, practice segment contents, the practice boundary, and
restart/rematch separation.

`pnpm run lint`, `pnpm run typecheck` and `pnpm test` pass: 304 tests across 23
files. This is deterministic local evidence only. The React page is still a
placeholder and wires none of these operations, so no browser, assistive
technology, multi-device or cloud journey acceptance is claimed by this change.