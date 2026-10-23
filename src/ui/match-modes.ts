import type { HumanSideChoice, ModelSelection } from '../controller/index.js';
import type { PlayerSelectionV1 } from '../storage/index.js';
import { isEngineSelection } from '../engines/local.js';
import { createAgentSelection, isAgentSelection } from '../agents/seat.js';

export type MatchMode = 'local' | 'ai' | 'human-engine' | 'engine-engine' | 'engine-ai' | 'ai-ai' | 'human-agent' | 'agent-engine' | 'agent-ai';
export type SeatKind = 'human' | 'engine' | 'ai' | 'agent';
export const MATCH_MODES: { id: MatchMode; label: string }[] = [
  { id: 'local', label: 'Human versus human' },
  { id: 'ai', label: 'Human versus AI' },
  { id: 'human-engine', label: 'Human versus engine' },
  { id: 'engine-engine', label: 'Engine versus engine' },
  { id: 'engine-ai', label: 'Engine versus AI' },
  { id: 'ai-ai', label: 'AI versus AI' },
  { id: 'human-agent', label: 'Human versus agent' },
  { id: 'agent-engine', label: 'Agent versus engine' },
  { id: 'agent-ai', label: 'Agent versus AI' },
];

/** Agent modes seat an agent that plays through this page's tools. */
export function isAgentMode(mode: MatchMode): boolean {
  return mode === 'human-agent' || mode === 'agent-engine' || mode === 'agent-ai';
}

/** The side the agent plays in modes where it faces another automated seat. */
export function agentFacesSide(mode: MatchMode): boolean { return mode === 'agent-engine' || mode === 'agent-ai'; }

export function seatKinds(mode: MatchMode, humanSide: 'white' | 'black', engineSide: 'white' | 'black'): Record<'white' | 'black', SeatKind> {
  if (mode === 'local') return { white: 'human', black: 'human' };
  if (mode === 'engine-engine') return { white: 'engine', black: 'engine' };
  if (mode === 'ai-ai') return { white: 'ai', black: 'ai' };
  if (mode === 'engine-ai') return engineSide === 'white' ? { white: 'engine', black: 'ai' } : { white: 'ai', black: 'engine' };
  // In agent-versus-automation modes, engineSide names the agent's color.
  if (mode === 'agent-engine') return engineSide === 'white' ? { white: 'agent', black: 'engine' } : { white: 'engine', black: 'agent' };
  if (mode === 'agent-ai') return engineSide === 'white' ? { white: 'agent', black: 'ai' } : { white: 'ai', black: 'agent' };
  const opponent = mode === 'human-engine' ? 'engine' : mode === 'human-agent' ? 'agent' : 'ai';
  return humanSide === 'white' ? { white: 'human', black: opponent } : { white: opponent, black: 'human' };
}

export function composePlayers(mode: MatchMode, humanSide: HumanSideChoice, engineSide: 'white' | 'black',
  selections: Record<'white' | 'black', ModelSelection | null>, random: () => number = Math.random): Record<'white' | 'black', PlayerSelectionV1> {
  const side = humanSide === 'random' ? random() < 0.5 ? 'white' : 'black' : humanSide;
  const kinds = seatKinds(mode, side, engineSide);
  const player = (color: 'white' | 'black'): PlayerSelectionV1 => {
    if (kinds[color] === 'human') return { kind: 'human' };
    if (kinds[color] === 'agent') return createAgentSelection();
    // Human matches configure a single opponent independently of the eventual color.
    const selection = mode === 'ai' || mode === 'human-engine' ? selections.black : selections[color];
    if (!selection || selection.diagnostic !== 'passed-current-session' || isAgentSelection(selection) ||
        isEngineSelection(selection) !== (kinds[color] === 'engine')) {
      throw new Error(`Choose and check the ${color === 'white' ? 'White' : 'Black'} ${kinds[color] === 'engine' ? 'engine' : 'AI model'} before starting.`);
    }
    return structuredClone(selection);
  };
  return { white: player('white'), black: player('black') };
}
