const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const directions = [-1, 0, 1].flatMap((dr) => [-1, 0, 1].map((dc) => [dr, dc])).filter(([dr, dc]) => dr || dc);

const elements = {
  board: document.querySelector('#board'),
  notice: document.querySelector('#notice'),
  turnLabel: document.querySelector('#turn-label'),
  turnDisc: document.querySelector('#turn-disc'),
  statusPill: document.querySelector('#status-pill'),
  blackScore: document.querySelector('#black-score'),
  whiteScore: document.querySelector('#white-score'),
  model: document.querySelector('#model-label'),
  lastMove: document.querySelector('#last-move'),
  confidence: document.querySelector('#confidence'),
  signalCopy: document.querySelector('#signal-copy'),
  remaining: document.querySelector('#remaining'),
  restart: document.querySelector('#restart'),
};

let board;
let phase;
let lastMove;
let match = 0;

function initialBoard() {
  const next = Array(64).fill(EMPTY);
  next[27] = WHITE;
  next[28] = BLACK;
  next[35] = BLACK;
  next[36] = WHITE;
  return next;
}

function getFlips(position, row, col, player) {
  if (position[row * 8 + col] !== EMPTY) return [];
  const other = player === BLACK ? WHITE : BLACK;
  const flips = [];
  for (const [dr, dc] of directions) {
    const line = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && position[r * 8 + c] === other) {
      line.push(r * 8 + c);
      r += dr;
      c += dc;
    }
    if (line.length && r >= 0 && r < 8 && c >= 0 && c < 8 && position[r * 8 + c] === player) flips.push(...line);
  }
  return flips;
}

function legalMoves(position, player) {
  const moves = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      if (getFlips(position, row, col, player).length) moves.push({ row, col });
    }
  }
  return moves;
}

function playMove(position, move, player) {
  const next = [...position];
  const flips = getFlips(position, move.row, move.col, player);
  if (!flips.length) throw new Error('illegal move');
  next[move.row * 8 + move.col] = player;
  for (const index of flips) next[index] = player;
  return next;
}

function moveLabel(move) {
  return `${'ABCDEFGH'[move.col]}${move.row + 1}`;
}

function setPhase(next) {
  phase = next;
  elements.statusPill.classList.toggle('thinking', next === 'thinking');
  elements.statusPill.querySelector('b').textContent = next === 'human' ? 'YOUR TURN' : next === 'thinking' ? 'JEV THINKING' : 'GAME OVER';
  elements.turnLabel.textContent = next === 'human' ? 'あなたの番' : next === 'thinking' ? 'Jev の番' : '対局終了';
  elements.turnDisc.textContent = next === 'human' ? '黒' : next === 'thinking' ? '白' : '';
}

function render() {
  const legal = phase === 'human' ? legalMoves(board, BLACK) : [];
  const legalSet = new Set(legal.map(({ row, col }) => row * 8 + col));
  elements.board.replaceChildren(...board.map((cell, index) => {
    const row = Math.floor(index / 8);
    const col = index % 8;
    const playable = legalSet.has(index);
    const square = document.createElement('button');
    square.className = `square${playable ? ' playable' : ''}${lastMove === index ? ' last' : ''}`;
    square.type = 'button';
    square.disabled = !playable;
    square.setAttribute('role', 'gridcell');
    square.setAttribute('aria-label', `${moveLabel({ row, col })}${playable ? '、置けます' : ''}`);
    if (cell) {
      const disc = document.createElement('span');
      disc.className = `disc ${cell === BLACK ? 'black' : 'white'}`;
      square.append(disc);
    } else if (playable) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      square.append(hint);
    }
    square.addEventListener('click', () => playHuman({ row, col }));
    return square;
  }));
  elements.blackScore.textContent = board.filter((cell) => cell === BLACK).length;
  elements.whiteScore.textContent = board.filter((cell) => cell === WHITE).length;
}

function finishOrReturn() {
  const humanMoves = legalMoves(board, BLACK);
  const jevMoves = legalMoves(board, WHITE);
  if (!humanMoves.length && !jevMoves.length) {
    setPhase('over');
    const black = board.filter((cell) => cell === BLACK).length;
    const white = board.filter((cell) => cell === WHITE).length;
    elements.notice.textContent = black === white ? '引き分け' : black > white ? 'あなたの勝ち' : 'Jev の勝ち';
    render();
    return true;
  }
  if (humanMoves.length) {
    setPhase('human');
    elements.notice.textContent = 'あなたの番です';
    render();
    return true;
  }
  return false;
}

async function requestJev(position) {
  const currentMatch = match;
  setPhase('thinking');
  elements.notice.textContent = 'Jev が合法手を評価中…';
  elements.model.textContent = '評価中';
  elements.signalCopy.textContent = '候補手の安定性・角・相手の自由度を比較しています。';
  render();

  let current = position;
  while (legalMoves(current, WHITE).length) {
    try {
      const response = await fetch('/api/jev-move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: current }),
      });
      const result = await response.json();
      if (currentMatch !== match) return;
      if (!response.ok) throw new Error(result.error || 'Jev に接続できませんでした。');
      if (!result.move || !getFlips(current, result.move.row, result.move.col, WHITE).length) throw new Error('Jev が不正な手を返しました。');
      current = playMove(current, result.move, WHITE);
      board = current;
      lastMove = result.move.row * 8 + result.move.col;
      elements.model.textContent = result.model || 'JEV';
      elements.lastMove.textContent = moveLabel(result.move);
      elements.confidence.textContent = `${Math.round(result.confidence * 100)}%`;
      elements.remaining.textContent = result.remaining;
      elements.signalCopy.textContent = 'Jev が評価した手を盤面へ反映しました。';
      if (finishOrReturn()) return;
      elements.notice.textContent = 'あなたはパス。Jev がもう一度評価中…';
      render();
    } catch (error) {
      setPhase('human');
      elements.notice.textContent = error instanceof Error ? error.message : 'Jev に接続できませんでした。';
      elements.model.textContent = '停止';
      elements.signalCopy.textContent = 'API呼び出しを止めました。再試行するにはもう一度着手してください。';
      render();
      return;
    }
  }
  finishOrReturn();
}

function playHuman(move) {
  if (phase !== 'human' || !getFlips(board, move.row, move.col, BLACK).length) return;
  setPhase('thinking');
  board = playMove(board, move, BLACK);
  lastMove = move.row * 8 + move.col;
  render();
  if (!legalMoves(board, WHITE).length) {
    if (finishOrReturn()) elements.notice.textContent = 'Jev はパス。あなたの番です';
    return;
  }
  void requestJev(board);
}

function restart() {
  match += 1;
  board = initialBoard();
  lastMove = null;
  setPhase('human');
  elements.notice.textContent = '光っているマスに置けます';
  elements.model.textContent = '待機中';
  elements.lastMove.textContent = '—';
  elements.confidence.textContent = '—';
  elements.signalCopy.textContent = 'あなたが着手すると、Jev が合法手を比較します。';
  render();
}

elements.restart.addEventListener('click', restart);
restart();
