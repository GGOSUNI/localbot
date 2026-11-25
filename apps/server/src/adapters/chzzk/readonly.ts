import type { ConnectionState, Envelope } from '@localbot/shared';
import { envelope } from '../../core/bus.ts';
import { createLogger } from '../../core/logger.ts';
import type { AdapterStatus, PlatformAdapter } from '../types.ts';
import { CMD, chatServerIndex, parseFrame } from './parse.ts';

const log = createLogger('chzzk');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const API = 'https://api.chzzk.naver.com';
const COMM = 'https://comm-api.game.naver.com/nng_main';
const POLL_MS = 30_000; // 방송 상태·채팅 채널 변경 확인 주기
const POLL_WAITING_MS = 10_000; // 방송 전(채팅방 없음)에는 더 자주 확인 → 방송 켜면 10초 안에 연결
const PING_MS = 20_000;
const SILENCE_MS = 65_000; // 이만큼 아무것도 안 오면 연결이 죽은 것으로 보고 다시 연결

export class ChannelNotFoundError extends Error {}

/** 채널 이름 조회 (주소 확인용). 없는 채널이면 ChannelNotFoundError */
export async function fetchChannelName(channelId: string): Promise<string> {
  const r = await get(`${API}/service/v1/channels/${channelId}`);
  // 없는 채널도 200 + channelId:null + "(알 수 없음)" 으로 응답함
  const name = r?.content?.channelId ? r.content.channelName : null;
  if (!name) throw new ChannelNotFoundError('채널을 찾을 수 없습니다');
  return name;
}

/**
 * 비공식 읽기 전용 연결: 로그인·앱 등록 없이 채널 주소만으로 채팅·후원·구독을 받습니다.
 * 봇이 채팅을 보낼 수는 없습니다 (공식 API 연결이 필요). DESIGN.md §5.2 방식 B.
 *
 * 고장 대책
 *  - 30초마다 방송 상태 확인 → 방송이 새로 켜져 채팅 채널이 바뀌면 자동으로 갈아탐
 *  - 20초마다 ping, 65초간 무응답이면 끊고 재연결
 *  - 재연결은 1초 → 2초 → … 최대 30초 백오프, 채팅 서버도 돌아가며 시도
 */
export class ChzzkReadonlyAdapter implements PlatformAdapter {
  readonly id = 'chzzk-readonly';
  readonly capabilities = { sendChat: false, deleteMessage: false, timeoutUser: false };

  private emit: ((env: Envelope) => void) | null = null;
  private ws: WebSocket | null = null;
  private chatChannelId: string | null = null;
  private stopped = true;
  private pollTimer: Timer | null = null;
  private pingTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private attempt = 0;
  private lastFrameAt = 0;
  private wasLive: boolean | null = null;

  readonly state: ConnectionState;

  constructor(
    readonly channelId: string,
    channelName: string,
    private onState: (s: ConnectionState) => void,
  ) {
    this.state = {
      channelId, channelName, live: false, liveTitle: null, chat: 'connecting', mode: 'readonly', error: null,
    };
  }

  async start(emit: (env: Envelope) => void) {
    this.emit = emit;
    this.stopped = false;
    await this.poll();
  }

  async stop() {
    this.stopped = true;
    for (const t of [this.pollTimer, this.reconnectTimer]) if (t) clearTimeout(t);
    this.closeSocket();
    this.emit = null;
    this.setState({ chat: 'idle' });
  }

  status(): AdapterStatus {
    return this.state.chat === 'connected' ? 'connected' : this.state.chat === 'idle' ? 'disconnected' : 'reconnecting';
  }

  async sendChat(): Promise<void> {
    throw new Error('읽기 전용 연결에서는 채팅을 보낼 수 없습니다');
  }

  // ── 방송 상태 폴링 ──
  private async poll() {
    if (this.stopped) return;
    try {
      const r = await get(`${API}/polling/v2/channels/${this.channelId}/live-status`);
      const c = r?.content;
      const live = c?.status === 'OPEN';
      if (this.wasLive !== null && live !== this.wasLive) {
        this.push({ type: 'stream', state: live ? 'online' : 'offline' });
      }
      this.wasLive = live;
      this.setState({ live, liveTitle: c?.liveTitle ?? null, error: null });

      const next: string | null = c?.chatChannelId ?? null;
      if (!next) {
        if (this.chatChannelId) this.closeSocket();
        this.chatChannelId = null;
        this.setState({ chat: 'waiting' });
      } else if (next !== this.chatChannelId) {
        if (this.chatChannelId) log.info(`chat channel changed ${this.chatChannelId} → ${next}`);
        this.chatChannelId = next;
        this.attempt = 0;
        this.connect();
      } else if (!this.ws && !this.reconnectTimer) {
        this.connect();
      }
    } catch (err) {
      log.warn('live-status poll failed', String(err));
      this.setState({ error: '치지직 서버에 연결할 수 없습니다 (인터넷 확인)' });
      if (!this.ws && this.chatChannelId && !this.reconnectTimer) this.scheduleReconnect();
    }
    if (!this.stopped) this.pollTimer = setTimeout(() => this.poll(), this.chatChannelId ? POLL_MS : POLL_WAITING_MS);
  }

  // ── 채팅 소켓 ──
  private async connect() {
    if (this.stopped || !this.chatChannelId) return;
    this.closeSocket();
    const cid = this.chatChannelId;
    this.setState({ chat: this.attempt === 0 ? 'connecting' : 'reconnecting' });

    let token: string;
    try {
      const r = await get(`${COMM}/v1/chats/access-token?channelId=${cid}&chatType=STREAMING`);
      token = r?.content?.accessToken;
      if (!token) throw new Error(`no access token (code ${r?.code})`);
    } catch (err) {
      log.warn('access token failed', String(err));
      return this.scheduleReconnect();
    }
    if (this.stopped || cid !== this.chatChannelId) return;

    const server = ((chatServerIndex(cid) - 1 + this.attempt) % 9) + 1; // 실패할 때마다 다른 서버
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const ws = new WebSocket(`wss://kr-ss${server}.chat.naver.com/chat`, (proxy ? { proxy } : {}) as any);
    this.ws = ws;
    this.lastFrameAt = Date.now();

    ws.onopen = () => {
      ws.send(JSON.stringify({
        ver: '3', cmd: CMD.CONNECT, svcid: 'game', cid, tid: 1,
        bdy: { uid: null, devType: 2001, accTkn: token, auth: 'READ' },
      }));
    };

    ws.onmessage = (m) => {
      this.lastFrameAt = Date.now();
      let frame: any;
      try {
        frame = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (frame.cmd === CMD.PING) return ws.send(JSON.stringify({ ver: '3', cmd: CMD.PONG }));
      if (frame.cmd === CMD.CONNECTED) {
        this.attempt = 0;
        log.info(`chat connected (kr-ss${server}, ${this.state.channelName})`);
        this.setState({ chat: 'connected', error: null });
        this.push({ type: 'system', level: 'info', message: `치지직 채팅 연결됨 — ${this.state.channelName}` });
        return;
      }
      for (const { event, ts } of parseFrame(frame)) this.push(event, ts);
    };

    ws.onclose = (e) => {
      if (this.ws !== ws) return; // 이미 교체된 소켓
      this.ws = null;
      this.clearPing();
      if (this.stopped) return;
      log.warn(`chat socket closed (code ${e.code})`);
      if (this.state.chat === 'connected') {
        this.push({ type: 'system', level: 'warn', message: '치지직 채팅 연결이 끊겼습니다. 다시 연결하는 중…' });
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose에서 처리 */
    };

    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > SILENCE_MS) {
        log.warn('chat silent too long — reconnecting');
        ws.close();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ver: '3', cmd: CMD.PING }));
    }, PING_MS);
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.setState({ chat: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private closeSocket() {
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  }

  private clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private push(event: Envelope['event'], ts?: number) {
    this.emit?.(envelope('chzzk-readonly', event, ts));
  }

  private setState(patch: Partial<ConnectionState>) {
    Object.assign(this.state, patch);
    this.onState({ ...this.state });
  }
}

async function get(url: string): Promise<any> {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
