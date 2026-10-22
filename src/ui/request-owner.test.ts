import { describe, expect, it, vi } from 'vitest';
import { createRequestOwner } from './request-owner';

describe('the request owner of a screen', () => {
  it('rejects old authority even before the screen rerenders', () => {
    let generation = 1;
    const owner = createRequestOwner({ context: 'account-a', isContextCurrent: () => generation === 1 });
    const token = owner.begin();
    generation = 2;
    expect(owner.isCurrent(token)).toBe(false);
    owner.finish(token);
    expect(owner.begin()).toBe(0);
  });
  it('runs one operation at a time, even in the same tick', () => {
    const pending: boolean[] = [];
    const owner = createRequestOwner({ context: 'a', onPendingChange: value => pending.push(value) });
    expect(owner.begin()).toBeGreaterThan(0);
    // A second click in the same tick never starts a second operation.
    expect(owner.begin()).toBe(0);
    expect(owner.pending).toBe(true);
    owner.finish(1);
    expect(owner.pending).toBe(false);
    expect(pending).toEqual([true, false]);
  });

  it('never lets a stale answer clear a newer operation', () => {
    const owner = createRequestOwner({ context: 'a' });
    const stale = owner.begin();
    owner.finish(stale);
    const fresh = owner.begin();
    expect(fresh).toBe(2);
    // The stale answer of the first operation arrives late.
    owner.finish(stale);
    expect(owner.pending).toBe(true);
    // The owner of the pending state clears it.
    owner.finish(fresh);
    expect(owner.pending).toBe(false);
  });

  it('invalidates the requests when the context changes', () => {
    const owner = createRequestOwner({ context: 'a' });
    const token = owner.begin();
    owner.moveTo('b');
    // The answer of the old context is discarded.
    expect(owner.isCurrent(token)).toBe(false);
    // The pending state of the old context is cleared.
    expect(owner.pending).toBe(false);
  });

  it('invalidates the requests when the screen unmounts', () => {
    const owner = createRequestOwner({ context: 'a' });
    const token = owner.begin();
    owner.invalidate();
    expect(owner.isCurrent(token)).toBe(false);
    expect(owner.pending).toBe(false);
    // A screen that is gone never starts an operation.
    expect(owner.begin()).toBe(0);
    // A replay of the effect revives the owner.
    owner.revive();
    expect(owner.begin()).toBeGreaterThan(0);
  });

  it('reports the pending state to the interface', () => {
    const onPendingChange = vi.fn();
    const owner = createRequestOwner({ context: 'a', onPendingChange });
    owner.begin();
    owner.finish(1);
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).toHaveBeenCalledWith(false);
  });
});
