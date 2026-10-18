# KHA-53 controller turn effects evidence

## Decision

`TurnBudgetsV1` remains the KHA-36 spent-count value for one pending turn. KHA-53 maps its
counts to the existing `BudgetCheckpointV1` without changing storage schema version 1:
`illegalMoveAttemptsRemaining` and `manualRetriesBySide` remain per-side; formatting
corrections remaining apply to the active turn. The controller derives remaining values
from each classified effect. A legal accepted move resets the next turn's counters using
KHA-36 constants. Illegal attempt records are persisted in a version-1 `move-attempts`
checkpoint extension keyed by side. The controller checks its supported record shape on
use, checks each new record against current rules state and model identity, requires the
next sequential attempt, and preserves records for both sides when appending. Archive
validation treats extension payloads generically as versioned JSON and preserves them across
export/import; it does not validate this domain-specific record shape.

The typed `model-turn-effect` intent receives a `ModelTurnDecision`, never provider text.
Its eligibility comes from the controller's complete ten-field fence and active request.
The decision remains a classified claim from the move-classification boundary, not a
cryptographic capability: code in the same page can construct a resignation declaration.
The controller does not accept a caller-supplied result as authority; it derives the fourth
attempt loss from its persisted remaining budget and applies resignation loss from the
classified effect kind. Verifying that a resignation declaration came from a provider would
require moving or authenticating classification, outside this slice's provider-text-free
intent contract.
Nonterminal effects atomically write the budget spend, event and bumped request generation.
The next `begin-model-turn` creates a replacement request on the same board/side. Stop,
expiry and stale requests cannot reach a budget-writing effect commit. Resignation and the
fourth illegal attempt atomically latch immutable final results and stop the clock.

## Verification

- Controller interface fixture `persists classified illegal attempts and latches the fourth as an immutable loss` verifies all four attempt counts, archive event count, durable attempt records and final result.
- Controller public-dispatch regressions reject attempts 1 with a loss, attempt 4 without a loss, jumps, record/counter mismatches and a forged illegal accepted-move; stale replay leaves budgets unchanged.
- Existing controller tests cover active-request requirements, generation/fence invalidation, clock expiry and Stop handling.
- `pnpm run check` passes: lint, 346 tests, both TypeScript projects, Vite build and distribution notices.
- Acceptance cases remain `not_run`; this evidence is not native-browser or live-provider evidence.
