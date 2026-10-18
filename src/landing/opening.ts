import { Chess } from 'chess.js';

const moves = [
  { san: 'e4', note: 'White takes space in the center and opens a path for the bishop.' },
  { san: 'e5', note: 'Black meets the pawn in the center and makes room to develop.' },
  { san: 'Nf3', note: 'White develops a knight and attacks the pawn on e5.' },
  { san: 'Nc6', note: 'Black develops a knight to defend the central pawn.' },
  { san: 'Bc4', note: 'White’s bishop takes aim at f7. The Italian game is on the board.' },
  { san: 'Bc5', note: 'Black develops the bishop toward f2. Both sides are ready to castle soon.' },
];

type OpeningFrame = {
  fen: string;
  board: ReturnType<Chess['board']>;
  move: ReturnType<Chess['move']> | null;
  note: string;
  turn: ReturnType<Chess['turn']>;
};

/** A fixed, legal opening for the landing page. No model or provider request is made. */
export function createOpeningFrames() {
  const game = new Chess();
  const frames: [OpeningFrame, ...OpeningFrame[]] = [{
    fen: game.fen(),
    board: game.board(),
    move: null,
    note: 'White moves first. Start with e4 to claim space in the center.',
    turn: game.turn(),
  }];

  for (const { san, note } of moves) {
    const move = game.move(san);
    frames.push({ fen: game.fen(), board: game.board(), move, note, turn: game.turn() });
  }

  return frames;
}

export const openingFrames = createOpeningFrames();
export const openingMoves = moves.map(({ san }) => san);
