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
/** 후원 TTS */
export interface TtsSettings {
  enabled: boolean;
  minAmountKRW: number;
  /** {user} {amount} {message} */
  template: string;
  maxChars: number;
  /** 비우면 자동 (한국어 목소리 우선) */
  voice: string;
  /** -10 ~ 10 */
  rate: number;
  /** 0 ~ 100 */
  volume: number;
  /** 읽는 동안 노래 소리를 줄임 */
  duck: boolean;
  bannedWords: string[];
  /** 익명 후원도 읽기 */
  readAnonymous: boolean;
}
export interface TtsItem { id: number; nickname: string | null; amountKRW: number; message: string; speech: string; at: number }
export interface TtsState { settings: TtsSettings; available: boolean; speaking: TtsItem | null; queue: TtsItem[]; voices: string[] }

export type ServerMessage =
  | { type: 'hello'; workerStartedAt: number; recent: Envelope[]; connection: ConnectionState; songs: SongsState; roulette: RouletteState; official: OfficialStatus }
  | { type: 'official'; state: OfficialStatus }
  /** 숨겨 둔 유튜브 창의 화면 (JPEG base64) */
  | { type: 'frame'; jpeg: string }
  | { type: 'event'; envelope: Envelope }
  | { type: 'connection'; state: ConnectionState }
  | { type: 'songs'; state: SongsState }
  | { type: 'roulette'; state: RouletteState }
  | { type: 'tts'; state: TtsState };

/** 서버 → 오버레이/플레이어 */
export type OverlayMessage =
  | { type: 'overlay.hello'; role: 'player' | 'overlay' | 'alert'; master: boolean }
  | { type: 'player.role'; master: boolean }
  | { type: 'player.cmd'; cmd: PlayerCommand }
  | { type: 'songs'; state: Pick<SongsState, 'now' | 'paused' | 'queue'> }
  | { type: 'roulette.show'; spin: Spin }
  /** 후원 알림 (TTS 읽는 동안 표시) */
  | { type: 'alert.show'; alert: { id: number; nickname: string | null; amountKRW: number; message: string } }
  | { type: 'alert.hide'; id: number };

/** 오버레이/플레이어 → 서버 */
export type OverlayReport = PlayerReport | { type: 'roulette.done'; spinId: number };
