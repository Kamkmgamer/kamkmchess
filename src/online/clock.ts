/**
 * Online clock reading (KHA-74).
 *
 * The service owns the clock. Every snapshot carries the clock as it was
 * sampled at that version: both banks, the active seat and the instant the
 * active seat started thinking. The interface interpolates between two
 * snapshots; it never decides a result and never writes a bank back.
 *
 * The rules this module keeps:
 *
 * - The active bank decreases while the active seat thinks. The idle bank
 *   never moves.
 * - A reading never goes below zero. An expired bank reads zero.
 * - The opening reply window is a separate deadline. While it is open no main
 *   clock runs, so neither bank decreases.
 * - The reading is a pure function of the snapshot and an instant, so the
 *   interface can redraw it at any rate without asking the service.
 */
import type { ClockState, Seat } from './contracts';

/** The interpolated clock of one online match. */
export interface OnlineClockReading {
  readonly whiteMs: number;
  readonly blackMs: number;
  /** The seat that is thinking, or null when no clock runs. */
  readonly activeSeat: Seat | null;
  /** True when the active bank reached zero. */
  readonly expired: boolean;
  /** The end of the opening reply window, or null. */
  readonly replyDeadlineAt: string | null;
  /** The seat that owes the opening reply, or null. */
  readonly replySeat: Seat | null;
}

/**
 * Reads the clock of a snapshot at an instant.
 *
 * The instant is in milliseconds since the epoch, the same unit the service
 * uses for the sampled bank values.
 */
export function onlineClockReading(clock: ClockState, now: number): OnlineClockReading {
  const whiteMs = Math.max(0, clock.whiteMs);
  const blackMs = Math.max(0, clock.blackMs);
  const replyDeadlineAt = clock.replyDeadlineAt;
  const replySeat = clock.replySeat;
  // While the opening reply window is open, no main clock runs.
  if (replySeat !== null && replyDeadlineAt !== null) {
    return {
      whiteMs,
      blackMs,
      activeSeat: null,
      expired: false,
      replyDeadlineAt,
      replySeat,
    };
  }
  const activeSeat = clock.activeSeat;
  if (activeSeat === null || clock.activeSince === null) {
    return {
      whiteMs,
      blackMs,
      activeSeat: null,
      expired: false,
      replyDeadlineAt,
      replySeat,
    };
  }
  const since = Date.parse(clock.activeSince);
  if (Number.isNaN(since)) {
    return { whiteMs, blackMs, activeSeat, expired: false, replyDeadlineAt, replySeat };
  }
  const elapsed = Math.max(0, now - since);
  if (activeSeat === 'white') {
    const remaining = Math.max(0, whiteMs - elapsed);
    return {
      whiteMs: remaining,
      blackMs,
      activeSeat,
      expired: remaining === 0,
      replyDeadlineAt,
      replySeat,
    };
  }
  const remaining = Math.max(0, blackMs - elapsed);
  return {
    whiteMs,
    blackMs: remaining,
    activeSeat,
    expired: remaining === 0,
    replyDeadlineAt,
    replySeat,
  };
}

/** Formats a bank as a clock reading. The value is game data, not interface copy. */
export function formatOnlineClock(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}
