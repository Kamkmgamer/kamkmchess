import type { RulesCheckpointV1 } from '../storage';
import type { ProtocolHistory } from '../providers/protocols';
import type { TurnBudgetsV1 } from '../moves';
import type { ModelThinkingV1 } from './thinking';

export interface MoveClockSnapshotV1 {
  whiteMs: number;
  blackMs: number;
  incrementMs: number;
}

export interface MoveTurnSnapshotV1 {
  snapshotId: string;
  clock: MoveClockSnapshotV1;
  budgets: TurnBudgetsV1;
  previousThinking?: ModelThinkingV1;
}

export interface ComposedMoveInputV1 {
  history: ProtocolHistory;
}

/** Build each move request from controller-owned chess state, never the provider transcript. */
export function composeMoveInput(
  rules: RulesCheckpointV1,
  instructions: string,
  turn: MoveTurnSnapshotV1,
): ComposedMoveInputV1 {
  if (instructions.length === 0) throw new TypeError('Current game instructions must not be empty.');
  if (turn.snapshotId.length === 0) throw new TypeError('A fresh position snapshot needs an ID.');
  const repeatedPositions = rules.repetitionLedger.positions.filter((entry) => BigInt(entry.occurrences) > 1n);
  const currentAttempts = turn.budgets.illegalMoveAttempts === 0
    ? [] : turn.budgets.attemptRecords.slice(-turn.budgets.illegalMoveAttempts);
  const rejectedMoves = currentAttempts.map((record) => ({
    move: record.move.from + record.move.to + (record.move.promotion ?? ''),
    reason: record.violation.message,
  }));

  return {
    history: {
      instructions,
      records: [{
        id: turn.snapshotId,
        role: 'user',
        text: JSON.stringify({
          kind: 'current-match-input',
          fen: rules.currentFen,
          sideToMove: rules.sideToMove,
          startingFen: rules.startingFen,
          moves: rules.moves.map((move) => move.san).join(' '),
          ...(repeatedPositions.length === 0 ? {} : { repeatedPositions }),
          clock: turn.clock,
          ...(turn.previousThinking === undefined ? {} : { previousThinking: turn.previousThinking }),
          ...(rejectedMoves.length === 0 ? {} : { rejectedMoves }),
          ...(turn.budgets.formatCorrections === 0 ? {} : { formatCorrection: 'Your previous reply had an invalid move format. Choose one move and return only the required JSON, including q, r, b or n for a promotion.' }),
        }),
      }],
      cachePrefixRecordCount: 0,
    },
  };
}

export interface ReplayCapacityLimitsV1 {
  maxRequestBytes?: number;
  maxContextTokens?: number;
  maxOutputTokens: number;
  reasoningHeadroomTokens?: number;
  countInputTokens?: (encodedRequestBody: string) => number;
}

export type ReplayCapacityV1 =
  | { status: 'fits'; encodedRequestBytes: number; inputTokens: number | null; reservedTokens: number }
  | { status: 'rejected'; reason: 'request-bytes' | 'context-tokens' | 'capacity-unverifiable'; encodedRequestBytes: number; inputTokens: number | null; reservedTokens: number };

/** Checks the exact encoded destination body and keeps requested output/reasoning headroom. */
export function checkReplayCapacity(
  encodedBody: Readonly<Record<string, unknown>>,
  limits: ReplayCapacityLimitsV1,
): ReplayCapacityV1 {
  const encoded = JSON.stringify(encodedBody);
  const encodedRequestBytes = new TextEncoder().encode(encoded).byteLength;
  const reservedTokens = limits.maxOutputTokens + (limits.reasoningHeadroomTokens ?? 0);
  const inputTokens = limits.countInputTokens?.(encoded) ?? null;
  if (limits.maxRequestBytes !== undefined && encodedRequestBytes > limits.maxRequestBytes) {
    return { status: 'rejected', reason: 'request-bytes', encodedRequestBytes, inputTokens, reservedTokens };
  }
  if (limits.maxContextTokens !== undefined) {
    if (inputTokens === null) {
      return { status: 'rejected', reason: 'capacity-unverifiable', encodedRequestBytes, inputTokens, reservedTokens };
    }
    if (inputTokens + reservedTokens > limits.maxContextTokens) {
      return { status: 'rejected', reason: 'context-tokens', encodedRequestBytes, inputTokens, reservedTokens };
    }
  }
  return { status: 'fits', encodedRequestBytes, inputTokens, reservedTokens };
}
