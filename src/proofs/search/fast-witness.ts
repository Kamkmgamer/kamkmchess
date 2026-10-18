import { Chess } from 'chess.js';
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
import {
  makeSearchMove,
  searchAttacked,
  searchBoard,
  searchCoordinates,
  searchKing,
  searchMoves,
  undoSearchMove,
  type SearchMove,
} from './chess-search.js';

const FAST_MAX_DEPTH = 12;
const GREEDY_MAX_DEPTH = 24;
const FAST_BEAM_WIDTH = 16;
const FALLBACK_BEAM_WIDTH = 64;
const FAST_MAX_NODES = 80_000;
const FAST_TIME_BUDGET_MS = 3_000;
const YIELD_INTERVAL_MS = 8;

interface Candidate {
  readonly parentFen: string;
  readonly parent: Candidate | null;
  readonly lastMove: SearchMove | null;
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
  .sort((left, right) => left.length - right.length)
  .map(parseMoves);

function seedWitness(
  query: ProofQuery, chess: Chess, rootMoves: readonly SearchMove[], expired: () => boolean,
): FastMatingWitnessResult | null {
  const rootFen = chess.fen();
  const sameMove = (raw: SearchMove, move: CoordinateMove) => {
    const coordinates = searchCoordinates(raw);
    return coordinates.from === move.from && coordinates.to === move.to && coordinates.promotion === move.promotion;
  };
  for (const seed of OPENING_SEEDS) {
    if (expired()) return null;
    const first = seed[0];
    if (!first || !rootMoves.some((move) => sameMove(move, first))) continue;
    chess.load(rootFen, { skipValidation: true });
    const path: CoordinateMove[] = [];
    for (const move of seed) {
      if (expired()) return null;
      const proposed = searchMoves(chess).find((candidate) => sameMove(candidate, move));
      if (!proposed) break;
      makeSearchMove(chess, proposed);
      path.push(move);
      const color = isTargetMate(query, chess);
      if (color) {
        const accepted = acceptedResult(query, color, path);
        if (accepted) return accepted;
        break;
      }
    }
  }
  chess.load(rootFen, { skipValidation: true });
  return null;
}

function squareDistance(a: number, b: number): number {
  return Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 4) - (b >> 4)));
}

function attackPotential(chess: Chess, attacker: Color, inCheck: boolean): { score: number; zoneAttacks: number } {
  const defender: Color = attacker === 'w' ? 'b' : 'w';
  const board = searchBoard(chess);
  const enemyKing = searchKing(chess, defender);
  const friendlyKing = searchKing(chess, attacker);
  const enemyFile = enemyKing & 7;
  const enemyRank = enemyKing >> 4;
  const enemyEdgeDistance = Math.min(enemyFile, 7 - enemyFile, enemyRank, 7 - enemyRank);
  let potential = (4 - enemyEdgeDistance) * 2.5;
  potential += (7 - squareDistance(friendlyKing, enemyKing)) * 1.5;
  // Read the engine's numeric board without allocating piece/square snapshots
  // for every candidate. Preserve the original heuristic and beam diversity.
  let kingZoneAttacks = 0;
  let safeKingEscapes = 0;
  for (let rankOffset = -1; rankOffset <= 1; rankOffset += 1) {
    for (let fileOffset = -1; fileOffset <= 1; fileOffset += 1) {
      if (rankOffset === 0 && fileOffset === 0) continue;
      const square = enemyKing + rankOffset * 16 + fileOffset;
      if (square < 0 || (square & 0x88) !== 0) continue;
      const controlled = searchAttacked(chess, square, attacker);
      if (controlled) kingZoneAttacks += 1;
      if (!controlled && board[square]?.color !== defender) safeKingEscapes += 1;
    }
  }
  potential += kingZoneAttacks * 2.4;
  potential += (8 - safeKingEscapes) * 1.5;
  let strongest = 0;
  let secondStrongest = 0;
  for (let square = 0; square < 128; square += 1) {
    if ((square & 0x88) !== 0) { square += 7; continue; }
    const piece = board[square];
    if (!piece || piece.color !== attacker || piece.type === 'k') continue;
    const value = piece.type === 'q' ? 1.8 : piece.type === 'r' ? 1.5 : piece.type === 'b' || piece.type === 'n' ? 1.2 : 0.8;
    const pressure = (7 - squareDistance(square, enemyKing)) * value;
    if (pressure > strongest) { secondStrongest = strongest; strongest = pressure; }
    else if (pressure > secondStrongest) secondStrongest = pressure;
  }
  potential += strongest * 1.25 + secondStrongest * 0.35;
  if (inCheck && chess.turn() !== attacker) potential += 24;
  return { score: potential, zoneAttacks: kingZoneAttacks };
}

function makeCandidate(
  chess: Chess, parent: Candidate | null, targetColors: readonly Color[],
  parentFen: string, lastMove: SearchMove | null,
): Candidate {
  const inCheck = chess.isCheck();
  let attacker: Color = targetColors[0] ?? 'w';
  let best = attackPotential(chess, attacker, inCheck);
  for (const color of targetColors.slice(1)) {
    const potential = attackPotential(chess, color, inCheck);
    if (potential.score > best.score) { best = potential; attacker = color; }
  }
  const tacticalBand = `${inCheck ? 'check' : 'quiet'}:${Math.min(3, Math.floor(best.zoneAttacks / 2))}`;
  const first = parent?.lastMove ? null : lastMove && searchCoordinates(lastMove);
  return {
    parentFen,
    parent,
    lastMove,
    score: best.score,
    attacker,
    rootMove: first ? `${first.from}${first.to}${first.promotion ?? ''}` : parent?.rootMove ?? 'root',
    tacticalBand,
  };
}

function candidatePath(candidate: Candidate, finalMove: SearchMove): CoordinateMove[] {
  const path = [searchCoordinates(finalMove)];
  for (let parent: Candidate | null = candidate; parent?.lastMove; parent = parent.parent) {
    path.push(searchCoordinates(parent.lastMove));
  }
  return path.reverse();
}

function selectBeam(candidates: Candidate[], targetColors: readonly Color[], beamWidth: number): Candidate[] {
  candidates.sort((left, right) => right.score - left.score);
  if (beamWidth === 1) return candidates.slice(0, 1);
  const selected: Candidate[] = [];
  const selectedSet = new Set<Candidate>();
  const addDiverse = (pool: readonly Candidate[], limit: number) => {
    if (limit <= 0 || selected.length >= beamWidth) return;
    const signatures = new Set<string>();
    for (const item of pool) {
      const signature = `${item.rootMove}/${item.tacticalBand}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      selected.push(item);
      selectedSet.add(item);
      if (signatures.size >= limit || selected.length >= beamWidth) break;
    }
  };

  // Global deadness accepts either mating color. Reserve beam space for both
  // attackers so one easy pressure pattern cannot crowd out the other.
  const perAttacker = Math.max(1, Math.ceil(beamWidth / targetColors.length));
  for (const attacker of targetColors) {
    addDiverse(candidates.filter((item) => item.attacker === attacker), perAttacker);
  }
  addDiverse(candidates.filter((item) => !selectedSet.has(item)), beamWidth - selected.length);
  for (const item of candidates) {
    if (selected.length >= beamWidth) break;
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
  let rootMoves: readonly SearchMove[];
  try { rootMoves = searchMoves(rootChess); } catch { return null; }
  for (const proposed of rootMoves) {
    if (options.signal?.aborted) return null;
    if (now() - startedAt >= timeBudgetMs) return null;
    makeSearchMove(rootChess, proposed);
    const color = isTargetMate(query, rootChess);
    undoSearchMove(rootChess);
    if (color) return acceptedResult(query, color, [searchCoordinates(proposed)]);
  }

  const expired = () => options.signal?.aborted === true || now() - startedAt >= timeBudgetMs;
  const seed = seedWitness(query, rootChess, rootMoves, expired);
  if (seed) return seed;
  if (expired()) return null;

  const colors = intendedColors(query);
  const rootFen = rootChess.fen();
  let visitedCount = 0;
  let lastYield = now();
  // Most playable positions need only one promising cooperative continuation.
  // Try narrow beams first, then retain the diverse search for harder roots.
  for (const beamWidth of [1, FAST_BEAM_WIDTH, FALLBACK_BEAM_WIDTH]) {
    // Hashes only prune discovery. A collision can miss a witness, never accept
    // an invalid one; the independent checker still replays every accepted path.
    rootChess.load(rootFen, { skipValidation: true });
    let beam: Candidate[] = [makeCandidate(rootChess, null, colors, rootFen, null)];
    const visited = new Set<string>([`${rootChess.hash()}|0`]);
    const maxDepth = beamWidth === 1 ? GREEDY_MAX_DEPTH : FAST_MAX_DEPTH;
    for (let depth = 0; depth < maxDepth && visitedCount < FAST_MAX_NODES; depth += 1) {
      const next: Candidate[] = [];
      for (const candidate of beam) {
        rootChess.load(candidate.parentFen, { skipValidation: true });
        if (candidate.lastMove) makeSearchMove(rootChess, candidate.lastMove);
        // Serialize only beam parents, rather than every speculative child.
        const parentFen = rootChess.fen();
        for (const proposed of searchMoves(rootChess)) {
          if (++visitedCount > FAST_MAX_NODES || now() - startedAt >= timeBudgetMs || options.signal?.aborted) return null;
          makeSearchMove(rootChess, proposed);
          const color = isTargetMate(query, rootChess);
          if (color) return acceptedResult(query, color, candidatePath(candidate, proposed));
          const key = `${rootChess.hash()}|${depth + 1}`;
          if (!visited.has(key)) {
            visited.add(key);
            next.push(makeCandidate(rootChess, candidate, colors, parentFen, proposed));
          }
          undoSearchMove(rootChess);
          if (now() - lastYield >= YIELD_INTERVAL_MS) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (options.signal?.aborted || now() - startedAt >= timeBudgetMs) return null;
            lastYield = now();
          }
        }
      }
      beam = selectBeam(next, colors, beamWidth);
      if (beam.length === 0) break;
    }
  }
  return null;
}
