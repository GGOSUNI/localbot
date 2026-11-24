import type { Envelope } from './events.ts';
import type { RouletteState, Spin } from './roulette.ts';
import type { PlayerCommand, PlayerReport, SongsState } from './songs.ts';

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

/** 서버 → 대시보드 */
export type ServerMessage =
  | { type: 'hello'; workerStartedAt: number; recent: Envelope[]; connection: ConnectionState; songs: SongsState; roulette: RouletteState }
  | { type: 'event'; envelope: Envelope }
  | { type: 'connection'; state: ConnectionState }
  | { type: 'songs'; state: SongsState }
  | { type: 'roulette'; state: RouletteState };

/** 서버 → 오버레이/플레이어 */
export type OverlayMessage =
  | { type: 'overlay.hello'; role: 'player' | 'overlay'; master: boolean }
  | { type: 'player.role'; master: boolean }
  | { type: 'player.cmd'; cmd: PlayerCommand }
  | { type: 'songs'; state: Pick<SongsState, 'now' | 'paused' | 'queue'> }
  | { type: 'roulette.show'; spin: Spin };

/** 오버레이/플레이어 → 서버 */
export type OverlayReport = PlayerReport | { type: 'roulette.done'; spinId: number };
