import type { CoordinateMove, Position, Promotion, Square } from '../rules/index.js';
import { ConflictingDuplicateKeyError, parseStrictJsonObject } from './json.js';
import { detectExplicitRefusal, mentionsCoordinate, mentionsRefusal } from './refusal.js';
import type {
  CompletedAnswer,
  DeclarationOrigin,
  FormatFailureReason,
  ReplyClassification,
  ResignationDeclaration,
  RetainedFieldV1,
} from './types.js';

const COORDINATE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const ACTION_KEYS: ReadonlySet<string> = new Set(['move', 'resign']);

/** Removes at most one Markdown code fence, keeping any other fence marker visible. */
function unwrapSingleFence(text: string): string {
  const trimmed = text.trim();
  const withoutOpening = trimmed.replace(/^```[^\n`]*\n?/, '');
  return withoutOpening.replace(/```[^\n`]*$/, '').trim();
}

function retainedFieldsOf(value: Record<string, unknown>): readonly RetainedFieldV1[] {
  return Object.entries(value)
    .filter(([key]) => !ACTION_KEYS.has(key) && key !== 'plan')
    .map(([key, entry]) => ({ key, value: entry }));
}

function isSquare(value: string): value is Square {
  return /^[a-h][1-8]$/.test(value);
}

function isPromotion(value: string): value is Promotion {
  return value === 'q' || value === 'r' || value === 'b' || value === 'n';
}

/**
 * Normalizes one coordinate token: surrounding and internal whitespace removed, letter
 * case folded. It never adds a promotion piece and never reorders or completes squares.
 */
export function normalizeCoordinateToken(raw: string): string {
  return raw.replace(/\s+/g, '').toLowerCase();
}

function toCoordinateMove(text: string): CoordinateMove | null {
  if (!COORDINATE_PATTERN.test(text)) return null;
  const from = text.slice(0, 2);
  const to = text.slice(2, 4);
  const suffix = text.slice(4);
  if (!isSquare(from) || !isSquare(to)) return null;
  return suffix === ''
    ? { from, to }
    : isPromotion(suffix)
      ? { from, to, promotion: suffix }
      : null;
}

/**
 * Reports whether the position makes the promotion piece part of the command itself.
 *
 * Only the application's own board is inspected. The legal-move list behind this answer is
 * never exposed to a model, and no piece is ever chosen on the model's behalf.
 */
export function requiresExplicitPromotion(position: Position, move: CoordinateMove): boolean {
  if (move.promotion !== undefined) return false;
  const piece = position.pieces.find((candidate) => candidate.square === move.from);
  if (piece === undefined || piece.type !== 'p' || piece.color !== position.sideToMove) return false;
  const targetRank = position.sideToMove === 'w' ? '8' : '1';
  return move.to[1] === targetRank;
}

interface MoveRead {
  readonly move: CoordinateMove;
  readonly text: string;
}

const COORDINATE_DECORATION = /^(?:[*_`"'(\s])+|(?:[*_`"')!\s])+$/g;

function stripCoordinateDecoration(text: string): string {
  return text.replace(COORDINATE_DECORATION, '').replace(/[.!]+$/, '');
}

function readCoordinate(text: string): MoveRead | 'unreadable' {
  const normalized = normalizeCoordinateToken(stripCoordinateDecoration(text));
  const move = toCoordinateMove(normalized);
  return move === null ? 'unreadable' : { move, text: normalized };
}

function formatFailure(reason: FormatFailureReason, fragment: string): ReplyClassification {
  return { kind: 'format-failure', reason, fragment, retainedFields: [] };
}

function moveReadOutcome(
  read: MoveRead,
  origin: DeclarationOrigin,
  position: Position | undefined,
  retainedFields: readonly RetainedFieldV1[],
  plan: string | undefined,
): ReplyClassification {
  if (position !== undefined && requiresExplicitPromotion(position, read.move)) {
    return {
      kind: 'format-failure',
      reason: 'missing-promotion',
      fragment: read.text,
      retainedFields,
    };
  }
  return { kind: 'move', move: read.move, text: read.text, origin, retainedFields, ...(plan === undefined ? {} : { plan }) };
}

/** Every explicit final `Move:` line, in reply order, with its raw coordinate token. */
function explicitMoveLines(text: string): readonly string[] {
  const tokens: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[*_#>`\s-]*move\s*:\s*[*_`"']?\s*(.*?)\s*[*_`"']?\s*[.!]?\s*$/i.exec(line);
    if (match === null) continue;
    const value = (match[1] ?? '').trim();
    if (value !== '') tokens.push(value);
  }
  return tokens;
}

/** Every line that holds nothing but one coordinate, which is a standalone command. */
function standaloneCoordinateLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => COORDINATE_PATTERN.test(normalizeCoordinateToken(stripCoordinateDecoration(line))));
}

function classifyJsonObject(
  value: Record<string, unknown>,
  position: Position | undefined,
): ReplyClassification | null {
  const hasMove = Object.prototype.hasOwnProperty.call(value, 'move');
  const hasResignation = Object.prototype.hasOwnProperty.call(value, 'resign');
  if (!hasMove && !hasResignation) return null;

  const retainedFields = retainedFieldsOf(value);
  const plan = typeof value.plan === 'string' ? value.plan : undefined;
  const resigns = hasResignation && value.resign === true;
  const declaresResignation = hasResignation && value.resign !== false;

  if (declaresResignation && hasMove) {
    return { kind: 'format-failure', reason: 'move-and-resignation', fragment: '', retainedFields };
  }
  if (resigns) {
    const declaration: ResignationDeclaration = {
      kind: 'resignation',
      origin: 'json-resignation',
      statement: 'resign: true',
      retainedFields,
      ...(plan === undefined ? {} : { plan }),
    };
    return declaration;
  }
  if (!hasMove) return formatFailure('no-action', '');
  const raw = value.move;
  if (typeof raw !== 'string') {
    return {
      kind: 'format-failure',
      reason: 'unreadable-move',
      fragment: typeof raw,
      retainedFields,
    };
  }
  const read = readCoordinate(raw);
  if (read === 'unreadable') {
    return { kind: 'format-failure', reason: 'unreadable-move', fragment: raw, retainedFields };
  }
  return moveReadOutcome(read, 'json-move', position, retainedFields, plan);
}

/**
 * Classifies one completed choice-zero answer exactly once.
 *
 * The parser never reads reasoning, plans, other choices or retained history, never
 * repairs JSON, and never chooses a move for the model. Every unreadable, ambiguous or
 * missing-promotion answer is a formatting failure that asks for clarification.
 */
export function classifyCompletedAnswer(answer: CompletedAnswer): ReplyClassification {
  const unwrapped = unwrapSingleFence(answer.answerText);
  if (unwrapped === '') return formatFailure('no-action', '');
  if (unwrapped.includes('```')) {
    return { kind: 'format-failure', reason: 'unreadable-move', fragment: '```', retainedFields: [] };
  }

  let jsonClassification: ReplyClassification | null = null;
  try {
    const parsed = parseStrictJsonObject(unwrapped);
    jsonClassification = classifyJsonObject(parsed.value, answer.position);
  } catch (error) {
    if (error instanceof ConflictingDuplicateKeyError) {
      return { kind: 'format-failure', reason: 'conflicting-duplicate-keys', fragment: error.key, retainedFields: [] };
    }
  }
  if (jsonClassification !== null && jsonClassification.kind !== 'format-failure') {
    return jsonClassification;
  }

  const refusal = detectExplicitRefusal(unwrapped);
  const moveLines = explicitMoveLines(unwrapped);
  const standaloneLines = standaloneCoordinateLines(unwrapped);
  const reads: readonly (MoveRead | 'unreadable')[] = [
    ...moveLines.map((token) => readCoordinate(token)),
    ...standaloneLines.map((line) => readCoordinate(line)),
    readCoordinate(unwrapped),
  ];
  const readable = reads.filter((read): read is MoveRead => read !== 'unreadable');
  const distinct = new Set(readable.map((read) => read.text));

  if (readable.length > 0 && distinct.size > 1) {
    return { kind: 'format-failure', reason: 'competing-answers', fragment: [...distinct].join(' '), retainedFields: [] };
  }
  if (refusal.kind === 'refusal') {
    if (readable.length > 0) {
      return { kind: 'format-failure', reason: 'competing-answers', fragment: refusal.statement, retainedFields: [] };
    }
    return { kind: 'resignation', origin: 'explicit-refusal', statement: refusal.statement, retainedFields: [] };
  }
  if (jsonClassification !== null && jsonClassification.kind === 'format-failure') {
    if (jsonClassification.reason === 'move-and-resignation') return jsonClassification;
    if (readable.length === 0) return jsonClassification;
  }
  if (readable.length > 0) {
    if (mentionsRefusal(unwrapped)) {
      return { kind: 'format-failure', reason: 'competing-answers', fragment: unwrapped, retainedFields: [] };
    }
    return moveReadOutcome(
      readable[0] as MoveRead,
      moveLines.length > 0 ? 'fallback-final-move-line' : 'fallback-standalone',
      answer.position,
      [],
      undefined,
    );
  }
  if (moveLines.length > 0) {
    return { kind: 'format-failure', reason: 'unreadable-move', fragment: moveLines[moveLines.length - 1] as string, retainedFields: [] };
  }
  if (mentionsRefusal(unwrapped) && mentionsCoordinate(unwrapped)) {
    return { kind: 'format-failure', reason: 'competing-answers', fragment: unwrapped, retainedFields: [] };
  }
  return formatFailure('no-action', unwrapped);
}

export type { ReplyClassification };
