import { parsePosition } from '../rules/index.js';
import type { PieceOnSquare } from '../rules/index.js';
import type { MoveGrade } from '../review/grades.js';
import type { ReviewedMove } from '../review/review.js';
import { BROWSER_ENGINES } from '../engines/browser.js';
import { formatEvaluation, whiteEvaluationPercent } from '../engines/uci-score.js';
import type { EvaluationScore } from '../engines/uci-score.js';
import { sceneAt } from '../recap/timeline.js';
import type { RecapTimeline } from '../recap/timeline.js';
import { BOARD_STYLES } from '../ui/board-style.js';
import type { BoardStyle } from '../ui/board-style.js';
import { pieceImage } from '../ui/piece-image.js';
import type { PieceStyle } from '../ui/piece-style.js';

export const VIDEO_WIDTH = 720;
export const VIDEO_HEIGHT = 1280;
export const VIDEO_FPS = 30;

const INK = '#252b27';
const MUTED = '#5e665f';
const PAPER = '#f7f4ec';
const GRADE_COLORS: Record<MoveGrade, string> = { great: '#237252', best: '#367847', good: '#536b51',
  'slight-inaccuracy': '#87641a', inaccuracy: '#87641a', mistake: '#ad512c', blunder: '#af353b', forced: '#626b64', unreviewed: '#626b64' };
const CREDIT: Record<PieceStyle, readonly string[]> = {
  merida: ['Merida by Armando Hernandez Marroquin', 'github.com/lichess-org/lila · GPL-2.0-or-later'],
  cburnett: ['Cburnett by Colin M. L. Burnett', 'github.com/lichess-org/lila · GPL-2.0-or-later'],
  firi: ['Firi by James Faure', 'github.com/jfaure/Firi-pieceset', 'creativecommons.org/licenses/by/4.0/'],
  kaneo: ['Kaneo by Kadagaden', 'github.com/Kadagaden/chess-pieces', 'creativecommons.org/licenses/by/4.0/', 'SVG dimensions adjusted for responsive display'],
  kamkm: ['Kamkm pieces by kamkm chess', 'github.com/Kamkmgamer/kamkmchess · GPL-3.0-or-later'],
};

export interface RenderAssets {
  readonly images: ReadonlyMap<string, HTMLImageElement>;
  readonly positions: ReadonlyMap<string, readonly PieceOnSquare[]>;
  readonly boardStyle: BoardStyle;
  readonly credits: readonly string[];
}

export async function prepareRenderAssets(timeline: RecapTimeline, boardStyle: BoardStyle, pieceStyle: PieceStyle, signal: AbortSignal): Promise<RenderAssets> {
  const images = new Map<string, HTMLImageElement>();
  await Promise.all((['w', 'b'] as const).flatMap(color => (['k', 'q', 'r', 'b', 'n', 'p'] as const).map(async type => {
    if (signal.aborted) throw new DOMException('Video stopped.', 'AbortError');
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); img.onload = null; img.onerror = null; };
      const abort = () => { cleanup(); img.src = ''; reject(new DOMException('Video stopped.', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('The chess pieces could not load. Retry the video.')); }, 20_000);
      img.onload = () => { cleanup(); resolve(); };
      img.onerror = () => { cleanup(); reject(new Error('The chess pieces could not load. Retry the video.')); };
      signal.addEventListener('abort', abort, { once: true });
      img.src = pieceImage(color, type, pieceStyle);
    });
    images.set(color + type, img);
  })));
  await document.fonts.ready;
  if (signal.aborted) throw new DOMException('Video stopped.', 'AbortError');
  const positions = new Map<string, readonly PieceOnSquare[]>();
  for (const fen of [timeline.review.replay.startingFen, ...timeline.review.moves.flatMap(move => [move.fenBefore, move.fenAfter])]) {
    if (!positions.has(fen)) positions.set(fen, parsePosition(fen).pieces);
  }
  return { images, positions, boardStyle, credits: CREDIT[pieceStyle] };
}

function fitText(context: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, size: number, weight = 500): void {
  let font = size;
  do { context.font = `${weight} ${font}px "Segoe UI", system-ui, sans-serif`; font -= 1; } while (context.measureText(text).width > width && font > 15);
  if (context.measureText(text).width <= width) context.fillText(text, x, y);
  else {
    let clipped = text;
    while (clipped.length && context.measureText(clipped + '…').width > width) clipped = clipped.slice(0, -1);
    context.fillText(clipped + '…', x, y);
  }
}

/** The played move is already on the board, so a winning mate count has advanced by one. */
export function frameEvaluation(move: Pick<ReviewedMove, 'side' | 'playedScore'>): EvaluationScore {
  const raw = move.playedScore.value;
  if (move.playedScore.kind === 'cp') return { kind: 'cp', value: raw * (move.side === 'white' ? 1 : -1) };
  const remaining = raw > 0 ? raw - 1 : raw;
  return { kind: 'mate', value: remaining * (move.side === 'white' ? 1 : -1),
    winner: (raw > 0) === (move.side === 'white') ? 'white' : 'black' };
}

/** Seeking, preview, and export use exactly the same chess frame renderer. */
export function renderFrame(canvas: HTMLCanvasElement, timeline: RecapTimeline, seconds: number,
  assets: RenderAssets, orientation: 'white' | 'black'): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw the video.');
  const scene = sceneAt(timeline, seconds);
  const time = Math.max(0, seconds - scene.start);
  const move = scene.move;
  const jumping = scene.jump && time < 0.6;
  const amount = scene.kind === 'move' ? Math.min(1, Math.max(0, (time - (scene.jump ? 0.6 : 0)) / 0.35)) : 1;
  const eased = 1 - (1 - amount) ** 3;
  const palette = BOARD_STYLES[assets.boardStyle];
  const boardX = 48, boardY = 378, boardSize = 608, square = boardSize / 8;
  const squareXY = (key: string): [number, number] => {
    const file = key.charCodeAt(0) - 97, rank = Number(key[1]) - 1;
    return [boardX + (orientation === 'white' ? file : 7 - file) * square,
      boardY + (orientation === 'white' ? 7 - rank : rank) * square];
  };
  context.save();
  context.scale(canvas.width / VIDEO_WIDTH, canvas.height / VIDEO_HEIGHT);
  context.fillStyle = PAPER; context.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  context.textAlign = 'left'; context.textBaseline = 'alphabetic'; context.fillStyle = INK;
  fitText(context, 'kamkm chess', 48, 58, 450, 25, 650);
  context.fillStyle = MUTED;
  fitText(context, BROWSER_ENGINES[timeline.review.engineId].name, 48, 91, 610, 18);
  context.fillStyle = INK;
  fitText(context, scene.kind === 'move' ? move!.label : scene.caption, 48, 190, 625, scene.kind === 'move' ? 66 : 46, 650);
  if (scene.kind === 'move' && move) {
    context.fillStyle = GRADE_COLORS[move.grade];
    fitText(context, scene.caption, 48, 237, 610, 29, 650);
    context.fillStyle = MUTED;
    fitText(context, move.explanation, 48, 278, 625, 22);
  } else if (scene.kind === 'intro') {
    context.fillStyle = MUTED;
    fitText(context, `${timeline.review.replay.players.white} vs ${timeline.review.replay.players.black}`, 48, 243, 625, 26);
  } else {
    context.fillStyle = MUTED;
    const result = timeline.review.replay.result;
    fitText(context, result.winner === 'draw' ? '½ – ½' : result.winner === 'white' ? '1 – 0' : '0 – 1', 48, 250, 610, 40, 600);
  }
  const upper = orientation === 'white' ? 'black' : 'white';
  const lower = upper === 'black' ? 'white' : 'black';
  context.fillStyle = INK;
  fitText(context, timeline.review.replay.players[upper], boardX, boardY - 30, boardSize, 25, 600);
  fitText(context, timeline.review.replay.players[lower], boardX, boardY + boardSize + 46, boardSize, 25, 600);
  for (let row = 0; row < 8; row++) for (let file = 0; file < 8; file++) {
    context.fillStyle = (row + file) % 2 ? palette.dark : palette.light;
    context.fillRect(boardX + file * square, boardY + row * square, square, square);
  }
  const from = move?.uci.slice(0, 2), to = move?.uci.slice(2, 4);
  if (move && scene.kind === 'move') for (const key of [from!, to!]) {
    context.fillStyle = palette.lastMove;
    context.fillRect(...squareXY(key), square, square);
  }
  const before = move ? assets.positions.get(move.fenBefore) ?? [] : [];
  const after = assets.positions.get(scene.fen) ?? [];
  const movingPiece = before.find(piece => piece.square === from);
  const castle = movingPiece?.type === 'k' && from && to && Math.abs(from.charCodeAt(0) - to.charCodeAt(0)) === 2;
  const rookFrom = castle ? `${to![0] === 'g' ? 'h' : 'a'}${from![1]}` : null;
  const rookTo = castle ? `${to![0] === 'g' ? 'f' : 'd'}${from![1]}` : null;
  const drawPiece = (piece: PieceOnSquare, x: number, y: number, alpha = 1) => {
    const image = assets.images.get(piece.color + piece.type);
    if (!image) return;
    context.globalAlpha = alpha;
    context.drawImage(image, x + 3, y + 3, square - 6, square - 6);
    context.globalAlpha = 1;
  };
  const animate = scene.kind === 'move' && amount < 1;
  if (animate) {
    for (const piece of before) {
      if (piece.square === from || piece.square === rookFrom) continue;
      const remains = after.some(next => next.square === piece.square && next.color === piece.color && next.type === piece.type);
      drawPiece(piece, ...squareXY(piece.square), remains ? 1 : 1 - eased);
    }
    for (const [origin, target] of [[from, to], [rookFrom, rookTo]]) {
      if (!origin || !target) continue;
      let piece = before.find(piece => piece.square === origin);
      if (!piece) continue;
      if (amount > 0.7) piece = after.find(piece => piece.square === target) ?? piece;
      const a = squareXY(origin), b = squareXY(target);
      drawPiece(piece, a[0] + (b[0] - a[0]) * eased, a[1] + (b[1] - a[1]) * eased);
    }
  } else for (const piece of after) drawPiece(piece, ...squareXY(piece.square));
  if (scene.kind === 'move' && move && time > 0.65 && ['great', 'mistake', 'blunder'].includes(move.grade)) {
    const a = squareXY(from!), b = squareXY(to!);
    const x1 = a[0] + square / 2, y1 = a[1] + square / 2;
    const x2 = b[0] + square / 2, y2 = b[1] + square / 2;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    context.save(); context.globalAlpha = 0.7; context.strokeStyle = GRADE_COLORS[move.grade]; context.fillStyle = GRADE_COLORS[move.grade];
    context.lineWidth = 8; context.lineCap = 'round';
    context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2 - Math.cos(angle) * 16, y2 - Math.sin(angle) * 16); context.stroke();
    context.beginPath(); context.moveTo(x2, y2);
    context.lineTo(x2 - 26 * Math.cos(angle - 0.45), y2 - 26 * Math.sin(angle - 0.45));
    context.lineTo(x2 - 26 * Math.cos(angle + 0.45), y2 - 26 * Math.sin(angle + 0.45)); context.closePath(); context.fill(); context.restore();
  }
  // The badge describes the played move; the preferred SAN stays in the caption.
  if (scene.kind === 'move' && move && ['inaccuracy', 'mistake', 'blunder'].includes(move.grade) && time > 0.7) {
    const [x, y] = squareXY(to!);
    context.fillStyle = GRADE_COLORS[move.grade];
    context.beginPath(); context.arc(x + square - 10, y + 10, 15, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#fff'; context.font = 'bold 21px "Segoe UI", sans-serif'; context.textAlign = 'center';
    context.fillText(move.grade === 'blunder' ? '??' : '?', x + square - 10, y + 17); context.textAlign = 'left';
  }
  context.fillStyle = MUTED; context.font = '16px "Segoe UI", sans-serif';
  for (let i = 0; i < 8; i++) {
    context.fillText('abcdefgh'[orientation === 'white' ? i : 7 - i]!, boardX + i * square + square / 2 - 4, boardY + boardSize + 19);
  }
  let fraction = 0.5;
  let evaluation = '';
  if (move) {
    const score = frameEvaluation(move);
    fraction = whiteEvaluationPercent(score) / 100; evaluation = formatEvaluation(score);
  }
  context.fillStyle = INK; context.fillRect(672, boardY, 8, boardSize);
  context.fillStyle = '#fff'; context.fillRect(672, orientation === 'white' ? boardY + boardSize * (1 - fraction) : boardY, 8, boardSize * fraction);
  context.fillStyle = MUTED;
  fitText(context, evaluation, 48, 1106, 300, 22);
  context.textAlign = 'right'; fitText(context, `${move?.ply ?? 0}/${timeline.review.moves.length}`, 672, 1106, 200, 22); context.textAlign = 'left';
  context.fillStyle = '#d7d9d0'; context.fillRect(48, 1135, 624, 3);
  context.fillStyle = '#567753'; context.fillRect(48, 1135, 624 * Math.min(1, Math.max(0, seconds / timeline.duration)), 3);
  context.fillStyle = MUTED;
  assets.credits.forEach((credit, index) => fitText(context, credit, 48, 1180 + index * 24, 625, 16));
  if (jumping) {
    context.fillStyle = PAPER; context.globalAlpha = 1 - Math.min(1, time / 0.6); context.fillRect(0, boardY - 5, 720, boardSize + 10); context.globalAlpha = 1;
    context.fillStyle = MUTED; fitText(context, 'Later in the game', 48, 312, 625, 20);
  }
  context.restore();
}

export function recapCredits(assets: RenderAssets): string {
  return [...assets.credits, 'Procedural music by kamkm chess. No external recordings.',
    'Analysis: Stockfish 19, https://github.com/nmrugg/stockfish.js',
    'Created with https://github.com/Kamkmgamer/kamkmchess'].join('\n');
}
