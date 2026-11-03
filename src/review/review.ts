import { BROWSER_ENGINES, BrowserUciEngine, downloadBrowserEngine, ENGINE_VERSION, isEngineDownloaded } from '../engines/browser.js';
import type { BrowserEngineId } from '../engines/browser.js';
import type { ReviewLine } from '../engines/review-score.js';
import { applyCoordinateMove, legalMoves, parsePosition } from '../rules/index.js';
import type { Position } from '../rules/index.js';
import { assessMove, expectedScore, GRADE_LABELS } from './grades.js';
import type { MoveAssessment } from './grades.js';
import { coordinateText } from './replay.js';
import type { GameReplay, ReplayMove } from './replay.js';
import { loadReview, saveReview } from './store.js';

const REVIEW_VERSION = 1;
const NODES = 100_000;
export interface ReviewedMove extends ReplayMove, MoveAssessment { readonly ply: number }
export interface GameReview { readonly replay: GameReplay; readonly engineId: BrowserEngineId; readonly moves: readonly ReviewedMove[] }
export interface ReviewProgress { readonly engine: string; readonly completed: number; readonly total: number; readonly download: number | null; readonly fallback: boolean }

function aborted(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('Review stopped.', 'AbortError'); }
function legalPv(position: Position, line: ReviewLine): boolean {
  try {
    for (const uci of line.pv) {
      const move = legalMoves(position).find(move => coordinateText(move) === uci);
      if (!move) return false;
      position = applyCoordinateMove(position, move).position;
    }
    return line.pv.length > 0;
  } catch { return false; }
}

export async function reviewGame(replay: GameReplay, signal: AbortSignal, onProgress: (value: ReviewProgress) => void, fast = false): Promise<GameReview> {
  aborted(signal);
  const preferred: BrowserEngineId = !fast && await isEngineDownloaded('stockfish-full') ? 'stockfish-full' : 'stockfish-lite';
  const nodes = fast ? 20_000 : NODES;
  for (const engineId of preferred === 'stockfish-full' ? ['stockfish-full', 'stockfish-lite'] as const : ['stockfish-lite'] as const) {
    const fallback = engineId !== preferred;
    const engine = BROWSER_ENGINES[engineId].name;
    let worker: BrowserUciEngine | null = null;
    try {
      onProgress({ engine, completed: 0, total: replay.moves.length, download: null, fallback });
      const key = JSON.stringify({ v: REVIEW_VERSION, engine: `${ENGINE_VERSION}/${engineId}`, nodes,
        game: replay.gameId, scope: replay.scope, line: replay.lineId, fen: replay.startingFen,
        moves: replay.moves.map(move => move.uci), result: [replay.result.winner, replay.result.reason] });
      const cached = await loadReview(key);
      // Reject incomplete or incompatible persisted records before resuming.
      const reviewed: ReviewedMove[] = [];
      for (const [index, move] of cached.entries()) {
        if (!move || index >= replay.moves.length || move.uci !== replay.moves[index]!.uci || move.fenBefore !== replay.moves[index]!.fenBefore
          || move.ply !== index + 1 || !Number.isFinite(move.depth) || typeof move.explanation !== 'string'
          || !Object.hasOwn(GRADE_LABELS, move.grade) || !move.playedScore || !['mate', 'cp'].includes(move.playedScore.kind)
          || !Number.isSafeInteger(move.playedScore.value) || typeof move.bestSan !== 'string' || typeof move.bestMove !== 'string'
          || (move.loss !== null && (!Number.isFinite(move.loss) || move.loss < 0 || move.loss > 1))) break;
        reviewed.push({ ...move, ...replay.moves[index]! });
      }
      if (reviewed.length === replay.moves.length) {
        aborted(signal); onProgress({ engine, completed: reviewed.length, total: replay.moves.length, download: null, fallback });
        return { replay, engineId, moves: reviewed };
      }
      const assets = await downloadBrowserEngine(engineId, progress => {
        if (!signal.aborted) onProgress({ engine, completed: reviewed.length, total: replay.moves.length,
          download: Math.min(1, progress.loaded / Math.max(1, progress.total)), fallback });
      }, signal);
      aborted(signal);
      worker = new BrowserUciEngine(assets);
      for (let index = reviewed.length; index < replay.moves.length; index++) {
        aborted(signal);
        const move = replay.moves[index]!;
        const position = parsePosition(move.fenBefore);
        const legal = legalMoves(position);
        const root = { startingFen: replay.startingFen, moves: replay.moves.slice(0, index).map(move => move.uci) };
        const multiPv = Math.min(2, legal.length);
        let search = await worker.review(root, { nodes, multiPv }, signal);
        let best = search.lines[0]!;
        let second = search.lines[1];
        let played = search.lines.find(line => line.pv[0] === move.uci)
          ?? (await worker.review(root, { nodes, multiPv: 1, searchMove: move.uci }, signal)).lines[0]!;
        const initialBest = best.pv[0];
        const a = expectedScore(best), b = expectedScore(played), c = second ? expectedScore(second) : null;
        const important = b !== null && a !== null && (a - b >= 0.02 || b > a + 0.03 || (c !== null && a - c >= 0.10));
        if (important || best.depth < 8 || played.depth < 8 || best.pv[0] !== search.bestMove) {
          search = await worker.review(root, { nodes: nodes * 3, multiPv }, signal);
          best = search.lines[0]!; second = search.lines[1];
          played = search.lines.find(line => line.pv[0] === move.uci)
            ?? (await worker.review(root, { nodes: nodes * 3, multiPv: 1, searchMove: move.uci }, signal)).lines[0]!;
        }
        const bestCoordinate = legal.find(candidate => coordinateText(candidate) === best.pv[0]);
        const bestSan = bestCoordinate ? applyCoordinateMove(position, bestCoordinate).san : '';
        const confirmed = best.pv[0] === search.bestMove && legalPv(position, best) && legalPv(position, played) && (!second || legalPv(position, second));
        let assessment = assessMove({ best, played, second, uci: move.uci, bestSan, legalCount: legal.length, confirmed });
        if (assessment.grade === 'great' && initialBest !== best.pv[0]) assessment = { ...assessment, grade: 'best', explanation: "Stockfish's first choice." };
        reviewed.push({ ...move, ...assessment, ply: index + 1 });
        aborted(signal);
        await saveReview(key, reviewed);
        aborted(signal);
        onProgress({ engine, completed: reviewed.length, total: replay.moves.length, download: null, fallback });
      }
      return { replay, engineId, moves: reviewed };
    } catch (error) {
      if (signal.aborted || engineId === 'stockfish-lite') throw error;
      // Full-engine failures restart under a separate Lite cache identity.
    } finally { worker?.close(); }
  }
  throw new Error('Stockfish could not review this game. Retry to continue.');
}
