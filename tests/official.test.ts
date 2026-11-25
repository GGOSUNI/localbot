import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChzzkOfficial } from '../apps/server/src/adapters/chzzk/official.ts';
import { openDatabase } from '../apps/server/src/core/db.ts';

/** 가짜 치지직 Open API (문서 규격: https://chzzk.gitbook.io/chzzk) */
function fakeChzzk() {
  const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  let tokenN = 0;
  let validAccess = new Set<string>();
  let validRefresh = new Set<string>();
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    calls.push({ url, method: init.method ?? 'GET', headers, body });
    const path = new URL(url).pathname;
    if (path === '/auth/v1/token') {
      if (body.clientId !== 'cid' || body.clientSecret !== 'secret') return res(401, { code: 401, message: 'INVALID_CLIENT' });
      if (body.grantType === 'authorization_code' && body.code !== 'good-code') return res(401, { code: 401, message: 'INVALID_TOKEN' });
      if (body.grantType === 'refresh_token') {
        if (!validRefresh.has(body.refreshToken)) return res(401, { code: 401, message: 'INVALID_TOKEN' });
        validRefresh.delete(body.refreshToken); // 1회용
      }
      tokenN++;
      validAccess.add(`AT${tokenN}`);
      validRefresh.add(`RT${tokenN}`);
      return res(200, { code: 200, message: null, content: { accessToken: `AT${tokenN}`, refreshToken: `RT${tokenN}`, tokenType: 'Bearer', expiresIn: '86400' } });
    }
    if (path === '/auth/v1/token/revoke') return res(200, { code: 200, content: null });
    const auth = headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !validAccess.has(auth.slice(7))) return res(401, { code: 401, message: 'INVALID_TOKEN' });
    if (path === '/open/v1/users/me') return res(200, { code: 200, content: { channelId: 'ccf0fa6c106ab0190fe2def14cb2ec45', channelName: '누메드' } });
    if (path === '/open/v1/chats/send') return res(200, { code: 200, content: { messageId: 'm1' } });
    return res(404, { code: 404, message: 'NOT_FOUND' });
  }) as typeof fetch;
  return { fetchImpl, calls, expireAll: () => (validAccess = new Set()) };
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lb-off-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'bot.db'), join(dir, 'bk'));
  const api = fakeChzzk();
  const clock = { t: 1_800_000_000_000 };
  const o = new ChzzkOfficial(db, 7777, () => {}, api.fetchImpl, () => clock.t);
  return { o, api, clock, db };
}

async function login(o: ChzzkOfficial) {
  o.configure('cid', 'secret');
  const state = new URL(o.loginUrl()!).searchParams.get('state');
  return o.handleCallback('good-code', state);
}

describe('치지직 공식 연결', () => {
  test('로그인 주소는 문서 규격 (clientId, redirectUri, state)', () => {
    const { o } = setup();
    expect(o.loginUrl()).toBeNull(); // 앱 정보 없으면 불가
    o.configure('cid', 'secret');
    const u = new URL(o.loginUrl()!);
    expect(u.origin + u.pathname).toBe('https://chzzk.naver.com/account-interlock');
    expect(u.searchParams.get('clientId')).toBe('cid');
    expect(u.searchParams.get('redirectUri')).toBe('http://localhost:7777/oauth/chzzk');
    expect(u.searchParams.get('state')!.length).toBeGreaterThan(10);
  });

  test('콜백 → 토큰 발급 → 내 채널 조회', async () => {
    const { o, api } = setup();
    const r = await login(o);
    expect(r).toEqual({ ok: true, channelName: '누메드', channelId: 'ccf0fa6c106ab0190fe2def14cb2ec45' });
    const tok = api.calls.find((c) => c.url.endsWith('/auth/v1/token'))!;
    expect(tok.body).toMatchObject({ grantType: 'authorization_code', clientId: 'cid', clientSecret: 'secret', code: 'good-code' });
    expect(o.status()).toMatchObject({ loggedIn: true, channelName: '누메드' });
  });

  test('state가 틀리거나 재사용되면 거부 (다른 사이트의 가짜 로그인 방지)', async () => {
    const { o } = setup();
    o.configure('cid', 'secret');
    expect((await o.handleCallback('good-code', 'forged')).ok).toBe(false);
    const state = new URL(o.loginUrl()!).searchParams.get('state');
    expect((await o.handleCallback('good-code', state)).ok).toBe(true);
    expect((await o.handleCallback('good-code', state)).ok).toBe(false);
  });

  test('state는 10분 지나면 만료', async () => {
    const { o, clock } = setup();
    o.configure('cid', 'secret');
    const state = new URL(o.loginUrl()!).searchParams.get('state');
    clock.t += 11 * 60_000;
    expect((await o.handleCallback('good-code', state)).ok).toBe(false);
  });

  test('Client Secret이 틀리면 알아들을 수 있는 메시지', async () => {
    const { o } = setup();
    o.configure('cid', 'wrong');
    const state = new URL(o.loginUrl()!).searchParams.get('state');
    const r = await o.handleCallback('good-code', state);
    expect(r.ok === false && r.error).toContain('Client ID 또는 Secret');
  });

  test('채팅 전송: Bearer 헤더, 100자 제한', async () => {
    const { o, api } = setup();
    await login(o);
    expect(await o.sendChat('a'.repeat(150))).toBe(true);
    const send = api.calls.find((c) => c.url.endsWith('/open/v1/chats/send'))!;
    expect(send.method).toBe('POST');
    expect(send.headers.authorization).toMatch(/^Bearer AT\d+$/);
    expect(send.body.message.length).toBe(100);
  });

  test('만료 직전이면 미리 갱신, 리프레시 토큰은 새 것으로 교체 (1회용)', async () => {
    const { o, api, clock } = setup();
    await login(o);
    clock.t += 86_400_000 - 60_000; // 만료 1분 전
    expect(await o.sendChat('hi')).toBe(true);
    const refresh = api.calls.filter((c) => c.body?.grantType === 'refresh_token');
    expect(refresh).toHaveLength(1);
    clock.t += 86_400_000 - 60_000;
    expect(await o.sendChat('hi2')).toBe(true); // 새 리프레시 토큰으로 또 갱신됨
    expect(api.calls.filter((c) => c.body?.grantType === 'refresh_token')).toHaveLength(2);
  });

  test('서버가 갑자기 401을 주면 갱신 후 한 번 더 시도', async () => {
    const { o, api } = setup();
    await login(o);
    api.expireAll();
    expect(await o.sendChat('hi')).toBe(true);
  });

  test('로그아웃하면 전송 안 됨, 앱 정보는 유지', async () => {
    const { o } = setup();
    await login(o);
    await o.logout();
    expect(o.canSend).toBe(false);
    expect(o.status()).toMatchObject({ configured: true, loggedIn: false });
    expect(await o.sendChat('x')).toBe(false);
  });
});
