export type ClockSide = 'white' | 'black';

export interface TimeControl {
  readonly startingTimeMs: number;
  readonly incrementMs: number;
}

export interface ClockBanks {
  readonly whiteMs: number;
  readonly blackMs: number;
}

export interface TimeSample {
  readonly monotonicMs: number;
  readonly wallTimeMs: number;
  /** Estimated host UTC minus wall time, when an integration has this evidence. */
  readonly hostOffsetMs?: number;
}

export interface ClockState {
  /** Clock record format only. The controller owns the monotonic game revision. */
  readonly schemaVersion: 1;
  readonly timeControl: TimeControl;
  readonly banksAtAnchor: ClockBanks;
  readonly activeSide: ClockSide;
  readonly anchor: TimeSample;
  /**
   * True while the active side's clock is held, for example while a failed model turn
   * waits to be retried. A held clock charges no time; its banks stay at banksAtAnchor.
   */
  readonly paused?: boolean;
}

export interface ClockComparisonPolicy {
  /** Caller-selected tolerance. The approved spec does not set this value. */
  readonly maxReferenceDivergenceMs: number;
}

export interface ClockDeadline {
  /** Null when the deadline crosses a process boundary. */
  readonly monotonicMs: number | null;
  readonly wallTimeMs: number;
  readonly hostTimeMs: number | null;
}

export interface ClockReferenceEvidence {
  readonly basis: 'monotonic' | 'wall-clock';
  readonly assurance: 'same-process-assumption' | 'wall-clock-assumption';
  readonly anchor: TimeSample;
  readonly observedAt: TimeSample;
  readonly elapsed: {
    readonly monotonicMs: number | null;
    readonly wallMs: number;
    readonly hostAdjustedMs: number | null;
  };
  readonly maxObservedDivergenceMs: number;
}

export type ClockReconciliationReason =
  | 'monotonic-regression'
  | 'wall-clock-regression'
  | 'host-reference-regression'
  | 'reference-divergence';

interface ClockReadingEvidenceFields {
  readonly activeSide: ClockSide;
  readonly deadline: ClockDeadline;
  readonly evidence: ClockReferenceEvidence;
}

export type ClockReading =
  | (ClockReadingEvidenceFields & {
      readonly status: 'running' | 'expired';
      readonly remaining: ClockBanks;
      readonly elapsedMs: number;
    })
  | (ClockReadingEvidenceFields & {
      readonly status: 'reconciliation-required';
      /** Null when references disagree and the calculation cannot authorize a transition. */
      readonly remaining: null;
      readonly elapsedMs: null;
      readonly reason: ClockReconciliationReason;
    });

export interface StartClockInput {
  readonly at: TimeSample;
  readonly timeControl?: TimeControl;
  readonly activeSide?: ClockSide;
}

export const DEFAULT_TIME_CONTROL: Readonly<TimeControl> = Object.freeze({
  startingTimeMs: 15 * 60 * 1_000,
  incrementMs: 10 * 1_000,
});

export function startClock(input: StartClockInput): ClockState {
  assertSample(input.at, 'at');
  const timeControl = input.timeControl ?? DEFAULT_TIME_CONTROL;
  assertTimeControl(timeControl);
  const activeSide = input.activeSide ?? 'white';
  assertSide(activeSide, 'activeSide');

  return {
    schemaVersion: 1,
    timeControl: {
      startingTimeMs: timeControl.startingTimeMs,
      incrementMs: timeControl.incrementMs,
    },
    banksAtAnchor: {
      whiteMs: timeControl.startingTimeMs,
      blackMs: timeControl.startingTimeMs,
    },
    activeSide,
    anchor: copySample(input.at),
  };
}

export function getClockDeadline(state: ClockState): ClockDeadline {
  assertClockState(state);
  const bankMs = getBank(state.banksAtAnchor, state.activeSide);
  const hostTimeMs = state.anchor.hostOffsetMs === undefined
    ? null
    : state.anchor.wallTimeMs + state.anchor.hostOffsetMs + bankMs;
  const monotonicMs = state.anchor.monotonicMs + bankMs;
  const wallTimeMs = state.anchor.wallTimeMs + bankMs;
  assertFinite(monotonicMs, 'deadline.monotonicMs');
  assertFinite(wallTimeMs, 'deadline.wallTimeMs');
  if (hostTimeMs !== null) assertFinite(hostTimeMs, 'deadline.hostTimeMs');

  return {
    monotonicMs,
    wallTimeMs,
    hostTimeMs,
  };
}

export function readClockAt(
  state: ClockState,
  at: TimeSample,
  policy: ClockComparisonPolicy,
): ClockReading {
  assertClockState(state);
  assertSample(at, 'at');
  assertPolicy(policy);

  const evidence = compareReferences(state.anchor, at, 'monotonic');
  const deadline = getClockDeadline(state);
  if (state.paused === true) {
    // A held clock measures no time, so reference drift cannot change what it reads.
    return {
      status: getBank(state.banksAtAnchor, state.activeSide) <= 0 ? 'expired' : 'running',
      activeSide: state.activeSide,
      remaining: { ...state.banksAtAnchor },
      elapsedMs: 0,
      deadline,
      evidence,
    };
  }
  const reason = timingIssue(evidence, policy);
  if (reason !== undefined) {
    return {
      status: 'reconciliation-required',
      activeSide: state.activeSide,
      remaining: null,
      elapsedMs: null,
      deadline,
      evidence,
      reason,
    };
  }

  const elapsedMs = evidence.elapsed.monotonicMs;
  if (elapsedMs === null) throw new Error('Live clock evidence must include monotonic elapsed time.');
  const remaining = subtractActiveBank(state.banksAtAnchor, state.activeSide, elapsedMs);
  return {
    status: elapsedMs >= getBank(state.banksAtAnchor, state.activeSide) ? 'expired' : 'running',
    activeSide: state.activeSide,
    remaining,
    elapsedMs,
    deadline,
    evidence,
  };
}

export type ClockRecovery =
  | {
      readonly status: 'recovered';
      readonly clock: ClockState;
      readonly remaining: ClockBanks;
      readonly elapsedChargedMs: number;
      readonly deadline: ClockDeadline;
      readonly evidence: ClockReferenceEvidence;
    }
  | {
      readonly status: 'expired';
      readonly remaining: ClockBanks;
      readonly elapsedChargedMs: number;
      readonly deadline: ClockDeadline;
      readonly evidence: ClockReferenceEvidence;
    }
  | {
      readonly status: 'reconciliation-required';
      readonly remaining: null;
      readonly deadline: ClockDeadline;
      readonly evidence: ClockReferenceEvidence;
      readonly reason: ClockReconciliationReason;
    };

export function recoverClockAfterAbsence(
  state: ClockState,
  resumedAt: TimeSample,
  policy: ClockComparisonPolicy,
): ClockRecovery {
  assertClockState(state);
  assertSample(resumedAt, 'resumedAt');
  assertPolicy(policy);

  const evidence = compareReferences(state.anchor, resumedAt, 'wall-clock');
  const deadline = absenceDeadline(state);
  if (state.paused === true) {
    // A held clock charges nothing for the absence and stays held after it.
    return {
      status: 'recovered',
      clock: { ...state, anchor: copySample(resumedAt) },
      remaining: { ...state.banksAtAnchor },
      elapsedChargedMs: 0,
      deadline,
      evidence,
    };
  }
  const reason = timingIssue(evidence, policy);
  if (reason !== undefined) {
    return {
      status: 'reconciliation-required',
      remaining: null,
      deadline,
      evidence,
      reason,
    };
  }

  const elapsedChargedMs = evidence.elapsed.wallMs;
  const remaining = subtractActiveBank(state.banksAtAnchor, state.activeSide, elapsedChargedMs);
  const status = elapsedChargedMs >= getBank(state.banksAtAnchor, state.activeSide) ? 'expired' : 'recovered';
  if (status === 'expired') {
    return { status, remaining, elapsedChargedMs, deadline, evidence };
  }

  return {
    status,
    clock: {
      ...state,
      banksAtAnchor: remaining,
      anchor: copySample(resumedAt),
    },
    remaining,
    elapsedChargedMs,
    deadline,
    evidence,
  };
}

export type ClockMoveCandidate =
  | {
      readonly status: 'candidate';
      readonly clock: ClockState;
      readonly elapsedChargedMs: number;
      readonly incrementCredit: { readonly side: ClockSide; readonly milliseconds: number };
      readonly reading: ClockReading;
    }
  | { readonly status: 'expired'; readonly reading: ClockReading }
  | { readonly status: 'reconciliation-required'; readonly reading: ClockReading }
  | { readonly status: 'wrong-side'; readonly expectedSide: ClockSide };

/**
 * Calculate a pre-commit clock candidate for a unique, eligible, legal move.
 * The controller must discard it unless the checkpoint transaction commits.
 */
export function calculateMoveClockCandidate(
  state: ClockState,
  movingSide: ClockSide,
  decisionAt: TimeSample,
  policy: ClockComparisonPolicy,
): ClockMoveCandidate {
  assertClockState(state);
  assertSide(movingSide, 'movingSide');
  if (movingSide !== state.activeSide) {
    return { status: 'wrong-side', expectedSide: state.activeSide };
  }

  const reading = readClockAt(state, decisionAt, policy);
  if (reading.status === 'expired') return { status: 'expired', reading };
  if (reading.status === 'reconciliation-required') {
    return { status: 'reconciliation-required', reading };
  }

  const banksAfterIncrement = addToBank(reading.remaining, movingSide, state.timeControl.incrementMs);
  return {
    status: 'candidate',
    clock: {
      ...withoutPause(state),
      banksAtAnchor: banksAfterIncrement,
      activeSide: oppositeSide(movingSide),
      anchor: copySample(decisionAt),
    },
    elapsedChargedMs: reading.elapsedMs,
    incrementCredit: { side: movingSide, milliseconds: state.timeControl.incrementMs },
    reading,
  };
}

export interface ClockUndoInput {
  readonly resumedSide: ClockSide;
  /** Credits belonging only to accepted moves that this Undo removes. */
  readonly incrementCreditsToRemove: ClockBanks;
}

export type ClockUndoCandidate =
  | {
      readonly status: 'candidate';
      readonly clock: ClockState;
      readonly elapsedChargedMs: number;
      readonly incrementCreditsRemoved: ClockBanks;
      readonly reading: ClockReading;
    }
  | { readonly status: 'expired'; readonly reading: ClockReading }
  | { readonly status: 'reconciliation-required'; readonly reading: ClockReading }
  | {
      readonly status: 'rejected-credit-removal';
      readonly banksAfterRemoval: ClockBanks;
      readonly reading: ClockReading;
    };

/** Calculate an Undo clock candidate; the controller owns its commit and event fences. */
export function calculateUndoClockCandidate(
  state: ClockState,
  input: ClockUndoInput,
  decisionAt: TimeSample,
  policy: ClockComparisonPolicy,
): ClockUndoCandidate {
  assertClockState(state);
  assertSide(input.resumedSide, 'resumedSide');
  assertBanks(input.incrementCreditsToRemove, 'incrementCreditsToRemove');

  const reading = readClockAt(state, decisionAt, policy);
  if (reading.status === 'expired') return { status: 'expired', reading };
  if (reading.status === 'reconciliation-required') {
    return { status: 'reconciliation-required', reading };
  }

  const banksAfterRemoval = subtractCredits(
    reading.remaining,
    input.incrementCreditsToRemove,
  );
  if (banksAfterRemoval.whiteMs <= 0 || banksAfterRemoval.blackMs <= 0) {
    return { status: 'rejected-credit-removal', banksAfterRemoval, reading };
  }

  return {
    status: 'candidate',
    clock: {
      ...withoutPause(state),
      banksAtAnchor: banksAfterRemoval,
      activeSide: input.resumedSide,
      anchor: copySample(decisionAt),
    },
    elapsedChargedMs: reading.elapsedMs,
    incrementCreditsRemoved: { ...input.incrementCreditsToRemove },
    reading,
  };
}

/**
 * Hold the active side's clock at `remaining`, the banks already charged up to `at`.
 * A held clock charges no time until resumeClock restarts it.
 */
export function pauseClock(state: ClockState, remaining: ClockBanks, at: TimeSample): ClockState {
  assertClockState(state);
  assertBanks(remaining, 'remaining');
  assertSample(at, 'at');
  return { ...state, banksAtAnchor: { ...remaining }, anchor: copySample(at), paused: true };
}

/** Restart a held clock from `at`, without charging the interval it was held. */
export function resumeClock(state: ClockState, at: TimeSample): ClockState {
  assertClockState(state);
  assertSample(at, 'at');
  return { ...withoutPause(state), anchor: copySample(at) };
}

/**
 * Credit `amountMs` to one side's bank. `remaining` is the banks already charged up to
 * `at`; the clock keeps its active side and stays running or held as it was.
 */
export function addClockTime(
  state: ClockState,
  remaining: ClockBanks,
  side: ClockSide,
  amountMs: number,
  at: TimeSample,
): ClockState {
  assertClockState(state);
  assertBanks(remaining, 'remaining');
  assertSide(side, 'side');
  assertSample(at, 'at');
  assertFinite(amountMs, 'amountMs');
  if (amountMs <= 0) throw new RangeError('amountMs must be positive.');
  return { ...state, banksAtAnchor: addToBank(remaining, side, amountMs), anchor: copySample(at) };
}

function withoutPause(state: ClockState): ClockState {
  if (state.paused === undefined) return state;
  return {
    schemaVersion: state.schemaVersion,
    timeControl: state.timeControl,
    banksAtAnchor: state.banksAtAnchor,
    activeSide: state.activeSide,
    anchor: state.anchor,
  };
}

function compareReferences(
  anchor: TimeSample,
  observedAt: TimeSample,
  basis: ClockReferenceEvidence['basis'],
): ClockReferenceEvidence {
  const wallMs = observedAt.wallTimeMs - anchor.wallTimeMs;
  assertFinite(wallMs, 'wallElapsedMs');
  const monotonicMs = basis === 'monotonic'
    ? observedAt.monotonicMs - anchor.monotonicMs
    : null;
  if (monotonicMs !== null) assertFinite(monotonicMs, 'monotonicElapsedMs');
  const hostAdjustedMs = anchor.hostOffsetMs === undefined || observedAt.hostOffsetMs === undefined
    ? null
    : wallMs + observedAt.hostOffsetMs - anchor.hostOffsetMs;
  if (hostAdjustedMs !== null) assertFinite(hostAdjustedMs, 'hostAdjustedElapsedMs');
  const divergence = [
    monotonicMs === null ? null : Math.abs(wallMs - monotonicMs),
    monotonicMs === null || hostAdjustedMs === null ? null : Math.abs(hostAdjustedMs - monotonicMs),
    hostAdjustedMs === null ? null : Math.abs(hostAdjustedMs - wallMs),
  ].filter((value): value is number => value !== null);

  const maxObservedDivergenceMs = Math.max(0, ...divergence);
  assertFinite(maxObservedDivergenceMs, 'maxObservedDivergenceMs');

  return {
    basis,
    assurance: basis === 'monotonic' ? 'same-process-assumption' : 'wall-clock-assumption',
    anchor: copySample(anchor),
    observedAt: copySample(observedAt),
    elapsed: { monotonicMs, wallMs, hostAdjustedMs },
    maxObservedDivergenceMs,
  };
}

function timingIssue(
  evidence: ClockReferenceEvidence,
  policy: ClockComparisonPolicy,
): ClockReconciliationReason | undefined {
  if (evidence.elapsed.monotonicMs !== null && evidence.elapsed.monotonicMs < 0) {
    return 'monotonic-regression';
  }
  if (evidence.elapsed.wallMs < 0) return 'wall-clock-regression';
  if (evidence.elapsed.hostAdjustedMs !== null && evidence.elapsed.hostAdjustedMs < 0) {
    return 'host-reference-regression';
  }
  if (evidence.maxObservedDivergenceMs > policy.maxReferenceDivergenceMs) {
    return 'reference-divergence';
  }
  return undefined;
}

function absenceDeadline(state: ClockState): ClockDeadline {
  const deadline = getClockDeadline(state);
  return { ...deadline, monotonicMs: null };
}

function subtractActiveBank(banks: ClockBanks, activeSide: ClockSide, elapsedMs: number): ClockBanks {
  return addToBank(banks, activeSide, -elapsedMs, true);
}

function addToBank(
  banks: ClockBanks,
  side: ClockSide,
  amountMs: number,
  clampAtZero = false,
): ClockBanks {
  const value = getBank(banks, side) + amountMs;
  const next = clampAtZero ? Math.max(0, value) : value;
  assertFinite(next, 'calculatedBankMs');
  return side === 'white'
    ? { whiteMs: next, blackMs: banks.blackMs }
    : { whiteMs: banks.whiteMs, blackMs: next };
}

function subtractCredits(banks: ClockBanks, credits: ClockBanks): ClockBanks {
  return {
    whiteMs: banks.whiteMs - credits.whiteMs,
    blackMs: banks.blackMs - credits.blackMs,
  };
}

function getBank(banks: ClockBanks, side: ClockSide): number {
  return side === 'white' ? banks.whiteMs : banks.blackMs;
}

function oppositeSide(side: ClockSide): ClockSide {
  return side === 'white' ? 'black' : 'white';
}

function copySample(sample: TimeSample): TimeSample {
  return sample.hostOffsetMs === undefined
    ? { monotonicMs: sample.monotonicMs, wallTimeMs: sample.wallTimeMs }
    : {
        monotonicMs: sample.monotonicMs,
        wallTimeMs: sample.wallTimeMs,
        hostOffsetMs: sample.hostOffsetMs,
      };
}

function assertClockState(state: ClockState): void {
  if (state.schemaVersion !== 1) throw new RangeError('Unsupported clock schema version.');
  assertTimeControl(state.timeControl);
  assertBanks(state.banksAtAnchor, 'banksAtAnchor');
  assertSide(state.activeSide, 'activeSide');
  assertSample(state.anchor, 'anchor');
  if (state.paused !== undefined && typeof state.paused !== 'boolean') {
    throw new RangeError('paused must be a boolean.');
  }
}

function assertTimeControl(timeControl: TimeControl): void {
  assertFinite(timeControl.startingTimeMs, 'startingTimeMs');
  assertFinite(timeControl.incrementMs, 'incrementMs');
  if (timeControl.startingTimeMs <= 0) throw new RangeError('startingTimeMs must be positive.');
  if (timeControl.incrementMs < 0) throw new RangeError('incrementMs must be nonnegative.');
}

function assertBanks(banks: ClockBanks, name: string): void {
  assertFinite(banks.whiteMs, `${name}.whiteMs`);
  assertFinite(banks.blackMs, `${name}.blackMs`);
  if (banks.whiteMs < 0 || banks.blackMs < 0) {
    throw new RangeError(`${name} must contain nonnegative banks.`);
  }
}

function assertSample(sample: TimeSample, name: string): void {
  assertFinite(sample.monotonicMs, `${name}.monotonicMs`);
  assertFinite(sample.wallTimeMs, `${name}.wallTimeMs`);
  if (sample.monotonicMs < 0) throw new RangeError(`${name}.monotonicMs must be nonnegative.`);
  if (sample.hostOffsetMs !== undefined) assertFinite(sample.hostOffsetMs, `${name}.hostOffsetMs`);
}

function assertPolicy(policy: ClockComparisonPolicy): void {
  assertFinite(policy.maxReferenceDivergenceMs, 'maxReferenceDivergenceMs');
  if (policy.maxReferenceDivergenceMs < 0) {
    throw new RangeError('maxReferenceDivergenceMs must be nonnegative.');
  }
}

function assertSide(side: ClockSide, name: string): void {
  if (side !== 'white' && side !== 'black') throw new RangeError(`${name} must be white or black.`);
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
}
