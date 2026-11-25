import type { Database } from 'bun:sqlite';
import type { OverlayMessage, TtsItem, TtsState, Viewer } from '@localbot/shared';
import { getSetting, setSetting } from '../../core/db.ts';
import { createLogger } from '../../core/logger.ts';
import type { Speaker } from './speaker.ts';
import { cleanMessage, DEFAULT_TTS, sanitizeTts, speechFor, type TtsSettings } from './text.ts';

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
    return { ...DEFAULT_TTS, ...getSetting<Partial<TtsSettings>>(this.db, KEY, {}) };
  }
  setSettings(p: Partial<TtsSettings>) {
    const next = { ...this.settings(), ...sanitizeTts(p) };
    setSetting(this.db, KEY, next);
    this.hooks.onChange();
    return next;
  }

  state(): TtsState {
    return { settings: this.settings(), available: this.speaker.available, speaking: this.speaking, queue: [...this.queue], voices: this.voiceList };
  }

  onDonation(viewer: Viewer | null, amountKRW: number, text: string | undefined) {
    const s = this.settings();
    if (!s.enabled || amountKRW < s.minAmountKRW) return;
    if (!viewer && !s.readAnonymous) return;
    this.enqueue({ nickname: viewer?.nickname ?? null, amountKRW, text });
  }

  /** 대시보드 "테스트" */
  test(text = '테스트 후원입니다. 잘 들리나요?') {
    this.enqueue({ nickname: '테스트시청자', amountKRW: 1000, text });
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

  private enqueue(i: { nickname: string | null; amountKRW: number; text?: string }) {
    const s = this.settings();
    const item: TtsItem = {
      // 방송 화면용: 링크·금지어는 화면에도 안 나오게
      id: this.nextId++, nickname: i.nickname, amountKRW: i.amountKRW, message: cleanMessage(i.text ?? '', { maxChars: 120, bannedWords: s.bannedWords }),
      speech: speechFor(i, s), at: (this.hooks.now ?? Date.now)(),
    };
    this.queue.push(item);
    log.info(`queued #${item.id}: ${item.speech}`);
    this.hooks.onChange();
    if (!this.speaking) void this.run();
  }

  private async run() {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      const s = this.settings();
      this.speaking = item;
      this.hooks.onChange();
      for (const send of this.overlays.values()) send({ type: 'alert.show', alert: item });
      if (s.duck) this.hooks.duck(true);
      try {
        await Bun.sleep(400); // 노래 소리가 줄어든 뒤 읽기
        if (!this.skipPending && this.speaker.available) {
          const h = this.speaker.speak(item.speech, { voice: s.voice, rate: s.rate, volume: s.volume });
          this.cancel = h.cancel;
          await h.done;
        } else if (!this.skipPending) {
          await Bun.sleep(4000); // 목소리가 없는 PC: 알림 카드만 잠깐 보여 줌
        }
      } catch (err) {
        log.warn('speak failed', String(err));
      } finally {
        this.cancel = null;
        this.skipPending = false;
        if (s.duck) this.hooks.duck(false);
        for (const send of this.overlays.values()) send({ type: 'alert.hide', id: item.id });
        this.speaking = null;
        this.hooks.onChange();
      }
      await Bun.sleep(300);
    }
  }
}
