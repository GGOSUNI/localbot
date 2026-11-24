import type { Envelope } from './events.ts';

/** 서버 → 클라이언트(대시보드/오버레이) WebSocket 메시지 */
export type ServerMessage =
  | { type: 'hello'; workerStartedAt: number; recent: Envelope[] }
  | { type: 'event'; envelope: Envelope };
