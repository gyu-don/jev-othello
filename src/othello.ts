export type Cell = 0 | 1 | 2;
export type Board = Cell[];
export type Move = { row: number; col: number };

export const BLACK: Cell = 1;
export const WHITE: Cell = 2;

const directions = [-1, 0, 1]
  .flatMap((dr) => [-1, 0, 1].map((dc) => [dr, dc] as const))
  .filter(([dr, dc]) => dr !== 0 || dc !== 0);

export function opponent(player: Cell): Cell {
  return player === BLACK ? WHITE : BLACK;
}

export function getFlips(board: Board, row: number, col: number, player: Cell): number[] {
  if (board[row * 8 + col] !== 0) return [];
  const other = opponent(player);
  const flips: number[] = [];

  for (const [dr, dc] of directions) {
    const line: number[] = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === other) {
      line.push(r * 8 + c);
      r += dr;
      c += dc;
    }
    if (line.length && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === player) {
      flips.push(...line);
    }
  }
  return flips;
}

export function legalMoves(board: Board, player: Cell): Move[] {
  const moves: Move[] = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      if (getFlips(board, row, col, player).length) moves.push({ row, col });
    }
  }
  return moves;
}

export function playMove(board: Board, move: Move, player: Cell): Board {
  const flips = getFlips(board, move.row, move.col, player);
  if (!flips.length) throw new Error('Illegal move');
  const next = [...board] as Board;
  next[move.row * 8 + move.col] = player;
  for (const index of flips) next[index] = player;
  return next;
}

export function moveLabel(move: Move): string {
  return `${'ABCDEFGH'[move.col]}${move.row + 1}`;
}

/** Standard Othello transcript notation, e.g. `f5`. Used as the label Jev chooses between. */
export function notation(move: Move): string {
  return `${'abcdefgh'[move.col]}${move.row + 1}`;
}

export type SquareType = 'corner' | 'x_square' | 'c_square' | 'edge' | 'inner';

const cornerSquares: Move[] = [
  { row: 0, col: 0 },
  { row: 0, col: 7 },
  { row: 7, col: 0 },
  { row: 7, col: 7 },
];

/** For each X- and C-square, the corner whose fate it decides. */
const cornerNeighbours = new Map<string, Move>([
  ['1,1', { row: 0, col: 0 }], ['0,1', { row: 0, col: 0 }], ['1,0', { row: 0, col: 0 }],
  ['1,6', { row: 0, col: 7 }], ['0,6', { row: 0, col: 7 }], ['1,7', { row: 0, col: 7 }],
  ['6,1', { row: 7, col: 0 }], ['7,1', { row: 7, col: 0 }], ['6,0', { row: 7, col: 0 }],
  ['6,6', { row: 7, col: 7 }], ['7,6', { row: 7, col: 7 }], ['6,7', { row: 7, col: 7 }],
]);

const xSquares = new Set(['1,1', '1,6', '6,1', '6,6']);

export function squareType(move: Move): SquareType {
  const key = `${move.row},${move.col}`;
  if (cornerSquares.some((corner) => corner.row === move.row && corner.col === move.col)) return 'corner';
  if (xSquares.has(key)) return 'x_square';
  if (cornerNeighbours.has(key)) return 'c_square';
  if (move.row === 0 || move.row === 7 || move.col === 0 || move.col === 7) return 'edge';
  return 'inner';
}

/** The corner an X- or C-square sits next to, or `null` for every other square. */
export function adjacentCorner(move: Move): Move | null {
  return cornerNeighbours.get(`${move.row},${move.col}`) ?? null;
}

export function isCorner(move: Move): boolean {
  return squareType(move) === 'corner';
}

export function countDiscs(board: Board): { black: number; white: number; empty: number } {
  let black = 0;
  let white = 0;
  for (const cell of board) {
    if (cell === BLACK) black += 1;
    else if (cell === WHITE) white += 1;
  }
  return { black, white, empty: 64 - black - white };
}
