/** 신청곡 + 스테이션 공용 타입 (DESIGN.md §3) */

export type TrackSource = 'youtube' | 'local';

export interface Track {
  id: number;
  source: TrackSource;
  /** youtube: videoId, local: 파일 경로 */
  ref: string;
  title: string;
  artist: string | null;
  durationSec: number | null;
  /** null = 아직 검증 안 됨 */
  playable: boolean | null;
}

export type QueueStatus =
  | 'pending_approval' | 'queued' | 'playing' | 'played' | 'skipped' | 'failed' | 'cancelled' | 'rejected';

export interface QueueItem {
  id: number;
  track: Track;
  requesterName: string | null;
  requesterKey: string | null;
  priority: number; // 0 일반, 1 우선(후원)
  status: QueueStatus;
  reason: string | null;
  via: 'chat' | 'donation' | 'dashboard';
  paidKRW: number;
  requestedAt: number;
}

export interface NowPlaying {
  kind: 'request' | 'station';
  queueId: number | null;
  stationId: number | null;
  track: Track;
  requesterName: string | null;
  position: number;
  duration: number | null;
  startedAt: number;
}

export interface Station {
  id: number;
  name: string;
  kind: 'manual' | 'local' | 'popular';
  mode: 'sequential' | 'shuffle';
  folder: string | null;
  trackCount: number;
}

export interface SongPolicy {
  open: boolean;
  allowChat: boolean;
  allowDonation: boolean;
  permission: 'everyone' | 'subscriber' | 'manager';
  maxDurationSec: number;
  perUserLimit: number;
  dedupQueue: boolean;
  recentBlockMinutes: number;
  donationMinKRW: number;
  donationPriorityKRW: number;
  approvalMode: boolean;
  interruptStation: boolean;
  blacklistVideos: string[];
  blacklistKeywords: string[];
  stationNoRepeat: number;
}

export const DEFAULT_SONG_POLICY: SongPolicy = {
  open: true,
  allowChat: true,
  allowDonation: true,
  permission: 'everyone',
  maxDurationSec: 480,
  perUserLimit: 2,
  dedupQueue: true,
  recentBlockMinutes: 120,
  donationMinKRW: 0,
  donationPriorityKRW: 1000,
  approvalMode: false,
  interruptStation: false,
  blacklistVideos: [],
  blacklistKeywords: [],
  stationNoRepeat: 20,
};

export interface SongsState {
  now: NowPlaying | null;
  paused: boolean;
  volume: number;
  /** 플레이어(OBS 소스 등)가 연결되어 있는지 */
  playerOnline: boolean;
  /** 브라우저 자동재생 차단 → 플레이어 탭에서 클릭 필요 */
  playerBlocked: boolean;
  /** YouTube 연속 실패로 로컬 비상 스테이션 사용 중 */
  fallbackUntil: number | null;
  queue: QueueItem[];
  pending: QueueItem[];
  history: QueueItem[];
  stations: Station[];
  activeStationId: number | null;
  policy: SongPolicy;
  canUndo: string | null;
}

/** 서버 → 플레이어 명령 */
export type PlayerCommand =
  | { op: 'play'; seq: number; track: { id: number; source: TrackSource; ref: string; title: string }; position: number; volume: number; paused: boolean }
  | { op: 'pause'; seq: number }
  | { op: 'resume'; seq: number }
  | { op: 'stop'; seq: number }
  | { op: 'volume'; volume: number }
  | { op: 'prefetch'; trackId: number; ref: string };

/** 플레이어 → 서버 보고 */
export type PlayerReport =
  | { type: 'player.hb'; seq: number; state: 'loading' | 'playing' | 'paused' | 'buffering' | 'blocked'; time: number; duration: number | null }
  | { type: 'player.ended'; seq: number }
  | { type: 'player.error'; seq: number; code: number | string }
  | { type: 'player.verified'; trackId: number; ok: boolean; duration: number | null; code?: number | string };
