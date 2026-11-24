import type { Envelope } from './events.ts';

export interface ConnectionState {
  channelId: string | null;
  channelName: string | null;
  live: boolean;
  liveTitle: string | null;
  /** idle: 채널 미설정 · waiting: 채팅 채널 없음(방송 전) · connecting/connected/reconnecting */
  chat: 'idle' | 'waiting' | 'connecting' | 'connected' | 'reconnecting';
  mode: 'readonly' | 'official' | null;
  error: string | null;
}

/** 서버 → 클라이언트(대시보드/오버레이) WebSocket 메시지 */
export type ServerMessage =
  | { type: 'hello'; workerStartedAt: number; recent: Envelope[]; connection: ConnectionState }
  | { type: 'event'; envelope: Envelope }
  | { type: 'connection'; state: ConnectionState };
