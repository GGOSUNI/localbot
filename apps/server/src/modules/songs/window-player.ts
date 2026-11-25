import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayerCommand, PlayerReport } from '@localbot/shared';
import { createLogger } from '../../core/logger.ts';

const log = createLogger('yt-window');

/**
 * 유튜브 창 플레이어.
 *
 * 음반사·애니 OP처럼 "유튜브 밖 재생 금지(150/101)"인 영상은 어떤 임베드 플레이어로도 재생할 수 없습니다.
 * 이런 곡만 PC의 엣지/크롬으로 진짜 youtube.com 페이지를 작은 창에 띄워 재생하고,
 * 크롬 개발자 도구 프로토콜(CDP)로 재생 위치·끝남·볼륨을 다룹니다.
 *
 * 엔진 입장에서는 평범한 플레이어 하나와 같습니다: PlayerCommand를 받고 PlayerReport를 보냅니다.
 */

export const WINDOW_TITLE = 'LocalBot 유튜브 플레이어';

export interface WindowPlayerOptions {
  dataDir: string;
  /** CDP 포트 (기본: LocalBot 포트 + 1) */
  debugPort: number;
  enabled: () => boolean;
  /** 모든 곡을 이 창으로 재생하는 모드인지 */
  always?: () => boolean;
  /** 로컬 음악 파일 주소 (유튜브 창 모드에서 내 음악 폴더 곡도 이 창으로) */
  localUrl?: (trackId: number) => string;
  report: (r: PlayerReport) => void;
  onStatus?: () => void;
  /** 창 화면(JPEG base64) — 대시보드 안에 영상을 보여 주기 위함. 초당 약 4장 */
  onFrame?: (jpegBase64: string) => void;
  /** 테스트용: 브라우저 경로·시청 페이지 주소·추가 인자 */
  browserPath?: string | null;
  watchBase?: string;
  extraArgs?: string[];
}

type Status = 'off' | 'unavailable' | 'idle' | 'starting' | 'playing';

export function findBrowser(): string | null {
  if (process.env.LOCALBOT_BROWSER) return process.env.LOCALBOT_BROWSER;
  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [
          // 엣지를 먼저: 모든 윈도우에 있고, 사용자가 평소 크롬을 쓰면 소리가 섞이지 않음
          `${env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium'];
  return candidates.find((p) => p && !p.includes('undefined') && existsSync(p)) ?? null;
}

/** 아주 작은 CDP 클라이언트 */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, (params: any) => void>();
  closed = false;
  on(method: string, fn: (params: any) => void) {
    this.listeners.set(method, fn);
  }
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.method) return this.listeners.get(m.method)?.(m.params);
      const p = m.id ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('closed'));
      this.pending.clear();
    };
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('cdp connect timeout')), 5000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve(new Cdp(ws));
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error('cdp connect failed'));
      };
    });
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), reject(new Error(`cdp timeout: ${method}`))), 8000);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

/**
 * 모든 페이지에 미리 심는 스크립트 (페이지 안에서 0.1초마다 돎)
 * - 영상만 화면 가득 (컨트롤·추천·팝업 숨김) → 대시보드에 깔끔하게
 * - 광고: 소리 끄고, 건너뛰기 버튼 누르고, 못 건너뛰는 광고는 끝으로 감기
 * - "계속 시청하시겠습니까?" 같은 확인 창 자동으로 닫기
 */
export const PAGE_SCRIPT = `(() => {
  if (window.__lb) return; window.__lb = 1;
  const CSS = 'html,body{overflow:hidden!important;background:#000!important}'
    + '#movie_player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;background:#000!important}'
    + '#movie_player .html5-video-container{position:absolute!important;inset:0!important;width:100%!important;height:100%!important}'
    + '#movie_player video{position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;object-fit:contain!important}'
    + '#movie_player>:not(.html5-video-container):not(.ytp-error):not(.ytp-cued-thumbnail-overlay){opacity:0!important;pointer-events:none!important}'
    + '#movie_player.ad-showing video{opacity:0!important}'
    + 'ytd-popup-container,tp-yt-iron-overlay-backdrop,#masthead-container,ytd-mealbar-promo-renderer{opacity:0!important;pointer-events:none!important}';
  const SKIP = '.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-ad-skip-button-container button,.ytp-ad-overlay-close-button';
  const DISMISS = 'yt-confirm-dialog-renderer #confirm-button button,yt-confirm-dialog-renderer #confirm-button,ytd-mealbar-promo-renderer #dismiss-button button,tp-yt-paper-dialog #dismiss-button button';
  let wasAd = false;
  const check = () => {
    if (!document.getElementById('lb-style') && (document.head || document.documentElement)) {
      const st = document.createElement('style'); st.id = 'lb-style'; st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    const p = document.querySelector('#movie_player');
    if (!p) return;
    const v = p.querySelector('video') || document.querySelector('video');
    const ad = p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
    document.querySelectorAll(SKIP).forEach((b) => { try { b.click(); } catch {} });
    document.querySelectorAll(DISMISS).forEach((b) => { try { b.click(); } catch {} });
    if (ad && v) {
      wasAd = true;
      v.muted = true;
      try { v.playbackRate = 16; } catch {}
      try { if (isFinite(v.duration) && v.duration > 0.5 && v.currentTime < v.duration - 0.3) v.currentTime = v.duration - 0.1; } catch {}
      if (v.paused) v.play().catch(() => {});
    } else if (wasAd && v) {
      wasAd = false;
      v.muted = false;
      try { v.playbackRate = 1; } catch {}
    }
  };
  setInterval(check, 100);
  document.addEventListener('playing', check, true);
  document.addEventListener('loadedmetadata', check, true);
  // 곡 끝: 유튜브가 '다음 동영상'으로 넘어가기 전에 우리가 먼저 멈추고 끝났다고 표시
  const vidNow = () => { try { return new URL(location.href).searchParams.get('v'); } catch { return null; } };
  const isAd = () => { const p = document.querySelector('#movie_player'); return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')); };
  const markEnd = (v) => {
    if (!document.querySelector('#movie_player') || isAd()) return;
    if (!window.__lbEnded) window.__lbEnded = vidNow();
    try { v.pause(); } catch {}
  };
  document.addEventListener('timeupdate', (e) => {
    const v = e.target;
    if (v && v.tagName === 'VIDEO' && isFinite(v.duration) && v.duration > 5 && v.duration - v.currentTime < 0.6) markEnd(v);
  }, true);
  document.addEventListener('ended', (e) => { if (e.target && e.target.tagName === 'VIDEO') markEnd(e.target); }, true);
})();`;

/** JPEG 가로·세로 (base64 앞부분의 SOF 마커만 읽음) */
export function jpegSize(b64: string): { w: number; h: number } | null {
  const b = Buffer.from(b64.slice(0, 4000), 'base64');
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

interface PageState {
  vid: string | null;
  /** 끝까지 재생돼서 멈춘 영상 (유튜브 자동재생 막기) */
  endedVid: string | null;
  href: string;
  ready: boolean;
  ad: boolean;
  err: string | null;
  t: number;
  d: number | null;
  paused: boolean;
  ended: boolean;
}

export class WindowPlayer {
  private browserPath: string | null;
  private cdp: Cdp | null = null;
  private starting: Promise<Cdp | null> | null = null;
  private current: Extract<PlayerCommand, { op: 'play' }> | null = null;
  private seq = 0;
  private volume = 60;
  private paused = false;
  private poll: Timer | null = null;
  private endedSent = -1;
  private navigatedAt = 0;
  /** 지금 곡에서 본 가장 늦은 재생 위치·길이 (유튜브가 딴 영상으로 넘어가도 위치를 안 잃게) */
  private maxT = 0;
  private dur: number | null = null;
  private sawMine = false;
  private _status: Status;
  private visible = false;
  private lastFrameAt = 0;

  constructor(private o: WindowPlayerOptions) {
    this.browserPath = o.browserPath === undefined ? findBrowser() : o.browserPath;
    this._status = this.browserPath ? 'idle' : 'unavailable';
  }

  get status(): Status {
    if (!this.o.enabled() && !this.always()) return 'off';
    return this._status;
  }

  /** 지금 이 플레이어로 재생을 넘길 수 있는지 */
  available(): boolean {
    return (this.o.enabled() || this.always()) && !!this.browserPath;
  }
  always(): boolean {
    return !!this.o.always?.() && !!this.browserPath;
  }

  send(cmd: PlayerCommand) {
    switch (cmd.op) {
      case 'play':
        this.seq = cmd.seq;
        this.current = cmd;
        this.volume = cmd.volume;
        this.paused = cmd.paused;
        this.endedSent = -1;
        this.maxT = cmd.position;
        this.dur = null;
        this.sawMine = false;
        void this.play(cmd);
        break;
      case 'pause':
        this.paused = true;
        void this.evalState();
        break;
      case 'resume':
        this.paused = false;
        void this.evalState();
        break;
      case 'volume':
        this.volume = cmd.volume;
        void this.evalState();
        break;
      case 'stop':
        this.seq = cmd.seq;
        this.current = null;
        void this.idle();
        break;
      case 'prefetch':
        break; // 창 플레이어는 미리 확인하지 않음
    }
  }

  async shutdown() {
    this.stopPolling();
    this.cdp?.close();
    this.cdp = null;
  }

  /** 유튜브 창을 화면에 보이기/숨기기 (숨겨도 소리는 계속, 영상은 대시보드에 표시됨) */
  async setVisible(v: boolean) {
    this.visible = v;
    await this.applyVisibility();
  }
  get isVisible() {
    return this.visible;
  }

  // ── 내부 ──

  /** 숨겨져 있을 땐 화면을 정확히 640×360(16:9)으로 → 대시보드 영상이 안 잘리고 안 찌그러짐 */
  private async applyViewport() {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return;
    if (this.visible) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    else await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 360, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  }

  private async applyVisibility() {
    await this.applyViewport();
    const port = this.o.debugPort;
    try {
      const ver = (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())) as { webSocketDebuggerUrl?: string };
      const list = (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())) as { id: string; type: string }[];
      const page = list.find((t) => t.type === 'page');
      if (!ver.webSocketDebuggerUrl || !page) return;
      const b = await Cdp.connect(ver.webSocketDebuggerUrl);
      try {
        const { windowId } = await b.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: page.id });
        await b.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
        await b.send('Browser.setWindowBounds', {
          windowId,
          bounds: this.visible ? { left: 80, top: 80, width: 660, height: 420 } : { left: -4000, top: -4000, width: 660, height: 420 },
        });
      } finally {
        b.close();
      }
    } catch (err) {
      log.debug('window visibility change failed', String(err));
    }
  }

  private startScreencast(cdp: Cdp) {
    if (!this.o.onFrame) return;
    cdp.on('Page.screencastFrame', (p: { data: string; sessionId: number }) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      // 화면 크기가 16:9로 바뀌기 전 프레임은 버림 (찌그러진 화면 방지)
      const size = jpegSize(p.data);
      if (!this.visible && size && Math.abs(size.w / size.h - 16 / 9) > 0.05) return;
      const now = Date.now();
      if (now - this.lastFrameAt < 80 || !this.current) return; // 최대 약 12프레임
      if (!this.lastFrameAt) log.info('screencast frames flowing');
      this.lastFrameAt = now;
      this.o.onFrame?.(p.data);
    });
    void cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 640, maxHeight: 360, everyNthFrame: 1 }).catch(() => {});
  }

  private setStatus(s: Status) {
    if (this._status === s) return;
    this._status = s;
    this.o.onStatus?.();
  }

  private watchUrl(ref: string, position: number) {
    const base = this.o.watchBase ?? 'https://www.youtube.com/watch';
    const t = Math.max(0, Math.floor(position));
    return `${base}?v=${encodeURIComponent(ref)}${t ? `&t=${t}s` : ''}`;
  }

  private async play(cmd: Extract<PlayerCommand, { op: 'play' }>) {
    this.setStatus('starting');
    const cdp = await this.ensure();
    if (!cdp || this.seq !== cmd.seq) {
      if (!cdp) this.o.report({ type: 'player.error', seq: cmd.seq, code: 'window-unavailable' });
      return;
    }
    try {
      this.navigatedAt = Date.now();
      const url = cmd.track.source === 'local' && this.o.localUrl
        ? `${this.o.localUrl(cmd.track.id)}#t=${Math.floor(cmd.position)}`
        : this.watchUrl(cmd.track.ref, cmd.position);
      await cdp.send('Page.navigate', { url });
      await cdp.send('Page.bringToFront').catch(() => {});
      this.setStatus('playing');
      this.startPolling();
    } catch (err) {
      log.warn('navigate failed', String(err));
      this.o.report({ type: 'player.error', seq: cmd.seq, code: 'window-navigate' });
    }
  }

  private async idle() {
    this.stopPolling();
    this.setStatus(this.browserPath ? 'idle' : 'unavailable');
    if (!this.cdp || this.cdp.closed) return;
    // 소리만 끄고 창은 유지 (다음 곡을 빨리 틀기 위해)
    await this.cdp
      .send('Runtime.evaluate', { expression: `document.querySelector('video')?.pause(); document.title=${JSON.stringify(WINDOW_TITLE)};` })
      .catch(() => {});
    await this.cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
  }

  private startPolling() {
    this.stopPolling();
    this.poll = setInterval(() => void this.tick(), 1000);
  }
  private stopPolling() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private async tick() {
    const cur = this.current;
    if (!cur) return this.stopPolling();
    const s = await this.evalState();
    if (!s || this.current !== cur) return;
    const seq = cur.seq;
    const mine = cur.track.source === 'local' ? s.href.includes(`/media/${cur.track.id}`) : s.vid === cur.track.ref;
    const ended = () => {
      if (this.endedSent === seq) return;
      this.endedSent = seq;
      this.o.report({ type: 'player.ended', seq });
    };
    // 끝까지 재생돼서 우리가 멈춰 둔 곡
    if (cur.track.source === 'youtube' && s.endedVid === cur.track.ref) return ended();
    if (!mine) {
      // 유튜브가 다른 영상(자동재생·추천)으로 넘어감 → 이 곡은 끝난 걸로 (같은 곡 다시 틀지 않음)
      if (this.sawMine && cur.track.source === 'youtube') {
        log.info(`page left "${cur.track.title}" at ${this.maxT.toFixed(0)}s → next`);
        return ended();
      }
      return this.o.report({ type: 'player.hb', seq, state: 'loading', time: this.maxT, duration: null });
    }
    this.sawMine = true;
    if (s.err && Date.now() - this.navigatedAt > 3000) {
      log.warn(`youtube page error: ${s.err}`);
      return this.o.report({ type: 'player.error', seq, code: 'window-error' });
    }
    if (s.ad) return this.o.report({ type: 'player.hb', seq, state: 'ad', time: this.maxT, duration: null });
    if (s.ended && s.t > 1) return ended();
    if (s.ready && s.t > this.maxT) this.maxT = s.t;
    if (s.d) this.dur = s.d;
    const state = !s.ready ? 'loading' : s.paused ? (this.paused ? 'paused' : 'buffering') : 'playing';
    this.o.report({ type: 'player.hb', seq, state, time: s.t, duration: s.d });
  }

  /** 페이지 상태 읽기 + 원하는 상태(볼륨·일시정지)로 맞추기. 유튜브 자동재생(다음 영상)도 끔 */
  private async evalState(): Promise<PageState | null> {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return null;
    const expr = `(() => {
      document.title = ${JSON.stringify(WINDOW_TITLE)};
      ${PAGE_SCRIPT}
      const p = document.querySelector('#movie_player');
      const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
      let vid = null; try { vid = new URL(location.href).searchParams.get('v'); } catch {}
      const ad = !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
      const e = document.querySelector('.ytp-error');
      const err = e && e.offsetParent !== null ? (e.innerText || 'error').slice(0, 120) : null;
      const an = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]'); if (an) an.click();
      const endedVid = window.__lbEnded || null;
      if (v) {
        v.volume = ${this.volume / 100};
        if (!ad && ${this.paused} && !v.paused) v.pause();
        if ((ad || !${this.paused}) && v.paused && !v.ended && !endedVid) v.play().catch(() => {});
      }
      return { vid, endedVid, href: location.href, ready: !!v && v.readyState >= 2, ad, err, t: v ? v.currentTime : 0,
               d: v && isFinite(v.duration) ? v.duration : null, paused: v ? v.paused : true, ended: v ? v.ended : false };
    })()`;
    try {
      const r = await cdp.send<{ result: { value: PageState } }>('Runtime.evaluate', { expression: expr, returnByValue: true });
      return r.result?.value ?? null;
    } catch {
      return null;
    }
  }

  /** 창(브라우저)이 없으면 띄우고 CDP로 붙음. 창을 닫았으면 다음 곡 때 다시 띄움 */
  private ensure(): Promise<Cdp | null> {
    if (this.cdp && !this.cdp.closed) return Promise.resolve(this.cdp);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!this.browserPath) return null;
      const port = this.o.debugPort;
      let page = await this.findPage(port);
      if (!page) {
        const profile = join(this.o.dataDir, 'youtube-window');
        mkdirSync(profile, { recursive: true });
        log.info(`launching ${this.browserPath}`);
        try {
          Bun.spawn(
            [
              this.browserPath,
              `--remote-debugging-port=${port}`,
              '--remote-allow-origins=*',
              `--user-data-dir=${profile}`,
              '--no-first-run',
              '--no-default-browser-check',
              '--autoplay-policy=no-user-gesture-required',
              '--window-size=660,420',
              // 화면 밖에 숨겨도 재생·화면 갱신이 멈추지 않게
              '--window-position=-4000,-4000',
              '--disable-backgrounding-occluded-windows',
              '--disable-renderer-backgrounding',
              '--disable-background-timer-throttling',
              '--disable-features=CalculateNativeWinOcclusion',
              ...(this.o.extraArgs ?? []),
              '--app=about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
          ).unref();
        } catch (err) {
          log.error('browser launch failed', String(err));
          return null;
        }
        for (let i = 0; i < 40 && !page; i++) {
          await Bun.sleep(250);
          page = await this.findPage(port);
        }
      }
      if (!page) {
        log.warn('browser did not expose a page');
        return null;
      }
      try {
        const cdp = await Cdp.connect(page);
        await cdp.send('Page.enable').catch(() => {});
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT }).catch(() => {});
        this.cdp = cdp;
        await this.applyViewport();
        this.startScreencast(cdp);
        // 처음엔 화면 밖에 띄우므로 창을 옮길 필요 없음 (사용자가 '보이기'를 눌러 둔 경우만)
        if (this.visible) void this.applyVisibility();
        return cdp;
      } catch (err) {
        log.warn('cdp connect failed', String(err));
        return null;
      }
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async findPage(port: number): Promise<string | null> {
    try {
      const list = (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())) as {
        type: string;
        webSocketDebuggerUrl?: string;
      }[];
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  }
}
