import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { adjacentCorner, BLACK, type Board, type Cell, countDiscs, getFlips, legalMoves, type Move, notation, playMove, squareType, WHITE } from './othello.ts';

if (!process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY がありません。doppler run -- npm start で起動してください。');
  process.exit(1);
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3000);
const MAX_REQUESTS = Number(process.env.JEV_MAX_REQUESTS ?? 80);
const WINDOW_REQUESTS = Number(process.env.JEV_REQUESTS_PER_MINUTE ?? 20);
const client = new TypeSafeClient();
let totalRequests = 0;
let windowStartedAt = Date.now();
let windowRequests = 0;

const publicDir = new URL('../public/', import.meta.url);
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function isBoard(value: unknown): value is Board {
  return Array.isArray(value) && value.length === 64 && value.every((cell) => cell === 0 || cell === 1 || cell === 2);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

function takeQuota(): { allowed: true; remaining: number } | { allowed: false; retryAfter: number } {
  const now = Date.now();
  if (now - windowStartedAt >= 60_000) {
    windowStartedAt = now;
    windowRequests = 0;
  }
  if (totalRequests >= MAX_REQUESTS) return { allowed: false, retryAfter: -1 };
  if (windowRequests >= WINDOW_REQUESTS) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((60_000 - (now - windowStartedAt)) / 1000)) };
  }
  totalRequests += 1;
  windowRequests += 1;
  return { allowed: true, remaining: MAX_REQUESTS - totalRequests };
}

type Phase = 'opening' | 'midgame' | 'endgame';

/** Othello strategy inverts over the course of a game, so the advice has to follow the phase. */
const phaseGuide: Record<Phase, string> = {
  opening:
    'Phase: opening. Do NOT try to own many discs. Flipping a lot of discs this early is usually a losing plan because every disc you own can be flipped back. Prefer quiet moves in the centre that keep your disc count low, keep your discs off the frontier, and leave Black with as few legal replies as possible. Never play an x_square or a c_square while its corner is still empty.',
  midgame:
    'Phase: midgame. Mobility and safety decide the game here. Take a corner whenever one is offered. Prefer moves that cut down Black\'s number of legal replies and that do not put your discs on the frontier. Refuse any move that lets Black take a corner on the reply, and keep avoiding x_squares and c_squares next to an empty corner.',
  endgame:
    'Phase: endgame. Few empty squares are left, so the final disc count now matters directly. Take corners, build stable discs along edges you already control, and flip discs freely when it is safe to do so. Still refuse any move that hands Black a corner.',
};

const glossary = {
  corner: 'a1, h1, a8, h8. A disc on a corner can never be flipped, so corners are the most valuable squares on the board.',
  x_square: 'b2, g2, b7, g7. Diagonally adjacent to a corner. Playing one while that corner is empty usually gives the corner to the opponent and loses the game.',
  c_square: 'b1, a2, g1, h2, a7, b8, g8, h7. Adjacent to a corner along an edge. Dangerous while that corner is still empty.',
  edge: 'Any other square on the outer ring. Useful once you are safe, but easy to over-extend on.',
  inner: 'Any square off the outer ring. These are the quiet, safe squares that keep your options open.',
};

function phaseOf(empty: number): Phase {
  if (empty >= 40) return 'opening';
  if (empty >= 13) return 'midgame';
  return 'endgame';
}

/** The board as Jev sees it: file letters on top, rank numbers on the left, legal moves marked `*`. */
function renderBoard(board: Board, moves: Move[]): string[] {
  const marked = new Set(moves.map((move) => move.row * 8 + move.col));
  const rows = ['    a b c d e f g h'];
  for (let row = 0; row < 8; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < 8; col += 1) {
      const index = row * 8 + col;
      cells.push(board[index] === BLACK ? 'B' : board[index] === WHITE ? 'W' : marked.has(index) ? '*' : '.');
    }
    rows.push(`${row + 1}   ${cells.join(' ')}`);
  }
  return rows;
}

function ownerOf(cell: Cell): string {
  return cell === WHITE ? 'you (White)' : cell === BLACK ? 'Black (the opponent)' : 'empty';
}

function describeCandidate(board: Board, move: Move) {
  const next = playMove(board, move, WHITE);
  const replies = legalMoves(next, BLACK);
  const corner = adjacentCorner(move);
  return {
    square: notation(move),
    square_type: squareType(move),
    discs_flipped: getFlips(board, move.row, move.col, WHITE).length,
    black_legal_replies_after: replies.length,
    black_can_take_a_corner_after: replies.some((reply) => squareType(reply) === 'corner'),
    ...(corner ? { adjacent_corner: { square: notation(corner), owner: ownerOf(board[corner.row * 8 + corner.col]) } } : {}),
  };
}

/** Accepts the transcript the browser keeps; anything malformed is simply dropped. */
function parseHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const moves = value.filter((entry): entry is string => typeof entry === 'string' && /^[a-h][1-8]$/.test(entry));
  return moves.length === value.length && moves.length <= 64 ? moves : [];
}

async function handleJevMove(req: IncomingMessage, res: ServerResponse) {
  let payload: unknown;
  try {
    payload = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'リクエストを読めませんでした。' });
    return;
  }
  const board = (payload as { board?: unknown }).board;
  if (!isBoard(board)) {
    sendJson(res, 400, { error: '盤面が不正です。' });
    return;
  }
  const history = parseHistory((payload as { history?: unknown }).history);
  const moves = legalMoves(board, WHITE);
  if (!moves.length) {
    sendJson(res, 200, { move: null, mode: 'pass', remaining: MAX_REQUESTS - totalRequests });
    return;
  }
  const quota = takeQuota();
  if (!quota.allowed) {
    if (quota.retryAfter > 0) res.setHeader('Retry-After', String(quota.retryAfter));
    sendJson(res, 429, { error: quota.retryAfter > 0 ? '1分あたりの上限に達しました。少し待ってください。' : 'この起動中のJev利用上限に達しました。サーバーを再起動するとリセットされます。' });
    return;
  }

  const { black, white, empty } = countDiscs(board);
  const phase = phaseOf(empty);
  const candidates = Object.fromEntries(moves.map((move) => [notation(move), describeCandidate(board, move)]));

  try {
    const result = await client.systemOne({
      model: 'jev-latest',
      state: {
        game: 'Othello (Reversi), 8x8.',
        notation: 'Files a-h run left to right, ranks 1-8 run top to bottom. A square is written file then rank, e.g. f5. B is a Black disc, W is a White disc, . is an empty square, and * is an empty square where White may legally play right now.',
        glossary,
        board: renderBoard(board, moves),
        to_move: 'White (W). You are White. Black is the human opponent.',
        move_number: 61 - empty,
        empty_squares: empty,
        disc_count: { black, white },
        phase,
        transcript: history.length ? history.join('') : 'none yet',
        black_last_move: history.length ? history[history.length - 1] : 'none yet',
        legal_moves_for_white: moves.map(notation),
      },
      questions: {
        best: choice(
          [
            'You are a world-class Othello player, rated above 2400, playing White.',
            'Which of these candidate moves is the strongest for White in this position?',
            phaseGuide[phase],
            'Judge by long-term winning chances, never by how many discs a move flips right now.',
          ].join(' '),
          candidates,
        ),
        blunder: choice(
          [
            'Among these same candidate moves for White, which one is the worst - the single move most likely to lose the game?',
            'Weigh most heavily, in this order: letting Black take a corner on the reply, playing an x_square or c_square whose corner is still empty, handing Black a large number of legal replies, and flipping a lot of discs while the game is still young.',
          ].join(' '),
          candidates,
        ),
      },
    });

    // Jev does not reason, so we ask it the same position from two directions and let the
    // two probability distributions temper each other instead of trusting one argmax.
    const best = result.answers.best;
    const blunder = result.answers.blunder;
    const ranked = moves
      .map((move) => {
        const label = notation(move);
        const support = best.probabilities[label] ?? 0;
        const risk = blunder.probabilities[label] ?? 0;
        return { move, label, support, risk, score: support - 0.5 * risk };
      })
      .sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (!top) throw new Error('Jev returned no usable move');

    sendJson(res, 200, {
      move: top.move,
      notation: top.label,
      confidence: top.support,
      risk: top.risk,
      overruled: top.label !== best.choice ? best.choice : null,
      model: result.model,
      remaining: quota.remaining,
    });
  } catch (error) {
    console.error(`Jev evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    sendJson(res, 502, { error: 'Jevの評価に失敗しました。利用回数には計上されています。' });
  }
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'style.css', 'favicon.svg'].includes(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  try {
    const file = await readFile(join(publicDir.pathname, name));
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(name)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/api/jev-move') {
    await handleJevMove(req, res);
    return;
  }
  if (req.method === 'GET') {
    await serveStatic(url.pathname, res);
    return;
  }
  res.writeHead(405, { Allow: 'GET, POST' });
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Jev Othello: http://${HOST}:${PORT}`);
  console.log(`Jev calls: max ${MAX_REQUESTS} per process, ${WINDOW_REQUESTS} per minute`);
});
