import { parsePosition, PositionValidationError } from '../rules/position';
import type { Color, Position } from '../rules/types';

export type SetupDraft = {
  side: 'white' | 'black' | 'random';
  minutes: string;
  increment: string;
  modelId: string;
  start: { kind: 'standard' } | { kind: 'custom'; fen: string };
};

export type PreviewSetup = {
  humanColor: Color;
  minutes: number;
  incrementSeconds: number;
  modelId: string | null;
  start: { kind: 'standard' } | { kind: 'custom'; position: Position };
};

export const defaultSetup: PreviewSetup = {
  humanColor: 'w', minutes: 15, incrementSeconds: 10, modelId: null, start: { kind: 'standard' },
};

export const defaultSetupDraft: SetupDraft = {
  side: 'white', minutes: '15', increment: '10', modelId: '', start: { kind: 'standard' },
};

type SetupResult = { ok: true; setup: PreviewSetup } | {
  ok: false;
  field: 'minutes' | 'increment' | 'modelId' | 'fen';
  message: string;
};

/** Validate a local preview without starting clocks, saving a game, or contacting a model. */
export function prepareSetup(draft: SetupDraft, random: () => number = Math.random): SetupResult {
  const minutes = Number(draft.minutes);
  const incrementSeconds = Number(draft.increment);
  if (!draft.minutes.trim() || !Number.isFinite(minutes) || minutes <= 0 || !Number.isSafeInteger(Math.round(minutes * 60_000))) {
    return { ok: false, field: 'minutes', message: 'Starting time must be a positive number of minutes.' };
  }
  if (!draft.increment.trim() || !Number.isFinite(incrementSeconds) || incrementSeconds < 0 || !Number.isSafeInteger(Math.round(incrementSeconds * 1000))) {
    return { ok: false, field: 'increment', message: 'Increment must be zero or a positive number of seconds.' };
  }
  if (draft.modelId !== draft.modelId.trim()) {
    return { ok: false, field: 'modelId', message: 'Remove the spaces before or after the model ID. Its spelling is otherwise kept exactly.' };
  }

  let start: PreviewSetup['start'] = { kind: 'standard' };
  if (draft.start.kind === 'custom') {
    try {
      start = { kind: 'custom', position: parsePosition(draft.start.fen) };
    } catch (error) {
      return { ok: false, field: 'fen', message: error instanceof PositionValidationError ? error.message : 'This position could not be read. Check all six FEN fields.' };
    }
  }

  const humanColor = draft.side === 'random' ? (random() < 0.5 ? 'w' : 'b') : draft.side === 'white' ? 'w' : 'b';
  return { ok: true, setup: { humanColor, minutes, incrementSeconds, modelId: draft.modelId || null, start } };
}

export function formatSetupClock(minutes: number) {
  const seconds = Math.round(minutes * 60);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; // taste-skill-ignore: pads real clock seconds, not section numbering.
}
