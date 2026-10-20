import { describe, expect, it } from 'vitest';
import { formatOnlineClock, onlineClockReading } from './clock';
import type { ClockState } from './contracts';

const base: ClockState = {
  whiteMs: 300_000,
  blackMs: 300_000,
  activeSeat: 'white',
  activeSince: '2026-10-21T10:00:00.000Z',
  deadlineAt: null,
  whiteMoved: true,
  blackMoved: true,
  turnNumber: 5,
  replySeat: null,
  replyDeadlineAt: null,
};

describe('the online clock is interpolated from the canonical snapshot', () => {
  it('decreases the active bank while the seat thinks', () => {
    const reading = onlineClockReading(base, Date.parse('2026-10-21T10:00:30.000Z'));
    expect(reading.whiteMs).toBe(270_000);
    expect(reading.blackMs).toBe(300_000);
    expect(reading.activeSeat).toBe('white');
    expect(reading.expired).toBe(false);
  });

  it('never moves the idle bank', () => {
    const reading = onlineClockReading({ ...base, activeSeat: 'black' }, Date.parse('2026-10-21T10:01:00.000Z'));
    expect(reading.whiteMs).toBe(300_000);
    expect(reading.blackMs).toBe(240_000);
  });

  it('never reads below zero', () => {
    const reading = onlineClockReading(base, Date.parse('2026-10-21T10:10:00.000Z'));
    expect(reading.whiteMs).toBe(0);
    expect(reading.expired).toBe(true);
  });

  it('runs no main clock while the opening reply is outstanding', () => {
    const reading = onlineClockReading({
      ...base,
      activeSeat: null,
      activeSince: null,
      replySeat: 'black',
      replyDeadlineAt: '2026-10-21T10:00:15.000Z',
    }, Date.parse('2026-10-21T10:00:10.000Z'));
    expect(reading.activeSeat).toBeNull();
    expect(reading.whiteMs).toBe(300_000);
    expect(reading.blackMs).toBe(300_000);
    expect(reading.replySeat).toBe('black');
  });

  it('reads a clock with no active seat', () => {
    const reading = onlineClockReading({ ...base, activeSeat: null, activeSince: null }, Date.parse('2026-10-21T10:00:10.000Z'));
    expect(reading.activeSeat).toBeNull();
    expect(reading.expired).toBe(false);
  });

  it('formats a bank as a clock reading', () => {
    expect(formatOnlineClock(300_000)).toBe('5:00');
    expect(formatOnlineClock(65_000)).toBe('1:05');
    expect(formatOnlineClock(0)).toBe('0:00');
  });
});
