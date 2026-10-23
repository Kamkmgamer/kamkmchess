import { describe, expect, it } from 'vitest';
import { composePlayers } from './match-modes.js';
import { createEngineSelection } from '../engines/local.js';
import { createAgentSelection } from '../agents/seat.js';
import type { ModelSelection } from '../controller/index.js';

const engine = createEngineSelection({ engineId: 'stockfish-lite', hashMb: 32, moveTimeMs: 1000 });
const ai: ModelSelection = { kind: 'model', providerId: 'fixture', connectionId: 'white-model', modelRoutingId: 'white-model',
  configurationRevision: 1, protocol: 'chat-completions', diagnostic: 'passed-current-session' };
const otherAi = { ...ai, connectionId: 'black-model', modelRoutingId: 'black-model' };

describe('match modes', () => {
  it('assigns separate opponents in all four new modes', () => {
    expect(composePlayers('human-engine', 'black', 'white', { white: null, black: engine })).toEqual({ white: engine, black: { kind: 'human' } });
    expect(composePlayers('engine-engine', 'white', 'white', { white: engine, black: engine })).toEqual({ white: engine, black: engine });
    expect(composePlayers('engine-ai', 'white', 'black', { white: ai, black: engine })).toEqual({ white: ai, black: engine });
    expect(composePlayers('ai-ai', 'white', 'white', { white: ai, black: otherAi })).toEqual({ white: ai, black: otherAi });
  });
  it('resolves random human color once and preserves existing modes', () => {
    expect(composePlayers('human-engine', 'random', 'white', { white: null, black: engine }, () => 0.8).white).toEqual(engine);
    expect(composePlayers('ai', 'white', 'white', { white: null, black: ai }).black).toEqual(ai);
    expect(composePlayers('local', 'white', 'white', { white: null, black: null })).toEqual({ white: { kind: 'human' }, black: { kind: 'human' } });
  });
  it('rejects unchecked, missing or incorrectly classified opponents', () => {
    expect(() => composePlayers('engine-ai', 'white', 'white', { white: ai, black: engine })).toThrow();
    expect(() => composePlayers('ai-ai', 'white', 'white', { white: ai, black: null })).toThrow();
    expect(() => composePlayers('ai', 'white', 'white', { white: null, black: { ...ai, diagnostic: 'unknown' } })).toThrow();
  });
  it('seats an agent beside the existing modes without needing a checked selection', () => {
    const agent = createAgentSelection();
    expect(composePlayers('human-agent', 'white', 'white', { white: null, black: null })).toEqual({ white: { kind: 'human' }, black: agent });
    expect(composePlayers('agent-engine', 'white', 'black', { white: engine, black: null })).toEqual({ white: engine, black: agent });
    expect(composePlayers('agent-ai', 'white', 'white', { white: null, black: ai })).toEqual({ white: agent, black: ai });
    expect(() => composePlayers('agent-engine', 'white', 'white', { white: null, black: ai })).toThrow();
    expect(() => composePlayers('ai', 'white', 'white', { white: null, black: agent })).toThrow();
  });
});
