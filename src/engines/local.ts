import type { GameController, ModelSelection } from '../controller/index.js';
import type { PlayerSelectionV1 } from '../storage/index.js';
import { applyCoordinateMove } from '../rules/index.js';
import type { CoordinateMove, Square } from '../rules/index.js';
import { createTurnBudgets } from '../moves/index.js';
import { searchBrowserEngine } from './browser.js';
import type { BrowserEngineSettings } from './browser.js';

export type EngineSettings = BrowserEngineSettings;
export interface ComputerInfo {
  logicalCores: number;
  memoryGb: number | null;
}
export function recommendEngine(computer: ComputerInfo): EngineSettings {
  const cores = Number.isFinite(computer.logicalCores) ? Math.max(1, Math.floor(computer.logicalCores)) : 2;
  const memory = computer.memoryGb !== null && Number.isFinite(computer.memoryGb) && computer.memoryGb > 0 ? computer.memoryGb : 2;
  return { engineId: memory >= 8 && cores >= 8 ? 'stockfish-full' : 'stockfish-lite',
    hashMb: memory < 4 ? 16 : memory < 8 ? 32 : 64, moveTimeMs: 1000 };
}

export function isEngineSelection(selection: PlayerSelectionV1): selection is ModelSelection & { providerId: 'browser-uci' } {
  // The v1 archive's automated-player record is shared by LLMs and UCI engines.
  // The reserved provider ID keeps engine execution out of provider connections.
  return selection.kind === 'model' && selection.providerId === 'browser-uci';
}

export function engineSettings(selection: ModelSelection): EngineSettings {
  if (!isEngineSelection(selection) || selection.protocol !== 'custom') throw new Error('This opponent is not a browser chess engine.');
  const value = JSON.parse(selection.connectionId) as Partial<EngineSettings>;
  if (!['stockfish-lite', 'stockfish-full'].includes(value.engineId ?? '') || value.engineId !== selection.modelRoutingId ||
    !Number.isInteger(value.hashMb) || value.hashMb! < 16 || value.hashMb! > 256 ||
    !Number.isInteger(value.moveTimeMs) || value.moveTimeMs! < 100 || value.moveTimeMs! > 10_000) {
    throw new Error('Saved engine settings are invalid. Choose the engine again.');
  }
  return value as EngineSettings;
}

export function createEngineSelection(settings: EngineSettings): ModelSelection {
  const selection: ModelSelection = { kind: 'model', providerId: 'browser-uci', connectionId: JSON.stringify(settings),
    configurationRevision: 1, modelRoutingId: settings.engineId, protocol: 'custom', diagnostic: 'passed-current-session' };
  engineSettings(selection);
  return selection;
}

export async function runEngineTurn(controller: GameController, signal: AbortSignal): Promise<boolean> {
  const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: controller.snapshot().fence });
  if (started.kind !== 'model-turn-started') return false;
  let fence = started.request.fence;
  try {
    const settings = engineSettings(started.request.selection);
    const checkpoint = started.snapshot.checkpoint;
    const clock = started.request.clockReading;
    const remaining = clock.status === 'running' ? (started.request.fence.side === 'white' ? clock.remaining.whiteMs : clock.remaining.blackMs) : 10_000;
    const body = { ...settings, moveTimeMs: Math.max(10, Math.min(settings.moveTimeMs, Math.floor(remaining / 10))),
      startingFen: checkpoint.rules.startingFen,
      moves: checkpoint.rules.moves.map(move => `${move.from}${move.to}${move.promotion ?? ''}`) };
    const requestId = crypto.randomUUID();
    const archived = await controller.appendModelTurnArchive(fence, { kind: 'request', requestId, protocol: 'uci',
      modelId: settings.engineId, body: new TextEncoder().encode(JSON.stringify(body)) });
    if (!archived) return false;
    fence = archived;
    const result = await searchBrowserEngine(body, body, signal);
    if (signal.aborted) throw new DOMException('Engine turn stopped.', 'AbortError');
    const recorded = await controller.appendModelTurnArchive(fence, { kind: 'terminal', requestId, outcome: 'complete',
      details: result, messages: [] });
    if (!recorded) return false;
    fence = recorded;
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(result.move)) throw new Error('The engine returned no playable move. Check its setup and retry.');
    const move: CoordinateMove = { from: result.move.slice(0, 2) as Square, to: result.move.slice(2, 4) as Square,
      ...(result.move[4] ? { promotion: result.move[4] as 'q' | 'r' | 'b' | 'n' } : {}) };
    const transition = applyCoordinateMove(started.request.position, move);
    const accepted = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence,
      effect: { kind: 'accepted-move', move, transition, budgets: createTurnBudgets() } });
    if (accepted.kind === 'rejected' && accepted.reason === 'illegal-move') throw new Error('The engine returned an illegal move. Check the engine and retry.');
    return accepted.kind === 'accepted';
  } catch (error) {
    await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-interrupted', fence, reason: signal.aborted ? 'aborted' : 'failed' });
    throw error;
  }
}
