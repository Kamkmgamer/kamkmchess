import type {
  CompletedReplyClassification,
  FormatRejectionCategory,
  MoveProposal,
  ProtocolIneligibleReply,
} from './parser.js';

export const RECOVERY_POLICY_VERSION = 1 as const;
export const ILLEGAL_ATTEMPT_LIMIT = 4;
export const AUTOMATIC_FORMAT_CORRECTION_LIMIT = 3;

export interface RecoveryBudgetStateV1 {
  readonly version: 1;
  readonly illegalAttemptsUsed: number;
  readonly automaticFormatCorrectionsUsed: number;
}

/** Set only by the controller after it checks the current identity fence, uniqueness and deadline. */
export interface EligibleControllerDecisionV1 {
  readonly status: 'eligible';
  readonly decisionId: string;
  readonly currentFenceId: string;
  readonly checkedBy: 'controller';
  readonly fence: 'current';
  readonly deadline: 'before';
  readonly unique: true;
}

export interface IneligibleControllerDecisionV1 {
  readonly status: 'ineligible';
  readonly decisionId: string;
  readonly reason: 'stale' | 'stopped' | 'expired' | 'duplicate' | 'superseded' | 'terminal';
}

export type ControllerEligibilityV1 =
  | EligibleControllerDecisionV1
  | IneligibleControllerDecisionV1;

export type RuleViolationCategory =
  | 'wrong-side-to-move'
  | 'king-left-in-check'
  | 'castling-unavailable'
  | 'en-passant-unavailable'
  | 'destination-occupied-by-own-piece'
  | 'pawn-forward-blocked'
  | 'pawn-capture-target-missing'
  | 'piece-movement-not-allowed'
  | 'not-legal-in-position';

export type TechnicalFailureCode =
  | 'connection-error'
  | 'http-error'
  | 'provider-error'
  | 'protocol-error'
  | 'truncated-response';

type NonMoveReply = Exclude<CompletedReplyClassification, MoveProposal>;

export type RecoveryPolicyEventV1 =
  | {
      readonly kind: 'model-reply';
      readonly reply: MoveProposal;
      /** The controller's current-position rules check, performed before this policy call. */
      readonly moveValidation:
        | { readonly status: 'legal' }
        | { readonly status: 'illegal'; readonly reason: RuleViolationCategory };
    }
  | { readonly kind: 'model-reply'; readonly reply: NonMoveReply }
  | { readonly kind: 'technical-failure'; readonly code: TechnicalFailureCode }
  | { readonly kind: 'ordinary-switch' }
  | { readonly kind: 'manual-retry' };

export interface RecoveryPolicyInputV1 {
  readonly version: 1;
  readonly state: RecoveryBudgetStateV1;
  readonly eligibility: ControllerEligibilityV1;
  readonly event: RecoveryPolicyEventV1;
}

export type RecoveryPolicyOutcomeV1 =
  | {
      readonly kind: 'ignored';
      readonly reason: IneligibleControllerDecisionV1['reason'];
    }
  | { readonly kind: 'protocol-ineligible-preserved'; readonly cause: ProtocolIneligibleReply['cause'] }
  | { readonly kind: 'model-resigned' }
  | {
      readonly kind: 'automatic-format-correction';
      readonly correctionNumber: number;
      readonly request: { readonly logicalRequests: 1; readonly instruction: string };
    }
  | { readonly kind: 'format-corrections-exhausted'; readonly chessLoss: false; readonly manualRetryAllowed: true }
  | {
      readonly kind: 'automatic-illegal-correction';
      readonly attemptNumber: number;
      readonly request: { readonly logicalRequests: 1; readonly instruction: string };
    }
  | { readonly kind: 'illegal-attempt-limit-loss'; readonly attemptNumber: 4 }
  | { readonly kind: 'legal-move-accepted'; readonly budgetsReset: true }
  | { readonly kind: 'technical-failure-preserved'; readonly code: TechnicalFailureCode }
  | { readonly kind: 'ordinary-switch-preserved' }
  | { readonly kind: 'manual-retry-authorized'; readonly request: { readonly logicalRequests: 1 } };

export interface RecoveryPolicyOutputV1 {
  readonly version: 1;
  readonly eligibility: ControllerEligibilityV1;
  readonly event: RecoveryPolicyEventV1;
  readonly previous: RecoveryBudgetStateV1;
  readonly next: RecoveryBudgetStateV1;
  readonly decision: RecoveryPolicyOutcomeV1;
}

const FORMAT_INSTRUCTIONS: Readonly<Record<FormatRejectionCategory, string>> = {
  'invalid-json':
    'Your response was not valid JSON. Return one valid JSON object with a required move string and an optional plan string. Keep the move in coordinate notation.',
  'duplicate-json-key':
    'Your JSON object repeats a field name. Return one object with one move field and, if useful, one plan field.',
  'unexpected-answer-shape':
    'Return one JSON object with a required move string and an optional plan string.',
  'invalid-code-fence':
    'Use plain text or one complete code fence around the reply. Return one valid JSON object with the required move string.',
  'missing-move':
    'Your response did not include a chosen move. Return the required move field in one JSON object.',
  'move-not-coordinate':
    'The move must use coordinate notation with a starting square and destination square. Add the promotion piece you choose when a pawn reaches its last rank.',
  'missing-promotion':
    'The chosen pawn move reaches its last rank and needs a promotion suffix. Keep your move choice and add the promotion piece you choose.',
  'ambiguous-answer':
    'Your response contains more than one possible move or combines a move with resignation. Return one clear move or an explicit resignation, not both.',
  'invalid-plan':
    'The optional plan field must contain text. Omit the plan field when you do not need it.',
  'invalid-resign-flag':
    'The resign field must be a JSON boolean. Set it to true only when resigning; otherwise return one move.',
};

const ILLEGAL_INSTRUCTIONS: Readonly<Record<RuleViolationCategory, string>> = {
  'wrong-side-to-move':
    'The proposed piece belongs to the side that is not to move. Choose a move for the side to move.',
  'king-left-in-check':
    'The proposed move leaves your king in check or moves it into check. Choose another move that keeps your king safe.',
  'castling-unavailable':
    'Castling is unavailable under the current rights or king-safety rules. Choose a move that is legal in this position.',
  'en-passant-unavailable':
    'En passant is unavailable in the current position. Choose a move that is legal in this position.',
  'destination-occupied-by-own-piece':
    'The destination square contains one of your own pieces. Choose a move with a valid destination or capture.',
  'pawn-forward-blocked':
    'A pawn cannot move forward into an occupied square. Choose a move that follows the current position rules.',
  'pawn-capture-target-missing':
    'A pawn diagonal move requires an opposing piece or an available en passant target. Choose a move that follows the current position rules.',
  'piece-movement-not-allowed':
    'The proposed piece movement is not allowed for that piece in this position. Choose another move that follows its movement rules.',
  'not-legal-in-position':
    'The proposed move is not legal in the current position. Choose another move that is legal.',
};

const TECHNICAL_CODES = new Set<TechnicalFailureCode>([
  'connection-error',
  'http-error',
  'provider-error',
  'protocol-error',
  'truncated-response',
]);
const INELIGIBLE_REASONS = new Set<IneligibleControllerDecisionV1['reason']>([
  'stale',
  'stopped',
  'expired',
  'duplicate',
  'superseded',
  'terminal',
]);

function copyState(state: RecoveryBudgetStateV1): RecoveryBudgetStateV1 {
  return {
    version: 1,
    illegalAttemptsUsed: state.illegalAttemptsUsed,
    automaticFormatCorrectionsUsed: state.automaticFormatCorrectionsUsed,
  };
}

function validateState(state: RecoveryBudgetStateV1): void {
  if (state.version !== RECOVERY_POLICY_VERSION) {
    throw new RangeError(`Unsupported recovery policy state version: ${String(state.version)}.`);
  }
  if (
    !Number.isInteger(state.illegalAttemptsUsed) ||
    state.illegalAttemptsUsed < 0 ||
    state.illegalAttemptsUsed > ILLEGAL_ATTEMPT_LIMIT
  ) {
    throw new RangeError('Illegal-attempt count must be an integer from 0 through 4.');
  }
  if (
    !Number.isInteger(state.automaticFormatCorrectionsUsed) ||
    state.automaticFormatCorrectionsUsed < 0 ||
    state.automaticFormatCorrectionsUsed > AUTOMATIC_FORMAT_CORRECTION_LIMIT
  ) {
    throw new RangeError('Automatic format-correction count must be an integer from 0 through 3.');
  }
}

function validateEligibility(eligibility: ControllerEligibilityV1): void {
  if (typeof eligibility.decisionId !== 'string' || eligibility.decisionId.trim().length === 0) {
    throw new TypeError('Controller decision ID is required.');
  }
  if (eligibility.status === 'ineligible') {
    if (!INELIGIBLE_REASONS.has(eligibility.reason)) throw new TypeError('Unknown ineligible controller reason.');
    return;
  }
  if (eligibility.status !== 'eligible') throw new TypeError('Unknown controller eligibility status.');
  if (typeof eligibility.currentFenceId !== 'string' || eligibility.currentFenceId.trim().length === 0) {
    throw new TypeError('Current fence ID is required.');
  }
  if (
    eligibility.checkedBy !== 'controller' ||
    eligibility.fence !== 'current' ||
    eligibility.deadline !== 'before' ||
    eligibility.unique !== true
  ) {
    throw new TypeError('Eligible recovery decisions require a current, unique, pre-deadline controller fence.');
  }
}

function output(
  input: RecoveryPolicyInputV1,
  next: RecoveryBudgetStateV1,
  decision: RecoveryPolicyOutcomeV1,
): RecoveryPolicyOutputV1 {
  return {
    version: RECOVERY_POLICY_VERSION,
    eligibility: input.eligibility,
    event: input.event,
    previous: copyState(input.state),
    next: copyState(next),
    decision,
  };
}

/** Creates the independent counters for a new turn or practice segment. */
export function createInitialRecoveryBudgetState(): RecoveryBudgetStateV1 {
  return Object.freeze({
    version: RECOVERY_POLICY_VERSION,
    illegalAttemptsUsed: 0,
    automaticFormatCorrectionsUsed: 0,
  });
}

/**
 * Returns a pure, versioned budget decision. It does not check fences, clocks or move legality,
 * dispatch requests, apply moves, or commit state; the controller owns those operations.
 */
export function decideRecoveryPolicy(input: RecoveryPolicyInputV1): RecoveryPolicyOutputV1 {
  if (input.version !== RECOVERY_POLICY_VERSION) {
    throw new RangeError(`Unsupported recovery policy input version: ${String(input.version)}.`);
  }
  validateState(input.state);
  validateEligibility(input.eligibility);
  const state = copyState(input.state);

  if (input.eligibility.status === 'ineligible') {
    return output(input, state, { kind: 'ignored', reason: input.eligibility.reason });
  }
  if (state.illegalAttemptsUsed === ILLEGAL_ATTEMPT_LIMIT) {
    return output(input, state, { kind: 'ignored', reason: 'terminal' });
  }

  const event = input.event;
  if (event.kind === 'model-reply') {
    const reply = event.reply;
    if (reply.kind === 'protocol-ineligible') {
      return output(input, state, { kind: 'protocol-ineligible-preserved', cause: reply.cause });
    }
    if (reply.kind === 'resignation') return output(input, state, { kind: 'model-resigned' });
    if ('moveValidation' in event) {
      if (reply.kind !== 'move-proposal') throw new TypeError('Only a parsed move proposal can carry move validation.');
      if (event.moveValidation.status === 'legal') {
        return output(input, createInitialRecoveryBudgetState(), {
          kind: 'legal-move-accepted',
          budgetsReset: true,
        });
      }
      const instruction = ILLEGAL_INSTRUCTIONS[event.moveValidation.reason];
      if (instruction === undefined) throw new TypeError('Unknown controller-validated chess-rule category.');
      if (state.illegalAttemptsUsed >= ILLEGAL_ATTEMPT_LIMIT) {
        return output(input, state, { kind: 'illegal-attempt-limit-loss', attemptNumber: 4 });
      }
      const attemptNumber = state.illegalAttemptsUsed + 1;
      const next = { ...state, illegalAttemptsUsed: attemptNumber };
      if (attemptNumber === ILLEGAL_ATTEMPT_LIMIT) {
        return output(input, next, { kind: 'illegal-attempt-limit-loss', attemptNumber: 4 });
      }
      return output(input, next, {
        kind: 'automatic-illegal-correction',
        attemptNumber,
        request: { logicalRequests: 1, instruction },
      });
    }
    if (reply.kind === 'format-rejection') {
      const instruction = FORMAT_INSTRUCTIONS[reply.category];
      if (instruction === undefined) throw new TypeError('Unknown parser formatting-rejection category.');
      if (state.automaticFormatCorrectionsUsed >= AUTOMATIC_FORMAT_CORRECTION_LIMIT) {
        return output(input, state, {
          kind: 'format-corrections-exhausted',
          chessLoss: false,
          manualRetryAllowed: true,
        });
      }
      const correctionNumber = state.automaticFormatCorrectionsUsed + 1;
      return output(
        input,
        { ...state, automaticFormatCorrectionsUsed: correctionNumber },
        {
          kind: 'automatic-format-correction',
          correctionNumber,
          request: { logicalRequests: 1, instruction },
        },
      );
    }
    throw new TypeError('Unsupported model-reply classification.');
  }

  if (event.kind === 'technical-failure') {
    if (!TECHNICAL_CODES.has(event.code)) throw new TypeError('Unknown technical-failure category.');
    return output(input, state, { kind: 'technical-failure-preserved', code: event.code });
  }
  if (event.kind === 'ordinary-switch') return output(input, state, { kind: 'ordinary-switch-preserved' });
  if (event.kind === 'manual-retry') {
    return output(input, state, {
      kind: 'manual-retry-authorized',
      request: { logicalRequests: 1 },
    });
  }
  throw new TypeError('Unknown recovery policy event.');
}
