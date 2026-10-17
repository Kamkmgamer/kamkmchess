export { applyCoordinateMove, IllegalMoveError, legalMoves } from './transitions.js';
export type { Transition } from './transitions.js';
export { parsePosition, PositionValidationError } from './position.js';
export { isSquareAttackedInFen } from './chess-adapter.js';
export { observeEndingFacts } from './endings.js';
export type { EndingFacts, ObservedEnding } from './endings.js';
export {
  createRepetitionLedger,
  recordPosition,
  repetitionCount,
  repetitionIdentity,
  RepetitionLedgerValidationError,
  restoreRepetitionLedger,
} from './repetition.js';
export type { RepetitionLedger, RepetitionOccurrence } from './repetition.js';
export type {
  Color,
  CoordinateMove,
  File,
  PieceOnSquare,
  PieceType,
  Position,
  PositionField,
  PositionValidationIssue,
  Promotion,
  Rank,
  Square,
} from './types.js';
