import { createChessPosition } from './chess-adapter.js';
import { parsePosition } from './position.js';
import { REPETITION_LEDGER_BRAND, type Position } from './types.js';

export interface RepetitionOccurrence {
  readonly identity: string;
  readonly occurrences: string;
}

export interface RepetitionLedger {
  readonly [REPETITION_LEDGER_BRAND]: true;
  readonly version: 1;
  readonly entries: readonly RepetitionOccurrence[];
}

export class RepetitionLedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepetitionLedgerValidationError';
  }
}

function freezeLedger(entries: readonly RepetitionOccurrence[]): RepetitionLedger {
  const sortedEntries = [...entries]
    .sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0))
    .map((entry) => Object.freeze({ identity: entry.identity, occurrences: entry.occurrences }));
  return Object.freeze({
    [REPETITION_LEDGER_BRAND]: true as const,
    version: 1 as const,
    entries: Object.freeze(sortedEntries),
  });
}

export function repetitionIdentity(position: Position): string {
  const engine = createChessPosition(position);
  const context = engine.ctx();
  const hasLegalEnPassant = engine.epSquare !== undefined && [...engine.board.pieces(engine.turn, 'pawn')]
    .some(square => engine.dests(square, context).has(engine.epSquare!));
  return [
    position.placement,
    position.sideToMove,
    position.castlingRights,
    hasLegalEnPassant ? position.enPassantSquare ?? '-' : '-',
  ].join(' ');
}

export function createRepetitionLedger(position: Position): RepetitionLedger {
  return recordPosition(freezeLedger([]), position);
}

export function recordPosition(ledger: RepetitionLedger, position: Position): RepetitionLedger {
  const identity = repetitionIdentity(position);
  const occurrences = new Map(ledger.entries.map((entry) => [entry.identity, entry.occurrences]));
  const prior = occurrences.get(identity) ?? '0';
  occurrences.set(identity, (BigInt(prior) + 1n).toString());
  return freezeLedger([...occurrences].map(([key, count]) => ({ identity: key, occurrences: count })));
}

export function repetitionCount(ledger: RepetitionLedger, position: Position): string {
  const identity = repetitionIdentity(position);
  return ledger.entries.find((entry) => entry.identity === identity)?.occurrences ?? '0';
}

function positionForIdentity(identity: string): Position {
  const fields = identity.split(' ');
  if (fields.length !== 4 || fields.some((field) => field.length === 0)) {
    throw new RepetitionLedgerValidationError('Ledger identity must contain placement, turn, rights, and en-passant fields.');
  }
  const placement = fields[0];
  const turn = fields[1];
  const rights = fields[2];
  const enPassant = fields[3];
  if (placement === undefined || turn === undefined || rights === undefined || enPassant === undefined) {
    throw new RepetitionLedgerValidationError('Ledger identity is missing a position field.');
  }

  const fullmove = turn === 'w' && enPassant !== '-' ? '2' : '1';
  const position = parsePosition(`${placement} ${turn} ${rights} ${enPassant} 0 ${fullmove}`);
  if (repetitionIdentity(position) !== identity) {
    throw new RepetitionLedgerValidationError('Ledger identity is not canonical or includes unusable en passant.');
  }
  return position;
}

export function restoreRepetitionLedger(snapshot: unknown): RepetitionLedger {
  if (typeof snapshot !== 'object' || snapshot === null) {
    throw new RepetitionLedgerValidationError('Ledger snapshot must be an object.');
  }
  const value = snapshot as { version?: unknown; entries?: unknown };
  if (value.version !== 1 || !Array.isArray(value.entries)) {
    throw new RepetitionLedgerValidationError('Ledger snapshot has an unsupported version or entries field.');
  }

  const entries: RepetitionOccurrence[] = [];
  const seen = new Set<string>();
  for (const item of value.entries) {
    if (typeof item !== 'object' || item === null) {
      throw new RepetitionLedgerValidationError('Ledger entries must be objects.');
    }
    const entry = item as { identity?: unknown; occurrences?: unknown };
    if (
      typeof entry.identity !== 'string' ||
      typeof entry.occurrences !== 'string' ||
      !/^[1-9]\d*$/.test(entry.occurrences)
    ) {
      throw new RepetitionLedgerValidationError('Each ledger entry needs a canonical identity and positive decimal occurrence count.');
    }
    if (seen.has(entry.identity)) {
      throw new RepetitionLedgerValidationError('Ledger identities cannot repeat as separate entries.');
    }
    positionForIdentity(entry.identity);
    seen.add(entry.identity);
    entries.push({ identity: entry.identity, occurrences: entry.occurrences });
  }

  return freezeLedger(entries);
}
