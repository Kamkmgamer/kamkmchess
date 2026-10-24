import { classifyCompletedAnswer } from '../moves';
import { parsePosition } from '../rules';
import type { HistoryCheckpointV1, RulesCheckpointV1 } from '../storage';
import type { ProtocolStreamResult } from '../providers/protocols';

export interface ModelThinkingV1 {
  fen: string;
  move?: string;
  plan?: string;
  reasoning?: string;
}

/** Maximum reasoning text carried into the next provider request. */
export const MAX_CARRIED_REASONING_CHARS = 4_000;

function carriedThinking(thinking: ModelThinkingV1): ModelThinkingV1 {
  if (thinking.reasoning === undefined || thinking.reasoning.length <= MAX_CARRIED_REASONING_CHARS) return thinking;
  return { ...thinking, reasoning: thinking.reasoning.slice(0, MAX_CARRIED_REASONING_CHARS) };
}

function objectFromText(text: string): Record<string, unknown> | undefined {
  // Raw stream records can be large. Never parse them to recover chess memory.
  if (!/^\s*\{/.test(text)) return undefined;
  if (/^\s*\{\s*"kind"\s*:\s*"opaque-provider-record"/.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function joinedText(...values: unknown[]): string | undefined {
  const texts = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return texts.length === 0 ? undefined : [...new Set(texts)].join('\n\n');
}

function thinkingFromAnswer(fen: string, answerText: string, reasoningText: string, planText: string): ModelThinkingV1 | undefined {
  const answer = objectFromText(answerText);
  const plan = joinedText(answer?.plan, planText);
  const reasoning = joinedText(reasoningText, answer?.reasoning);
  if (plan === undefined && reasoning === undefined) return undefined;
  try {
    const choice = classifyCompletedAnswer({ answerText, position: parsePosition(fen) });
    return { fen, ...(choice.kind === 'move' ? { move: choice.text } : {}),
      ...(plan === undefined ? {} : { plan }), ...(reasoning === undefined ? {} : { reasoning }) };
  } catch { return undefined; }
}

/** Store normalized authored thinking separately from raw provider records, using the existing archive schema. */
export function createThinkingRecord(currentInput: string, result: ProtocolStreamResult): string | null {
  if (result.terminal !== 'complete' || result.content !== 'answer') return null;
  const input = objectFromText(currentInput);
  if (input?.kind !== 'current-match-input' || typeof input.fen !== 'string' ||
      (input.sideToMove !== 'white' && input.sideToMove !== 'black')) return null;
  const thinking = thinkingFromAnswer(input.fen, result.answerText, result.reasoningText, result.planText);
  return thinking === undefined ? null : JSON.stringify({ kind: 'model-thinking', side: input.sideToMove, ...thinking });
}

/** Thinking for an answer authored outside a provider stream, such as a browser agent's tool call. */
export function createAnswerThinkingRecord(currentInput: string, answerText: string): string | null {
  const input = objectFromText(currentInput);
  if (input?.kind !== 'current-match-input' || typeof input.fen !== 'string' ||
      (input.sideToMove !== 'white' && input.sideToMove !== 'black')) return null;
  const thinking = thinkingFromAnswer(input.fen, answerText, '', '');
  return thinking === undefined ? null : JSON.stringify({ kind: 'model-thinking', side: input.sideToMove, ...thinking });
}

/** Return one retained thinking record for the playing side, never an accumulating transcript. */
export function latestThinking(history: HistoryCheckpointV1, rules: RulesCheckpointV1): ModelThinkingV1 | undefined {
  let legacyReplies: string[] = [];
  for (let index = history.messages.length - 1; index >= 0; index -= 1) {
    const message = history.messages[index]!;
    if (message.disposition !== 'retained') continue;
    if (/^\s*\{\s*"kind"\s*:\s*"opaque-provider-record"/.test(message.content)) continue;
    const data = objectFromText(message.content);
    if (message.role === 'assistant') {
      if (data?.kind === 'model-thinking') {
        if (data.side !== rules.sideToMove || typeof data.fen !== 'string') continue;
        const plan = joinedText(data.plan);
        const reasoning = joinedText(data.reasoning);
        if (plan !== undefined || reasoning !== undefined) {
          return carriedThinking({ fen: data.fen, ...(typeof data.move === 'string' ? { move: data.move } : {}),
            ...(plan === undefined ? {} : { plan }), ...(reasoning === undefined ? {} : { reasoning }) });
        }
      } else legacyReplies.unshift(message.content);
    } else if (message.role === 'user' && data?.kind === 'current-match-input') {
      // Older saves lack typed thinking records. Only recover a reply tied to a committed move.
      if (data.sideToMove === rules.sideToMove && typeof data.fen === 'string' && legacyReplies.length > 0) {
        const thinking = thinkingFromAnswer(data.fen, legacyReplies[0]!, legacyReplies.slice(1).join('\n\n'), '');
        if (thinking?.move !== undefined && rules.moves.some((move) =>
          move.fenBefore === thinking.fen && move.from + move.to + (move.promotion ?? '') === thinking.move)) return carriedThinking(thinking);
      }
      legacyReplies = [];
    }
  }
  return undefined;
}
