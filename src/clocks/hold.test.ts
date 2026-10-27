import { describe, expect, it } from 'vitest';
import {
  addClockTime,
  calculateMoveClockCandidate,
  calculateUndoClockCandidate,
  pauseClock,
  readClockAt,
  recoverClockAfterAbsence,
  resumeClock,
  startClock,
} from './index';

const policy = { maxReferenceDivergenceMs: 0 };
const at = (ms: number) => ({ monotonicMs: ms, wallTimeMs: 1_000_000 + ms });

function runningBlack() {
  // Black to move with 600s each; 100s later Black has 500s left.
  const clock = startClock({ at: at(0), activeSide: 'black', timeControl: { startingTimeMs: 600_000, incrementMs: 5_000 } });
  const reading = readClockAt(clock, at(100_000), policy);
  if (reading.status !== 'running') throw new Error('expected a running clock');
  return { clock, reading };
}

describe('held clock', () => {
  it('charges no time while held, however long it waits', () => {
    const { clock, reading } = runningBlack();
    const held = pauseClock(clock, reading.remaining, at(100_000));
    expect(held.paused).toBe(true);
    expect(readClockAt(held, at(5_000_000), policy)).toMatchObject({
      status: 'running', elapsedMs: 0, remaining: { whiteMs: 600_000, blackMs: 500_000 },
    });
  });

  it('ignores reference drift while held instead of asking for reconciliation', () => {
    const { clock, reading } = runningBlack();
    const held = pauseClock(clock, reading.remaining, at(100_000));
    // Monotonic time going backwards (for example a reload) would normally need review.
    expect(readClockAt(held, { monotonicMs: 1, wallTimeMs: 1_000_000 + 900_000 }, policy).status).toBe('running');
  });

  it('charges nothing for an absence while held and stays held', () => {
    const { clock, reading } = runningBlack();
    const held = pauseClock(clock, reading.remaining, at(100_000));
    const recovered = recoverClockAfterAbsence(held, { monotonicMs: 0, wallTimeMs: 1_000_000 + 9_000_000 }, policy);
    expect(recovered).toMatchObject({ status: 'recovered', elapsedChargedMs: 0, remaining: { blackMs: 500_000 } });
    if (recovered.status !== 'recovered') throw new Error('expected recovery');
    expect(recovered.clock.paused).toBe(true);
  });

  it('resumes from the resume instant without charging the held interval', () => {
    const { clock, reading } = runningBlack();
    const held = pauseClock(clock, reading.remaining, at(100_000));
    const resumed = resumeClock(held, at(400_000));
    expect(resumed.paused).toBeUndefined();
    expect(readClockAt(resumed, at(410_000), policy)).toMatchObject({
      status: 'running', elapsedMs: 10_000, remaining: { blackMs: 490_000 },
    });
  });

  it('starts the next turn running after a move or Undo', () => {
    const { clock, reading } = runningBlack();
    const held = pauseClock(clock, reading.remaining, at(100_000));
    const move = calculateMoveClockCandidate(held, 'black', at(200_000), policy);
    if (move.status !== 'candidate') throw new Error('expected a move candidate');
    expect(move.clock.paused).toBeUndefined();
    expect(move.clock.activeSide).toBe('white');
    // The held interval was not charged: 500s plus the 5s increment.
    expect(move.clock.banksAtAnchor.blackMs).toBe(505_000);
    const undo = calculateUndoClockCandidate(held, { resumedSide: 'black', incrementCreditsToRemove: { whiteMs: 0, blackMs: 0 } }, at(200_000), policy);
    if (undo.status !== 'candidate') throw new Error('expected an undo candidate');
    expect(undo.clock.paused).toBeUndefined();
  });
});

describe('adding clock time', () => {
  it('credits a running side after charging the time already used', () => {
    const { clock, reading } = runningBlack();
    const credited = addClockTime(clock, reading.remaining, 'black', 60_000, at(100_000));
    expect(credited.banksAtAnchor).toEqual({ whiteMs: 600_000, blackMs: 560_000 });
    expect(credited.paused).toBeUndefined();
    expect(readClockAt(credited, at(110_000), policy)).toMatchObject({ remaining: { blackMs: 550_000 } });
  });

  it('credits the idle side and keeps a held clock held', () => {
    const { clock, reading } = runningBlack();
    const held = pauseClock(clock, reading.remaining, at(100_000));
    const credited = addClockTime(held, reading.remaining, 'white', 30_000, at(200_000));
    expect(credited.banksAtAnchor).toEqual({ whiteMs: 630_000, blackMs: 500_000 });
    expect(credited.paused).toBe(true);
    expect(credited.activeSide).toBe('black');
  });

  it('rejects a non-positive or non-finite amount', () => {
    const { clock, reading } = runningBlack();
    expect(() => addClockTime(clock, reading.remaining, 'black', 0, at(100_000))).toThrow(RangeError);
    expect(() => addClockTime(clock, reading.remaining, 'black', -1, at(100_000))).toThrow(RangeError);
    expect(() => addClockTime(clock, reading.remaining, 'black', Number.NaN, at(100_000))).toThrow(RangeError);
  });
});
