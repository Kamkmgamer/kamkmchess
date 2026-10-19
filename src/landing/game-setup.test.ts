import { describe, expect, it } from 'vitest';
import { defaultSetupDraft, formatSetupClock, prepareSetup } from './game-setup';

describe('sidebar setup preview', () => {
  it('uses the approved White and 15+10 defaults', () => {
    expect(prepareSetup(defaultSetupDraft)).toEqual({ ok: true, setup: {
      humanColor: 'w', minutes: 15, incrementSeconds: 10, modelId: null, start: { kind: 'standard' },
    } });
  });

  it('accepts positive custom time, zero increment and exact model IDs', () => {
    expect(prepareSetup({ ...defaultSetupDraft, side: 'black', minutes: '0.5', increment: '0', modelId: 'custom/Model:Latest' })).toEqual({ ok: true, setup: {
      humanColor: 'b', minutes: 0.5, incrementSeconds: 0, modelId: 'custom/Model:Latest', start: { kind: 'standard' },
    } });
    expect(formatSetupClock(0.5)).toBe('0:30');
    expect(formatSetupClock(15)).toBe('15:00');
  });

  it.each(['', '0', '-1', 'Infinity', 'not a time', '1e30'])('rejects invalid starting minutes: %s', (minutes) => {
    expect(prepareSetup({ ...defaultSetupDraft, minutes })).toMatchObject({ ok: false, field: 'minutes' });
  });

  it.each(['', '-1', 'Infinity', 'not a time', '1e30'])('rejects invalid increments: %s', (increment) => {
    expect(prepareSetup({ ...defaultSetupDraft, increment })).toMatchObject({ ok: false, field: 'increment' });
  });

  it('rejects surrounding model-ID whitespace instead of changing the ID', () => {
    expect(prepareSetup({ ...defaultSetupDraft, modelId: ' Model/ID ' })).toMatchObject({ ok: false, field: 'modelId' });
  });

  it('resolves a random side when setup is applied', () => {
    expect(prepareSetup({ ...defaultSetupDraft, side: 'random' }, () => 0.2)).toMatchObject({ ok: true, setup: { humanColor: 'w' } });
    expect(prepareSetup({ ...defaultSetupDraft, side: 'random' }, () => 0.8)).toMatchObject({ ok: true, setup: { humanColor: 'b' } });
  });

  it('keeps custom FEN counters and validates the actual setup', () => {
    const fen = '8/8/4k3/8/8/4K3/8/8 w - - 42 87';
    expect(prepareSetup({ ...defaultSetupDraft, start: { kind: 'custom', fen } })).toMatchObject({ ok: true, setup: { start: {
      kind: 'custom', position: { fen, halfmoveClock: '42', fullmoveNumber: '87', sideToMove: 'w' },
    } } });
    expect(prepareSetup({ ...defaultSetupDraft, start: { kind: 'custom', fen: '8/8/8/8/8/8/4k3/4K3 w - - 0 1' } })).toMatchObject({ ok: false, field: 'fen' });
  });
});
