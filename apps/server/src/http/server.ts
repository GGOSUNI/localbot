import type { ConnectionState, Envelope, ServerMessage } from '@localbot/shared';
import type { ServerWebSocket } from 'bun';
import type { MockAdapter } from '../adapters/mock.ts';
import type { EventBus } from '../core/bus.ts';
import type { ChzzkConnection } from '../core/connection.ts';
import { VERSION } from '../core/config.ts';
import type { Ingest } from '../core/ingest.ts';
import { createLogger } from '../core/logger.ts';
import dashboardHtmlRaw from '../dashboard/index.html' with { type: 'text' };
import { csrfOk, hasSession, hostAllowed, sessionCookie, timingSafeEqual } from './security.ts';

const log = createLogger('http');
// type: 'text' 로 가져오면 런타임에는 문자열 (exe에 그대로 포함됨)
const dashboardHtml = dashboardHtmlRaw as unknown as string;

interface Deps {
  host: string;
  port: number;
  dashboardKey: string;
  bus: EventBus;
  ingest: Ingest;
  mock: MockAdapter;
  workerStartedAt: number;
  connection: ChzzkConnection;
  onCrashRequested: () => void;
  onQuitRequested: () => void;
}

export interface HttpHandle {
  stop(): void;
  broadcastConnection(state: ConnectionState): void;
}

type WsData = { kind: 'dashboard' };

export function startHttp(deps: Deps): HttpHandle {
  const sockets = new Set<ServerWebSocket<WsData>>();
  const json = (data: unknown, status = 200) => Response.json(data, { status });

  const broadcast = (m: ServerMessage) => {
    const msg = JSON.stringify(m);
    for (const ws of sockets) ws.send(msg);
  };
  deps.bus.on((envelope: Envelope) => broadcast({ type: 'event', envelope }));

  const server = Bun.serve<WsData>({
    hostname: deps.host,
    port: deps.port,

    async fetch(req, srv) {
      if (!hostAllowed(req, deps.port)) return new Response('bad host', { status: 421 });
      const url = new URL(req.url);
      const authed = hasSession(req, deps.dashboardKey);

      // ── 인증 불필요 ──
      if (url.pathname === '/api/health') {
        return json({ ok: true, version: VERSION, pid: process.pid, workerStartedAt: deps.workerStartedAt });
      }

      // ── 대시보드 진입: ?key= 로 세션 쿠키 발급 후 키 없는 URL로 이동 ──
      if (url.pathname === '/') {
        const key = url.searchParams.get('key');
        if (key && timingSafeEqual(key, deps.dashboardKey)) {
          return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie(key) } });
        }
        if (!authed) return new Response(LOCKED_PAGE, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
        return new Response(dashboardHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      // ── 여기부터 대시보드 세션 필요 ──
      if (!authed) return json({ error: 'unauthorized' }, 401);

      if (url.pathname === '/ws') {
        return srv.upgrade(req, { data: { kind: 'dashboard' } }) ? undefined : json({ error: 'upgrade failed' }, 400);
      }

      if (url.pathname === '/api/connection' && req.method === 'GET') return json(deps.connection.state);

      if (url.pathname === '/api/events' && req.method === 'GET') {
        return json(deps.ingest.recent(Number(url.searchParams.get('limit') ?? 50)));
      }

      if (req.method === 'POST') {
        if (!csrfOk(req)) return json({ error: 'csrf' }, 403);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

        if (url.pathname === '/api/connection') {
          const result = await deps.connection.setChannel(str(body.input, ''));
          return json(result, result.ok ? 200 : 400);
        }
        if (url.pathname === '/api/connection/clear') {
          await deps.connection.clear();
          return json({ ok: true });
        }
        if (url.pathname === '/api/app/quit') {
          setTimeout(deps.onQuitRequested, 50);
          return json({ ok: true });
        }
        if (url.pathname === '/api/mock/chat') {
          deps.mock.chat(str(body.nickname, '테스트시청자'), str(body.text, '안녕하세요'));
          return json({ ok: true });
        }
        if (url.pathname === '/api/mock/donation') {
          const amount = Math.floor(Number(body.amount));
          if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'amount' }, 400);
          const nick = typeof body.nickname === 'string' && body.nickname.trim() ? body.nickname.trim() : null;
          deps.mock.donation(nick, amount, typeof body.text === 'string' ? body.text : undefined);
          return json({ ok: true });
        }
        if (url.pathname === '/api/debug/crash') {
          // Supervisor 복구 확인용. 응답을 보낸 뒤에 죽입니다.
          setTimeout(deps.onCrashRequested, 50);
          return json({ ok: true, crashing: process.pid });
        }
      }
      return json({ error: 'not found' }, 404);
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
        const hello: ServerMessage = {
          type: 'hello', workerStartedAt: deps.workerStartedAt, recent: deps.ingest.recent(50), connection: deps.connection.state,
        };
        ws.send(JSON.stringify(hello));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {
        /* M0: 클라이언트 → 서버 메시지 없음 (REST 사용) */
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
    broadcastConnection: (state) => broadcast({ type: 'connection', state }),
  };
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>LocalBot</title>
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>🔒 LocalBot 대시보드</h2>
<p>트레이 아이콘의 <b>"대시보드 열기"</b>로 접속하거나, 콘솔에 표시된 주소를 사용하세요.</p></div>`;
