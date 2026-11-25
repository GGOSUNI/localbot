import { statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ConnectionState, Envelope, OverlayMessage, OverlayReport, ServerMessage } from '@localbot/shared';
import type { ServerWebSocket } from 'bun';
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
  songs: SongService;
  roulette: RouletteService;
  workerStartedAt: number;
  onCrashRequested: () => void;
  onQuitRequested: () => void;
}

export interface HttpHandle {
  stop(): void;
  broadcastConnection(state: ConnectionState): void;
  broadcastSongs(): void;
  broadcastRoulette(): void;
}

type WsData =
  | { kind: 'dashboard' }
  | { kind: 'overlay'; id: string; role: 'player' | 'overlay' };

type Json = Record<string, any>;
type Route = { method: string; re: RegExp; fn: (m: RegExpMatchArray, body: Json) => unknown | Promise<unknown> };

export function startHttp(deps: Deps): HttpHandle {
  const dashboards = new Set<ServerWebSocket<WsData>>();
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
    },

    async fetch(req, srv) {
      if (!hostAllowed(req, deps.port)) return new Response('bad host', { status: 421 });
      const url = new URL(req.url);
      const authed = hasSession(req, deps.dashboardKey);

      if (url.pathname === '/api/health') {
        return json({ ok: true, version: VERSION, pid: process.pid, workerStartedAt: deps.workerStartedAt });
      }
      if (url.pathname === '/api/session') return json({ authed });

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
          const role = url.searchParams.get('role') === 'player' ? 'player' : 'overlay';
          return srv.upgrade(req, { data: { kind: 'overlay', id: crypto.randomUUID(), role } }) ? undefined : json({ error: 'upgrade' }, 400);
        }
        return serveMedia(req, deps.songs.localFile(Number(url.pathname.slice('/media/'.length))));
      }

      if (!authed) return json({ error: 'unauthorized' }, 401);

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
          };
          ws.send(JSON.stringify(hello));
          return;
        }
        overlays.add(ws);
        const send = (m: OverlayMessage) => ws.send(JSON.stringify(m));
        send({ type: 'overlay.hello', role: d.role, master: false });
        const st = deps.songs.state();
        send({ type: 'songs', state: { now: st.now, paused: st.paused, queue: st.queue.slice(0, 10) } });
        if (d.role === 'player') deps.songs.engine.addPlayer(d.id, send);
        else deps.roulette.addOverlay(d.id, send);
      },
      close(ws) {
        const d = ws.data;
        if (d.kind === 'dashboard') return void dashboards.delete(ws);
        overlays.delete(ws);
        if (d.role === 'player') deps.songs.engine.removePlayer(d.id);
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
