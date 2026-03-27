(function () {
  if (window.__namuGameInit) return;
  window.__namuGameInit = true;

  const SERVER = window.NAMU_GAME_CONFIG?.SERVER_URL || 'http://localhost:3000';

  function getTitle() {
    const match = location.pathname.match(/^\/w\/(.+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  let socket = null;
  let hudEl = null;
  let myPlayerId = null;
  let roomId = null;
  let currentTitle = getTitle();
  let lastReportedTitle = null;
  let latestRoom = null;
  let hudStatus = '세션 확인 중...';
  let lastSeenHref = location.href;
  let disqualified = false;
  let socketInitialized = false;
  const EXPECTED_NEXT_TITLE_KEY = '__namuGameExpectedNextTitle';
  const ROUND_SESSION_KEY = '__namuGameRoundSession';
  const PENDING_NAVIGATION_KEY = '__namuGamePendingNavigation';

  if (!currentTitle) return;

  function createHUD() {
    if (hudEl || !document.body) return;

    hudEl = document.createElement('div');
    hudEl.id = '__namugame_hud';
    hudEl.style.cssText = `
      position: fixed; top: 12px; right: 12px; z-index: 2147483647;
      background: rgba(251, 255, 254, 0.96);
      border: 1px solid rgba(185, 210, 202, 0.95);
      border-radius: 10px; padding: 12px 14px;
      min-width: 200px; max-width: 260px;
      font-family: 'Malgun Gothic', sans-serif;
      font-size: 13px; color: #22312d;
      box-shadow: 0 8px 24px rgba(37, 75, 67, 0.15);
      user-select: none; pointer-events: none;
      line-height: 1.5;
      backdrop-filter: blur(6px);
    `;
    document.body.appendChild(hudEl);
  }

  function hideHUD() {
    if (hudEl?.parentNode) {
      hudEl.parentNode.removeChild(hudEl);
    }
  }

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || ms < 0) return '-';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function getRankColor(rank, disqualified) {
    if (disqualified) return '#c84e4e';
    if (rank === 1) return '#c9a227';
    if (rank === 2) return '#8f98a3';
    if (rank === 3) return '#b87333';
    return '#6b7f79';
  }

  function getExpectedNextTitle() {
    try {
      return sessionStorage.getItem(EXPECTED_NEXT_TITLE_KEY);
    } catch {
      return null;
    }
  }

  function setExpectedNextTitle(title) {
    try {
      if (title) sessionStorage.setItem(EXPECTED_NEXT_TITLE_KEY, title);
      else sessionStorage.removeItem(EXPECTED_NEXT_TITLE_KEY);
    } catch {}
  }

  function getPendingNavigation() {
    try {
      const raw = sessionStorage.getItem(PENDING_NAVIGATION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function setPendingNavigation(navigation) {
    try {
      if (navigation) sessionStorage.setItem(PENDING_NAVIGATION_KEY, JSON.stringify(navigation));
      else sessionStorage.removeItem(PENDING_NAVIGATION_KEY);
    } catch {}
  }

  function getHashRoundSession() {
    const hash = location.hash || '';
    const match = hash.match(/(?:^#|&)ng=([^&]+)/);
    if (!match) return null;
    const [roundIdText, roundToken] = decodeURIComponent(match[1]).split(':');
    const roundId = Number(roundIdText);
    if (!Number.isInteger(roundId) || !roundToken) return null;
    return { roundId, roundToken };
  }

  function getStoredRoundSession() {
    try {
      const raw = sessionStorage.getItem(ROUND_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function setStoredRoundSession(session) {
    try {
      if (session?.roundId && session?.roundToken) {
        sessionStorage.setItem(ROUND_SESSION_KEY, JSON.stringify(session));
      } else {
        sessionStorage.removeItem(ROUND_SESSION_KEY);
      }
    } catch {}
  }

  function getRoundSession() {
    const fromHash = getHashRoundSession();
    if (fromHash) {
      setStoredRoundSession(fromHash);
      return fromHash;
    }
    return getStoredRoundSession();
  }

  function hasAuthorizedRound(room) {
    if (!room || (room.status !== 'playing' && room.status !== 'finished')) return true;
    const roundSession = getRoundSession();
    return !!roundSession
      && roundSession.roundId === room.roundId
      && roundSession.roundToken === room.roundToken;
  }

  function getDisqualifyMessage(reason) {
    if (reason === 'invalid_navigation') return '검색/직접 이동으로 탈락했습니다';
    if (reason === 'back_navigation') return '뒤로가기로 탈락했습니다';
    return '탈락했습니다';
  }

  function canUseExtensionApi() {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id && !!chrome.storage?.local;
  }

  function safeStorageSet(items) {
    if (!canUseExtensionApi()) return;
    try {
      chrome.storage.local.set(items, () => {
        const error = chrome.runtime?.lastError;
        if (error && !String(error.message || '').includes('Extension context invalidated')) {
          console.warn('storage.set failed:', error.message);
        }
      });
    } catch (error) {
      if (!String(error?.message || '').includes('Extension context invalidated')) {
        console.warn('storage.set threw:', error);
      }
    }
  }

  function safeStorageGet(keys, callback) {
    if (!canUseExtensionApi()) return;
    try {
      chrome.storage.local.get(keys, (result) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          if (!String(error.message || '').includes('Extension context invalidated')) {
            console.warn('storage.get failed:', error.message);
          }
          return;
        }
        callback(result);
      });
    } catch (error) {
      if (!String(error?.message || '').includes('Extension context invalidated')) {
        console.warn('storage.get threw:', error);
      }
    }
  }

  function safeStorageRemove(keys) {
    if (!canUseExtensionApi()) return;
    try {
      chrome.storage.local.remove(keys, () => {
        const error = chrome.runtime?.lastError;
        if (error && !String(error.message || '').includes('Extension context invalidated')) {
          console.warn('storage.remove failed:', error.message);
        }
      });
    } catch (error) {
      if (!String(error?.message || '').includes('Extension context invalidated')) {
        console.warn('storage.remove threw:', error);
      }
    }
  }

  function ensureSocketConnected() {
    if (socketInitialized || !roomId || !myPlayerId) return;
    socketInitialized = true;
    socket = io(SERVER);

    socket.on('room:update', (room) => {
      latestRoom = room;
      const me = room.players[myPlayerId];
      disqualified = !!me?.disqualified;
      if (room.status !== 'playing' || me?.disqualified || me?.done) {
        setExpectedNextTitle(null);
        setPendingNavigation(null);
      }
      safeStorageSet({ room });
      syncCurrentTitle();
      if (!hasAuthorizedRound(room)) {
        hideHUD();
        return;
      }
      if (!validateNavigation(room)) return;
      renderHUD(room);
    });

    socket.on('game:finished', ({ players }) => {
      if (!latestRoom) return;
      latestRoom = {
        ...latestRoom,
        status: 'finished',
        players: players || latestRoom.players,
      };
      renderHUD(latestRoom);
    });

    socket.on('connect', () => {
      hudStatus = '서버 연결됨';
      lastReportedTitle = null;
      lastSeenHref = location.href;
      if (!hasAuthorizedRound(latestRoom)) {
        hideHUD();
        return;
      }
      if (!validateCurrentPage(latestRoom)) return;
      reportCurrentPage(true);
    });

    socket.on('disconnect', () => {
      hudStatus = '서버 연결이 끊어졌습니다';
      if (latestRoom?.status === 'playing') renderHUD(latestRoom);
    });

    socket.on('connect_error', () => {
      hudStatus = '서버 연결 실패';
      if (latestRoom?.status === 'playing') renderHUD(latestRoom);
    });
  }

  function applyStoredSession(stored) {
    if (!stored.roomId || !stored.playerId) {
      roomId = null;
      myPlayerId = null;
      latestRoom = null;
      hideHUD();
      return;
    }

    roomId = stored.roomId;
    myPlayerId = stored.playerId;

    if (stored.room) {
      latestRoom = stored.room;
      if ((stored.room.status === 'playing' || stored.room.status === 'finished') && hasAuthorizedRound(stored.room)) {
        renderHUD(stored.room);
      } else {
        hideHUD();
      }
    } else {
      hideHUD();
    }

    ensureSocketConnected();
  }

  function syncCurrentTitle() {
    currentTitle = getTitle();
    return currentTitle;
  }

  function renderHUD(room) {
    if (!hudEl) createHUD();
    if (!hudEl) return;

    if (!document.body.contains(hudEl)) {
      document.body.appendChild(hudEl);
    }

    if (!room) {
      hudEl.innerHTML = `<div style="color:#6b7f79;font-size:12px">${esc(hudStatus)}</div>`;
      return;
    }

    if (room.status !== 'playing' && room.status !== 'finished') {
      hideHUD();
      return;
    }

    const me = room.players[myPlayerId];
    const myElapsedMs = me
      ? (me.done ? me.elapsedMs : (typeof me.startedAt === 'number' ? Date.now() - me.startedAt : null))
      : null;

    let html = `
      <div style="color:#006b60;font-weight:bold;margin-bottom:8px;font-size:13px">나무위키 게임</div>
      <div style="margin-bottom:5px;font-size:12px">
        <span style="color:#6b7f79">목표: </span>
        <span style="color:#006b60;font-weight:bold">${esc(room.endDoc)}</span>
      </div>
      <div style="margin-bottom:8px;font-size:12px;color:#6b7f79">
        현재: ${esc(currentTitle)} &nbsp;|&nbsp; ${formatDuration(myElapsedMs)}
      </div>
    `;

    if (!me) {
      html += '<div style="color:#a07b1e;font-size:12px;margin-bottom:8px">내 플레이어 정보를 찾는 중...</div>';
    }

    if (me && me.disqualified) {
      html += `<div style="color:#c84e4e;font-weight:bold;margin-bottom:8px">${esc(getDisqualifyMessage(me.disqualifyReason))}</div>`;
    }

    const winner = Object.values(room.players).find((player) => player.rank === 1) || null;

    if (winner && winner.id === myPlayerId) {
      html += `<div style="color:#a78017;font-weight:bold;margin-bottom:8px">${me.rank}위 도착!</div>`;
    }

    if (room.status === 'finished') {
      html += '<div style="color:#6b7f79;font-size:12px;margin-bottom:8px">게임 종료</div>';
    }

    if (winner) {
      html += `
        <div style="border-top:1px solid #d8e6e1;padding-top:8px;margin-top:4px;margin-bottom:8px">
          <div style="color:#006b60;font-weight:bold;font-size:12px">${esc(winner.nickname)} 1위 경로</div>
          <div style="color:#6b7f79;font-size:10px;word-break:break-all">${winner.path && winner.path.length ? winner.path.map(esc).join(' → ') : '-'}</div>
        </div>
      `;
    }

    const sorted = Object.values(room.players).sort((a, b) => {
      if (a.disqualified && b.disqualified) return a.nickname.localeCompare(b.nickname);
      if (a.disqualified) return 1;
      if (b.disqualified) return -1;
      if (a.done && b.done) return a.rank - b.rank;
      if (a.done) return -1;
      if (b.done) return 1;
      return (a.startedAt || 0) - (b.startedAt || 0);
    });

    html += '<div style="border-top:1px solid #d8e6e1;padding-top:8px">';
    sorted.forEach((player) => {
      const isMe = player.id === myPlayerId;
      const elapsedMs = player.done
        ? player.elapsedMs
        : (typeof player.startedAt === 'number' ? Date.now() - player.startedAt : null);
      const statusLabel = player.disqualified
        ? '탈락'
        : (player.done ? `${player.rank}위 (${formatDuration(elapsedMs)})` : '');
      const statusColor = getRankColor(player.rank, player.disqualified);
      html += `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
          <span style="color:${isMe ? '#006b60' : '#435752'};${isMe ? 'font-weight:bold' : ''};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px">
            ${isMe ? '▶ ' : ''}${esc(player.nickname)}
          </span>
          <span style="color:${statusColor};font-size:11px;flex-shrink:0">
            ${statusLabel}
          </span>
        </div>
      `;
    });
    html += '</div>';

    if (me && me.path.length > 1) {
      html += `
        <div style="border-top:1px solid #d8e6e1;padding-top:6px;margin-top:4px;font-size:10px;color:#6b7f79;word-break:break-all">
          ${me.path.map(esc).join(' → ')}
        </div>
      `;
    }

    hudEl.innerHTML = html;
  }

  function reportCurrentPage(force) {
    const title = syncCurrentTitle();
    if (!title || !socket || !socket.connected || !roomId || !myPlayerId || disqualified || latestRoom?.status === 'finished') return;
    if (!force && title === lastReportedTitle) return;
    const roundSession = getRoundSession();
    if (!roundSession || (latestRoom && !hasAuthorizedRound(latestRoom))) return;

    hudStatus = '세션 복구 중...';
    renderHUD(latestRoom);
    lastReportedTitle = title;
    socket.emit('room:rejoin', {
      roomId,
      playerId: myPlayerId,
      title,
      roundId: roundSession.roundId,
      roundToken: roundSession.roundToken,
    }, ({ ok, room, error } = {}) => {
      if (!ok || !room) {
        if (error === 'invalid_round_session') {
          setStoredRoundSession(null);
          hideHUD();
          return;
        }
        if (ok === false) {
          latestRoom = null;
          safeStorageRemove(['roomId', 'playerId', 'room', 'activeRoundId']);
          setStoredRoundSession(null);
        }
        if (hudEl) {
          hudEl.innerHTML = '<div style="color:#ff6b6b;font-size:12px">세션 복구 실패</div>';
        }
        return;
      }
      latestRoom = room;
      const me = room.players[myPlayerId];
      disqualified = !!me?.disqualified;
      renderHUD(room);
    });
  }

  function validateNavigation(room) {
    if (!room || room.status !== 'playing') return true;
    if (!hasAuthorizedRound(room)) return true;
    const me = room.players[myPlayerId];
    if (!me || me.disqualified || me.done) return true;

    const expectedNextTitle = getExpectedNextTitle();
    const pendingNavigation = getPendingNavigation();
    const titleChanged = currentTitle !== lastReportedTitle;
    if (!titleChanged) return true;

    if (currentTitle === room.startDoc && me.path.length <= 1) {
      setExpectedNextTitle(null);
      return true;
    }

    if (expectedNextTitle && currentTitle === expectedNextTitle) {
      setExpectedNextTitle(null);
      setPendingNavigation(null);
      return true;
    }

    if (
      pendingNavigation
      && pendingNavigation.fromTitle === lastReportedTitle
      && Date.now() - pendingNavigation.at <= 10000
    ) {
      setExpectedNextTitle(null);
      setPendingNavigation(null);
      return true;
    }

    disqualifyPlayer('invalid_navigation');
    return false;
  }

  function validateCurrentPage(room) {
    syncCurrentTitle();
    if (!room || room.status !== 'playing') return true;
    if (!hasAuthorizedRound(room)) return true;

    const me = room.players[myPlayerId];
    if (!me || me.disqualified || me.done) return true;

    if (currentTitle === room.startDoc && (!me.path || me.path.length === 0)) {
      return true;
    }

    const expectedNextTitle = getExpectedNextTitle();
    if (expectedNextTitle && currentTitle === expectedNextTitle) {
      setExpectedNextTitle(null);
      setPendingNavigation(null);
      return true;
    }

    const pendingNavigation = getPendingNavigation();
    if (
      pendingNavigation
      && pendingNavigation.fromTitle === (me.path?.[me.path.length - 1] || room.startDoc)
      && Date.now() - pendingNavigation.at <= 10000
    ) {
      setExpectedNextTitle(null);
      setPendingNavigation(null);
      return true;
    }

    if (me.path && me.path.length > 0 && currentTitle === me.path[me.path.length - 1]) {
      return true;
    }

    disqualifyPlayer('invalid_navigation');
    return false;
  }

  function handleNavigation(force) {
    const href = location.href;
    const title = syncCurrentTitle();
    if (!title) return;
    if (latestRoom && !hasAuthorizedRound(latestRoom)) {
      hideHUD();
      return;
    }
    if (!force && href === lastSeenHref && title === lastReportedTitle) {
      if (latestRoom) renderHUD(latestRoom);
      return;
    }

    lastSeenHref = href;

    if (!force && title === lastReportedTitle) {
      if (latestRoom) renderHUD(latestRoom);
      return;
    }

    if (latestRoom && !validateNavigation(latestRoom)) return;
    reportCurrentPage(force);
  }

  function disqualifyPlayer(reason) {
    if (disqualified || !socket || !socket.connected || !roomId || !myPlayerId) return;
    disqualified = true;
    hudStatus = getDisqualifyMessage(reason);
    renderHUD(latestRoom);
    socket.emit('player:disqualify', {
      roomId,
      playerId: myPlayerId,
      reason,
    }, ({ ok, room } = {}) => {
      if (!ok || !room) return;
      latestRoom = room;
      const me = room.players[myPlayerId];
      disqualified = !!me?.disqualified;
      safeStorageSet({ room });
      renderHUD(room);
    });
  }

  function installNavigationTracking() {
    const wrapHistoryMethod = (methodName) => {
      const original = history[methodName];
      if (typeof original !== 'function') return;

      history[methodName] = function (...args) {
        const result = original.apply(this, args);
        setTimeout(() => handleNavigation(false), 0);
        return result;
      };
    };

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');

    window.addEventListener('popstate', () => {
      if (latestRoom && !hasAuthorizedRound(latestRoom)) return;
      disqualifyPlayer('back_navigation');
      handleNavigation(false);
    });
    window.addEventListener('hashchange', () => handleNavigation(false));

    setInterval(() => {
      handleNavigation(false);
    }, 1500);

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!target) return;
      if (event.defaultPrevented) return;

      const href = target.getAttribute('href');
      if (!href || !href.startsWith('/w/')) return;
      if (latestRoom && !hasAuthorizedRound(latestRoom)) return;

      const opensNewTab = target.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;
      if (opensNewTab) {
        disqualifyPlayer('invalid_navigation');
        return;
      }

      const nextTitle = decodeURIComponent(href.slice(3));
      if (!nextTitle || nextTitle === currentTitle) return;
      setExpectedNextTitle(nextTitle);
      setPendingNavigation({
        fromTitle: currentTitle,
        at: Date.now(),
      });
    }, true);

    document.addEventListener('auxclick', (event) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!target) return;

      const href = target.getAttribute('href');
      if (!href || !href.startsWith('/w/')) return;
      if (latestRoom && !hasAuthorizedRound(latestRoom)) return;
      disqualifyPlayer('invalid_navigation');
    }, true);
  }

  installNavigationTracking();

  safeStorageGet(['roomId', 'playerId', 'room'], (stored) => {
    applyStoredSession(stored);
  });

  if (canUseExtensionApi()) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (!Object.prototype.hasOwnProperty.call(changes, 'roomId')
        && !Object.prototype.hasOwnProperty.call(changes, 'playerId')
        && !Object.prototype.hasOwnProperty.call(changes, 'room')) {
        return;
      }

      safeStorageGet(['roomId', 'playerId', 'room'], (stored) => {
        applyStoredSession(stored);
      });
    });
  }
})();
