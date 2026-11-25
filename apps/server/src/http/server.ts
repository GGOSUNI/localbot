import { statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ConnectionState, Envelope, OfficialStatus, OverlayMessage, OverlayReport, ServerMessage } from '@localbot/shared';
import type { ServerWebSocket } from 'bun';
import type { ChzzkOfficial } from '../adapters/chzzk/official.ts';
import { REDIRECT_PATH } from '../adapters/chzzk/official.ts';
import type { MockAdapter } from '../adapters/mock.ts';
import type { EventBus } from '../core/bus.ts';
import { VERSION } from '../core/config.ts';
import type { ChzzkConnection } from '../core/connection.ts';
import type { Ingest } from '../core/ingest.ts';
import { createLogger } from '../core/logger.ts';
import dashboardPage from '../dashboard/index.html';
import nowPlayingPage from '../overlays/nowplaying.html';
import playerPage from '../overlays/player.html';
import roulettePage from '../overlays/roulette.html';
import { fromShareCode, TEMPLATES, toShareCode } from '../modules/roulette/logic.ts';
import type { RouletteService } from '../modules/roulette/service.ts';
import type { SongService } from '../modules/songs/service.ts';
import type { TtsService } from '../modules/tts/service.ts';
import alertPage from '../overlays/alert.html';
import { csrfOk, hasSession, hostAllowed, sessionCookie, timingSafeEqual } from './security.ts';

const log = createLogger('http');

interface Deps {
  host: string;
  port: number;
  dashboardKey: string;
  overlayKey: () => string;
  regenerateOverlayKey: () => string;
  bus: EventBus;
  ingest: Ingest;
  mock: MockAdapter;
  connection: ChzzkConnection;
  official: ChzzkOfficial;
  onOfficialLogin: (channelId: string) => Promise<void>;
  songs: SongService;
  roulette: RouletteService;
  ytWindow: { setVisible(v: boolean): Promise<void>; isVisible: boolean };
  tts: TtsService;
  workerStartedAt: number;
  onCrashRequested: () => void;
  onQuitRequested: () => void;
}

export interface HttpHandle {
  stop(): void;
  broadcastConnection(state: ConnectionState): void;
  broadcastOfficial(state: OfficialStatus): void;
  broadcastFrame(jpeg: string): void;
  broadcastTts(): void;
  broadcastSongs(): void;
  broadcastRoulette(): void;
}

type WsData =
  | { kind: 'dashboard' }
  | { kind: 'overlay'; id: string; role: 'player' | 'overlay' | 'alert' };

type Json = Record<string, any>;
type Route = { method: string; re: RegExp; fn: (m: RegExpMatchArray, body: Json) => unknown | Promise<unknown> };

export function startHttp(deps: Deps): HttpHandle {
  const dashboards = new Set<ServerWebSocket<WsData>>();
  let lastFrame: string | null = null; // 새로 연 대시보드에도 영상 화면을 바로 보여 주기 위함
  const overlays = new Set<ServerWebSocket<WsData>>();
  const json = (data: unknown, status = 200) => Response.json(data, { status });

  const toDash = (m: ServerMessage) => {
    const s = JSON.stringify(m);
    for (const ws of dashboards) ws.send(s);
  };
  const toOverlays = (m: OverlayMessage) => {
    const s = JSON.stringify(m);
    for (const ws of overlays) ws.send(s);
  };
  deps.bus.on((envelope: Envelope) => toDash({ type: 'event', envelope }));

  // 상태 변경이 몰려도 한 틱에 한 번만 보냄
  let songsDirty = false;
  let rouletteDirty = false;
  const broadcastSongs = () => {
    if (songsDirty) return;
    songsDirty = true;
    queueMicrotask(() => {
      songsDirty = false;
      const state = deps.songs.state();
      toDash({ type: 'songs', state });
      toOverlays({ type: 'songs', state: { now: state.now, paused: state.paused, queue: state.queue.slice(0, 10) } });
    });
  };
  const broadcastRoulette = () => {
    if (rouletteDirty) return;
    rouletteDirty = true;
    queueMicrotask(() => {
      rouletteDirty = false;
      toDash({ type: 'roulette', state: deps.roulette.state() });
    });
  };

  // ── REST (대시보드 세션 + CSRF 헤더 필요) ──
  const S = deps.songs;
  const R = deps.roulette;
  const id = (m: RegExpMatchArray) => Number(m[1]);
  const ok = { ok: true };
  const routes: Route[] = [
    { method: 'GET', re: /^\/api\/connection$/, fn: () => deps.connection.state },
    { method: 'POST', re: /^\/api\/connection$/, fn: (_, b) => deps.connection.setChannel(String(b.input ?? '')) },
    { method: 'POST', re: /^\/api\/connection\/clear$/, fn: async () => (await deps.connection.clear(), ok) },
    { method: 'GET', re: /^\/api\/official$/, fn: () => deps.official.status() },
    { method: 'POST', re: /^\/api\/official\/config$/, fn: (_, b) => deps.official.configure(String(b.clientId ?? ''), String(b.clientSecret ?? '')) },
    { method: 'POST', re: /^\/api\/official\/logout$/, fn: async () => (await deps.official.logout(), ok) },
    { method: 'POST', re: /^\/api\/official\/forget$/, fn: () => (deps.official.forget(), ok) },
    {
      method: 'POST', re: /^\/api\/official\/test$/, fn: async (_, b) => {
        if (!deps.official.canSend) return { ok: false, error: '먼저 치지직으로 로그인해 주세요' };
        const sent = await deps.official.sendChat(String(b.message ?? '🤖 LocalBot 연결 테스트'));
        return sent ? ok : { ok: false, error: deps.official.status().error ?? '전송 실패' };
      },
    },
    { method: 'POST', re: /^\/api\/app\/quit$/, fn: () => (setTimeout(deps.onQuitRequested, 50), ok) },
    { method: 'POST', re: /^\/api\/debug\/crash$/, fn: () => (setTimeout(deps.onCrashRequested, 50), { ok: true, crashing: process.pid }) },
    {
      method: 'POST', re: /^\/api\/mock\/chat$/, fn: (_, b) => {
        const roles = b.manager ? ['manager' as const] : ['viewer' as const];
        deps.mock.chat(str(b.nickname, '테스트시청자'), str(b.text, '안녕하세요'), roles);
        return ok;
      },
    },
    {
      method: 'POST', re: /^\/api\/mock\/donation$/, fn: (_, b) => {
        const amount = Math.floor(Number(b.amount));
        if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: '금액을 확인해 주세요' };
        const nick = typeof b.nickname === 'string' && b.nickname.trim() ? b.nickname.trim() : null;
        deps.mock.donation(nick, amount, typeof b.text === 'string' ? b.text : undefined);
        return ok;
      },
    },
    { method: 'GET', re: /^\/api\/events$/, fn: () => deps.ingest.recent(100) },
    { method: 'GET', re: /^\/api\/overlay-key$/, fn: () => ({ key: deps.overlayKey() }) },
    { method: 'POST', re: /^\/api\/overlay-key\/regenerate$/, fn: () => ({ key: deps.regenerateOverlayKey() }) },

    // 신청곡
    { method: 'GET', re: /^\/api\/songs$/, fn: () => S.state() },
    {
      method: 'POST', re: /^\/api\/songs\/request$/, fn: async (_, b) => {
        const r = await S.requestByInput({ text: String(b.input ?? ''), viewer: null, via: 'dashboard' });
        return { ok: r.ok, message: r.message };
      },
    },
    { method: 'POST', re: /^\/api\/songs\/skip$/, fn: () => (S.skip(), ok) },
    { method: 'POST', re: /^\/api\/songs\/pause$/, fn: () => (S.engine.pause(), ok) },
    { method: 'POST', re: /^\/api\/songs\/resume$/, fn: () => (S.engine.resume(), ok) },
    { method: 'POST', re: /^\/api\/songs\/volume$/, fn: (_, b) => (S.engine.setVolume(Number(b.volume)), ok) },
    { method: 'GET', re: /^\/api\/tts$/, fn: () => deps.tts.state() },
    { method: 'POST', re: /^\/api\/tts\/settings$/, fn: (_, b) => deps.tts.setSettings(b) },
    { method: 'POST', re: /^\/api\/tts\/test$/, fn: (_, b) => (deps.tts.test(typeof b.text === 'string' && b.text.trim() ? b.text : undefined), ok) },
    { method: 'POST', re: /^\/api\/tts\/skip$/, fn: () => (deps.tts.skip(), ok) },
    { method: 'POST', re: /^\/api\/tts\/clear$/, fn: () => (deps.tts.clear(), ok) },
    { method: 'POST', re: /^\/api\/songs\/window$/, fn: async (_, b) => (await deps.ytWindow.setVisible(!!b.visible), { ok: true, visible: deps.ytWindow.isVisible }) },
    { method: 'POST', re: /^\/api\/songs\/retry-youtube$/, fn: () => (S.engine.endFallback(), ok) },
    { method: 'POST', re: /^\/api\/songs\/undo$/, fn: () => ({ ok: true, undone: S.undo() }) },
    { method: 'POST', re: /^\/api\/songs\/clear$/, fn: () => (S.clearQueue(), ok) },
    { method: 'POST', re: /^\/api\/songs\/policy$/, fn: (_, b) => S.setPolicy(b) },
    { method: 'POST', re: /^\/api\/songs\/queue\/(\d+)\/remove$/, fn: (m) => (S.remove(id(m)), ok) },
    { method: 'POST', re: /^\/api\/songs\/queue\/(\d+)\/(top|up|down)$/, fn: (m) => (S.move(id(m), m[2] as 'top'), ok) },
    { method: 'POST', re: /^\/api\/songs\/queue\/(\d+)\/(approve|reject)$/, fn: (m) => (S.approve(id(m), m[2] === 'approve'), ok) },
    { method: 'POST', re: /^\/api\/songs\/stations$/, fn: (_, b) => S.createStation({ name: str(b.name, ''), kind: b.kind === 'local' ? 'local' : 'manual', mode: b.mode === 'sequential' ? 'sequential' : 'shuffle', links: b.links, folder: b.folder }) },
    { method: 'POST', re: /^\/api\/songs\/stations\/(\d+)\/activate$/, fn: (m) => (S.activateStation(id(m)), ok) },
    { method: 'POST', re: /^\/api\/songs\/stations\/off$/, fn: () => (S.activateStation(null), ok) },
    { method: 'POST', re: /^\/api\/songs\/stations\/(\d+)\/delete$/, fn: (m) => (S.deleteStation(id(m)), ok) },
    { method: 'POST', re: /^\/api\/songs\/stations\/(\d+)\/rescan$/, fn: (m) => ({ ok: true, count: S.scanFolder(id(m)) }) },
    { method: 'POST', re: /^\/api\/songs\/stations\/(\d+)\/links$/, fn: async (m, b) => ({ ok: true, added: await S.addToStation(id(m), String(b.links ?? '')) }) },
    { method: 'POST', re: /^\/api\/songs\/stations\/(\d+)\/mode$/, fn: (m, b) => (S.setStationMode(id(m), b.mode === 'sequential' ? 'sequential' : 'shuffle'), ok) },

    // 룰렛
    { method: 'GET', re: /^\/api\/roulette$/, fn: () => R.state() },
    { method: 'GET', re: /^\/api\/roulette\/templates$/, fn: () => TEMPLATES },
    { method: 'POST', re: /^\/api\/roulette$/, fn: (_, b) => R.save(null, b) },
    { method: 'POST', re: /^\/api\/roulette\/(\d+)$/, fn: (m, b) => R.save(id(m), b) },
    { method: 'POST', re: /^\/api\/roulette\/(\d+)\/delete$/, fn: (m) => (R.remove(id(m)), ok) },
    { method: 'POST', re: /^\/api\/roulette\/(\d+)\/move$/, fn: (m, b) => (R.move(id(m), b.dir === -1 ? -1 : 1), ok) },
    { method: 'POST', re: /^\/api\/roulette\/(\d+)\/spin$/, fn: (m, b) => ({ ok: true, spin: R.manualSpin(id(m), Number(b.times) || 1) }) },
    { method: 'GET', re: /^\/api\/roulette\/(\d+)\/stats$/, fn: (m) => R.stats(id(m)) },
    { method: 'GET', re: /^\/api\/roulette\/(\d+)\/share$/, fn: (m) => { const r = R.get(id(m)); return r ? { code: toShareCode(r) } : { error: 'not found' }; } },
    {
      method: 'POST', re: /^\/api\/roulette\/import$/, fn: (_, b) => {
        const shape = fromShareCode(String(b.code ?? ''));
        if (!shape) return { ok: false, error: '공유 코드가 올바르지 않습니다' };
        return R.save(null, { ...shape, enabled: false });
      },
    },
    { method: 'POST', re: /^\/api\/penalties\/(\d+)$/, fn: (m, b) => (R.setPenaltyDone(id(m), !!b.done), ok) },
    { method: 'POST', re: /^\/api\/penalties\/clear-done$/, fn: () => (R.clearDonePenalties(), ok) },
  ];

  const server = Bun.serve<WsData>({
    hostname: deps.host,
    port: deps.port,
    development: false,

    // 페이지(정적 번들)는 비밀이 없어 인증 없이 제공. 데이터는 전부 /api, /ws 에서 인증
    routes: {
      '/': dashboardPage,
      '/o/player': playerPage,
      '/o/nowplaying': nowPlayingPage,
      '/o/roulette': roulettePage,
      '/o/alert': alertPage,
    },

    async fetch(req, srv) {
      if (!hostAllowed(req, deps.port)) return new Response('bad host', { status: 421 });
      const url = new URL(req.url);
      const authed = hasSession(req, deps.dashboardKey);

      if (url.pathname === '/api/health') {
        return json({ ok: true, version: VERSION, pid: process.pid, workerStartedAt: deps.workerStartedAt });
      }
      if (url.pathname === '/api/session') return json({ authed });

      // 치지직 공식 로그인 콜백. localhost 주소로 돌아오므로 세션 쿠키 대신 1회용 state로 확인
      if (url.pathname === REDIRECT_PATH) {
        const r = await deps.official.handleCallback(url.searchParams.get('code'), url.searchParams.get('state'));
        if (r.ok) await deps.onOfficialLogin(r.channelId).catch(() => {});
        const msg = r.ok ? `✅ ${r.channelName} 채널로 로그인했습니다. 이제 봇이 채팅방에 답장합니다.` : `⚠️ ${r.error}`;
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>LocalBot</title><body style="font-family:system-ui;background:#0f1115;color:#e7e9ee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${escapeHtml(msg)}</h2><p><a style="color:#00d564" href="http://127.0.0.1:${deps.port}/#home">대시보드로 돌아가기</a></p></div><script>setTimeout(()=>location.href='http://127.0.0.1:${deps.port}/#home',${r.ok ? 1500 : 6000})</script>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }

      // 간편 로그인: 중계 서버가 토큰을 주소 # 뒤에 실어 보냄 → 이 페이지가 읽어서 LocalBot에 전달
      if (url.pathname === '/oauth/relay' && req.method === 'GET') {
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>LocalBot</title><body style="font-family:system-ui;background:#0f1115;color:#e7e9ee;display:grid;place-items:center;height:100vh;margin:0"><h2 id="m">로그인 처리 중…</h2><script>
const p=Object.fromEntries(new URLSearchParams(location.hash.slice(1)));history.replaceState(null,'',location.pathname);
fetch('/oauth/relay/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}).then(r=>r.json()).then(r=>{
document.getElementById('m').textContent=r.ok?'✅ '+r.channelName+' 채널로 로그인했습니다. 이제 봇이 채팅방에 답장합니다.':'⚠️ '+r.error;
setTimeout(()=>location.href='http://127.0.0.1:${deps.port}/#home',r.ok?1500:6000);});
</script>`,
          { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } },
        );
      }
      // JSON 본문이라 다른 사이트에서는 사전 확인(preflight)에 막힘 + 1회용 nonce 확인
      if (url.pathname === '/oauth/relay/complete' && req.method === 'POST') {
        if (!(req.headers.get('content-type') ?? '').includes('application/json')) return json({ ok: false, error: 'bad request' }, 400);
        const body = (await req.json().catch(() => ({}))) as Record<string, string>;
        const r = await deps.official.handleRelay(body);
        if (r.ok) await deps.onOfficialLogin(r.channelId).catch(() => {});
        return json(r, r.ok ? 200 : 400);
      }

      // 대시보드 로그인: ?key= → 세션 쿠키 → /
      if (url.pathname === '/login') {
        const key = url.searchParams.get('key') ?? '';
        if (key && timingSafeEqual(key, deps.dashboardKey)) {
          return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie(key) } });
        }
        return new Response(null, { status: 302, headers: { location: '/' } });
      }

      // 오버레이 WebSocket / 로컬 음악 파일: 오버레이 키로 인증
      if (url.pathname === '/ws/overlay' || url.pathname.startsWith('/media/')) {
        if (!timingSafeEqual(url.searchParams.get('key') ?? '', deps.overlayKey())) return json({ error: 'bad overlay key' }, 401);
        if (url.pathname === '/ws/overlay') {
          const r = url.searchParams.get('role');
          const role = r === 'player' ? 'player' : r === 'alert' ? 'alert' : 'overlay';
          return srv.upgrade(req, { data: { kind: 'overlay', id: crypto.randomUUID(), role } }) ? undefined : json({ error: 'upgrade' }, 400);
        }
        return serveMedia(req, deps.songs.localFile(Number(url.pathname.slice('/media/'.length))));
      }

      if (!authed) return json({ error: 'unauthorized' }, 401);

      if (url.pathname === '/api/official/login' && req.method === 'GET') {
        const to = deps.official.loginUrl();
        return to ? Response.redirect(to, 302) : json({ error: '로그인 설정이 없습니다' }, 400);
      }

      if (url.pathname === '/ws') {
        return srv.upgrade(req, { data: { kind: 'dashboard' } }) ? undefined : json({ error: 'upgrade failed' }, 400);
      }

      if (req.method !== 'GET' && !csrfOk(req)) return json({ error: 'csrf' }, 403);
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) return json({ error: 'not found' }, 404);
      const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Json) : {};
      const result = await route.fn(url.pathname.match(route.re)!, body);
      const failed = !!result && typeof result === 'object' && 'ok' in result && (result as Json).ok === false;
      return json(result ?? ok, failed ? 400 : 200);
    },

    websocket: {
      open(ws) {
        const d = ws.data;
        if (d.kind === 'dashboard') {
          dashboards.add(ws);
          const hello: ServerMessage = {
            type: 'hello', workerStartedAt: deps.workerStartedAt, recent: deps.ingest.recent(80),
            connection: deps.connection.state, songs: deps.songs.state(), roulette: deps.roulette.state(),
            official: deps.official.status(),
          };
          ws.send(JSON.stringify(hello));
          if (lastFrame) ws.send(JSON.stringify({ type: 'frame', jpeg: lastFrame } satisfies ServerMessage));
          ws.send(JSON.stringify({ type: 'tts', state: deps.tts.state() } satisfies ServerMessage));
          return;
        }
        overlays.add(ws);
        const send = (m: OverlayMessage) => ws.send(JSON.stringify(m));
        send({ type: 'overlay.hello', role: d.role, master: false });
        const st = deps.songs.state();
        send({ type: 'songs', state: { now: st.now, paused: st.paused, queue: st.queue.slice(0, 10) } });
        if (d.role === 'player') deps.songs.engine.addPlayer(d.id, send);
        else if (d.role === 'alert') deps.tts.addOverlay(d.id, send);
        else deps.roulette.addOverlay(d.id, send);
      },
      close(ws) {
        const d = ws.data;
        if (d.kind === 'dashboard') return void dashboards.delete(ws);
        overlays.delete(ws);
        if (d.role === 'player') deps.songs.engine.removePlayer(d.id);
        else if (d.role === 'alert') deps.tts.removeOverlay(d.id);
        else deps.roulette.removeOverlay(d.id);
      },
      message(ws, raw) {
        const d = ws.data;
        if (d.kind !== 'overlay') return;
        let m: OverlayReport;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m.type === 'roulette.done') deps.roulette.overlayDone(Number(m.spinId));
        else if (d.role === 'player' && m.type.startsWith('player.')) deps.songs.engine.report(d.id, m);
      },
    },

    error(err) {
      log.error('request failed', err);
      return json({ error: 'internal' }, 500);
    },
  });

  log.info(`listening on http://${deps.host}:${deps.port}`);
  return {
    stop: () => server.stop(true),
    broadcastConnection: (state) => toDash({ type: 'connection', state }),
    broadcastOfficial: (state) => toDash({ type: 'official', state }),
    broadcastTts: () => toDash({ type: 'tts', state: deps.tts.state() }),
    broadcastFrame: (jpeg) => {
      lastFrame = jpeg;
      if (dashboards.size) toDash({ type: 'frame', jpeg });
    },
    broadcastSongs,
    broadcastRoulette,
  };
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm',
};

/** 로컬 음악 파일. 탐색(seek)을 위해 Range 요청 지원 */
function serveMedia(req: Request, path: string | null): Response {
  if (!path) return new Response('not found', { status: 404 });
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return new Response('not found', { status: 404 });
  }
  const file = Bun.file(path);
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range')?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1) },
    });
  }
  return new Response(file, { headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size) } });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
