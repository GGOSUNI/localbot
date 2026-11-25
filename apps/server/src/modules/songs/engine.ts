import type { NowPlaying, OverlayMessage, PlayerCommand, PlayerReport, Track } from '@localbot/shared';
import { createLogger } from '../../core/logger.ts';

const log = createLogger('player');

/**
 * 재생 엔진. "서버가 유일한 진실의 원천" — 플레이어(OBS 소스)는 명령을 받아 소리만 냅니다.
 * DESIGN.md §3.3, §3.4 의 고장 대책이 전부 여기 있습니다.
 */

export const WATCHDOG = {
  /** 곡 시작 후 첫 진행까지 기다리는 시간 (광고·로딩) */
  firstProgressGraceMs: 30_000,
  /** 멈춰서 다시 불러온 뒤 기다리는 시간 (무음이 길어지지 않게 짧게) */
  reloadGraceMs: 15_000,
  /** 재생 중 위치가 이만큼 안 움직이면 멈춘 것 */
  stallMs: 8_000,
  /** 멈춤 시 같은 위치에서 다시 불러오는 횟수 */
  maxReloads: 1,
  /** YouTube 연속 실패 몇 번이면 로컬 비상 스테이션으로 */
  ytFailsForFallback: 2,
  fallbackMs: 3 * 60_000,
  persistEveryMs: 2_000,
};

/** YouTube 에러 중 다시 시도해도 소용없는 것 (영상 없음·퍼가기 금지) */
export const PERMANENT_YT_ERRORS = new Set([2, 100, 101, 150]);
/** 유튜브 밖 재생 금지 → 유튜브 창에서는 재생됨 */
export const EMBED_BLOCKED_ERRORS = new Set([101, 150]);

/** 유튜브 창 플레이어 (window-player.ts) — 엔진이 보기엔 플레이어 하나 */
export interface WindowPlayerLike {
  available(): boolean;
  /** 모든 곡을 이 창으로 재생하는 모드인지 */
  always(): boolean;
  send(cmd: PlayerCommand): void;
}
export const WINDOW_ID = 'youtube-window';

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
  /** 재생 금지 영상으로 판명 → 유튜브 창으로 재생하도록 기록 */
  onEmbedBlocked(trackId: number): void;
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
  private window: WindowPlayerLike | null = null;
  /** 지금 곡을 내는 플레이어 (마스터 id 또는 WINDOW_ID) */
  private route: string | null = null;

  constructor(private host: EngineHost) {}

  setWindowPlayer(w: WindowPlayerLike | null) {
    this.window = w;
  }
  /** 유튜브 창 하나로 모든 곡을 재생하는 모드 (OBS 플레이어 없이도 동작) */
  private get windowAll(): boolean {
    return !!this.window?.available() && this.window.always();
  }
  /** 소리를 낼 수 있는 플레이어가 있는지 */
  private get canPlay(): boolean {
    return !!this.master || this.windowAll;
  }
  /** 재생 방식이 바뀌었거나 창 플레이어가 막 연결됐을 때: 지금 곡을 새 경로로 다시 (또는 시작) */
  reroute() {
    if (!this.canPlay) return this.host.changed();
    if (this.np) this.sendPlay(this.np.position, true);
    else this.next();
    this.host.changed();
  }
  get playingInWindow(): boolean {
    return this.route === WINDOW_ID && !!this.np;
  }

  get master(): PlayerConn | null {
    return this.players[0] ?? null;
  }
  /** 브라우저 자동재생 차단으로 플레이어 클릭을 기다리는 중 */
  get playerBlocked(): boolean {
    return this.blocked && !!this.np;
  }
  get playerOnline(): boolean {
    return this.canPlay;
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
      if (next && this.route === WINDOW_ID) {
        next.send({ type: 'player.role', master: true }); // 유튜브 창은 계속 재생
      } else if (next) {
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
    if (this.np && this.route === WINDOW_ID) return; // 유튜브 창에서 재생 중 → 그대로
    if (this.np) this.sendPlay(this.np.position);
    else this.next();
  }

  // ── 플레이어 보고 처리 ──
  report(playerId: string, r: PlayerReport) {
    const t = this.host.now();

    if (r.type === 'player.verified') {
      if (playerId !== this.master?.id) return;
      this.prefetching = null;
      this.host.onVerified(r.trackId, r.ok, r.duration, r.code);
      this.prefetch();
      return;
    }
    // 지금 곡을 내는 플레이어의 보고만 (보조 플레이어·이전 곡의 늦은 보고 무시)
    if (playerId !== (this.route ?? this.master?.id)) return;
    if (!this.np || r.seq !== this.seq) return;

    if (r.type === 'player.hb') {
      if (r.state === 'ad') {
        // 유튜브 창 광고 중: 멈춘 게 아님
        this.lastProgressAt = t;
        return;
      }
      const wasBlocked = this.blocked;
      this.blocked = r.state === 'blocked';
      if (wasBlocked !== this.blocked) this.host.changed();
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
    if (r.type === 'player.ended') {
      // 한 번도 진행된 적 없는 곡의 '끝남'은 이전 곡의 늦은 신호일 가능성 → 무시 (워치독이 따로 지켜봄)
      if (this.lastProgressAt === null && !(this.np.duration && this.lastTime >= this.np.duration - 3)) {
        log.warn(`ignoring premature 'ended' for "${this.np.track.title}" (no progress yet)`);
        return;
      }
      return this.finish('played', null);
    }
    if (r.type === 'player.error') {
      // 유튜브 밖 재생 금지 영상 → 실패로 넘기지 않고 유튜브 창으로 같은 위치부터
      if (typeof r.code === 'number' && EMBED_BLOCKED_ERRORS.has(r.code) && this.np.track.source === 'youtube' && this.window?.available()) {
        log.info(`"${this.np.track.title}" is embed-blocked (${r.code}) → YouTube window`);
        this.host.onEmbedBlocked(this.np.track.id);
        this.np.track = { ...this.np.track, embedBlocked: true };
        this.sendPlay(this.lastTime, true);
        this.host.changed();
        return;
      }
      return this.fail(`재생 오류 (${r.code})`, r.code);
    }
  }

  /** 1초마다 호출. 워치독 */
  tick() {
    const np = this.np;
    if (!np || this.paused || !this.canPlay || this.blocked) return;
    const t = this.host.now();
    const stalled =
      this.lastProgressAt === null
        ? t - this.playSentAt > (this.reloads > 0 ? WATCHDOG.reloadGraceMs : WATCHDOG.firstProgressGraceMs)
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
    // 다시 불러와도 아예 시작조차 못 했다면 영상 하나의 문제가 아니라 YouTube 자체가 안 되는 것 → 바로 비상 전환
    const neverStarted = this.lastProgressAt === null && np.position < 1;
    this.fail(neverStarted ? '재생이 시작되지 않음' : '재생이 멈춤', undefined, neverStarted);
  }

  /** 로컬 비상 스테이션을 끝내고 YouTube를 다시 시도 (대시보드 버튼) */
  endFallback() {
    if (this.fallbackUntil === null) return;
    this.fallbackUntil = null;
    this.ytFails = 0;
    if (this.np?.kind === 'station' && this.np.track.source === 'local') this.finish('interrupted', null);
    else this.host.changed();
  }

  // ── 조작 ──
  /** 큐가 바뀌었을 때: 놀고 있으면 시작, 스테이션 곡 중이면 (설정에 따라) 신청곡으로 전환 */
  kick(interruptStation: boolean) {
    if (!this.canPlay) return this.host.changed();
    if (!this.np) return this.next();
    if (this.np.kind === 'station' && interruptStation) return this.finish('interrupted', null);
    this.prefetch();
  }

  skip(reason: string | null = null) {
    if (this.np) this.finish('skipped', reason);
  }

  /** 지금 곡을 내는 플레이어에게 */
  private toRoute(cmd: PlayerCommand) {
    if (this.route === WINDOW_ID) this.window?.send(cmd);
    else this.master?.send({ type: 'player.cmd', cmd });
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.toRoute({ op: 'pause', seq: this.seq });
    this.host.persist(this.np, this.paused, this.volume);
    this.host.changed();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.lastProgressAt = null;
    this.playSentAt = this.host.now();
    this.toRoute({ op: 'resume', seq: this.seq });
    this.host.persist(this.np, this.paused, this.volume);
    this.host.changed();
    if (!this.np && this.canPlay) this.next();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    for (const p of this.players) p.send({ type: 'player.cmd', cmd: { op: 'volume', volume: this.volume } });
    this.window?.send({ op: 'volume', volume: this.volume });
    this.host.persist(this.np, this.paused, this.volume);
    this.host.changed();
  }

  /** 현재 곡이 큐에서 지워졌을 때 등, 다음 곡으로 */
  next() {
    if (!this.canPlay) return this.host.changed();
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
      this.master?.send({ type: 'player.cmd', cmd: { op: 'stop', seq: this.seq } });
      if (this.route === WINDOW_ID) this.window?.send({ op: 'stop', seq: this.seq });
      this.route = null;
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
    if (!m || this.windowAll) return; // 유튜브 창 모드에서는 미리 확인할 필요 없음 (막힌 곡이 없음)
    const t = this.host.peekUnverified();
    if (!t || t.id === this.prefetching || t.id === this.np?.track.id) return;
    this.prefetching = t.id;
    m.send({ type: 'player.cmd', cmd: { op: 'prefetch', trackId: t.id, ref: t.ref } });
  }

  // ── 내부 ──
  private sendPlay(position: number, isReload = false) {
    const np = this.np;
    const m = this.master;
    if (!np || !this.canPlay) return;
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
    const useWindow = this.windowAll || !m || (np.track.source === 'youtube' && !!np.track.embedBlocked && !!this.window?.available());
    if (useWindow) {
      // 소리가 겹치지 않게 OBS 플레이어는 멈추고 유튜브 창으로
      m?.send({ type: 'player.cmd', cmd: { op: 'stop', seq: this.seq } });
      this.window!.send(cmd);
      this.route = WINDOW_ID;
    } else {
      if (this.route === WINDOW_ID) this.window?.send({ op: 'stop', seq: this.seq });
      m!.send({ type: 'player.cmd', cmd });
      this.route = m!.id;
    }
  }

  private fail(reason: string, code?: number | string, severe = false) {
    const np = this.np;
    if (!np) return;
    // 영상 하나의 문제(삭제·퍼가기 금지)는 YouTube 장애로 세지 않음
    const videoSpecific = typeof code === 'number' && PERMANENT_YT_ERRORS.has(code);
    if (np.track.source === 'youtube' && !videoSpecific) {
      this.ytFails += severe ? WATCHDOG.ytFailsForFallback : 1;
      if (this.ytFails >= WATCHDOG.ytFailsForFallback && this.fallbackUntil === null) {
        this.fallbackUntil = this.host.now() + WATCHDOG.fallbackMs;
        this.host.notify('warn', 'YouTube 재생이 안 돼서 3분간 로컬 비상 스테이션으로 전환합니다. 신청곡은 대기열에 그대로 남아 있습니다.');
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
