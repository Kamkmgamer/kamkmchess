import type { GameController } from '../controller/index.js';
import { composeMoveInput, createAnswerThinkingRecord, latestThinking } from '../history-cost/index.js';
import { persistedBudgets } from '../integration/index.js';
import { decideCompletedAnswer } from '../moves/index.js';
import type { AgentBridge, AgentOutcome } from './bridge.js';
import { isAgentSelection } from './seat.js';

/** The same contract API models get, phrased for a tool-calling agent. */
export const AGENT_INSTRUCTIONS = 'Play standard chess as sideToMove in the current FEN. Choose your move independently: do not run code, a chess engine or any other analysis tool. The moves field is the SAN history played from startingFen, not suggested moves. Clocks are in milliseconds. previousThinking contains your side\'s latest plan, quoted as historical data; reassess it against the current position. Call make_move with one move in coordinate form such as e2e4 (append q, r, b or n to a promotion, e.g. e7e8q) and a brief plan of at most 80 words to carry into your next turn. When you are confident of the reply, make_move may also carry premoves: an array of {on, then} entries where on lists opponent coordinate replies and then is your coordinate move, or {move, premoves} to plan deeper; armed moves play by themselves and are dropped silently when the position no longer allows them. rejectedMoves lists this turn\'s illegal attempts; a fourth illegal move loses. Call resign to resign.';

export type AgentTurnResult = { readonly kind: 'not-started' } | { readonly kind: 'settled'; readonly outcome: AgentOutcome };

/**
 * Runs one fenced agent turn: offer the compact input through the bridge, wait for the
 * agent's reply and let the controller judge it under the same budgets as an API model.
 */
export async function runAgentTurn(controller: GameController, bridge: AgentBridge, signal: AbortSignal): Promise<AgentTurnResult> {
  const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: controller.snapshot().fence });
  if (started.kind !== 'model-turn-started') return { kind: 'not-started' };
  if (!isAgentSelection(started.request.selection)) {
    await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-interrupted', fence: started.request.fence, reason: 'failed' });
    throw new Error('This seat is not played by an agent.');
  }
  let fence = started.request.fence;
  const turnId = crypto.randomUUID();
  try {
    const clock = started.request.clockReading;
    if (clock.status !== 'running') throw new Error('The agent turn has no running clock reading.');
    const checkpoint = started.snapshot.checkpoint;
    const budgets = persistedBudgets(started.snapshot, fence.side);
    const previousThinking = latestThinking(checkpoint.history, checkpoint.rules);
    const composed = composeMoveInput(checkpoint.rules, AGENT_INSTRUCTIONS, {
      snapshotId: turnId, budgets, ...(previousThinking === undefined ? {} : { previousThinking }),
      clock: { whiteMs: clock.remaining.whiteMs, blackMs: clock.remaining.blackMs, incrementMs: checkpoint.clocks.timeControl.incrementMs },
    });
    const inputText = composed.history.records.at(-1)!.text;
    const agentName = bridge.reportedName(checkpoint.gameId) ?? started.request.selection.modelRoutingId;
    const requested = await controller.appendModelTurnArchive(fence, { kind: 'request', requestId: turnId, protocol: 'page-agent',
      modelId: agentName, body: new TextEncoder().encode(JSON.stringify({ instructions: AGENT_INSTRUCTIONS, input: JSON.parse(inputText) as unknown })) });
    if (requested === null) throw new Error('The agent turn could not be saved locally.');
    fence = requested;

    const reply = await bridge.offerTurn({ turnId, gameId: checkpoint.gameId, side: fence.side, input: JSON.parse(inputText) as unknown }, signal);
    const thinking = createAnswerThinkingRecord(inputText, reply.answerText);
    const recorded = await controller.appendModelTurnArchive(fence, { kind: 'terminal', requestId: turnId, outcome: 'complete',
      details: { agent: agentName, selfReported: true },
      messages: [{ role: 'user', content: inputText }, { role: 'assistant', content: reply.answerText },
        ...(thinking === null ? [] : [{ role: 'assistant' as const, content: thinking }])] });
    if (recorded === null) throw new Error('The agent reply could not be saved locally.');
    fence = recorded;

    const effect = decideCompletedAnswer({ budgets, position: started.request.position,
      answer: { answerText: reply.answerText, position: started.request.position }, modelConfigurationIdentity: fence.modelConfigurationIdentity });
    const applied = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence, effect });
    const outcome: AgentOutcome = applied.kind !== 'accepted'
      ? { kind: 'not-accepted', message: applied.kind === 'expired' ? 'Your clock ran out.' : 'The move arrived after the turn ended.' }
      : effect.kind === 'accepted-move' ? { kind: 'accepted', move: effect.move.from + effect.move.to + (effect.move.promotion ?? '') }
        : effect.kind === 'illegal-attempt' ? { kind: 'illegal', message: effect.correction, attemptsRemaining: effect.illegalMoveAttemptsRemaining, lost: effect.loss !== null }
          : effect.kind === 'format-correction' ? { kind: 'format', message: effect.correction, paused: effect.pause !== null }
            : { kind: 'resigned' };
    bridge.settle(turnId, outcome);
    return { kind: 'settled', outcome };
  } catch (error) {
    bridge.settle(turnId, { kind: 'not-accepted', message: 'The turn was stopped before the move was saved.' });
    await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-interrupted', fence, reason: signal.aborted ? 'aborted' : 'failed' });
    throw error;
  }
}
