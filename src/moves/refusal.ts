/**
 * Explicit refusal detection for one completed answer.
 *
 * A refusal is a loss for the model opponent only when the model authored it as its own
 * final statement. Quoted, hypothetical, historical or attributed-to-someone-else text is
 * never a resignation, and neither is an HTTP error, filter event or missing response.
 * Those arrive as protocol outcomes, not as answer text, and never reach this module.
 */

export type RefusalRejection =
  | 'quoted'
  | 'hypothetical'
  | 'attributed'
  | 'historical'
  | 'not-final'
  | 'unrecognized';

export type RefusalDetection =
  | { readonly kind: 'refusal'; readonly statement: string }
  | { readonly kind: 'not-refusal'; readonly reason: RefusalRejection };

/** Declarations that only hold when the model itself gives up the game. */
const RESIGNATION_PATTERNS: readonly RegExp[] = [
  /^i\s+resign\b/i,
  /^(i\s+)?resign(ing|ation)?\b[.!]?$/i,
  /^(hereby\s+)?i\s+resign\b/i,
  /^i\s+forfeit\b/i,
  /^i\s+concede\b/i,
  /^resign(ing)?\b[,.]?\s+(the\s+)?(game|match)\b/i,
];

/** Explicit refusals to continue playing, which are a resignation in a timed match. */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bi\s+refuse\s+to\s+(make\s+|play\s+|choose\s+)?(a\s+)?move\b/i,
  /\bi\s+(will|am going to)\s+not\s+(make\s+|play\s+|choose\s+)?(a\s+)?move\b/i,
  /\bi\s+(choose|have chosen)\s+not\s+to\s+move\b/i,
  /\bi\s+decline\s+to\s+(move|play|make a move)\b/i,
  /\bi\s+give\s+up\b/i,
];

/** Markers that make a refusal statement about something other than this game. */
const HYPOTHETICAL_PATTERNS: readonly RegExp[] = [
  /\bif\s+(i|we)\b/i,
  /\bwhen\s+(i|we)\b/i,
  /\bwhenever\s+(i|we)\b/i,
  /\b(suppose|supposing|hypothetical\w*|imagine|in case)\b/i,
  /\bwould\s+(resign|refuse|give up)\b/i,
];

const ATTRIBUTED_PATTERNS: readonly RegExp[] = [
  /\byou\s+(resign|refuse|give up)\b/i,
  /\b(white|black|opponent|human|player)\s+(resign\w*|refuses?)\b/i,
];

const HISTORICAL_PATTERNS: readonly RegExp[] = [
  /\b(earlier|previously|history|historical|transcript|conversation|reply|answer|message)\b/i,
  /\b(for example|e\.g\.|such as|in this case|previously said)\b/i,
];

const QUOTE_PREFIX = /^[\s>"'“”‘’]/;
const DECORATION_PREFIX = /^[*_#>\-\s"'“”‘’`]+/;

function stripDecoration(line: string): string {
  return line.replace(DECORATION_PREFIX, '').replace(/[\s*_`]+$/, '');
}

/** Returns the final non-empty statement of an answer, or null when there is none. */
export function finalStatement(answerText: string): string | null {
  const lines = answerText.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = stripDecoration((lines[index] as string).trim());
    if (line !== '') return line;
  }
  return null;
}

function lastNonEmptyLine(answerText: string): string | null {
  const lines = answerText.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trim();
    if (line !== '') return line;
  }
  return null;
}

function matchesAny(patterns: readonly RegExp[], statement: string): boolean {
  return patterns.some((pattern) => pattern.test(statement));
}

/**
 * Classifies the final statement of one completed answer as a model resignation or not.
 * The returned statement is the exact accepted text, kept for the match conversation.
 */
export function detectExplicitRefusal(answerText: string): RefusalDetection {
  const rawLine = lastNonEmptyLine(answerText);
  if (rawLine === null) return { kind: 'not-refusal', reason: 'not-final' };
  if (QUOTE_PREFIX.test(rawLine)) return { kind: 'not-refusal', reason: 'quoted' };
  const statement = stripDecoration(rawLine);
  if (statement === '') return { kind: 'not-refusal', reason: 'not-final' };
  if (matchesAny(RESIGNATION_PATTERNS, statement) || matchesAny(REFUSAL_PATTERNS, statement)) {
    if (matchesAny(HISTORICAL_PATTERNS, statement)) return { kind: 'not-refusal', reason: 'historical' };
    if (matchesAny(ATTRIBUTED_PATTERNS, statement)) return { kind: 'not-refusal', reason: 'attributed' };
    if (matchesAny(HYPOTHETICAL_PATTERNS, statement)) return { kind: 'not-refusal', reason: 'hypothetical' };
    return { kind: 'refusal', statement };
  }
  return { kind: 'not-refusal', reason: 'unrecognized' };
}

/**
 * Reports whether an answer mentions giving up anywhere, not only in its final statement.
 * A mention next to any coordinate means the reply needs clarification rather than a guess.
 */
export function mentionsRefusal(answerText: string): boolean {
  return /\b(resign\w*|resignation|refuse\w*|refusal|give up|forfeit\w*|concede\w*)\b/i.test(answerText);
}

/** Reports whether an answer mentions any coordinate-looking token. */
export function mentionsCoordinate(answerText: string): boolean {
  return /(^|[^a-h0-9])[a-h][1-8][a-h][1-8][qrbn]?([^a-h0-9]|$)/i.test(answerText);
}