import type { CoordinateMove, Position } from '../rules/index.js';

/** Where an actionable answer was read from inside one completed choice-zero answer. */
export type DeclarationOrigin =
  | 'json-move'
  | 'json-resignation'
  | 'fallback-standalone'
  | 'fallback-final-move-line'
  | 'explicit-refusal';

/**
 * A formatting failure is a completed answer that carries no single unambiguous command.
 * Every reason is a clarification request, never a chess loss and never a silent guess.
 */
export type FormatFailureReason =
  | 'no-action'
  | 'unreadable-move'
  | 'missing-promotion'
  | 'conflicting-duplicate-keys'
  | 'move-and-resignation'
  | 'competing-answers';

export interface RetainedFieldV1 {
  readonly key: string;
  readonly value: unknown;
}

/** A normalized coordinate command read from one completed answer. */
export interface MoveDeclaration {
  readonly kind: 'move';
  readonly move: CoordinateMove;
  /** The exact normalized coordinate text that was accepted. */
  readonly text: string;
  readonly origin: DeclarationOrigin;
  readonly plan?: string;
  /** Extra non-action fields kept for the match conversation and archive. */
  readonly retainedFields: readonly RetainedFieldV1[];
}

/** An explicit model-authored refusal to move. It is a loss, not a clarification. */
export interface ResignationDeclaration {
  readonly kind: 'resignation';
  readonly origin: DeclarationOrigin;
  readonly statement: string;
  readonly plan?: string;
  readonly retainedFields: readonly RetainedFieldV1[];
}

export interface FormatFailureDeclaration {
  readonly kind: 'format-failure';
  readonly reason: FormatFailureReason;
  /** The offending fragment, kept for the correction message and the archive. */
  readonly fragment: string;
  readonly retainedFields: readonly RetainedFieldV1[];
}

export type ReplyClassification =
  | MoveDeclaration
  | ResignationDeclaration
  | FormatFailureDeclaration;

/**
 * The one completed choice-zero answer the parser is allowed to read.
 *
 * Callers pass `answerText` from a normal protocol-complete response only. Reasoning,
 * plans, other choices and retained history are never arguments here.
 */
export interface CompletedAnswer {
  readonly answerText: string;
  /**
   * The authoritative position, when the caller has one. It is used only to tell a
   * missing promotion suffix apart from a complete coordinate. It is never sent to a model.
   */
  readonly position?: Position;
}