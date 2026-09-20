import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { BLACK, type Board, getFlips, legalMoves, moveKey, moveLabel, playMove, WHITE } from './othello.ts';

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

  const candidates = Object.fromEntries(moves.map((move) => {
    const next = playMove(board, move, WHITE);
    const key = `${move.row},${move.col}`;
    const corner = ['0,0', '0,7', '7,0', '7,7'].includes(key);
    const edge = move.row === 0 || move.row === 7 || move.col === 0 || move.col === 7;
    const description = `${moveLabel(move)}に置く合法手。${getFlips(board, move.row, move.col, WHITE).length}枚返し、相手の次の合法手は${legalMoves(next, BLACK).length}個。角=${corner ? 'はい' : 'いいえ'}、辺=${edge ? 'はい' : 'いいえ'}。`;
    return [moveKey(move), description];
  }));

  try {
    const result = await client.systemOne({
      model: 'jev-latest',
      state: {
        rules: '8x8 Othello. B is the human player, W is Jev, . is empty. White must choose one listed legal move.',
        board: Array.from({ length: 8 }, (_, row) => board.slice(row * 8, row * 8 + 8).map((cell) => cell === BLACK ? 'B' : cell === WHITE ? 'W' : '.').join('')),
        turn: 'White (Jev)',
      },
      questions: {
        move: choice('Which candidate is the strongest practical Othello move for White? Prefer stable discs, corners, mobility, and avoiding moves that concede corners.', candidates),
      },
    });
    const answer = result.answers.move;
    const selected = moves.find((move) => moveKey(move) === answer.choice);
    if (!selected) throw new Error('Jev returned an unknown move');
    sendJson(res, 200, { move: selected, confidence: answer.confidence, model: result.model, remaining: quota.remaining });
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
