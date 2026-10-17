# KHA-53 controller turn effects evidence

## Decision

`TurnBudgetsV1` remains the KHA-36 spent-count value for one pending turn. KHA-53 maps its
counts to the existing `BudgetCheckpointV1` without changing storage schema version 1:
`illegalMoveAttemptsRemaining` and `manualRetriesBySide` remain per-side; formatting
corrections remaining apply to the active turn. The controller derives remaining values
from each classified effect. A legal accepted move resets the next turn's counters using
KHA-36 constants. Illegal attempt records are persisted in a version-1 `move-attempts`
checkpoint extension keyed by side. Existing generic extension validation preserves the
records across archive export and restore.

The typed `model-turn-effect` intent receives a `ModelTurnDecision`, never provider text.
Its eligibility comes from the controller's complete ten-field fence and active request.
Nonterminal effects atomically write the budget spend, event and bumped request generation.
The next `begin-model-turn` creates a replacement request on the same board/side. Stop,
expiry and stale requests cannot reach a budget-writing effect commit. Resignation and the
fourth illegal attempt atomically latch immutable final results and stop the clock.

## Verification

- Controller interface fixture `persists classified illegal attempts and latches the fourth as an immutable loss` verifies all four attempt counts, archive event count, durable attempt records and final result.
- Existing controller tests cover active-request requirements, generation/fence invalidation, clock expiry and Stop handling.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` results are recorded in the implementation handoff.
- Acceptance cases remain `not_run`; this evidence is not native-browser or live-provider evidence.
