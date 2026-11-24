import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 통합 테스트: 실제 Supervisor → Worker 프로세스를 띄우고,
 * 워커를 강제로 죽였을 때 1초 안에 복구되는지 확인합니다.
 */
const PORT = 17000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ENTRY = resolve(import.meta.dir, '../apps/server/src/main.ts');

let home: string;
let sup: Subprocess;
let cookie: string;

async function health(): Promise<{ pid: number; workerStartedAt: number } | null> {
  try {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok ? ((await r.json()) as any) : null;
  } catch {
    return null;
  }
}
async function waitHealthy(timeoutMs: number, notPid?: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const h = await health();
    if (h && h.pid !== notPid) return h;
    await Bun.sleep(25);
  }
  throw new Error('worker did not become healthy');
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'localbot-sup-'));
  sup = Bun.spawn(['bun', ENTRY], {
    env: { ...process.env, LOCALBOT_HOME: home, LOCALBOT_PORT: String(PORT), LOCALBOT_NO_BROWSER: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitHealthy(10_000);
  const key = readFileSync(join(home, 'data', 'dashboard.key'), 'utf8').trim();
  const r = await fetch(`${BASE}/?key=${key}`, { redirect: 'manual' });
  expect(r.status).toBe(302);
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
});

afterAll(async () => {
  sup.kill('SIGTERM');
  await sup.exited;
  rmSync(home, { recursive: true, force: true });
});

const authed = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { cookie, 'x-localbot': '1', 'content-type': 'application/json', ...init.headers } });

describe('보안', () => {
  test('세션 없이 API 접근 불가', async () => {
    expect((await fetch(`${BASE}/api/events`)).status).toBe(401);
    expect((await fetch(`${BASE}/`)).status).toBe(401);
  });
  test('잘못된 Host 헤더 거부 (DNS rebinding)', async () => {
    const r = await fetch(`${BASE}/api/health`, { headers: { host: 'evil.example:80' } });
    expect(r.status).toBe(421);
  });
  test('CSRF 헤더 없는 POST 거부', async () => {
    const r = await fetch(`${BASE}/api/mock/donation`, { method: 'POST', headers: { cookie }, body: '{"amount":1000}' });
    expect(r.status).toBe(403);
  });
});

describe('이벤트 흐름', () => {
  test('가짜 후원 → WebSocket으로 실시간 수신 → DB에 저장', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } } as any);
    const got = new Promise<any>((res) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type === 'event' && msg.envelope.event.type === 'donation') res(msg.envelope);
      };
    });
    await new Promise((r) => (ws.onopen = r));
    await authed('/api/mock/donation', { method: 'POST', body: JSON.stringify({ nickname: '테스터', amount: 3000, text: 'hi' }) });
    const env = await got;
    expect(env.event.amountKRW).toBe(3000);
    ws.close();

    const events = (await (await authed('/api/events')).json()) as any[];
    expect(events.some((e) => e.id === env.id)).toBe(true);
  });
});

describe('자가 복구', () => {
  test('워커가 죽으면 1초 안에 새 워커가 뜨고, 데이터는 유지된다', async () => {
    const before = (await health())!;
    const countBefore = ((await (await authed('/api/events?limit=1000')).json()) as any[]).length;

    await authed('/api/debug/crash', { method: 'POST' });
    const t0 = Date.now();
    const after = await waitHealthy(5000, before.pid);
    const recoveryMs = Date.now() - t0;

    expect(after.pid).not.toBe(before.pid);
    expect(recoveryMs).toBeLessThan(1000);
    const countAfter = ((await (await authed('/api/events?limit=1000')).json()) as any[]).length;
    expect(countAfter).toBeGreaterThan(countBefore); // 기존 이벤트 + "워커 시작" 이벤트
    console.log(`  recovery: ${recoveryMs}ms`);
  });

  test('실행 중에는 락 파일이 있음 (중복 실행 방지)', async () => {
    expect(existsSync(join(home, 'data', 'localbot.lock'))).toBe(true);
  });
});
