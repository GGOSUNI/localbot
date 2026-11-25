import type { Database } from 'bun:sqlite';
import type { OfficialStatus } from '@localbot/shared';
import { getSetting, setSetting } from '../../core/db.ts';
import { createLogger } from '../../core/logger.ts';

const log = createLogger('chzzk-official');

/**
 * 치지직 공식 Open API 연결 (https://chzzk.gitbook.io/chzzk).
 * 지금은 "봇이 채팅방에 답장"하는 데 씁니다. 채팅·후원 수신은 읽기 전용 연결이 계속 담당.
 *
 * 흐름: 스트리머가 개발자센터에서 앱 등록 → Client ID/Secret 입력 → "치지직으로 로그인"
 *       → chzzk.naver.com/account-interlock → http://localhost:<port>/oauth/chzzk?code&state
 *       → 토큰 발급(1일) · 리프레시(30일, 1회용) → /open/v1/chats/send
 */

export const OPENAPI = 'https://openapi.chzzk.naver.com';
export const AUTH_PAGE = 'https://chzzk.naver.com/account-interlock';
export const REDIRECT_PATH = '/oauth/chzzk';
const KEY = 'chzzk.official';
const MAX_MESSAGE = 100; // 문서: 메시지 최대 100자
const SEND_GAP_MS = 1100; // 도배 방지

interface Saved {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  channelId?: string;
  channelName?: string;
}

export class ChzzkOfficial {
  private states = new Map<string, number>(); // 로그인 state → 만든 시각
  private sendChain: Promise<unknown> = Promise.resolve();
  private lastSend = 0;
  private lastError: string | null = null;

  constructor(
    private db: Database,
    private port: number,
    private onChange: () => void,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  get redirectUri() {
    return `http://localhost:${this.port}${REDIRECT_PATH}`;
  }

  private saved(): Saved | null {
    return getSetting<Saved | null>(this.db, KEY, null);
  }
  private save(s: Saved | null) {
    if (s) setSetting(this.db, KEY, s);
    else this.db.query('DELETE FROM settings WHERE key = ?').run(KEY);
    this.onChange();
  }

  status(): OfficialStatus {
    const s = this.saved();
    return {
      configured: !!(s?.clientId && s.clientSecret),
      loggedIn: !!s?.refreshToken,
      clientId: s?.clientId ?? null,
      channelId: s?.channelId ?? null,
      channelName: s?.channelName ?? null,
      redirectUri: this.redirectUri,
      error: this.lastError,
    };
  }

  get canSend(): boolean {
    return !!this.saved()?.refreshToken;
  }

  configure(clientId: string, clientSecret: string): { ok: true } | { ok: false; error: string } {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret) return { ok: false, error: 'Client ID와 Client Secret을 모두 넣어 주세요' };
    const prev = this.saved();
    // 앱을 바꾸면 기존 로그인은 무효
    this.save(prev && prev.clientId === id ? { ...prev, clientSecret: secret } : { clientId: id, clientSecret: secret });
    this.lastError = null;
    return { ok: true };
  }

  /** 로그인 페이지 주소. state는 10분 안에 한 번만 쓸 수 있음 */
  loginUrl(): string | null {
    const s = this.saved();
    if (!s?.clientId) return null;
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
    this.states.set(state, this.now());
    const u = new URL(AUTH_PAGE);
    u.searchParams.set('clientId', s.clientId);
    u.searchParams.set('redirectUri', this.redirectUri);
    u.searchParams.set('state', state);
    return u.toString();
  }

  /** /oauth/chzzk 콜백 처리 */
  async handleCallback(code: string | null, state: string | null): Promise<{ ok: true; channelName: string; channelId: string } | { ok: false; error: string }> {
    const created = state ? this.states.get(state) : undefined;
    if (!state || created === undefined || this.now() - created > 10 * 60_000) {
      return { ok: false, error: '로그인 요청이 만료됐습니다. 대시보드에서 다시 눌러 주세요.' };
    }
    this.states.delete(state);
    const s = this.saved();
    if (!s || !code) return { ok: false, error: '로그인 정보가 없습니다' };

    const tok = await this.tokenRequest({ grantType: 'authorization_code', clientId: s.clientId, clientSecret: s.clientSecret, code, state });
    if (!tok.ok) return tok;
    const next: Saved = { ...s, ...tok.tokens };
    this.save(next);

    const me = await this.api<{ channelId: string; channelName: string }>('GET', '/open/v1/users/me');
    if (!me.ok) return { ok: false, error: `로그인은 됐지만 채널 정보를 못 가져왔습니다 (${me.error}). 앱 권한에 "유저 정보 조회"가 있는지 확인해 주세요.` };
    this.save({ ...this.saved()!, channelId: me.data.channelId, channelName: me.data.channelName });
    this.lastError = null;
    log.info(`logged in as ${me.data.channelName}`);
    return { ok: true, channelName: me.data.channelName, channelId: me.data.channelId };
  }

  async logout() {
    const s = this.saved();
    if (s?.refreshToken) {
      await this.fetchImpl(`${OPENAPI}/auth/v1/token/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: s.clientId, clientSecret: s.clientSecret, token: s.refreshToken, tokenTypeHint: 'refresh_token' }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
    }
    if (s) this.save({ clientId: s.clientId, clientSecret: s.clientSecret });
  }

  /** 앱 정보까지 지우기 */
  forget() {
    this.save(null);
  }

  /**
   * 채팅방에 메시지 보내기. 100자로 자르고, 1초에 한 번 이하로 순서대로 보냄.
   * @returns 보냈으면 true
   */
  sendChat(text: string): Promise<boolean> {
    const message = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
    const run = async () => {
      const wait = this.lastSend + SEND_GAP_MS - this.now();
      if (wait > 0) await Bun.sleep(wait);
      this.lastSend = this.now();
      const r = await this.api('POST', '/open/v1/chats/send', { message });
      if (!r.ok) {
        this.lastError = `채팅 전송 실패: ${r.error}`;
        log.warn(this.lastError);
        this.onChange();
      } else if (this.lastError) {
        this.lastError = null;
        this.onChange();
      }
      return r.ok;
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => false);
    return p;
  }

  // ── 내부 ──

  private async tokenRequest(body: Record<string, string>): Promise<{ ok: true; tokens: Pick<Saved, 'accessToken' | 'refreshToken' | 'expiresAt'> } | { ok: false; error: string }> {
    try {
      const r = await this.fetchImpl(`${OPENAPI}/auth/v1/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await r.json().catch(() => ({}))) as { code?: number; message?: string; content?: Record<string, string> };
      const c = j.content;
      if (!r.ok || !c?.accessToken) return { ok: false, error: explain(j.message ?? `HTTP ${r.status}`) };
      return {
        ok: true,
        tokens: {
          accessToken: c.accessToken,
          refreshToken: c.refreshToken,
          expiresAt: this.now() + Number(c.expiresIn ?? 86400) * 1000,
        },
      };
    } catch {
      return { ok: false, error: '치지직 서버에 연결할 수 없습니다' };
    }
  }

  /** 만료 5분 전이면 미리 갱신. 리프레시 토큰은 1회용이라 새로 받은 것을 바로 저장 */
  private async freshToken(force = false): Promise<string | null> {
    const s = this.saved();
    if (!s?.refreshToken) return null;
    if (!force && s.accessToken && (s.expiresAt ?? 0) - this.now() > 5 * 60_000) return s.accessToken;
    const tok = await this.tokenRequest({ grantType: 'refresh_token', refreshToken: s.refreshToken, clientId: s.clientId, clientSecret: s.clientSecret });
    if (!tok.ok) {
      this.lastError = `로그인이 만료됐습니다. 다시 로그인해 주세요 (${tok.error})`;
      if (/INVALID_TOKEN|만료/.test(tok.error)) this.save({ clientId: s.clientId, clientSecret: s.clientSecret });
      this.onChange();
      return null;
    }
    this.save({ ...s, ...tok.tokens });
    return tok.tokens.accessToken!;
  }

  private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.freshToken(attempt > 0);
      if (!token) return { ok: false, error: '로그인 필요' };
      try {
        const r = await this.fetchImpl(`${OPENAPI}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const j = (await r.json().catch(() => ({}))) as { message?: string; content?: T };
        if (r.status === 401 && attempt === 0) continue; // 토큰 갱신 후 한 번 더
        if (!r.ok) return { ok: false, error: explain(j.message ?? `HTTP ${r.status}`) };
        return { ok: true, data: j.content as T };
      } catch {
        return { ok: false, error: '치지직 서버에 연결할 수 없습니다' };
      }
    }
    return { ok: false, error: '인증 실패' };
  }
}

function explain(msg: string): string {
  if (msg === 'INVALID_CLIENT') return 'Client ID 또는 Secret이 틀렸습니다';
  if (msg === 'FORBIDDEN') return '앱에 필요한 권한(스코프)이 없습니다 — 개발자센터에서 "채팅 메시지 쓰기"를 켜 주세요';
  if (msg === 'TOO_MANY_REQUESTS') return '요청이 너무 많습니다 (잠시 후 자동으로 다시 보냄)';
  return msg;
}
