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

/** 치지직 공식 연결 (봇 채팅 답장) */
export interface OfficialStatus {
  /** 로그인 버튼을 누를 수 있는 상태 (간편 로그인 서버가 있거나 직접 등록한 앱 정보가 있음) */
  configured: boolean;
  /** 키 입력 없이 로그인 버튼 하나로 (중계 서버) */
  easyLogin: boolean;
  loggedIn: boolean;
  clientId: string | null;
  channelId: string | null;
  channelName: string | null;
  redirectUri: string;
  error: string | null;
}

/** 서버 → 대시보드 */
export type ServerMessage =
  | { type: 'hello'; workerStartedAt: number; recent: Envelope[]; connection: ConnectionState; songs: SongsState; roulette: RouletteState; official: OfficialStatus }
  | { type: 'official'; state: OfficialStatus }
  /** 숨겨 둔 유튜브 창의 화면 (JPEG base64) */
  | { type: 'frame'; jpeg: string }
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
