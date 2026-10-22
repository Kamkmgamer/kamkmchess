/**
 * The feedback of a takeover of a seat (KHA-74).
 *
 * The module owns one question: where does the outcome of a takeover reach
 * the owner? A takeover the service proved is a status, and a takeover the
 * service refused and a takeover whose outcome could not be established are
 * failures the owner has to see. It is pure: it renders nothing, it owns no
 * state and it never changes the detail the service gave.
 *
 * The rules this module keeps:
 *
 * - A refused takeover and an unknown takeover are visible. The polite status
 *   of the screen is read by a screen reader alone, so a sighted owner would
 *   not learn from it that the control of the seat did not change and would
 *   take the seat for his own.
 * - The detail of the service is kept as it is. The owner reads the reason
 *   the service gave, not a sentence the browser invented.
 * - A thrown takeover is a failure as well, because the takeover did not
 *   happen. The message of the browser is kept when it has one.
 */
import type { OnlineTakeoverOutcome } from './online-takeover.js';

/** The feedback of a takeover of a seat. */
export type OnlineTakeoverFeedback =
  /** The service proved the takeover. The seat belongs to the owner. */
  | { readonly kind: 'status'; readonly detail: string }
  /** The takeover did not happen. The seat keeps its control. */
  | { readonly kind: 'failure'; readonly detail: string };

/**
 * The surfaces of the screen that show a feedback.
 *
 * The status is the polite region of the screen and the failure is the
 * visible error region of the screen. The two are never both written, so the
 * owner reads one outcome and not two.
 */
export interface OnlineTakeoverSurfaces {
  /** The polite status of the screen. */
  readonly status: (text: string) => void;
  /** The visible failure of the screen. */
  readonly failure: (text: string) => void;
}

/**
 * The feedback of an outcome of the service.
 *
 * The service decides the outcome, so the browser only routes it: a proved
 * takeover is a status and every other outcome is a failure the owner has to
 * see.
 */
export function onlineTakeoverFeedback(outcome: OnlineTakeoverOutcome): OnlineTakeoverFeedback {
  if (outcome.kind === 'accepted') return { kind: 'status', detail: outcome.detail };
  return { kind: 'failure', detail: outcome.detail };
}

/**
 * The feedback of a takeover that threw.
 *
 * The takeover did not happen, so it is a failure. The message of the browser
 * is the actionable one, so it is kept.
 */
export function onlineTakeoverErrorFeedback(error: unknown): OnlineTakeoverFeedback {
  return { kind: 'failure', detail: error instanceof Error ? error.message : 'The takeover was refused.' };
}

/**
 * Shows the feedback of a takeover on the screen.
 *
 * A status closes the visible failure and a failure closes the polite
 * status, so the screen shows exactly one outcome of the takeover.
 */
export function reportOnlineTakeover(
  surfaces: OnlineTakeoverSurfaces,
  feedback: OnlineTakeoverFeedback,
): void {
  if (feedback.kind === 'status') {
    surfaces.status(feedback.detail);
    return;
  }
  surfaces.failure(feedback.detail);
}
