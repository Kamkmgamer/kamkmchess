import type { ProtocolContent, ProtocolStreamResult, ProviderProtocol } from '../providers/protocols/index.js';
import type { CoordinateMove, Position, Promotion, Square } from '../rules/index.js';

export type ReplyNotation =
  | 'coordinate-json'
  | 'fenced-coordinate-json'
  | 'final-move-line'
  | 'standalone-coordinate'
  | 'fenced-coordinate';

export type FormatRejectionCategory =
  | 'invalid-json'
  | 'duplicate-json-key'
  | 'unexpected-answer-shape'
  | 'invalid-code-fence'
  | 'missing-move'
  | 'move-not-coordinate'
  | 'missing-promotion'
  | 'ambiguous-answer'
  | 'invalid-plan'
  | 'invalid-resign-flag';

export interface ReplyAttribution {
  readonly protocol: ProviderProtocol;
  readonly content: ProtocolContent;
  readonly channel: 'answer' | 'refusal';
  readonly text: string;
  readonly answerText: string;
  readonly refusalText: string;
  readonly protocolResult: ProtocolStreamResult;
}

interface ClassifiedReplyBase {
  readonly version: 1;
  readonly source: ReplyAttribution;
}

export interface MoveProposal extends ClassifiedReplyBase {
  readonly kind: 'move-proposal';
  readonly move: CoordinateMove;
  readonly notation: ReplyNotation;
}

export interface ModelResignation extends ClassifiedReplyBase {
  readonly kind: 'resignation';
  readonly reason: 'protocol-refusal' | 'json-resign' | 'final-refusal';
}

export interface FormatRejection extends ClassifiedReplyBase {
  readonly kind: 'format-rejection';
  readonly category: FormatRejectionCategory;
}

export interface ProtocolIneligibleReply extends ClassifiedReplyBase {
  readonly kind: 'protocol-ineligible';
  readonly cause: 'not-complete' | 'http-error' | 'protocol-error' | 'content-not-actionable';
}

export type CompletedReplyClassification =
  | MoveProposal
  | ModelResignation
  | FormatRejection
  | ProtocolIneligibleReply;

interface CandidateMove {
  readonly from: Square;
  readonly to: Square;
  readonly promotion?: Promotion;
}

type CandidateResult =
  | { readonly kind: 'move'; readonly move: CandidateMove }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ambiguous' };

interface UnwrappedAnswer {
  readonly text: string;
  readonly fenced: boolean;
}

function attribution(
  result: ProtocolStreamResult,
  channel: ReplyAttribution['channel'],
  text: string,
): ReplyAttribution {
  return {
    protocol: result.protocol,
    content: result.content,
    channel,
    text,
    answerText: result.answerText,
    refusalText: result.refusalText,
    protocolResult: result,
  };
}

function formatRejection(source: ReplyAttribution, category: FormatRejectionCategory): FormatRejection {
  return { version: 1, kind: 'format-rejection', category, source };
}

function ineligible(
  source: ReplyAttribution,
  cause: ProtocolIneligibleReply['cause'],
): ProtocolIneligibleReply {
  return { version: 1, kind: 'protocol-ineligible', cause, source };
}

function resultForMove(
  source: ReplyAttribution,
  text: string,
  position: Position,
  notation: ReplyNotation,
): CompletedReplyClassification {
  const candidate = parseCoordinateCandidate(text);
  if (candidate.kind === 'ambiguous') return formatRejection(source, 'ambiguous-answer');
  if (candidate.kind === 'invalid') return formatRejection(source, 'move-not-coordinate');

  if (candidate.move.promotion === undefined && coordinateNeedsPromotion(position, candidate.move)) {
    return formatRejection(source, 'missing-promotion');
  }

  return {
    version: 1,
    kind: 'move-proposal',
    move: candidate.move,
    notation,
    source,
  };
}

function coordinateNeedsPromotion(position: Position, move: CandidateMove): boolean {
  const movingPiece = position.pieces.find((piece) => piece.square === move.from);
  if (movingPiece === undefined || movingPiece.color !== position.sideToMove || movingPiece.type !== 'p') {
    return false;
  }

  const isWhite = position.sideToMove === 'w';
  const startingRank = isWhite ? '7' : '2';
  const promotionRank = isWhite ? '8' : '1';
  if (move.from[1] !== startingRank || move.to[1] !== promotionRank) return false;

  const fileDistance = Math.abs(move.from.charCodeAt(0) - move.to.charCodeAt(0));
  const destinationPiece = position.pieces.find((piece) => piece.square === move.to);
  if (fileDistance === 0) return destinationPiece === undefined;
  return (
    fileDistance === 1 &&
    destinationPiece !== undefined &&
    destinationPiece.color !== position.sideToMove &&
    destinationPiece.type !== 'k'
  );
}

function hasDuplicateObjectKeys(json: string): boolean {
  let cursor = 0;

  function skipWhitespace(): void {
    while (/\s/.test(json[cursor] ?? '')) cursor += 1;
  }

  function readString(): string {
    const start = cursor;
    cursor += 1;
    while (cursor < json.length) {
      const character = json[cursor];
      if (character === '\\') {
        cursor += 2;
      } else if (character === '"') {
        cursor += 1;
        return JSON.parse(json.slice(start, cursor)) as string;
      } else {
        cursor += 1;
      }
    }
    return '';
  }

  function readValue(): boolean {
    skipWhitespace();
    const character = json[cursor];

    if (character === '{') {
      cursor += 1;
      skipWhitespace();
      if (json[cursor] === '}') {
        cursor += 1;
        return false;
      }

      const keys = new Set<string>();
      while (cursor < json.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) return true;
        keys.add(key);
        skipWhitespace();
        cursor += 1;
        if (readValue()) return true;
        skipWhitespace();
        if (json[cursor] === '}') {
          cursor += 1;
          return false;
        }
        cursor += 1;
      }
      return false;
    }

    if (character === '[') {
      cursor += 1;
      skipWhitespace();
      if (json[cursor] === ']') {
        cursor += 1;
        return false;
      }
      while (cursor < json.length) {
        if (readValue()) return true;
        skipWhitespace();
        if (json[cursor] === ']') {
          cursor += 1;
          return false;
        }
        cursor += 1;
      }
      return false;
    }

    if (character === '"') {
      readString();
      return false;
    }

    while (cursor < json.length && !/[\s,}\]]/.test(json[cursor] ?? '')) cursor += 1;
    return false;
  }

  return readValue();
}

function unwrapCodeFence(answerText: string): UnwrappedAnswer | null {
  const trimmed = answerText.trim();
  if (!trimmed.startsWith('```')) return { text: trimmed, fenced: false };

  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (match?.[1] === undefined || trimmed.indexOf('```', 3) !== trimmed.lastIndexOf('```')) {
    return null;
  }
  return { text: match[1].trim(), fenced: true };
}

function parseCoordinateCandidate(rawText: string): CandidateResult {
  let candidate = rawText.trim().replace(/^[.,;:!?]+|[.,;:!?]+$/g, '');

  if (candidate.startsWith('(') || candidate.endsWith(')')) {
    if (!(candidate.startsWith('(') && candidate.endsWith(')') && candidate.length >= 2)) {
      return { kind: 'invalid' };
    }
    candidate = candidate.slice(1, -1).trim();
  }

  if (candidate.startsWith('`') || candidate.endsWith('`')) {
    if (!(candidate.startsWith('`') && candidate.endsWith('`') && candidate.length >= 2)) {
      return { kind: 'invalid' };
    }
    candidate = candidate.slice(1, -1).trim();
    if (candidate.includes('`')) return { kind: 'invalid' };
  } else if (candidate.startsWith('**') || candidate.endsWith('**')) {
    if (!(candidate.startsWith('**') && candidate.endsWith('**') && candidate.length >= 4)) {
      return { kind: 'invalid' };
    }
    candidate = candidate.slice(2, -2).trim();
  }

  candidate = candidate.replace(/^[.,;:!?]+|[.,;:!?]+$/g, '');
  candidate = candidate.replace(/\s+/g, '').toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(candidate)) {
    return coordinateTokenCount(rawText) > 1 ? { kind: 'ambiguous' } : { kind: 'invalid' };
  }

  return {
    kind: 'move',
    move: {
      from: candidate.slice(0, 2) as Square,
      to: candidate.slice(2, 4) as Square,
      ...(candidate.length === 5 ? { promotion: candidate[4] as Promotion } : {}),
    },
  };
}

function coordinateTokenCount(text: string): number {
  const coordinates = /[a-h][1-8]\s*[a-h][1-8](?:\s*[qrbn])?/gi;
  let count = 0;
  while (coordinates.exec(text) !== null) {
    count += 1;
    if (count > 1) return count;
  }
  return count;
}

function explicitRefusal(line: string): boolean {
  const text = line.trim().replace(/^[ \t]*(?:final[ \t]+(?:answer|decision)[ \t]*:[ \t]*)/i, '');
  const resignation = /^(?:i\s+)?resign(?:\s+(?:(?:from\s+)?(?:the|this)\s+)?(?:game|match))?[.!?]*$/i;
  const refusalToMove = /^(?:i\s+)?(?:(?:refuse|decline)\s+to|(?:will\s+not|cannot|can't|won't))\s+(?:(?:make|provide|choose)\s+)?(?:a\s+)?move[.!?]*$/i;
  return resignation.test(text) || refusalToMove.test(text);
}

function lineIsStandaloneCoordinate(line: string): boolean {
  return parseCoordinateCandidate(line).kind === 'move';
}

function isSingleLineAnswer(answer: UnwrappedAnswer): boolean {
  const boundaryTrimmedText = answer.text.trim();
  return !/[\r\n]/.test(boundaryTrimmedText);
}

function parseFallback(
  source: ReplyAttribution,
  answer: UnwrappedAnswer,
  position: Position,
): CompletedReplyClassification {
  const lines = answer.text.split(/\r?\n/);
  const finalMoveLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^[ \t]*final[ \t]+move[ \t]*[:=]/i.test(line));
  const refusalLines = lines.filter(explicitRefusal);

  if (finalMoveLines.length > 1) return formatRejection(source, 'ambiguous-answer');

  if (refusalLines.length > 0) {
    if (finalMoveLines.length > 0 || lines.some(lineIsStandaloneCoordinate)) {
      return formatRejection(source, 'ambiguous-answer');
    }
    // A refusal line in a multiline answer may be historical or quoted, so require a whole-answer match.
    if (isSingleLineAnswer(answer) && explicitRefusal(answer.text)) {
      return { version: 1, kind: 'resignation', reason: 'final-refusal', source };
    }
    return formatRejection(source, 'ambiguous-answer');
  }

  if (finalMoveLines.length === 1) {
    const finalLine = finalMoveLines[0];
    if (finalLine === undefined) return formatRejection(source, 'missing-move');
    const lineCandidate = finalLine.line.replace(/^[ \t]*final[ \t]+move[ \t]*[:=][ \t]*/i, '');
    if (lines.some((line, index) => index !== finalLine.index && lineIsStandaloneCoordinate(line))) {
      return formatRejection(source, 'ambiguous-answer');
    }
    if (explicitRefusal(lineCandidate)) {
      if (!isSingleLineAnswer(answer)) return formatRejection(source, 'ambiguous-answer');
      return { version: 1, kind: 'resignation', reason: 'final-refusal', source };
    }
    return resultForMove(source, lineCandidate, position, 'final-move-line');
  }

  const standalone = parseCoordinateCandidate(answer.text);
  if (standalone.kind === 'ambiguous') return formatRejection(source, 'ambiguous-answer');
  if (standalone.kind === 'move') {
    return resultForMove(
      source,
      answer.text,
      position,
      answer.fenced ? 'fenced-coordinate' : 'standalone-coordinate',
    );
  }

  if (coordinateTokenCount(answer.text) > 1) return formatRejection(source, 'ambiguous-answer');
  return formatRejection(source, 'missing-move');
}

function parseJsonAnswer(
  source: ReplyAttribution,
  jsonText: string,
  position: Position,
  fenced: boolean,
): CompletedReplyClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return formatRejection(source, 'invalid-json');
  }

  try {
    if (hasDuplicateObjectKeys(jsonText)) return formatRejection(source, 'duplicate-json-key');
  } catch {
    return formatRejection(source, 'unexpected-answer-shape');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return formatRejection(source, 'unexpected-answer-shape');
  }

  const object = parsed as Record<string, unknown>;
  const hasMove = Object.prototype.hasOwnProperty.call(object, 'move');
  const hasResign = Object.prototype.hasOwnProperty.call(object, 'resign');
  if (hasResign && object.resign !== true && object.resign !== false) {
    return formatRejection(source, 'invalid-resign-flag');
  }
  if (object.resign === true) {
    if (hasMove) return formatRejection(source, 'ambiguous-answer');
    return { version: 1, kind: 'resignation', reason: 'json-resign', source };
  }
  if (Object.prototype.hasOwnProperty.call(object, 'plan') && typeof object.plan !== 'string') {
    return formatRejection(source, 'invalid-plan');
  }
  if (!hasMove) return formatRejection(source, 'missing-move');
  if (typeof object.move !== 'string') return formatRejection(source, 'move-not-coordinate');

  return resultForMove(
    source,
    object.move,
    position,
    fenced ? 'fenced-coordinate-json' : 'coordinate-json',
  );
}

/**
 * Classifies only the public protocol result's completed answer or refusal channel.
 * `position` is used to detect a missing pawn-promotion suffix; this function never validates or applies a move.
 */
export function classifyCompletedReply(
  result: ProtocolStreamResult,
  position: Position,
): CompletedReplyClassification {
  const answerSource = result.content === 'refusal'
    ? attribution(result, 'refusal', result.refusalText)
    : attribution(result, 'answer', result.answerText);

  if (result.terminal !== 'complete') return ineligible(answerSource, 'not-complete');
  if (
    result.httpStatus !== undefined &&
    (!Number.isInteger(result.httpStatus) || result.httpStatus < 200 || result.httpStatus >= 300)
  ) {
    return ineligible(answerSource, 'http-error');
  }
  if (result.errors.length > 0 || result.incompleteDetails.length > 0 || result.toolRecords.length > 0) {
    return ineligible(answerSource, 'protocol-error');
  }
  if (result.content === 'refusal') {
    if (result.refusalText.trim().length === 0) return ineligible(answerSource, 'content-not-actionable');
    return {
      version: 1,
      kind: 'resignation',
      reason: 'protocol-refusal',
      source: answerSource,
    };
  }
  if (result.content !== 'answer') return ineligible(answerSource, 'content-not-actionable');

  const unwrapped = unwrapCodeFence(result.answerText);
  if (unwrapped === null) return formatRejection(answerSource, 'invalid-code-fence');
  if (unwrapped.text.startsWith('{')) {
    return parseJsonAnswer(answerSource, unwrapped.text, position, unwrapped.fenced);
  }
  if (unwrapped.text.startsWith('[')) return formatRejection(answerSource, 'unexpected-answer-shape');
  return parseFallback(answerSource, unwrapped, position);
}
