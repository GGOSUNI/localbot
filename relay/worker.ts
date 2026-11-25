/**
 * LocalBot 로그인 중계 서버 (Cloudflare Worker).
 *
 * 치지직 Open API는 토큰을 받을 때 Client Secret이 필요합니다. Secret을 exe에 넣으면 누구나 꺼낼 수 있으므로
 * 여기(서버)에만 두고, 각 사용자의 LocalBot은 이 서버를 거쳐 "로그인 버튼 하나"로 토큰을 받습니다.
 * 서버는 아무것도 저장하지 않습니다(토큰은 그대로 사용자 PC로 전달).
 *
 *   GET  /login?port=7777&nonce=…   → 치지직 로그인 화면으로
 *   GET  /callback?code&state       → 토큰 발급 → http://localhost:<port>/oauth/relay#… 로 전달
 *   POST /refresh {refreshToken}    → 토큰 갱신
 *   POST /revoke  {token}           → 로그아웃
 */

export interface Env {
  CHZZK_CLIENT_ID: string;
  CHZZK_CLIENT_SECRET: string;
}

const OPENAPI = 'https://openapi.chzzk.naver.com';
const AUTH_PAGE = 'https://chzzk.naver.com/account-interlock';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LocalBot</title>` +
      `<body style="font-family:system-ui,'Malgun Gothic',sans-serif;background:#0f1115;color:#e7e9ee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center">` +
      `<div><h2>${title}</h2>${body}</div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } },
  );

const validPort = (p: string | null) => !!p && /^\d{2,5}$/.test(p) && Number(p) >= 1024 && Number(p) <= 65535;
const validNonce = (n: string | null) => !!n && /^[A-Za-z0-9_-]{8,64}$/.test(n);

async function token(env: Env, body: Record<string, string>) {
  const r = await fetch(`${OPENAPI}/auth/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, clientId: env.CHZZK_CLIENT_ID, clientSecret: env.CHZZK_CLIENT_SECRET }),
  });
  const j = (await r.json().catch(() => ({}))) as { message?: string; content?: Record<string, string> };
  return { ok: r.ok && !!j.content?.accessToken, status: r.status, content: j.content, message: j.message ?? `HTTP ${r.status}` };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!env.CHZZK_CLIENT_ID || !env.CHZZK_CLIENT_SECRET) return json({ error: 'relay not configured' }, 500);

    if (url.pathname === '/' && req.method === 'GET') return json({ ok: true, service: 'localbot-relay' });

    if (url.pathname === '/login' && req.method === 'GET') {
      const port = url.searchParams.get('port');
      const nonce = url.searchParams.get('nonce');
      if (!validPort(port) || !validNonce(nonce)) return page('⚠️ 잘못된 요청', '<p>LocalBot 대시보드에서 다시 눌러 주세요.</p>', 400);
      const to = new URL(AUTH_PAGE);
      to.searchParams.set('clientId', env.CHZZK_CLIENT_ID);
      to.searchParams.set('redirectUri', `${url.origin}/callback`);
      to.searchParams.set('state', `${port}.${nonce}`);
      return Response.redirect(to.toString(), 302);
    }

    if (url.pathname === '/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? '';
      const [port, nonce] = state.split('.');
      if (!code || !validPort(port ?? null) || !validNonce(nonce ?? null)) return page('⚠️ 로그인 실패', '<p>잘못된 응답입니다. 다시 시도해 주세요.</p>', 400);
      const t = await token(env, { grantType: 'authorization_code', code, state });
      if (!t.ok) return page('⚠️ 로그인 실패', `<p>${t.message === 'INVALID_TOKEN' ? '로그인 시간이 지났습니다. 다시 눌러 주세요.' : '치지직 응답 오류'}</p>`, 502);
      // 토큰은 주소의 # 뒤(fragment)에 실어 보냄 → 서버 로그·리퍼러에 남지 않고 사용자 PC의 LocalBot만 읽음
      const frag = new URLSearchParams({
        nonce: nonce!, access: t.content!.accessToken!, refresh: t.content!.refreshToken!, expiresIn: String(t.content!.expiresIn ?? '86400'),
      });
      return Response.redirect(`http://localhost:${port}/oauth/relay#${frag}`, 302);
    }

    if (url.pathname === '/refresh' && req.method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as { refreshToken?: string };
      if (!b.refreshToken) return json({ error: 'refreshToken required' }, 400);
      const t = await token(env, { grantType: 'refresh_token', refreshToken: b.refreshToken });
      if (!t.ok) return json({ error: t.message }, t.status === 401 ? 401 : 502);
      return json({ accessToken: t.content!.accessToken, refreshToken: t.content!.refreshToken, expiresIn: t.content!.expiresIn });
    }

    if (url.pathname === '/revoke' && req.method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as { token?: string };
      if (!b.token) return json({ error: 'token required' }, 400);
      await fetch(`${OPENAPI}/auth/v1/token/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: env.CHZZK_CLIENT_ID, clientSecret: env.CHZZK_CLIENT_SECRET, token: b.token, tokenTypeHint: 'refresh_token' }),
      }).catch(() => null);
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};
