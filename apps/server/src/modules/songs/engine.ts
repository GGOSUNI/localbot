import type { NowPlaying, OverlayMessage, PlayerCommand, PlayerReport, Track } from '@localbot/shared';
import { createLogger } from '../../core/logger.ts';

const log = createLogger('player');

/**
 * 재생 엔진. "서버가 유일한 진실의 원천" — 플레이어(OBS 소스)는 명령을 받아 소리만 냅니다.
 * DESIGN.md §3.3, §3.4 의 고장 대책이 전부 여기 있습니다.
 */

export const WATCHDOG = {
  /** 곡 시작 후 첫 진행까지 기다리는 시간 (광고·로딩) */
  firstProgressGraceMs: 45_000,
  /** 재생 중 위치가 이만큼 안 움직이면 멈춘 것 */
  stallMs: 8_000,
  /** 멈춤 시 같은 위치에서 다시 불러오는 횟수 */
  maxReloads: 1,
  /** YouTube 연속 실패 몇 번이면 로컬 비상 스테이션으로 */
  ytFailsForFallback: 3,
  fallbackMs: 5 * 60_000,
  persistEveryMs: 2_000,
};

/** YouTube 에러 중 다시 시도해도 소용없는 것 (영상 없음·퍼가기 금지) */
export const PERMANENT_YT_ERRORS = new Set([2, 100, 101, 150]);

export type Pick =
  | { kind: 'request'; queueId: number; track: Track; requesterName: string | null }
  | { kind: 'station'; stationId: number; track: Track };

export type Outcome = 'played' | 'skipped' | 'failed' | 'interrupted';

export interface EngineHost {
  now(): number;
  pickNext(localOnly: boolean): Pick | null;
  /** 다음에 재생될 곡 중 아직 검증 안 된 YouTube 곡 */
  peekUnverified(): Track | null;
  onStarted(np: NowPlaying): void;
  onFinished(np: NowPlaying, outcome: Outcome, reason: string | null, code?: number | string): void;
  onVerified(trackId: number, ok: boolean, duration: number | null, code?: number | string): void;
  /** 재생 중 실제 길이가 확인됐을 때. 'skip'을 돌려주면 너무 긴 곡으로 건너뜀 */
  onDurationKnown(np: NowPlaying, duration: number): 'ok' | 'skip';
  notify(level: 'info' | 'warn', message: string): void;
  persist(np: NowPlaying | null, paused: boolean, volume: number): void;
  changed(): void;
}

interface PlayerConn {
  id: string;
  send(msg: OverlayMessage): void;
}

export class PlayerEngine {
  np: NowPlaying | null = null;
  paused = false;
  volume = 60;
  fallbackUntil: number | null = null;

  private players: PlayerConn[] = [];
  private seq = 0;
  private playSentAt = 0;
  private lastProgressAt: number | null = null;
  private lastTime = 0;
  private reloads = 0;
  private blocked = false;
  private ytFails = 0;
  private lastPersist = 0;
  private prefetching: number | null = null;

  constructor(private host: EngineHost) {}

  get master(): PlayerConn | null {
    return this.players[0] ?? null;
  }
  get playerOnline(): boolean {
    return this.players.length > 0;
  }

  /** 워커 재시작 후 DB에서 복원. 플레이어가 붙으면 같은 위치부터 이어서 재생 */
  restore(np: NowPlaying | null, paused: boolean, volume: number) {
    this.np = np;
    this.paused = paused;
    this.volume = volume;
  }

  // ── 플레이어 연결 관리 (마스터 리스: 소리는 하나만) ──
  addPlayer(id: string, send: PlayerConn['send']) {
    this.players.push({ id, send });
    const isMaster = this.master?.id === id;
    send({ type: 'player.role', master: isMaster });
    if (isMaster) this.onMasterReady();
    this.host.changed();
  }

  removePlayer(id: string) {
    const wasMaster = this.master?.id === id;
    this.players = this.players.filter((p) => p.id !== id);
    if (wasMaster) {
      log.warn('master player disconnected');
      const next = this.master;
      if (next) {
        next.send({ type: 'player.role', master: true });
        this.onMasterReady();
      } else {
        this.host.persist(this.np, this.paused, this.volume);
      }
    }
    this.host.changed();
  }

  private onMasterReady() {
    this.prefetching = null;
    if (this.np) this.sendPlay(this.np.position);
    else this.next();
  }

  // ── 플레이어 보고 처리 ──
  report(playerId: string, r: PlayerReport) {
    if (playerId !== this.master?.id) return; // 모니터(보조) 플레이어의 보고는 무시
    const t = this.host.now();

    if (r.type === 'player.verified') {
      this.prefetching = null;
      this.host.onVerified(r.trackId, r.ok, r.duration, r.code);
      this.prefetch();
      return;
    }
    if (!this.np || r.seq !== this.seq) return; // 이전 곡에 대한 늦은 보고

    if (r.type === 'player.hb') {
      this.blocked = r.state === 'blocked';
      if (r.state === 'playing' && r.time > this.lastTime + 0.25) {
        this.lastProgressAt = t;
        if (this.np.track.source === 'youtube') this.ytFails = 0;
      }
      this.lastTime = r.time;
      this.np.position = r.time;
      if (r.duration && r.duration > 0 && this.np.duration !== r.duration) {
        this.np.duration = r.duration;
        if (this.host.onDurationKnown(this.np, r.duration) === 'skip') {
          return this.finish('failed', `너무 긴 곡 (${Math.round(r.duration / 60)}분)`);
        }
      }
      if (t - this.lastPersist > WATCHDOG.persistEveryMs) {
        this.lastPersist = t;
        this.host.persist(this.np, this.paused, this.volume);
      }
      return;
    }
    if (r.type === 'player.ended') return this.finish('played', null);
    if (r.type === 'player.error') return this.fail(`재생 오류 (${r.code})`, r.code);
  }

  /** 1초마다 호출. 워치독 */
  tick() {
    const np = this.np;
    if (!np || this.paused || !this.master || this.blocked) return;
    const t = this.host.now();
    const stalled =
      this.lastProgressAt === null
        ? t - this.playSentAt > WATCHDOG.firstProgressGraceMs
        : t - this.lastProgressAt > WATCHDOG.stallMs;
    if (!stalled) return;

    // 끝부분에서 멈췄으면 ended 이벤트를 놓친 것 → 정상 종료로 처리
    if (np.duration && this.lastTime >= np.duration - 2) return this.finish('played', null);

    if (this.reloads < WATCHDOG.maxReloads) {
      this.reloads++;
      log.warn(`stall detected — reloading "${np.track.title}" at ${this.lastTime.toFixed(1)}s`);
      this.host.notify('warn', `재생이 멈춰서 다시 불러옵니다: ${np.track.title}`);
      this.sendPlay(this.lastTime, true);
      return;
    }
    this.fail('재생이 멈춤');
  }

  // ── 조작 ──
  /** 큐가 바뀌었을 때: 놀고 있으면 시작, 스테이션 곡 중이면 (설정에 따라) 신청곡으로 전환 */
  kick(interruptStation: boolean) {
    if (!this.master) return this.host.changed();
    if (!this.np) return this.next();
    if (this.np.kind === 'station' && interruptStation) return this.finish('interrupted', null);
    this.prefetch();
  }

  skip(reason: string | null = null) {
    if (this.np) this.finish('skipped', reason);
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.master?.send({ type: 'player.cmd', cmd: { op: 'pause', seq: this.seq } });
    this.host.persist(this.np, this.paused, this.volume);
    this.host.changed();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.lastProgressAt = null;
    this.playSentAt = this.host.now();
    this.master?.send({ type: 'player.cmd', cmd: { op: 'resume', seq: this.seq } });
    this.host.persist(this.np, this.paused, this.volume);
    this.host.changed();
    if (!this.np && this.master) this.next();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    for (const p of this.players) p.send({ type: 'player.cmd', cmd: { op: 'volume', volume: this.volume } });
    this.host.persist(this.np, this.paused, this.volume);
    this.host.changed();
  }

  /** 현재 곡이 큐에서 지워졌을 때 등, 다음 곡으로 */
  next() {
    if (!this.master) return this.host.changed();
    const t = this.host.now();
    if (this.fallbackUntil && t >= this.fallbackUntil) {
      this.fallbackUntil = null;
      this.ytFails = 0;
      this.host.notify('info', 'YouTube 재생을 다시 시도합니다');
    }
    const pick = this.host.pickNext(this.fallbackUntil !== null);
    if (!pick) {
      this.np = null;
      this.seq++;
      this.master.send({ type: 'player.cmd', cmd: { op: 'stop', seq: this.seq } });
      this.host.persist(null, this.paused, this.volume);
      this.host.changed();
      return;
    }
    this.np = {
      kind: pick.kind,
      queueId: pick.kind === 'request' ? pick.queueId : null,
      stationId: pick.kind === 'station' ? pick.stationId : null,
      track: pick.track,
      requesterName: pick.kind === 'request' ? pick.requesterName : null,
      position: 0,
      duration: pick.track.durationSec,
      startedAt: t,
    };
    this.reloads = 0;
    this.host.onStarted(this.np);
    this.sendPlay(0);
    this.host.persist(this.np, this.paused, this.volume);
    this.host.changed();
    this.prefetch();
  }

  /** 다음 곡을 숨은 플레이어로 미리 불러 재생 가능 여부를 확인 */
  prefetch() {
    const m = this.master;
    if (!m) return;
    const t = this.host.peekUnverified();
    if (!t || t.id === this.prefetching || t.id === this.np?.track.id) return;
    this.prefetching = t.id;
    m.send({ type: 'player.cmd', cmd: { op: 'prefetch', trackId: t.id, ref: t.ref } });
  }

  // ── 내부 ──
  private sendPlay(position: number, isReload = false) {
    const np = this.np;
    const m = this.master;
    if (!np || !m) return;
    this.seq++;
    this.playSentAt = this.host.now();
    this.lastProgressAt = null;
    this.lastTime = position;
    this.blocked = false;
    if (!isReload) this.reloads = 0;
    const cmd: PlayerCommand = {
      op: 'play', seq: this.seq, position, volume: this.volume, paused: this.paused,
      track: { id: np.track.id, source: np.track.source, ref: np.track.ref, title: np.track.title },
    };
    m.send({ type: 'player.cmd', cmd });
  }

  private fail(reason: string, code?: number | string) {
    const np = this.np;
    if (!np) return;
    if (np.track.source === 'youtube') {
      this.ytFails++;
      if (this.ytFails >= WATCHDOG.ytFailsForFallback && this.fallbackUntil === null) {
        this.fallbackUntil = this.host.now() + WATCHDOG.fallbackMs;
        this.host.notify('warn', 'YouTube 재생이 연속으로 실패해서 5분간 로컬 비상 스테이션으로 전환합니다. 신청곡은 대기열에 그대로 남아 있습니다.');
      }
    }
    this.finish('failed', reason, code);
  }

  private finish(outcome: Outcome, reason: string | null, code?: number | string) {
    const np = this.np;
    if (!np) return;
    log.info(`finish "${np.track.title}" → ${outcome}${reason ? ` (${reason})` : ''}`);
    this.np = null;
    this.host.onFinished(np, outcome, reason, code);
    this.next();
  }
}
