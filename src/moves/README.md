# Move parsing and recovery budgets

This module classifies one completed model answer into exactly one turn effect. It reads
provider text as untrusted text, never as instructions. It does not fetch, stream, retry,
select a model, own the clock, apply a result, or persist anything, and it never gives a
model a legal-move list, an evaluation, a ranked choice, or a replacement move. The local
entry point is index.ts.

## Classifying one completed answer

Call `classifyCompletedAnswer` only with a normal protocol-complete choice-zero answer.
Reasoning fields, plans, other choices, and retained history are never arguments, so they
cannot become commands. The result is one of three declarations.

| Declaration | Meaning |
| --- | --- |
| `move` | One unambiguous coordinate command, with the exact accepted text and retained extra fields. |
| `resignation` | An explicit model-authored refusal to continue. It is a model loss, not a clarification. |
| `format-failure` | A missing, ambiguous, or unreadable command. It asks for clarification and never guesses. |

The JSON reader accepts exactly one complete object, optionally inside one Markdown fence.
It rejects trailing content, arrays, scalars, and unterminated strings, and it reports
conflicting duplicate `move` or `resign` keys because `JSON.parse` would silently keep the
last one. Identical duplicate action keys remain a single declaration, and duplicate
non-action keys keep `JSON.parse` behaviour as retained extra fields. JSON is never
repaired and never completed.

Without a JSON object, the documented fallback accepts a coordinate that stands alone as
the whole answer or on its own line, or an explicit final `Move:` line, tolerating
whitespace, backticks, quotes, Markdown emphasis, and terminal punctuation. Two explicit
selections with different coordinates, or a move and a refusal in one reply, are
`competing-answers`. A coordinate inside a sentence, a plan, or a list of alternatives is
narrative, never a command.

Promotion must be explicit as `q`, `r`, `b`, or `n`. When the caller passes the
authoritative `position`, a coordinate that reaches the last rank with a promotable pawn
and no suffix becomes the `missing-promotion` clarification instead of an illegal move. No
piece is ever chosen for the model. Passing the position is how the module avoids charging
the chess budget for a formatting gap; the position is never sent to a model.

A resignation requires a final model-authored statement. `resign: true`, "I resign.",
"Resign.", an explicit refusal to move, a forfeit, or a concession resign. Quoted, block
quoted, hypothetical, attributed, and historical text does not. An HTTP error, a missing
response, a timeout, and a provider filter event are protocol outcomes, not answer text:
they never arrive here and never resign.

## Deciding one model turn

`decideModelTurn` turns a classification into its single allowed effect.

| Decision | Counters and result |
| --- | --- |
| `accepted-move` | Applies through the rules adapter and resets the next turn's budgets. |
| `illegal-attempt` | Spends one of four attempts; the fourth is an immediate model loss with reason `illegal-move`. |
| `format-correction` | Spends one of three automatic corrections; the fourth failure pauses for Retry or Switch. |
| `model-resignation` | Immediate model loss with reason `resignation`. |

The two budgets are independent. A formatting failure spends no chess attempt and never
loses the game, and a recovered illegal move spends a chess attempt rather than a second
formatting failure. Every attempt keeps its producing-model identity, because a recorded
loss is a match result, not a per-model rating.

Illegal attempts survive formatting corrections, technical interruptions, ordinary model
switches, and manual retries. A legal accepted move resets the next turn. A manual Retry
authorizes exactly one more request without refilling the automatic formatting budget or
erasing illegal attempts.

`applyTurnRecoveryEvent` handles events that are not completed answers. Manual Retry,
model switch, and technical interruption recover the pending turn without changing any
spent counter. Stop request, clock expiry, and a stale reply are fenced: they spend no
attempt, add no increment, and change no result.

`explainIllegalMove` words the specific violation the application can prove from its own
board, such as "That leaves your king in check" or "There is no piece on e4". It never
lists a legal move and never suggests one. Legality itself stays with the rules adapter.

## Reply fencing

A reply is eligible only when the controller's complete fence matches the active request.
The controller compares game, segment, side, revision, position revision, request and
analysis generations, ownership epoch, and model configuration identity. It advances the
generation on accepted effects, so a repeated FEN after Undo or a switch cannot revive an
old reply. Reply eligibility and at-most-once application are controller responsibilities.
## Controller composition

The composition boundary calls `decideCompletedAnswer` for a completed choice-zero answer
and sends the resulting `ModelTurnDecision` as a `model-turn-effect` intent with the
current controller fence. The controller never receives provider text. Accepted moves
are independently reapplied against controller state. Correction, illegal-attempt, and
resignation effects are committed atomically with their budget changes and archive event.
After a nonterminal correction or illegal attempt, begin a new model request using the
new fence; the same chess turn remains active and its spent budgets carry forward.
