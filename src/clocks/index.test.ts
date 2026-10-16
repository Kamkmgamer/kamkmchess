import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_CONTROL,
  calculateMoveClockCandidate,
  calculateUndoClockCandidate,
  getClockDeadline,
  recoverClockAfterAbsence,
  readClockAt,
  startClock,
} from './index';

const noDivergence = { maxReferenceDivergenceMs: 0 };

describe('clock calculation', () => {
  it('CLK-01 starts the default White clock at 15+10 and charges explicit elapsed time', () => {
    const clock = startClock({
      at: { monotonicMs: 10_000, wallTimeMs: 1_000_000 },
    });

    expect(DEFAULT_TIME_CONTROL).toEqual({
      startingTimeMs: 900_000,
      incrementMs: 10_000,
    });
    expect(clock.activeSide).toBe('white');
    expect(clock.banksAtAnchor).toEqual({ whiteMs: 900_000, blackMs: 900_000 });
    expect(
      readClockAt(
        clock,
        { monotonicMs: 11_000, wallTimeMs: 1_001_000 },
        { maxReferenceDivergenceMs: 0 },
      ),
    ).toMatchObject({
      status: 'running',
      elapsedMs: 1_000,
      remaining: { whiteMs: 899_000, blackMs: 900_000 },
    });
  });

  it('CLK-01 starts the selected Black clock with a positive custom control and zero increment', () => {
    const clock = startClock({
      at: { monotonicMs: 50, wallTimeMs: 5_000 },
      activeSide: 'black',
      timeControl: { startingTimeMs: 1, incrementMs: 0 },
    });

    expect(clock).toMatchObject({
      activeSide: 'black',
      banksAtAnchor: { whiteMs: 1, blackMs: 1 },
    });
    expect(getClockDeadline(clock)).toMatchObject({
      monotonicMs: 51,
      wallTimeMs: 5_001,
    });
    expect(() =>
      startClock({
        at: { monotonicMs: 0, wallTimeMs: 0 },
        timeControl: { startingTimeMs: 0, incrementMs: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      startClock({
        at: { monotonicMs: 0, wallTimeMs: 0 },
        timeControl: { startingTimeMs: 1, incrementMs: -1 },
      }),
    ).toThrow(RangeError);
  });

  it('CLK-03 expires at, as well as after, the active side deadline', () => {
    const clock = startClock({
      at: { monotonicMs: 100, wallTimeMs: 1_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 100 },
    });

    expect(getClockDeadline(clock)).toEqual({
      monotonicMs: 1_100,
      wallTimeMs: 2_000,
      hostTimeMs: null,
    });
    expect(
      readClockAt(clock, { monotonicMs: 1_099, wallTimeMs: 1_999 }, noDivergence),
    ).toMatchObject({
      status: 'running',
      remaining: { whiteMs: 1, blackMs: 1_000 },
    });
    expect(
      readClockAt(clock, { monotonicMs: 1_100, wallTimeMs: 2_000 }, noDivergence),
    ).toMatchObject({
      status: 'expired',
      remaining: { whiteMs: 0, blackMs: 1_000 },
      elapsedMs: 1_000,
    });
    expect(
      readClockAt(clock, { monotonicMs: 1_101, wallTimeMs: 2_001 }, noDivergence),
    ).toMatchObject({ status: 'expired', remaining: { whiteMs: 0, blackMs: 1_000 } });
  });

  it('CLK-03 gives one move increment and charges commit delay to the next side', () => {
    const clock = startClock({
      at: { monotonicMs: 100, wallTimeMs: 1_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 100 },
    });
    const candidate = calculateMoveClockCandidate(
      clock,
      'white',
      { monotonicMs: 600, wallTimeMs: 1_500 },
      noDivergence,
    );

    expect(candidate).toMatchObject({
      status: 'candidate',
      elapsedChargedMs: 500,
      incrementCredit: { side: 'white', milliseconds: 100 },
      clock: {
        activeSide: 'black',
        banksAtAnchor: { whiteMs: 600, blackMs: 1_000 },
        anchor: { monotonicMs: 600, wallTimeMs: 1_500 },
      },
    });
    if (candidate.status !== 'candidate') throw new Error('Expected a calculated move candidate.');

    expect(
      readClockAt(
        candidate.clock,
        { monotonicMs: 700, wallTimeMs: 1_600 },
        noDivergence,
      ),
    ).toMatchObject({
      status: 'running',
      remaining: { whiteMs: 600, blackMs: 900 },
      elapsedMs: 100,
    });
  });

  it('CLK-03 rejects a move at the deadline without calculating an increment', () => {
    const clock = startClock({
      at: { monotonicMs: 100, wallTimeMs: 1_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 100 },
    });

    expect(
      calculateMoveClockCandidate(
        clock,
        'white',
        { monotonicMs: 1_100, wallTimeMs: 2_000 },
        noDivergence,
      ),
    ).toMatchObject({
      status: 'expired',
      reading: { status: 'expired', remaining: { whiteMs: 0, blackMs: 1_000 } },
    });
  });

  it('CLK-01 returns no move candidate for the side that does not own the running clock', () => {
    const clock = startClock({
      at: { monotonicMs: 100, wallTimeMs: 1_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 100 },
    });

    expect(
      calculateMoveClockCandidate(
        clock,
        'black',
        { monotonicMs: 200, wallTimeMs: 1_100 },
        noDivergence,
      ),
    ).toEqual({ status: 'wrong-side', expectedSide: 'white' });
  });

  it('CLK-03 keeps a predeadline move candidate and expires the next side during commit delay', () => {
    const clock = startClock({
      at: { monotonicMs: 1_000, wallTimeMs: 2_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 0 },
    });
    const candidate = calculateMoveClockCandidate(
      clock,
      'white',
      { monotonicMs: 1_999, wallTimeMs: 2_999 },
      noDivergence,
    );

    expect(candidate.status).toBe('candidate');
    if (candidate.status !== 'candidate') throw new Error('Expected a predeadline move candidate.');
    expect(candidate.clock.activeSide).toBe('black');
    expect(
      readClockAt(
        candidate.clock,
        { monotonicMs: 3_000, wallTimeMs: 4_000 },
        noDivergence,
      ),
    ).toMatchObject({
      status: 'expired',
      elapsedMs: 1_001,
      remaining: { whiteMs: 1, blackMs: 0 },
      deadline: { monotonicMs: 2_999, wallTimeMs: 3_999 },
    });
  });

  it('CLK-03 leaves the original clock running when the caller discards an aborted candidate', () => {
    const clock = startClock({
      at: { monotonicMs: 0, wallTimeMs: 10_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 200 },
    });
    const candidate = calculateMoveClockCandidate(
      clock,
      'white',
      { monotonicMs: 500, wallTimeMs: 10_500 },
      noDivergence,
    );
    if (candidate.status !== 'candidate') throw new Error('Expected a move candidate before abort.');

    // An aborted checkpoint discards candidate.clock; only elapsed time remains charged.
    expect(clock).toMatchObject({
      activeSide: 'white',
      banksAtAnchor: { whiteMs: 1_000, blackMs: 1_000 },
      anchor: { monotonicMs: 0, wallTimeMs: 10_000 },
    });
    expect(
      readClockAt(clock, { monotonicMs: 700, wallTimeMs: 10_700 }, noDivergence),
    ).toMatchObject({
      status: 'running',
      remaining: { whiteMs: 300, blackMs: 1_000 },
    });
  });

  it('CLK-01 charges elapsed Undo time and removes only supplied increment credits', () => {
    const initial = startClock({
      at: { monotonicMs: 0, wallTimeMs: 10_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 200 },
    });
    const whiteMove = calculateMoveClockCandidate(
      initial,
      'white',
      { monotonicMs: 0, wallTimeMs: 10_000 },
      noDivergence,
    );
    if (whiteMove.status !== 'candidate') throw new Error('Expected White move calculation.');
    const blackMove = calculateMoveClockCandidate(
      whiteMove.clock,
      'black',
      { monotonicMs: 500, wallTimeMs: 10_500 },
      noDivergence,
    );
    if (blackMove.status !== 'candidate') throw new Error('Expected Black move calculation.');

    expect(
      calculateUndoClockCandidate(
        blackMove.clock,
        {
          resumedSide: 'white',
          incrementCreditsToRemove: { whiteMs: 200, blackMs: 200 },
        },
        { monotonicMs: 700, wallTimeMs: 10_700 },
        noDivergence,
      ),
    ).toMatchObject({
      status: 'candidate',
      elapsedChargedMs: 200,
      incrementCreditsRemoved: { whiteMs: 200, blackMs: 200 },
      clock: {
        activeSide: 'white',
        banksAtAnchor: { whiteMs: 800, blackMs: 500 },
        anchor: { monotonicMs: 700, wallTimeMs: 10_700 },
      },
    });
  });

  it('CLK-01 rejects Undo when removing credits leaves either bank nonpositive', () => {
    const clock = startClock({
      at: { monotonicMs: 0, wallTimeMs: 10_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 200 },
    });

    expect(
      calculateUndoClockCandidate(
        clock,
        { resumedSide: 'white', incrementCreditsToRemove: { whiteMs: 1_000, blackMs: 0 } },
        { monotonicMs: 0, wallTimeMs: 10_000 },
        noDivergence,
      ),
    ).toMatchObject({
      status: 'rejected-credit-removal',
      banksAfterRemoval: { whiteMs: 0, blackMs: 1_000 },
    });
  });

  it('CLK-04 reconstructs absence from wall time and keeps the historical expiry instant', () => {
    const clock = startClock({
      at: { monotonicMs: 7_000, wallTimeMs: 100_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 0 },
    });

    expect(
      recoverClockAfterAbsence(
        clock,
        { monotonicMs: 10, wallTimeMs: 101_001 },
        noDivergence,
      ),
    ).toMatchObject({
      status: 'expired',
      elapsedChargedMs: 1_001,
      remaining: { whiteMs: 0, blackMs: 1_000 },
      deadline: { monotonicMs: null, wallTimeMs: 101_000, hostTimeMs: null },
      evidence: {
        basis: 'wall-clock',
        assurance: 'wall-clock-assumption',
        elapsed: { monotonicMs: null, wallMs: 1_001 },
      },
    });
  });

  it('CLK-04 reanchors an unexpired restored clock before charging live time again', () => {
    const clock = startClock({
      at: { monotonicMs: 7_000, wallTimeMs: 100_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 0 },
    });
    const recovery = recoverClockAfterAbsence(
      clock,
      { monotonicMs: 10, wallTimeMs: 100_250 },
      noDivergence,
    );

    expect(recovery).toMatchObject({
      status: 'recovered',
      elapsedChargedMs: 250,
      remaining: { whiteMs: 750, blackMs: 1_000 },
      clock: { anchor: { monotonicMs: 10, wallTimeMs: 100_250 } },
    });
    if (recovery.status !== 'recovered') throw new Error('Expected an unexpired recovery.');
    expect(
      readClockAt(
        recovery.clock,
        { monotonicMs: 510, wallTimeMs: 100_750 },
        noDivergence,
      ),
    ).toMatchObject({
      status: 'running',
      remaining: { whiteMs: 250, blackMs: 1_000 },
      elapsedMs: 500,
    });
  });

  it('CLK-05 blocks a backward wall-clock recovery without granting time', () => {
    const clock = startClock({
      at: { monotonicMs: 100, wallTimeMs: 1_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 100 },
    });

    expect(
      recoverClockAfterAbsence(
        clock,
        { monotonicMs: 10, wallTimeMs: 900 },
        noDivergence,
      ),
    ).toMatchObject({
      status: 'reconciliation-required',
      remaining: null,
      reason: 'wall-clock-regression',
      evidence: {
        elapsed: { monotonicMs: null, wallMs: -100 },
        anchor: { wallTimeMs: 1_000 },
        observedAt: { wallTimeMs: 900 },
      },
    });
  });

  it('CLK-05 blocks a transition and preserves both samples after reference divergence', () => {
    const clock = startClock({
      at: { monotonicMs: 100, wallTimeMs: 1_000 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 100 },
    });
    const sampledAt = { monotonicMs: 150, wallTimeMs: 1_150 };

    expect(
      readClockAt(clock, sampledAt, { maxReferenceDivergenceMs: 10 }),
    ).toMatchObject({
      status: 'reconciliation-required',
      remaining: null,
      reason: 'reference-divergence',
      evidence: {
        anchor: { monotonicMs: 100, wallTimeMs: 1_000 },
        observedAt: sampledAt,
        elapsed: { monotonicMs: 50, wallMs: 150 },
        maxObservedDivergenceMs: 100,
      },
    });
  });

  it('CLK-05 catches a host-offset disagreement during absence recovery', () => {
    const clock = startClock({
      at: { monotonicMs: 100, wallTimeMs: 1_000, hostOffsetMs: 0 },
      timeControl: { startingTimeMs: 1_000, incrementMs: 100 },
    });

    expect(
      recoverClockAfterAbsence(
        clock,
        { monotonicMs: 10, wallTimeMs: 1_200, hostOffsetMs: 500 },
        { maxReferenceDivergenceMs: 100 },
      ),
    ).toMatchObject({
      status: 'reconciliation-required',
      remaining: null,
      reason: 'reference-divergence',
      evidence: {
        elapsed: { monotonicMs: null, wallMs: 200, hostAdjustedMs: 700 },
        maxObservedDivergenceMs: 500,
      },
    });
  });
});
