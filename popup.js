const SERVER = window.NAMU_GAME_CONFIG?.SERVER_URL || 'http://localhost:3000';

let socket = null;
let playingTimer = null;
let countdownTimer = null;
let myState = {
  roomId: null,
  playerId: null,
  nickname: null,
  isHost: false,
  room: null,
};
let roomCodeVisible = false;

function generateId() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function showScreen(name) {
  ['setup', 'lobby', 'countdown', 'playing'].forEach((screen) => {
    document.getElementById(`screen-${screen}`).classList.remove('screen-visible');
  });
  document.getElementById(`screen-${name}`).classList.add('screen-visible');
}

function syncPlayingTimer() {
  if (playingTimer) {
    clearInterval(playingTimer);
    playingTimer = null;
  }

  if (myState.room && myState.room.status === 'playing') {
    playingTimer = setInterval(() => {
      if (myState.room) renderPlaying(myState.room);
    }, 1000);
  }
}

function syncCountdownTimer() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  if (myState.room && myState.room.status === 'countdown') {
    countdownTimer = setInterval(() => {
      if (myState.room) renderCountdown(myState.room);
    }, 250);
  }
}

function showMessage(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  if (!msg) return;
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = '';
  }, 3000);
}

function showError(msg) {
  showMessage('setup-error', msg);
}

function showLobbyError(msg) {
  showMessage('lobby-error', msg);
}

function switchTab(tab) {
  document.getElementById('tab-create').className = 'tab-btn' + (tab === 'create' ? ' active' : '');
  document.getElementById('tab-join').className = 'tab-btn' + (tab === 'join' ? ' active' : '');
  document.getElementById('panel-create').style.display = tab === 'create' ? 'block' : 'none';
  document.getElementById('panel-join').style.display = tab === 'join' ? 'block' : 'none';
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || ms < 0) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getRankColor(rank, disqualified) {
  if (disqualified) return '#ff6b6b';
  if (rank === 1) return '#c9a227';
  if (rank === 2) return '#8f98a3';
  if (rank === 3) return '#b87333';
  return '';
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clearRoundSession() {
  chrome.storage.local.remove(['activeRoundId']);
}

function clearLocalSession() {
  clearRoundSession();
  chrome.storage.local.remove(['roomId', 'playerId', 'nickname', 'isHost', 'room', 'activeRoundId']);
}

function persistRoomState(room, extra = {}) {
  myState.room = room;
  if (room && myState.playerId) {
    const nextIsHost = room.hostPlayerId === myState.playerId;
    myState.isHost = nextIsHost;
    chrome.storage.local.set({ room, isHost: nextIsHost, ...extra });
    return;
  }
  chrome.storage.local.set({ room, ...extra });
}

function renderRoomScreen(room) {
  if (!room) return;
  if (room.status === 'waiting') renderLobby(room);
  else if (room.status === 'countdown') renderCountdown(room);
  else renderPlaying(room);
}

function getMaskedRoomCode(roomId) {
  if (!roomId) return '••••••';
  return '•'.repeat(Math.max(roomId.length, 6));
}

function updateRoomCodeDisplay() {
  const codeEl = document.getElementById('room-code-display');
  if (!codeEl) return;

  const code = myState.roomId || '';
  codeEl.textContent = roomCodeVisible ? code : getMaskedRoomCode(code);
  codeEl.style.letterSpacing = roomCodeVisible ? '6px' : '3px';
}

function connectSocket(cb) {
  if (socket && socket.connected) {
    cb();
    return;
  }

  socket = io(SERVER);
  socket.on('connect', cb);

  socket.on('room:update', (room) => {
    persistRoomState(room);
    renderRoomScreen(room);
    syncPlayingTimer();
    syncCountdownTimer();
  });

  socket.on('game:countdown', ({ sec }) => {
    renderCountdown({ countdownSec: sec });
  });

  socket.on('game:go', ({ startDoc, roundId, roundToken }) => {
    chrome.storage.local.set({ activeRoundId: roundId ?? null });
    const hash = roundId && roundToken
      ? `#ng=${encodeURIComponent(`${roundId}:${roundToken}`)}`
      : '';
    chrome.tabs.create({ url: `https://namu.wiki/w/${encodeURIComponent(startDoc)}${hash}` });
    if (myState.room) {
      document.getElementById('playing-end').textContent = myState.room.endDoc;
    }
    showScreen('playing');
  });

  socket.on('game:finished', ({ players }) => {
    if (!myState.room) return;
    const room = {
      ...myState.room,
      status: 'finished',
      players: players || myState.room.players,
    };
    persistRoomState(room);
    renderPlaying(room);
    syncPlayingTimer();
    syncCountdownTimer();
  });

  socket.on('connect_error', () => {
    showError('서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요.');
  });

  socket.on('game:start:blocked', ({ missingPlayers } = {}) => {
    showLobbyError('준비되지 않은 플레이어가 있습니다. 확장 아이콘을 눌러 준비해주세요.');
  });
}

function renderLobby(room) {
  showScreen('lobby');
  syncPlayingTimer();
  syncCountdownTimer();

  updateRoomCodeDisplay();
  document.getElementById('lobby-start').textContent = room.startDoc || '-';
  document.getElementById('lobby-end').textContent = room.endDoc || '-';

  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  Object.values(room.players).forEach((player) => {
    const popupReady = !!player.popupSocketId;
    const div = document.createElement('div');
    div.className = 'player-item';
    div.innerHTML = `
      <div class="player-dot" style="background:#4caf50"></div>
      <span class="player-name">${escHtml(player.nickname)}</span>
      ${player.id === room.hostPlayerId ? '<span class="host-badge">호스트</span>' : ''}
      <span class="ready-badge ${popupReady ? 'ready-on' : 'ready-off'}">${popupReady ? '준비됨' : '미준비'}</span>
    `;
    list.appendChild(div);
  });

  const startInput = document.getElementById('lobby-start-input');
  const endInput = document.getElementById('lobby-end-input');
  const isHost = myState.isHost;
  document.getElementById('lobby-doc-editor').style.display = isHost ? 'block' : 'none';
  document.getElementById('btn-start').style.display = isHost ? 'block' : 'none';
  document.getElementById('lobby-status').style.display = isHost ? 'none' : 'block';

  if (document.activeElement !== startInput) startInput.value = room.startDoc || '';
  if (document.activeElement !== endInput) endInput.value = room.endDoc || '';
}

function renderPlaying(room) {
  if (document.getElementById('screen-countdown').classList.contains('screen-visible')) return;

  showScreen('playing');
  syncPlayingTimer();
  syncCountdownTimer();
  document.getElementById('playing-end').textContent = room.endDoc;

  const allDone = room.status === 'finished';
  document.getElementById('playing-status').textContent = allDone
    ? '게임 종료!'
    : '1위 경로가 공개되면 나머지도 계속 진행합니다.';
  renderWinner(room);

  const list = document.getElementById('playing-players');
  list.innerHTML = '';

  const sorted = Object.values(room.players).sort((a, b) => {
    if (a.disqualified && b.disqualified) return a.nickname.localeCompare(b.nickname);
    if (a.disqualified) return 1;
    if (b.disqualified) return -1;
    if (a.done && b.done) return a.rank - b.rank;
    if (a.done) return -1;
    if (b.done) return 1;
    return (a.startedAt || 0) - (b.startedAt || 0);
  });

  sorted.forEach((player) => {
    const isMe = player.id === myState.playerId;
    const elapsedMs = player.done
      ? player.elapsedMs
      : (typeof player.startedAt === 'number' ? Date.now() - player.startedAt : null);
    const statusLabel = player.disqualified
      ? '탈락'
      : (player.done ? `${player.rank}위 (${formatDuration(elapsedMs)})` : '');
    const statusColor = getRankColor(player.rank, player.disqualified);

    const div = document.createElement('div');
    div.className = 'player-item';
    div.innerHTML = `
      <span class="player-name" style="${isMe ? 'color:#a8dadc;font-weight:bold' : ''}">${isMe ? '▶ ' : ''}${escHtml(player.nickname)}</span>
      <span class="player-stat" style="${statusColor ? `color:${statusColor}` : ''}">${statusLabel}</span>
    `;
    list.appendChild(div);
  });

  document.getElementById('btn-replay').style.display = myState.isHost ? 'block' : 'none';
  document.getElementById('btn-leave-playing').style.display = 'block';
}

function renderCountdown(room) {
  showScreen('countdown');
  const sec = getCountdownValue(room);
  document.getElementById('countdown-num').textContent = String(sec);
}

function getCountdownValue(room) {
  if (typeof room.countdownEndsAt === 'number') {
    const remainingMs = room.countdownEndsAt - Date.now();
    return Math.max(0, Math.ceil(remainingMs / 1000) - 1);
  }
  return room.countdownSec ?? 3;
}

function renderWinner(room) {
  const winnerBox = document.getElementById('winner-box');
  const winner = Object.values(room.players).find((player) => player.rank === 1) || null;
  if (!winner) {
    winnerBox.style.display = 'none';
    return;
  }

  winnerBox.style.display = 'block';
  document.getElementById('winner-name').textContent = winner.nickname;
  document.getElementById('winner-path').textContent = winner.path && winner.path.length
    ? winner.path.join(' → ')
    : '-';
}

function createRoom() {
  const nickname = document.getElementById('nickname').value.trim();
  if (!nickname) return showError('닉네임을 입력해주세요.');

  const playerId = generateId();
  myState.playerId = playerId;
  myState.nickname = nickname;
  myState.isHost = true;

  connectSocket(() => {
    socket.emit('room:create', { nickname, playerId }, ({ ok, roomId, room }) => {
      if (!ok) return showError('방 생성에 실패했습니다.');
      myState.roomId = roomId;
      roomCodeVisible = false;
      persistRoomState(room, { roomId, playerId, nickname, isHost: true });
      renderLobby(room);
    });
  });
}

function joinRoom() {
  const nickname = document.getElementById('nickname').value.trim();
  const roomId = document.getElementById('roomCode').value.trim().toUpperCase();

  if (!nickname) return showError('닉네임을 입력해주세요.');
  if (!roomId) return showError('방 코드를 입력해주세요.');

  const playerId = generateId();
  myState.playerId = playerId;
  myState.nickname = nickname;
  myState.isHost = false;

  connectSocket(() => {
    socket.emit('room:join', { roomId, nickname, playerId }, ({ ok, room, error }) => {
      if (!ok) return showError(error || '입장에 실패했습니다.');
      myState.roomId = roomId;
      roomCodeVisible = false;
      persistRoomState(room, { roomId, playerId, nickname, isHost: false });
      renderLobby(room);
    });
  });
}

function applyLobbyDocs(callback) {
  if (!socket || !myState.roomId || !myState.playerId) return;

  const startDoc = document.getElementById('lobby-start-input').value.trim();
  const endDoc = document.getElementById('lobby-end-input').value.trim();

  if (!startDoc || !endDoc) {
    showLobbyError('출발/도착 문서를 입력해주세요.');
    return;
  }
  if (startDoc === endDoc) {
    showLobbyError('출발과 도착 문서가 같습니다.');
    return;
  }

  socket.emit('room:update-docs', {
    roomId: myState.roomId,
    playerId: myState.playerId,
    startDoc,
    endDoc,
  }, ({ ok, room, error }) => {
    if (!ok || !room) {
      showLobbyError(error || '문서 설정에 실패했습니다.');
      return;
    }
    persistRoomState(room);
    renderLobby(room);
    callback?.(room);
  });
}

function setRoomCodeVisibility(visible) {
  roomCodeVisible = visible;
  updateRoomCodeDisplay();
}

function copyRoomCode() {
  const code = myState.roomId || '';
  if (!roomCodeVisible || !code) return;
  navigator.clipboard.writeText(code).catch(() => {});
  const codeEl = document.getElementById('room-code-display');
  const original = codeEl?.textContent || code;
  if (codeEl) {
    codeEl.textContent = '복사됨!';
    codeEl.style.letterSpacing = '0';
  }
  setTimeout(() => {
    if (!codeEl) return;
    const stillHovering = codeEl.matches(':hover');
    roomCodeVisible = stillHovering;
    codeEl.textContent = stillHovering ? code : getMaskedRoomCode(code);
    codeEl.style.letterSpacing = stillHovering ? '6px' : '3px';
  }, 1000);
}

function startGame() {
  if (!myState.isHost) return;
  applyLobbyDocs(() => {
    if (socket) socket.emit('game:start');
  });
}

function replayGame() {
  clearRoundSession();
  if (socket) socket.emit('game:replay');
}

function leaveRoom() {
  const finalizeLeave = () => {
    if (socket) socket.disconnect();
    socket = null;
    syncPlayingTimer();
    syncCountdownTimer();
    clearLocalSession();
    myState = { roomId: null, playerId: null, nickname: null, isHost: false, room: null };
    roomCodeVisible = false;
    showScreen('setup');
  };

  if (socket && socket.connected && myState.roomId && myState.playerId) {
    socket.emit('room:leave', {
      roomId: myState.roomId,
      playerId: myState.playerId,
    }, () => finalizeLeave());
    return;
  }

  finalizeLeave();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tab-create').addEventListener('click', () => switchTab('create'));
  document.getElementById('tab-join').addEventListener('click', () => switchTab('join'));
  document.getElementById('btn-create-room').addEventListener('click', createRoom);
  document.getElementById('btn-join-room').addEventListener('click', joinRoom);
  document.getElementById('room-code-display').addEventListener('mouseenter', () => setRoomCodeVisibility(true));
  document.getElementById('room-code-display').addEventListener('mouseleave', () => setRoomCodeVisibility(false));
  document.getElementById('room-code-display').addEventListener('click', copyRoomCode);
  document.getElementById('btn-apply-docs').addEventListener('click', () => applyLobbyDocs());
  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-leave-lobby').addEventListener('click', leaveRoom);
  document.getElementById('btn-replay').addEventListener('click', replayGame);
  document.getElementById('btn-leave-playing').addEventListener('click', leaveRoom);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (Object.prototype.hasOwnProperty.call(changes, 'room')) {
    myState.room = changes.room.newValue || null;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'roomId')) {
    myState.roomId = changes.roomId.newValue || null;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'playerId')) {
    myState.playerId = changes.playerId.newValue || null;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'nickname')) {
    myState.nickname = changes.nickname.newValue || null;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'isHost')) {
    myState.isHost = !!changes.isHost.newValue;
  }

  if (!myState.roomId || !myState.playerId) {
    syncPlayingTimer();
    syncCountdownTimer();
    showScreen('setup');
    return;
  }

  if (myState.room) {
    renderRoomScreen(myState.room);
  }
});

chrome.storage.local.get(['roomId', 'playerId', 'nickname', 'isHost'], ({ roomId, playerId, nickname, isHost }) => {
  if (roomId && playerId && nickname) {
    myState.roomId = roomId;
    myState.playerId = playerId;
    myState.nickname = nickname;
    myState.isHost = !!isHost;

    connectSocket(() => {
      socket.emit('room:get', { roomId, playerId }, ({ ok, room }) => {
        if (!ok) {
          clearLocalSession();
          showScreen('setup');
          return;
        }
        persistRoomState(room);
        renderRoomScreen(room);
      });
    });
  } else {
    showScreen('setup');
  }
});
