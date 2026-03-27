// 나무위키 게임 - background service worker
// 로비 및 인게임 소켓은 popup.js / content.js 에서 직접 관리
chrome.runtime.onInstalled.addListener(() => {
  console.log('나무위키 게임 익스텐션 설치됨');
});
