import type { Database } from 'bun:sqlite';
import type { OverlayMessage, TtsItem, TtsState, Viewer } from '@localbot/shared';
import { getSetting, setSetting } from '../../core/db.ts';
import { createLogger } from '../../core/logger.ts';
import { ONLINE_VOICES } from './online.ts';
import { normalizeVoice, type Speaker } from './speaker.ts';
import { cleanMessage, DEFAULT_TTS, OLD_DEFAULT_TEMPLATES, sanitizeTts, speechFor, type TtsSettings } from './text.ts';

const log = createLogger('tts');
const KEY = 'tts.settings';

export type { TtsItem, TtsState };

/**
 * 후원 TTS. 한 번에 하나씩 순서대로 읽고, 읽는 동안 노래 소리를 줄임.
 * 알림 오버레이(/o/alert)가 연결돼 있으면 화면에 후원 카드도 띄움.
 */
export class TtsService {
  private queue: TtsItem[] = [];
  private speaking: TtsItem | null = null;
  private cancel: (() => void) | null = null;
  private nextId = 1;
  private overlays = new Map<string, (m: OverlayMessage) => void>();
  private voiceList: string[] = [];
  /** 말하기 시작 전(노래 줄이는 중)에 누른 건너뛰기 */
  private skipPending = false;
  private running = false;

  constructor(
    private db: Database,
    private speaker: Speaker,
    private hooks: { duck: (on: boolean) => void; onChange: () => void; now?: () => number },
  ) {
    void speaker.voices().then((v) => {
      this.voiceList = v;
      if (v.length) hooks.onChange();
    }).catch(() => {});
  }

  settings(): TtsSettings {
    const saved = getSetting<Partial<TtsSettings>>(this.db, KEY, {});
    if (saved.template && OLD_DEFAULT_TEMPLATES.includes(saved.template)) delete saved.template;
    return { ...DEFAULT_TTS, ...saved };
  }
  setSettings(p: Partial<TtsSettings>) {
    const next = { ...this.settings(), ...sanitizeTts(p) };
    setSetting(this.db, KEY, next);
    this.hooks.onChange();
    return next;
  }

  state(): TtsState {
    const settings = this.settings();
    const windows = this.voiceList.map((v) => {
      const [name, lang] = v.split('|');
      return { id: `sapi:${name}`, label: `${name}${lang ? ` (${lang})` : ''}`, group: '윈도우 내장 (인터넷 없이)' };
    });
    return {
      settings, available: this.speaker.available, speaking: this.speaking, queue: [...this.queue], voices: this.voiceList,
      voiceOptions: [...ONLINE_VOICES.map((v) => ({ ...v, group: v.group === '구글' ? '구글' : '자연스러운 목소리 (인터넷)' })), ...windows],
      voiceSelected: normalizeVoice(settings.voice),
      voiceUsed: this.speaker.lastUsed ?? null,
      voiceError: this.speaker.lastError ?? null,
    };
  }

  onDonation(viewer: Viewer | null, amountKRW: number, text: string | undefined) {
    const s = this.settings();
    if (!s.enabled || !s.readDonations || amountKRW < s.minAmountKRW) return;
    if (!viewer && !s.readAnonymous) return;
    if (viewer && this.ignored(viewer, s)) return;
    this.enqueue({ kind: 'donation', nickname: viewer?.nickname ?? null, amountKRW, text });
  }

  /** 일반 채팅 읽기 */
  onChat(viewer: Viewer, text: string) {
    const s = this.settings();
    if (!s.enabled || !s.readChat) return;
    const t = text.trim();
    if (!t || t.startsWith('!')) return; // 명령어는 안 읽음
    const r = viewer.roles;
    if (r.includes('streamer') && !s.readStreamer) return;
    if (s.chatWho === 'manager' && !r.includes('manager') && !r.includes('streamer')) return;
    if (s.chatWho === 'subscriber' && !r.some((x) => x === 'subscriber' || x === 'manager' || x === 'streamer')) return;
    if (this.ignored(viewer, s)) return;
    this.enqueue({ kind: 'chat', nickname: viewer.nickname, amountKRW: 0, text: t });
  }

  private ignored(v: Viewer, s: TtsSettings) {
    const n = v.nickname.trim().toLowerCase();
    return s.ignoreNames.some((x) => x.trim().toLowerCase() === n);
  }

  /** 대시보드 "테스트" */
  test(text = '테스트입니다. 잘 들리나요?') {
    this.enqueue({ kind: 'chat', nickname: '테스트시청자', amountKRW: 0, text });
  }

  skip() {
    if (!this.speaking) return;
    if (this.cancel) this.cancel();
    else this.skipPending = true;
  }
  clear() {
    this.queue = [];
    this.skip();
    this.hooks.onChange();
  }

  addOverlay(id: string, send: (m: OverlayMessage) => void) {
    this.overlays.set(id, send);
    if (this.speaking) send({ type: 'alert.show', alert: this.speaking });
  }
  removeOverlay(id: string) {
    this.overlays.delete(id);
  }

  private enqueue(i: { kind: TtsItem['kind']; nickname: string | null; amountKRW: number; text?: string }) {
    const s = this.settings();
    const item: TtsItem = {
      // 방송 화면용: 링크·금지어는 화면에도 안 나오게
      id: this.nextId++, kind: i.kind, nickname: i.nickname, amountKRW: i.amountKRW, message: cleanMessage(i.text ?? '', { maxChars: 120, bannedWords: s.bannedWords }),
      speech: speechFor(i, s), at: (this.hooks.now ?? Date.now)(),
    };
    if (item.kind === 'chat' && !item.speech) return;
    this.queue.push(item);
    // 채팅이 너무 밀리면 오래된 채팅부터 버림 (후원은 안 버림)
    let chats = this.queue.filter((q) => q.kind === 'chat').length;
    while (chats > s.maxQueue) {
      const i2 = this.queue.findIndex((q) => q.kind === 'chat');
      this.queue.splice(i2, 1);
      chats--;
    }
    log.info(`queued #${item.id} (${item.kind}): ${item.speech}`);
    this.hooks.onChange();
    if (!this.running) void this.run();
  }

  private async run() {
    this.running = true;
    let ducked = false;
    const duck = (on: boolean) => {
      if (ducked === on) return;
      ducked = on;
      this.hooks.duck(on);
    };
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        const s = this.settings();
        this.speaking = item;
        this.hooks.onChange();
        const card = item.kind === 'donation';
        if (card) for (const send of this.overlays.values()) send({ type: 'alert.show', alert: item });
        try {
          // 읽을 게 있을 때만 노래 소리 줄임. 연달아 읽는 동안은 계속 줄인 채로
          if (item.speech && s.duck && !ducked) {
            duck(true);
            await Bun.sleep(400);
          }
          if (!item.speech) {
            await Bun.sleep(3000); // 메시지 없는 후원: 알림 카드만
          } else if (!this.skipPending && this.speaker.available) {
            const h = this.speaker.speak(item.speech, { voice: s.voice, rate: s.rate, volume: s.volume });
            this.cancel = h.cancel;
            await h.done;
          } else if (!this.skipPending) {
            await Bun.sleep(card ? 4000 : 1500); // 목소리가 없는 PC
          }
        } catch (err) {
          log.warn('speak failed', String(err));
        } finally {
          this.cancel = null;
          this.skipPending = false;
          if (card) for (const send of this.overlays.values()) send({ type: 'alert.hide', id: item.id });
          this.speaking = null;
          this.hooks.onChange();
        }
        await Bun.sleep(250);
      }
    } finally {
      duck(false);
      this.running = false;
    }
  }
}
