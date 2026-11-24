/** 플랫폼과 무관한 정규화 이벤트. 모듈은 이 타입만 봅니다. (DESIGN.md §6) */

export type Role = 'streamer' | 'manager' | 'subscriber' | 'follower' | 'viewer';

export interface Viewer {
  platform: 'chzzk';
  /** 플랫폼 고유 ID. 닉네임은 바뀌므로 키로 쓰지 않습니다. */
  id: string;
  nickname: string;
  roles: Role[];
}

export type BotEvent =
  | { type: 'chat'; viewer: Viewer; text: string; msgId: string }
  | {
      type: 'donation';
      viewer: Viewer | null; // 익명 후원
      amountKRW: number; // 치즈 1 = 1원
      text?: string;
      kind: 'chat' | 'video' | 'mission';
    }
  | { type: 'subscription'; viewer: Viewer; months: number; tier?: string }
  | { type: 'stream'; state: 'online' | 'offline' }
  | { type: 'system'; level: 'info' | 'warn' | 'error'; message: string };

export type EventSource = 'chzzk-official' | 'chzzk-readonly' | 'mock' | 'system';

export interface Envelope<E extends BotEvent = BotEvent> {
  id: string;
  ts: number;
  source: EventSource;
  event: E;
}
