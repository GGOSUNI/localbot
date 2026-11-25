import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChzzkOfficial } from '../apps/server/src/adapters/chzzk/official.ts';
import { openDatabase } from '../apps/server/src/core/db.ts';
import worker from '../relay/worker.ts';

/**
 * 간편 로그인 전체 흐름: LocalBot ↔ 중계 서버(실제 worker 코드) ↔ 가짜 치지직 API
 * 사용자는 키 입력 없이 "로그인" 버튼만 누름.
 */
const RELAY = 'https://relay.test';
const env = { CHZZK_CLIENT_ID: 'cid', CHZZK_CLIENT_SECRET: 'secret' };

function world() {
  const tokenCalls: any[] = [];
  let n = 0;
  const valid = new Set<string>();
  const refresh = new Set<string>();
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const chzzk = async (url: URL, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url.pathname === '/auth/v1/token') {
      tokenCalls.push(body);
      if (body.clientId !== 'cid' || body.clientSecret !== 'secret') return res(401, { message: 'INVALID_CLIENT' });
      if (body.grantType === 'authorization_code' && (body.code !== 'good' || !/^\d+\./.test(body.state))) return res(401, { message: 'INVALID_TOKEN' });
      if (body.grantType === 'refresh_token' && !refresh.delete(body.refreshToken)) return res(401, { message: 'INVALID_TOKEN' });
      n++;
      valid.add(`AT${n}`);
      refresh.add(`RT${n}`);
      return res(200, { code: 200, content: { accessToken: `AT${n}`, refreshToken: `RT${n}`, tokenType: 'Bearer', expiresIn: '86400' } });
    }
    if (url.pathname === '/auth/v1/token/revoke') return res(200, { code: 200 });
    const auth = init?.headers?.authorization ?? '';
    if (!valid.has(auth.replace('Bearer ', ''))) return res(401, { message: 'INVALID_TOKEN' });
    if (url.pathname === '/open/v1/users/me') return res(200, { code: 200, content: { channelId: 'ccf0fa6c106ab0190fe2def14cb2ec45', channelName: '누메드' } });
    if (url.pathname === '/open/v1/chats/send') return res(200, { code: 200, content: { messageId: 'm' } });
    return res(404, {});
  };
  // 중계 서버와 LocalBot이 보는 인터넷
  const net = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    if (url.origin === RELAY) return worker.fetch(new Request(url, init), env);
    if (url.hostname === 'openapi.chzzk.naver.com') return chzzk(url, init);
    throw new Error(`unexpected host ${url.host}`);
  }) as typeof fetch;
  return { net, tokenCalls };
}

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup() {
  const w = world();
  globalThis.fetch = w.net; // worker 안의 fetch
  const dir = mkdtempSync(join(tmpdir(), 'lb-relay-'));
  dirs.push(dir);
  const clock = { t: 1_800_000_000_000 };
  const o = new ChzzkOfficial(openDatabase(join(dir, 'b.db'), join(dir, 'bk')), 7777, () => {}, w.net, () => clock.t, RELAY);
  return { o, w, clock };
}

/** 사용자가 버튼을 누르고 치지직에서 "동의"를 누른 것까지 그대로 재현 */
async function clickLogin(o: ChzzkOfficial, code = 'good') {
  const login = o.loginUrl()!;
  const r1 = await worker.fetch(new Request(login), env); // 중계 서버 → 치지직 동의 화면
  const consent = new URL(r1.headers.get('location')!);
  expect(consent.origin + consent.pathname).toBe('https://chzzk.naver.com/account-interlock');
  expect(consent.searchParams.get('redirectUri')).toBe(`${RELAY}/callback`);
  // 치지직이 code와 state를 붙여 중계 서버로 돌려보냄
  const cb = new URL(`${RELAY}/callback`);
  cb.searchParams.set('code', code);
  cb.searchParams.set('state', consent.searchParams.get('state')!);
  const r2 = await worker.fetch(new Request(cb), env);
  const back = r2.headers.get('location');
  if (!back) return { ok: false as const, error: await r2.text() };
  const u = new URL(back);
  expect(u.origin).toBe('http://localhost:7777');
  expect(u.pathname).toBe('/oauth/relay');
  // LocalBot의 /oauth/relay 페이지가 # 뒤를 읽어서 넘김
  return o.handleRelay(Object.fromEntries(new URLSearchParams(u.hash.slice(1))));
}

describe('간편 로그인 (중계 서버)', () => {
  test('키 입력 없이 버튼만으로 로그인 → 채팅 전송', async () => {
    const { o, w } = setup();
    expect(o.status()).toMatchObject({ configured: true, easyLogin: true, loggedIn: false });
    const r = await clickLogin(o);
    expect(r).toEqual({ ok: true, channelName: '누메드', channelId: 'ccf0fa6c106ab0190fe2def14cb2ec45' });
    expect(await o.sendChat('🤖 테스트')).toBe(true);
    // Client Secret은 중계 서버만 씀
    expect(w.tokenCalls[0]).toMatchObject({ clientId: 'cid', clientSecret: 'secret', grantType: 'authorization_code' });
  });

  test('하루 지나면 중계 서버로 자동 갱신', async () => {
    const { o, w, clock } = setup();
    await clickLogin(o);
    clock.t += 86_400_000;
    expect(await o.sendChat('다음날')).toBe(true);
    expect(w.tokenCalls.filter((c) => c.grantType === 'refresh_token')).toHaveLength(1);
  });

  test('다른 데서 온 로그인 결과(nonce 불일치)는 거부', async () => {
    const { o } = setup();
    o.loginUrl();
    expect((await o.handleRelay({ nonce: 'someoneelse123', access: 'x', refresh: 'y' })).ok).toBe(false);
  });

  test('중계 서버: 이상한 포트·nonce는 거부, 토큰은 localhost로만 전달', async () => {
    for (const q of ['port=80&nonce=abcdefgh12', 'port=7777&nonce=a', 'port=7777&nonce=<script>xx']) {
      const r = await worker.fetch(new Request(`${RELAY}/login?${q}`), env);
      expect(r.status).toBe(400);
    }
  });

  test('치지직 동의가 실패하면 LocalBot에 아무것도 안 넘어감', async () => {
    const { o } = setup();
    const r = await clickLogin(o, 'bad-code');
    expect(r.ok).toBe(false);
    expect(o.canSend).toBe(false);
  });

  test('로그아웃 → 중계 서버로 revoke, 다시 로그인 버튼 상태', async () => {
    const { o } = setup();
    await clickLogin(o);
    await o.logout();
    expect(o.status()).toMatchObject({ loggedIn: false, easyLogin: true, configured: true });
  });
});
