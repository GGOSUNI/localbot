import type { OverlayMessage, PlayerCommand } from '@localbot/shared';
import { connectOverlay, inOBS, overlayKey, params } from './common.ts';

/**
 * 신청곡 플레이어. 서버 명령을 받아 소리만 냅니다 (상태는 서버가 가짐).
 * YouTube는 IFrame Player API, 로컬 파일은 <audio>.
 * 1초마다 하트비트를 보내 서버 워치독이 멈춤을 감지할 수 있게 합니다.
 */

// ── 최소 YouTube IFrame API 타입 ──
interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  mute(): void;
  unMute(): void;
  setVolume(v: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData?(): { video_id?: string };
}
declare global {
  interface Window {
    YT?: { Player: new (id: string, o: unknown) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}
const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

const $ = (id: string) => document.getElementById(id)!;
const audio = $('audio') as HTMLAudioElement;
if (!inOBS && params.get('hide') !== '1') document.body.classList.add('browser');

let master = false;
let seq = 0;
let current: Extract<PlayerCommand, { op: 'play' }> | null = null;
let volume = 60;
let paused = false;
let endedSent = -1;
let blocked = false;
let loadStartedAt = 0;
/** 이 seq의 곡이 실제로 재생(PLAYING)된 적 있는지 — 이전 곡의 늦은 '끝남' 신호를 걸러내기 위함 */
let playedSeq = -1;

// ── YouTube 로딩 ──
let ytMain: YTPlayer | null = null;
let ytPre: YTPlayer | null = null;
let ytReady: Promise<void> | null = null;
let prefetchId: number | null = null;
let prefetchTimer: number | undefined;

function loadYT(): Promise<void> {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ytReady = null; // 다음에 다시 시도
      reject(new Error('YouTube API load timeout'));
    }, 15_000);
    window.onYouTubeIframeAPIReady = () => {
      let n = 0;
      const done = () => ++n === 2 && (clearTimeout(timeout), resolve());
      const vars = { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin };
      ytMain = new window.YT!.Player('yt-main', {
        width: 480, height: 270, playerVars: vars,
        events: { onReady: done, onStateChange: onMainState, onError: (e: { data: number }) => onMainError(e.data) },
      });
      ytPre = new window.YT!.Player('yt-pre', {
        width: 480, height: 270, playerVars: vars,
        events: { onReady: done, onStateChange: onPreState, onError: (e: { data: number }) => onPreError(e.data) },
      });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      clearTimeout(timeout);
      ytReady = null;
      reject(new Error('YouTube API blocked'));
    };
    document.head.append(s);
  });
  return ytReady;
}

// ── 서버 연결 ──
const conn = connectOverlay('player', onMessage, (up) => {
  if (!up) setRole(null);
});

function onMessage(m: OverlayMessage) {
  if (m.type === 'player.role') {
    setRole(m.master);
    if (!m.master) stopAll();
  } else if (m.type === 'player.cmd' && master) {
    handle(m.cmd);
  } else if (m.type === 'songs') {
    const np = m.state.now;
    $('title').textContent = np ? np.track.title : '재생 중인 곡 없음';
    $('sub').textContent = np ? (np.requesterName ? `신청: ${np.requesterName}` : '스테이션') : '';
  }
}

function setRole(isMaster: boolean | null) {
  master = !!isMaster;
  const r = $('role');
  r.textContent = isMaster === null ? '서버 연결 끊김' : isMaster ? '재생 담당' : '대기 (다른 곳에서 재생 중)';
  r.className = isMaster ? 'badge ok' : 'badge';
}

async function handle(cmd: PlayerCommand) {
  switch (cmd.op) {
    case 'play': {
      stopAll();
      seq = cmd.seq;
      current = cmd;
      volume = cmd.volume;
      paused = cmd.paused;
      endedSent = -1;
      loadStartedAt = Date.now();
      if (cmd.track.source === 'local') {
        audio.src = `/media/${cmd.track.id}?key=${encodeURIComponent(overlayKey)}`;
        audio.volume = volume / 100;
        audio.currentTime = 0;
        const start = () => {
          if (cmd.position > 0) audio.currentTime = cmd.position;
          if (!paused) audio.play().catch(onBlocked);
        };
        audio.readyState >= 1 ? start() : audio.addEventListener('loadedmetadata', start, { once: true });
      } else {
        try {
          await loadYT();
        } catch {
          return conn.send({ type: 'player.error', seq: cmd.seq, code: 'youtube-unreachable' });
        }
        if (seq !== cmd.seq) return;
        ytMain!.setVolume(volume);
        ytMain!.unMute();
        ytMain!.loadVideoById({ videoId: cmd.track.ref, startSeconds: Math.max(0, cmd.position) });
        if (paused) setTimeout(() => seq === cmd.seq && ytMain?.pauseVideo(), 500);
      }
      break;
    }
    case 'pause':
      paused = true;
      audio.pause();
      ytMain?.pauseVideo();
      break;
    case 'resume':
      paused = false;
      if (current?.track.source === 'local') audio.play().catch(onBlocked);
      else ytMain?.playVideo();
      break;
    case 'stop':
      seq = cmd.seq;
      current = null;
      stopAll();
      break;
    case 'volume':
      volume = cmd.volume;
      audio.volume = volume / 100;
      ytMain?.setVolume(volume);
      break;
    case 'prefetch':
      prefetch(cmd.trackId, cmd.ref);
      break;
  }
}

function stopAll() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  try {
    ytMain?.stopVideo();
  } catch {
    /* 아직 준비 안 됨 */
  }
  blocked = false;
  $('unlock').classList.remove('show');
}

// ── 메인 플레이어 이벤트 ──
/**
 * YouTube 이벤트는 iframe에서 늦게 도착합니다. 스킵 직후 '이전 곡'의 끝남/오류 신호가
 * 새 곡의 것으로 착각되면 곡이 연쇄로 넘어가므로, 지금 곡의 신호인지 반드시 확인합니다.
 */
function isCurrentVideo(): boolean {
  if (current?.track.source !== 'youtube' || !ytMain) return false;
  const id = ytMain.getVideoData?.()?.video_id;
  return id ? id === current.track.ref : Date.now() - loadStartedAt > 1500;
}
function onMainState(e: { data: number }) {
  if (e.data === YT_STATE.PLAYING && isCurrentVideo()) {
    playedSeq = seq;
    clearBlocked();
  }
  // 실제로 재생된 적 있는 지금 곡만 '끝남'으로 인정
  if (e.data === YT_STATE.ENDED && playedSeq === seq && isCurrentVideo()) sendEnded();
}
function onMainError(code: number) {
  if (isCurrentVideo()) conn.send({ type: 'player.error', seq, code });
}
const isCurrentAudio = () => current?.track.source === 'local' && audio.currentSrc.includes(`/media/${current.track.id}?`);
audio.addEventListener('playing', () => isCurrentAudio() && (playedSeq = seq));
audio.addEventListener('ended', () => isCurrentAudio() && playedSeq === seq && sendEnded());
// src를 비울 때 나는 오류(이전 곡)는 무시
audio.addEventListener('error', () => isCurrentAudio() && conn.send({ type: 'player.error', seq, code: 'media' }));
audio.addEventListener('playing', clearBlocked);

function sendEnded() {
  if (endedSent === seq) return;
  endedSent = seq;
  conn.send({ type: 'player.ended', seq });
}

// ── 자동재생 차단 (일반 브라우저 탭에서만 생김. OBS는 허용) ──
// 페이지가 열릴 때 무음 소리를 실제로 재생해 보고 판단합니다.
let autoplay: 'unknown' | 'allowed' | 'blocked' = 'unknown';
void (async () => {
  const silent = new Audio(silentWav());
  try {
    await silent.play();
    autoplay = 'allowed';
  } catch (e) {
    autoplay = (e as DOMException)?.name === 'NotAllowedError' ? 'blocked' : 'allowed';
  }
})();
function silentWav(): string {
  const n = 800;
  const b = new DataView(new ArrayBuffer(44 + n));
  const w = (o: number, str: string) => [...str].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true);
  b.setUint16(22, 1, true); b.setUint32(24, 8000, true); b.setUint32(28, 8000, true); b.setUint16(32, 1, true);
  b.setUint16(34, 8, true); w(36, 'data'); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }));
}
function onBlocked() {
  blocked = true;
  $('unlock').classList.add('show');
}
function clearBlocked() {
  blocked = false;
  if (navigator.userActivation?.hasBeenActive) autoplay = 'allowed';
  $('unlock').classList.remove('show');
}
$('unlock').addEventListener('click', () => {
  clearBlocked();
  if (current?.track.source === 'local') audio.play().catch(onBlocked);
  else ytMain?.playVideo();
});

// ── 하트비트 ──
setInterval(() => {
  if (!master || !current) return;
  let state: 'loading' | 'playing' | 'paused' | 'buffering' | 'blocked';
  let time = 0;
  let duration: number | null = null;
  if (current.track.source === 'local') {
    time = audio.currentTime || 0;
    duration = Number.isFinite(audio.duration) ? audio.duration : null;
    state = audio.readyState < 2 ? 'loading' : audio.paused ? (paused ? 'paused' : 'loading') : 'playing';
  } else if (ytMain) {
    const s = ytMain.getPlayerState();
    time = ytMain.getCurrentTime() || 0;
    duration = ytMain.getDuration() || null;
    state = s === YT_STATE.PLAYING ? 'playing' : s === YT_STATE.PAUSED ? 'paused' : s === YT_STATE.BUFFERING ? 'buffering' : 'loading';
    // 자동재생이 실제로 막힌 브라우저에서만 '클릭 필요'로 판단 (추측하지 않음 — 추측이 틀리면 워치독이 멈춤)
    if (autoplay === 'blocked' && !paused && s !== YT_STATE.PLAYING && Date.now() - loadStartedAt > 3000) onBlocked();
  } else {
    state = 'loading';
  }
  if (blocked) state = 'blocked';
  conn.send({ type: 'player.hb', seq, state, time, duration });
  const bar = $('bar').firstElementChild as HTMLElement;
  bar.style.width = duration ? `${Math.min(100, (time / duration) * 100)}%` : '0';
}, 1000);

// ── 프리페치: 다음 곡을 숨은 플레이어로 미리 불러 재생 가능한지 확인 ──
async function prefetch(trackId: number, ref: string) {
  try {
    await loadYT();
  } catch {
    return;
  }
  prefetchId = trackId;
  clearTimeout(prefetchTimer);
  ytPre!.mute();
  ytPre!.loadVideoById({ videoId: ref });
  prefetchTimer = window.setTimeout(() => {
    // 판정 불가 (느린 네트워크 등) → 보고하지 않음. 실제 재생 때 워치독이 처리
    if (prefetchId === trackId) {
      ytPre?.stopVideo();
      prefetchId = null;
    }
  }, 20_000);
}
function onPreState(e: { data: number }) {
  if (prefetchId === null || e.data !== YT_STATE.PLAYING) return;
  const id = prefetchId;
  const duration = ytPre!.getDuration() || null;
  prefetchId = null;
  clearTimeout(prefetchTimer);
  ytPre!.stopVideo();
  conn.send({ type: 'player.verified', trackId: id, ok: true, duration });
}
function onPreError(code: number) {
  if (prefetchId === null) return;
  const id = prefetchId;
  prefetchId = null;
  clearTimeout(prefetchTimer);
  conn.send({ type: 'player.verified', trackId: id, ok: false, duration: null, code });
}
