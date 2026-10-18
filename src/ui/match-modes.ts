import type { HumanSideChoice, ModelSelection } from '../controller/index.js';
import type { PlayerSelectionV1 } from '../storage/index.js';
import { isEngineSelection } from '../engines/local.js';

export type MatchMode = 'local' | 'ai' | 'human-engine' | 'engine-engine' | 'engine-ai' | 'ai-ai';
export type SeatKind = 'human' | 'engine' | 'ai';
export const MATCH_MODES: { id: MatchMode; label: string }[] = [
  { id: 'local', label: 'Human versus human' },
  { id: 'ai', label: 'Human versus AI' },
  { id: 'human-engine', label: 'Human versus engine' },
  { id: 'engine-engine', label: 'Engine versus engine' },
  { id: 'engine-ai', label: 'Engine versus AI' },
  { id: 'ai-ai', label: 'AI versus AI' },
];

export function seatKinds(mode: MatchMode, humanSide: 'white' | 'black', engineSide: 'white' | 'black'): Record<'white' | 'black', SeatKind> {
  if (mode === 'local') return { white: 'human', black: 'human' };
  if (mode === 'engine-engine') return { white: 'engine', black: 'engine' };
  if (mode === 'ai-ai') return { white: 'ai', black: 'ai' };
  if (mode === 'engine-ai') return engineSide === 'white' ? { white: 'engine', black: 'ai' } : { white: 'ai', black: 'engine' };
  const opponent = mode === 'human-engine' ? 'engine' : 'ai';
  return humanSide === 'white' ? { white: 'human', black: opponent } : { white: opponent, black: 'human' };
}

export function composePlayers(mode: MatchMode, humanSide: HumanSideChoice, engineSide: 'white' | 'black',
  selections: Record<'white' | 'black', ModelSelection | null>, random: () => number = Math.random): Record<'white' | 'black', PlayerSelectionV1> {
  const side = humanSide === 'random' ? random() < 0.5 ? 'white' : 'black' : humanSide;
  const kinds = seatKinds(mode, side, engineSide);
  const player = (color: 'white' | 'black'): PlayerSelectionV1 => {
    if (kinds[color] === 'human') return { kind: 'human' };
    // Human matches configure a single opponent independently of the eventual color.
    const selection = mode === 'ai' || mode === 'human-engine' ? selections.black : selections[color];
    if (!selection || selection.diagnostic !== 'passed-current-session' ||
        isEngineSelection(selection) !== (kinds[color] === 'engine')) {
      throw new Error(`Choose and check the ${color === 'white' ? 'White' : 'Black'} ${kinds[color] === 'engine' ? 'engine' : 'AI model'} before starting.`);
    }
    return structuredClone(selection);
  };
  return { white: player('white'), black: player('black') };
}
