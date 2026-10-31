import { IllegalMoveError, applyCoordinateMove } from '../rules/index.js';
import type { CoordinateMove, Position, Transition } from '../rules/index.js';
import { classifyCompletedAnswer } from './parse.js';
import type {
  CompletedAnswer,
  FormatFailureReason,
  PremoveBranchV1,
  ReplyClassification,
} from './types.js';
import { explainIllegalMove } from './violations.js';
import type { IllegalMoveExplanation } from './violations.js';

/** The pending chess turn allows the initial attempt plus three automatic corrections. */
export const MAX_ILLEGAL_MOVE_ATTEMPTS = 4;

/** Automatic formatting corrections are independent of the chess-attempt budget. */
export const MAX_FORMAT_CORRECTIONS = 3;

export interface IllegalMoveAttemptRecordV1 {
  readonly attempt: number;
  /** Which model produced this attempt, so a loss is never read as a per-model rating. */
  readonly modelConfigurationIdentity: string | null;
  readonly move: CoordinateMove;
  readonly violation: IllegalMoveExplanation;
}

export interface TurnBudgetsV1 {
  readonly schemaVersion: 1;
  readonly illegalMoveAttempts: number;
  readonly formatCorrections: number;
  readonly manualRetries: number;
  readonly attemptRecords: readonly IllegalMoveAttemptRecordV1[];
}

export function createTurnBudgets(): TurnBudgetsV1 {
  return {
    schemaVersion: 1,
    illegalMoveAttempts: 0,
    formatCorrections: 0,
    manualRetries: 0,
    attemptRecords: [],
  };
}

export interface ModelTurnInput {
  readonly budgets: TurnBudgetsV1;
  readonly position: Position;
  readonly classification: ReplyClassification;
  /** Identity of the model that produced this completed answer. */
  readonly modelConfigurationIdentity: string | null;
}

export type ModelTurnDecision =
  | {
      readonly kind: 'accepted-move';
      readonly move: CoordinateMove;
      readonly transition: Transition;
      /** Conditional pre-moves to arm once this move is on the board, when the model attached any. */
      readonly premoves?: readonly PremoveBranchV1[];
      /** A legal accepted move resets the next turn's budgets. */
      readonly budgets: TurnBudgetsV1;
    }
  | {
      readonly kind: 'illegal-attempt';
      readonly attempt: number;
      readonly illegalMoveAttemptsRemaining: number;
      readonly correction: string;
      readonly record: IllegalMoveAttemptRecordV1;
      /** Set only on the fourth illegal attempt, which loses immediately and finally. */
      readonly loss: { readonly winner: 'human'; readonly reason: 'illegal-move' } | null;
      readonly budgets: TurnBudgetsV1;
    }
  | {
      readonly kind: 'format-correction';
      readonly reason: FormatFailureReason;
      readonly correction: string;
      readonly automatic: boolean;
      readonly formatCorrectionsRemaining: number;
      /** Set once the automatic formatting budget is spent: only Retry or Switch remains. */
      readonly pause: 'retry-or-switch' | null;
      readonly budgets: TurnBudgetsV1;
    }
  | {
      readonly kind: 'model-resignation';
      readonly statement: string;
      readonly loss: { readonly winner: 'human'; readonly reason: 'resignation' };
      readonly budgets: TurnBudgetsV1;
    };

const FORMAT_CORRECTIONS: Record<FormatFailureReason, string> = {
  'no-action':
    'Your last message did not contain a move. Reply with one JSON object such as {"move":"e2e4"} using four coordinate squares, or {"resign":true} to resign. Do not send prose without a Move line.',
  'unreadable-move':
    'Your last message did not contain one readable coordinate move. Reply with four coordinate squares such as {"move":"e2e4"}. Send exactly one move and no alternatives.',
  'missing-promotion':
    'Your last move reaches the last rank without naming a promotion piece. Reply again with the same move plus q, r, b or n, for example {"move":"e7e8q"}. The application will not choose a piece for you.',
  'conflicting-duplicate-keys':
    'Your last message declared more than one different move. Reply with exactly one JSON object containing a single move key.',
  'move-and-resignation':
    'Your last message both selected a move and resigned. Reply with only one of a move object or {"resign":true}.',
  'competing-answers':
    'Your last message left more than one possible move. Reply with exactly one move and no alternatives, reflections or quoted examples.',
};

/**
 * Turns one completed answer into the single turn effect it is allowed to cause.
 *
 * A formatting failure never spends a chess attempt and never loses the game. An illegal
 * move spends one chess attempt and loses only on the fourth. A refusal is an immediate
 * model loss. The caller owns the position, clock, increment and result latch.
 */
export function decideModelTurn(input: ModelTurnInput): ModelTurnDecision {
  const { budgets, classification, modelConfigurationIdentity } = input;

  if (classification.kind === 'resignation') {
    return {
      kind: 'model-resignation',
      statement: classification.statement,
      loss: { winner: 'human', reason: 'resignation' },
      budgets,
    };
  }

  if (classification.kind === 'format-failure') {
    const correction = FORMAT_CORRECTIONS[classification.reason];
    if (budgets.formatCorrections < MAX_FORMAT_CORRECTIONS) {
      const spent = budgets.formatCorrections + 1;
      return {
        kind: 'format-correction',
        reason: classification.reason,
        correction,
        automatic: true,
        formatCorrectionsRemaining: MAX_FORMAT_CORRECTIONS - spent,
        pause: null,
        budgets: { ...budgets, formatCorrections: spent },
      };
    }
    return {
      kind: 'format-correction',
      reason: classification.reason,
      correction,
      automatic: false,
      formatCorrectionsRemaining: 0,
      pause: 'retry-or-switch',
      budgets,
    };
  }

  try {
    const transition = applyCoordinateMove(input.position, classification.move);
    return {
      kind: 'accepted-move',
      move: transition.move,
      transition,
      ...(classification.premoves === undefined ? {} : { premoves: classification.premoves }),
      budgets: createTurnBudgets(),
    };
  } catch (error) {
    if (!(error instanceof IllegalMoveError)) throw error;
    const violation = explainIllegalMove(input.position, classification.move);
    const attempt = budgets.illegalMoveAttempts + 1;
    const record: IllegalMoveAttemptRecordV1 = {
      attempt,
      modelConfigurationIdentity,
      move: error.move,
      violation,
    };
    return {
      kind: 'illegal-attempt',
      attempt,
      illegalMoveAttemptsRemaining: MAX_ILLEGAL_MOVE_ATTEMPTS - attempt,
      correction: violation.message,
      record,
      loss:
        attempt >= MAX_ILLEGAL_MOVE_ATTEMPTS ? { winner: 'human', reason: 'illegal-move' } : null,
      budgets: {
        ...budgets,
        illegalMoveAttempts: attempt,
        attemptRecords: [...budgets.attemptRecords, record],
      },
    };
  }
}

/** Classifies one completed answer and applies its single turn effect. */
export function decideCompletedAnswer(
  input: Omit<ModelTurnInput, 'classification'> & { readonly answer: CompletedAnswer },
): ModelTurnDecision {
  return decideModelTurn({ ...input, classification: classifyCompletedAnswer(input.answer) });
}

export type TurnRecoveryEvent =
  | { readonly kind: 'manual-retry' }
  | { readonly kind: 'model-switch'; readonly modelConfigurationIdentity: string | null }
  | { readonly kind: 'technical-interruption'; readonly retryAfterSeconds?: number }
  | { readonly kind: 'stop-request' }
  | { readonly kind: 'clock-expired' }
  | { readonly kind: 'stale-reply' };

export type TurnRecoveryOutcome =
  | {
      readonly kind: 'manual-retry';
      readonly budgets: TurnBudgetsV1;
      /** One authorized request, without refilling the automatic formatting budget. */
      readonly clearsPause: true;
    }
  | {
      readonly kind: 'model-switch';
      readonly modelConfigurationIdentity: string | null;
      readonly budgets: TurnBudgetsV1;
      readonly clearsPause: true;
    }
  | {
      readonly kind: 'technical-interruption';
      readonly retryAfterSeconds?: number;
      readonly budgets: TurnBudgetsV1;
      readonly clearsPause: true;
    }
  | {
      readonly kind: 'fenced';
      readonly budgets: TurnBudgetsV1;
      readonly clearsPause: false;
    };

/**
 * Applies an event that is not a completed answer.
 *
 * Stop, expiry, stale and superseded events spend no attempt, add no increment and change
 * no result. A manual Retry authorizes exactly one more request without refilling any
 * budget. An ordinary model switch preserves every spent turn counter.
 */
export function applyTurnRecoveryEvent(budgets: TurnBudgetsV1, event: TurnRecoveryEvent): TurnRecoveryOutcome {
  switch (event.kind) {
    case 'manual-retry':
      return {
        kind: 'manual-retry',
        budgets: { ...budgets, manualRetries: budgets.manualRetries + 1 },
        clearsPause: true,
      };
    case 'model-switch':
      return {
        kind: 'model-switch',
        modelConfigurationIdentity: event.modelConfigurationIdentity,
        budgets,
        clearsPause: true,
      };
    case 'technical-interruption':
      return {
        kind: 'technical-interruption',
        budgets,
        clearsPause: true,
        ...(event.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: event.retryAfterSeconds }),
      };
    case 'stop-request':
    case 'clock-expired':
    case 'stale-reply':
      return { kind: 'fenced', budgets, clearsPause: false };
  }
}