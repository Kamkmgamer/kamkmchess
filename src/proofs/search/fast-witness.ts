import { Chess, type Move, type Square } from 'chess.js';
import {
  parsePosition,
  type Color,
  type CoordinateMove,
  type Position,
} from '../../rules/index.js';
import {
  checkProofEvidence,
  proofQueryIdentity,
  PROOF_CHECKER_VERSION,
  PROOF_SCHEMA_VERSION,
  RULES_ADAPTER_VERSION,
  type ProofEvidence,
  type ProofQuery,
} from '../index.js';
import type { ProofSearchPassResult } from './types.js';

const FAST_MAX_DEPTH = 12;
const FAST_BEAM_WIDTH = 16;
const FAST_MAX_NODES = 80_000;
const FAST_TIME_BUDGET_MS = 3_000;

interface Candidate {
  readonly chess: Chess;
  readonly moves: readonly CoordinateMove[];
  readonly score: number;
  readonly attacker: Color;
  readonly rootMove: string;
  readonly tacticalBand: string;
}

export type FastMatingWitnessResult = Extract<ProofSearchPassResult, { readonly status: 'accepted' }>;

function now(): number {
  // Date.now is deliberately independent from test/application performance
  // instrumentation so a frozen profiling clock cannot disable this bound.
  return Date.now();
}

function intendedColors(query: ProofQuery): readonly Color[] {
  if (query.predicate === 'cooperative-mating-reachability') return [query.intendedColor];
  if (query.predicate === 'timeout-opponent-mating') return [query.expiredColor === 'w' ? 'b' : 'w'];
  return ['w', 'b'];
}

function isTargetMate(query: ProofQuery, chess: Chess): Color | null {
  if (!chess.isCheck()) return null;
  if (!chess.isCheckmate()) return null;
  const deliveredBy: Color = chess.turn() === 'w' ? 'b' : 'w';
  return intendedColors(query).includes(deliveredBy) ? deliveredBy : null;
}

function evidence(query: ProofQuery, color: Color, moves: readonly CoordinateMove[]): ProofEvidence {
  return Object.freeze({
    schemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    kind: 'mate-witness',
    queryIdentity: query.queryIdentity,
    intendedColor: color,
    moves: Object.freeze(moves.map((move) => Object.freeze({ ...move }))),
  });
}

function acceptedResult(query: ProofQuery, color: Color, moves: readonly CoordinateMove[]): FastMatingWitnessResult | null {
  const proof = evidence(query, color, moves);
  const checked = checkProofEvidence(query, proof);
  if (checked.status !== 'accepted') return null;
  return {
    status: 'accepted',
    conclusion: checked.conclusion,
    queryIdentity: query.queryIdentity,
    evidence: proof,
    checkpointDisposition: 'fresh',
    pass: {
      maxDiscoveredStates: FAST_MAX_NODES,
      timeBudgetMs: FAST_TIME_BUDGET_MS,
      discoveredStateCount: 0,
      processedEdgeCount: moves.length,
      expandedStateCount: 0,
      totalDiscoveredStateCount: 0,
      totalDiscoveredEdgeCount: 0,
      elapsedMs: 0,
    },
  };
}

function parseMoves(uci: readonly string[]): CoordinateMove[] {
  return uci.map((text) => ({
    from: text.slice(0, 2) as CoordinateMove['from'],
    to: text.slice(2, 4) as CoordinateMove['to'],
    ...(text.length === 5 ? { promotion: text[4] as NonNullable<CoordinateMove['promotion']> } : {}),
  }));
}

// Short cooperative opening mates are cheap checked seeds. Each path is only a
// proposal: it must be legal from the current position and pass the checker.
const OPENING_LINES = [
  ['f2f3', 'e7e5', 'g2g4', 'd8h4'],
  ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'],
] as const;

// Checked witnesses found from representative positions in common openings.
// Prefixes let the same proof line help both the exact root position and later
// positions along the line. None is tied to a FEN; seedWitness replays moves.
const CHECKED_MOTIF_LINES = [
  ['e2e4', 'e7e5', 'g1f3', 'd8g5', 'e1e2', 'g5f4', 'f3e1', 'f4e4'],
  ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'a8b8', 'c4f7', 'e8e7', 'f3e5', 'd7d6', 'e5g6', 'e7d7', 'd1g4'],
  ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'c1g5', 'd8a5', 'e1e2', 'a5d2', 'e2f3', 'd2d1', 'f3g3', 'd1g4'],
  ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'd1a4', 'e8e7', 'a4d7', 'e7f6', 'd7d8', 'f6f5', 'd8f6', 'f5g4', 'f6g5'],
  ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'd2d3', 'f8b4', 'e1e2', 'c6d4', 'e2e3', 'f6g4'],
] as const;

// Every suffix can seed a search from a position reached partway through a
// known line. Duplicate suffixes are removed to keep this first pass cheap.
const OPENING_SEEDS = [...OPENING_LINES, ...CHECKED_MOTIF_LINES]
  .flatMap((line) => line.map((_, index) => line.slice(index)))
  .filter((seed, index, seeds) => seeds.findIndex((candidate) => candidate.join(' ') === seed.join(' ')) === index)
  .sort((left, right) => left.length - right.length);

function seedWitness(query: ProofQuery, root: Position): FastMatingWitnessResult | null {
  for (const seed of OPENING_SEEDS) {
    let chess: Chess;
    try { chess = new Chess(root.fen); } catch { continue; }
    const path: CoordinateMove[] = [];
    try {
      for (const uci of seed) {
        const move = parseMoves([uci])[0];
        if (!move) break;
        const played = chess.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
        path.push(coordinateMove(played));
        const color = isTargetMate(query, chess);
        if (color) return acceptedResult(query, color, path);
      }
    } catch { /* A seed only proposes a line; legal transition rules decide. */ }
  }
  return null;
}

function coordinateMove(move: Move): CoordinateMove {
  return {
    from: move.from as CoordinateMove['from'],
    to: move.to as CoordinateMove['to'],
    ...(move.promotion === undefined ? {} : { promotion: move.promotion as NonNullable<CoordinateMove['promotion']> }),
  };
}

function squareDistance(a: string, b: string): number {
  return Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])));
}

function squareOf(file: number, rank: number): Square {
  return `${String.fromCharCode(97 + file)}${8 - rank}` as Square;
}

function attackPotential(chess: Chess, attacker: Color): number {
  const defender: Color = attacker === 'w' ? 'b' : 'w';
  const board = chess.board();
  let enemyKing: string | undefined;
  let friendlyKing: string | undefined;
  for (let rank = 0; rank < 8; rank += 1) for (let file = 0; file < 8; file += 1) {
    const piece = board[rank]?.[file];
    if (!piece) continue;
    const square = squareOf(file, rank);
    if (piece.type === 'k') {
      if (piece.color === defender) enemyKing = square;
      else friendlyKing = square;
    }
  }
  if (!enemyKing || !friendlyKing) return -100;
  const enemyFile = enemyKing.charCodeAt(0) - 'a'.charCodeAt(0);
  const enemyRank = Number(enemyKing[1]) - 1;
  const enemyEdgeDistance = Math.min(enemyFile, 7 - enemyFile, enemyRank, 7 - enemyRank);
  let potential = (4 - enemyEdgeDistance) * 2.5;
  potential += (7 - squareDistance(friendlyKing, enemyKing)) * 1.5;
  // Cooperative play can deliberately give the king fewer safe squares. Count
  // attacks around its neighborhood rather than relying on piece proximity.
  let kingZoneAttacks = 0;
  let safeKingEscapes = 0;
  const enemyKingFile = enemyKing.charCodeAt(0) - 'a'.charCodeAt(0);
  const enemyKingRank = Number(enemyKing[1]);
  for (let rankOffset = -1; rankOffset <= 1; rankOffset += 1) {
    for (let fileOffset = -1; fileOffset <= 1; fileOffset += 1) {
      if (rankOffset === 0 && fileOffset === 0) continue;
      const file = enemyKingFile + fileOffset;
      const rank = enemyKingRank + rankOffset;
      if (file < 0 || file > 7 || rank < 1 || rank > 8) continue;
      const square = squareOf(file, 8 - rank);
      const controlled = chess.isAttacked(square, attacker);
      if (controlled) kingZoneAttacks += 1;
      const occupant = board[8 - rank]?.[file];
      if (!controlled && occupant?.color !== defender) safeKingEscapes += 1;
    }
  }
  potential += kingZoneAttacks * 2.4;
  potential += (8 - safeKingEscapes) * 1.5;
  let strongest = 0;
  let secondStrongest = 0;
  for (let rank = 0; rank < 8; rank += 1) for (let file = 0; file < 8; file += 1) {
    const piece = board[rank]?.[file];
    if (!piece || piece.color !== attacker || piece.type === 'k') continue;
    const value = piece.type === 'q' ? 1.8 : piece.type === 'r' ? 1.5 : piece.type === 'b' || piece.type === 'n' ? 1.2 : 0.8;
    const pressure = (7 - squareDistance(squareOf(file, rank), enemyKing)) * value;
    if (pressure > strongest) { secondStrongest = strongest; strongest = pressure; }
    else if (pressure > secondStrongest) secondStrongest = pressure;
  }
  potential += strongest * 1.25 + secondStrongest * 0.35;
  const checker = chess.turn() === 'w' ? 'b' : 'w';
  if (chess.isCheck() && checker === attacker) potential += 24;
  return potential;
}

function makeCandidate(chess: Chess, moves: readonly CoordinateMove[], targetColors: readonly Color[]): Candidate {
  const scores = targetColors.map((color) => ({ color, score: attackPotential(chess, color) }));
  scores.sort((left, right) => right.score - left.score);
  const best = scores[0] ?? { color: 'w' as const, score: -100 };
  const kingSquare = chess.board().flat().findIndex((piece) => piece?.type === 'k' && piece.color !== best.color);
  const kingFile = kingSquare % 8;
  const kingRank = 8 - Math.floor(kingSquare / 8);
  let zoneAttacks = 0;
  if (kingSquare >= 0) {
    for (let rankOffset = -1; rankOffset <= 1; rankOffset += 1) {
      for (let fileOffset = -1; fileOffset <= 1; fileOffset += 1) {
        if (rankOffset === 0 && fileOffset === 0) continue;
        const file = kingFile + fileOffset;
        const rank = kingRank + rankOffset;
        if (file < 0 || file > 7 || rank < 1 || rank > 8) continue;
        if (chess.isAttacked(squareOf(file, 8 - rank), best.color)) zoneAttacks += 1;
      }
    }
  }
  const tacticalBand = `${chess.isCheck() ? 'check' : 'quiet'}:${Math.min(3, Math.floor(zoneAttacks / 2))}`;
  const first = moves[0];
  return {
    chess,
    moves,
    score: best.score,
    attacker: best.color,
    rootMove: first ? `${first.from}${first.to}${first.promotion ?? ''}` : 'root',
    tacticalBand,
  };
}

function selectBeam(candidates: Candidate[], targetColors: readonly Color[]): Candidate[] {
  candidates.sort((left, right) => right.score - left.score || left.moves.length - right.moves.length);
  const selected: Candidate[] = [];
  const selectedSet = new Set<Candidate>();
  const addDiverse = (pool: readonly Candidate[], limit: number) => {
    if (limit <= 0 || selected.length >= FAST_BEAM_WIDTH) return;
    const signatures = new Set<string>();
    for (const item of pool) {
      const signature = `${item.rootMove}/${item.tacticalBand}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      selected.push(item);
      selectedSet.add(item);
      if (signatures.size >= limit || selected.length >= FAST_BEAM_WIDTH) break;
    }
  };

  // Global deadness accepts either mating color. Reserve beam space for both
  // attackers so one easy pressure pattern cannot crowd out the other.
  const perAttacker = Math.max(1, Math.ceil(FAST_BEAM_WIDTH / targetColors.length));
  for (const attacker of targetColors) {
    addDiverse(candidates.filter((item) => item.attacker === attacker), perAttacker);
  }
  addDiverse(candidates.filter((item) => !selectedSet.has(item)), FAST_BEAM_WIDTH - selected.length);
  for (const item of candidates) {
    if (selected.length >= FAST_BEAM_WIDTH) break;
    if (!selectedSet.has(item)) selected.push(item);
  }
  return selected;
}

/**
 * Bounded positive-only witness discovery. `null` means only that this quick
 * pass found no checked witness; it says nothing about deadness or reachability.
 */
export async function tryFastMatingWitness(
  query: ProofQuery,
  options: { readonly timeBudgetMs?: number; readonly signal?: AbortSignal } = {},
): Promise<FastMatingWitnessResult | null> {
  if (query.queryIdentity !== proofQueryIdentity(query)) return null;
  let root: Position;
  try { root = parsePosition(query.positionFen); } catch { return null; }
  if (options.signal?.aborted) return null;
  let rootChess: Chess;
  try { rootChess = new Chess(root.fen); } catch { return null; }
  const startedAt = now();
  const timeBudgetMs = Math.min(FAST_TIME_BUDGET_MS, options.timeBudgetMs ?? FAST_TIME_BUDGET_MS);
  // Check every root move for mate before spending the heuristic budget.
  let rootMoves: readonly Move[];
  try { rootMoves = rootChess.moves({ verbose: true }); } catch { return null; }
  for (const proposed of rootMoves) {
    if (options.signal?.aborted) return null;
    if (now() - startedAt >= timeBudgetMs) return null;
    let move: Move;
    try { move = rootChess.move(proposed); } catch { continue; }
    const color = isTargetMate(query, rootChess);
    rootChess.undo();
    if (color) return acceptedResult(query, color, [coordinateMove(move)]);
  }

  const seed = seedWitness(query, root);
  if (seed) return seed;

  const colors = intendedColors(query);
  let beam: Candidate[] = [makeCandidate(rootChess, [], colors)];
  const rootFen = rootChess.fen();
  const visited = new Set<string>([rootFen.split(' ', 4).join(' ')]);
  let visitedCount = 0;
  for (let depth = 0; depth < FAST_MAX_DEPTH && visitedCount < FAST_MAX_NODES; depth += 1) {
    const next: Candidate[] = [];
    for (const candidate of beam) {
      for (const proposed of candidate.chess.moves({ verbose: true })) {
        if (++visitedCount > FAST_MAX_NODES || now() - startedAt >= timeBudgetMs || options.signal?.aborted) return null;
        let child: Chess;
        try { child = new Chess(candidate.chess.fen()); } catch { continue; }
        let move: Move;
        try { move = child.move(proposed); } catch { continue; }
        const path = [...candidate.moves, coordinateMove(move)];
        const color = isTargetMate(query, child);
        if (color) return acceptedResult(query, color, path);
        const key = `${child.fen().split(' ', 4).join(' ')}|${depth + 1}`;
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(makeCandidate(child, path, colors));
        if (visitedCount % 256 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (options.signal?.aborted || now() - startedAt >= timeBudgetMs) return null;
        }
      }
    }
    beam = selectBeam(next, colors);
    if (beam.length === 0) break;
    if ((depth & 1) === 1 && now() - startedAt < timeBudgetMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (options.signal?.aborted) return null;
    }
  }
  return null;
}
