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

export function moveKey(move: Move): string {
  return `m_${move.row}_${move.col}`;
}

export function moveLabel(move: Move): string {
  return `${'ABCDEFGH'[move.col]}${move.row + 1}`;
}
