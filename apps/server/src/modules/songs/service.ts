import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  DEFAULT_SONG_POLICY, type NowPlaying, type QueueItem, type SongPolicy, type SongsState, type Station, type Track, type Viewer,
} from '@localbot/shared';
import { getSetting, setSetting } from '../../core/db.ts';
import { viewerKey } from '../../core/ingest.ts';
import { createLogger } from '../../core/logger.ts';
import { type EngineHost, type Outcome, PERMANENT_YT_ERRORS, type Pick, PlayerEngine } from './engine.ts';
import { SongStore, toTrack } from './store.ts';
import { checkOEmbed, findYouTubeId, type OEmbedResult } from './youtube.ts';

const log = createLogger('songs');

export const AUDIO_EXT = new Set(['.mp3', '.ogg', '.oga', '.opus', '.wav', '.flac', '.m4a', '.aac', '.webm']);
const POPULAR_NAME = '인기 신청곡';

export interface SongDeps {
  db: Database;
  now?: () => number;
  oembed?: (videoId: string) => Promise<OEmbedResult>;
  random?: () => number;
  /** 사용자에게 보여줄 알림 (대시보드 로그) */
  notify: (level: 'info' | 'warn', message: string) => void;
  /** 채팅 응답 (읽기 전용이면 대시보드에만 표시됨) */
  reply: (text: string) => void;
  onChange: () => void;
}

export type RequestResult = { ok: true; item: QueueItem; message: string } | { ok: false; message: string };

export class SongService {
  readonly store: SongStore;
  readonly engine: PlayerEngine;
  private now: () => number;
  private oembed: (id: string) => Promise<OEmbedResult>;
  private random: () => number;
  private timer: Timer | null = null;

  constructor(private deps: SongDeps) {
    this.store = new SongStore(deps.db);
    this.now = deps.now ?? Date.now;
    this.oembed = deps.oembed ?? ((id) => checkOEmbed(id));
    this.random = deps.random ?? Math.random;
    this.engine = new PlayerEngine(this.host());

    // 이전 실행 복원: 재생 중이던 곡과 위치
    const saved = this.store.loadPlayer();
    let np = saved.now;
    if (np?.queueId) {
      const st = this.store.rawQueueState(np.queueId);
      if (st?.status !== 'playing') np = null;
    }
    for (const id of this.store.danglingPlaying()) {
      if (id !== np?.queueId) this.store.setStatus(id, 'queued', this.now());
    }
    this.engine.restore(np, saved.paused, saved.volume);
  }

  start() {
    this.timer = setInterval(() => this.engine.tick(), 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.store.savePlayer(this.engine.np, this.engine.paused, this.engine.volume, this.now());
  }

  policy(): SongPolicy {
    return { ...DEFAULT_SONG_POLICY, ...getSetting<Partial<SongPolicy>>(this.deps.db, 'songs.policy', {}) };
  }
  setPolicy(patch: Partial<SongPolicy>) {
    const next = { ...this.policy(), ...sanitizePolicy(patch) };
    setSetting(this.deps.db, 'songs.policy', next);
    this.deps.onChange();
    return next;
  }
  activeStationId(): number | null {
    const id = getSetting<number | null>(this.deps.db, 'songs.activeStation', null);
    return id && this.store.station(id) ? id : null;
  }

  state(): SongsState {
    const undo = this.store.peekUndo();
    return {
      now: this.engine.np,
      paused: this.engine.paused,
      volume: this.engine.volume,
      playerOnline: this.engine.playerOnline,
      fallbackUntil: this.engine.fallbackUntil,
      queue: this.store.queued(),
      pending: this.store.pending(),
      history: this.store.history(30),
      stations: this.store.stations(),
      activeStationId: this.activeStationId(),
      policy: this.policy(),
      canUndo: undo?.label ?? null,
    };
  }

  // ───────────────────────── 신청 ─────────────────────────

  async request(input: {
    videoId: string;
    viewer: Viewer | null;
    via: QueueItem['via'];
    paidKRW?: number;
  }): Promise<RequestResult> {
    const p = this.policy();
    const { videoId, viewer, via } = input;
    const paid = input.paidKRW ?? 0;
    const isDash = via === 'dashboard';
    const isManager = !!viewer?.roles.some((r) => r === 'manager' || r === 'streamer');

    if (!isDash) {
      if (!p.open && !isManager) return fail('지금은 신청곡을 받지 않습니다');
      if (via === 'chat' && !p.allowChat) return fail('채팅 신청은 꺼져 있습니다');
      if (via === 'donation' && !p.allowDonation) return fail('후원 신청은 꺼져 있습니다');
      if (via === 'donation' && paid < p.donationMinKRW) return fail(`후원 신청은 ${p.donationMinKRW.toLocaleString()}원부터 가능합니다`);
      if (!isManager && via === 'chat' && !hasPermission(viewer, p.permission)) {
        return fail(p.permission === 'subscriber' ? '구독자만 신청할 수 있습니다' : '매니저만 신청할 수 있습니다');
      }
    }
    if (p.blacklistVideos.includes(videoId)) return fail('신청할 수 없는 곡입니다');

    let track = this.store.findTrack('youtube', videoId);
    if (track?.playable === false) return fail('재생할 수 없는 영상입니다');
    if (!track || track.title.startsWith('YouTube ')) {
      const o = await this.oembed(videoId);
      if (o.ok === false) {
        if (track) this.store.setPlayable(track.id, false, null);
        return fail(`신청할 수 없는 영상입니다 (${o.reason})`);
      }
      const t = this.store.upsertTrack('youtube', videoId, o.ok === true ? o.title : `YouTube ${videoId}`, o.ok === true ? o.author : null);
      track = this.store.findTrack('youtube', t.ref)!;
    }

    // ↓ 비동기 이후에 다시 확인 (동시에 같은 곡이 들어온 경우 대비)
    const title = `${track.title} ${track.artist ?? ''}`.toLowerCase();
    if (!isDash) {
      const kw = p.blacklistKeywords.find((k) => k && title.includes(k.toLowerCase()));
      if (kw) return fail('신청할 수 없는 곡입니다');
      if (track.durationSec && track.durationSec > p.maxDurationSec) {
        return fail(`${Math.floor(p.maxDurationSec / 60)}분이 넘는 곡은 신청할 수 없습니다`);
      }
      if (p.recentBlockMinutes > 0 && track.lastPlayedAt && this.now() - track.lastPlayedAt < p.recentBlockMinutes * 60_000) {
        return fail('최근에 재생된 곡입니다');
      }
    }
    if (p.dedupQueue && this.store.isTrackActive(track.id)) return fail('이미 대기열에 있는 곡입니다');
    const key = viewer ? viewerKey(viewer) : null;
    if (!isDash && !isManager && key && p.perUserLimit > 0 && this.store.activeCountFor(key) >= p.perUserLimit) {
      return fail(`1인당 최대 ${p.perUserLimit}곡까지 대기할 수 있습니다`);
    }

    const priority = via === 'donation' && paid >= p.donationPriorityKRW ? 1 : 0;
    const status = p.approvalMode && !isDash && !isManager ? 'pending_approval' : 'queued';
    const item = this.store.addToQueue({
      trackId: track.id, requesterKey: key, requesterName: viewer?.nickname ?? (via === 'dashboard' ? '스트리머' : '익명'),
      priority, status, via, paidKRW: paid, at: this.now(),
    });
    log.info(`request #${item.id} "${track.title}" by ${item.requesterName} (${via}${priority ? ', 우선' : ''})`);

    this.engine.kick(p.interruptStation);
    this.deps.onChange();

    const pos = this.store.queued().findIndex((q) => q.id === item.id) + 1;
    const message =
      status === 'pending_approval'
        ? `🎵 ${track.title} — 승인 대기 중`
        : this.engine.np?.queueId === item.id
          ? `🎵 ${track.title} — 바로 재생합니다`
          : `🎵 ${track.title} — ${pos}번째${priority ? ' (우선 신청)' : ''}`;
    return { ok: true, item, message };
  }

  /** 후원 메시지에 링크가 있으면 자동 신청 */
  async onDonation(viewer: Viewer | null, amountKRW: number, text: string | undefined) {
    const id = text ? findYouTubeId(text) : null;
    if (!id) return;
    const r = await this.request({ videoId: id, viewer, via: 'donation', paidKRW: amountKRW });
    this.deps.reply(r.ok ? `${viewer?.nickname ?? '익명'}님 ${r.message}` : `${viewer?.nickname ?? '익명'}님, ${r.message}`);
  }

  // ───────────────────────── 대기열 조작 ─────────────────────────

  skip() {
    const np = this.engine.np;
    if (!np) return;
    if (np.queueId) {
      const prev = this.store.rawQueueState(np.queueId)!;
      this.store.pushUndo(`스킵: ${np.track.title}`, { kind: 'requeue', id: np.queueId, prev: { ...prev, status: 'queued' } }, this.now());
    }
    this.engine.skip('스킵');
  }

  remove(id: number) {
    const st = this.store.rawQueueState(id);
    const it = this.store.item(id);
    if (!st || !it) return;
    if (this.engine.np?.queueId === id) return this.skip();
    this.store.pushUndo(`삭제: ${it.track.title}`, { kind: 'restore', items: [{ id, ...st }] }, this.now());
    this.store.setStatus(id, 'cancelled', this.now(), '삭제됨');
    this.deps.onChange();
    this.engine.prefetch();
  }

  clearQueue() {
    const items = [...this.store.queued(), ...this.store.pending()];
    if (!items.length) return;
    this.store.pushUndo(`대기열 비우기 (${items.length}곡)`, {
      kind: 'restore', items: items.map((i) => ({ id: i.id, ...this.store.rawQueueState(i.id)! })),
    }, this.now());
    for (const i of items) this.store.setStatus(i.id, 'cancelled', this.now(), '대기열 비움');
    this.deps.onChange();
  }

  move(id: number, where: 'top' | 'up' | 'down') {
    const q = this.store.queued();
    const idx = q.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const item = q[idx]!;
    if (where === 'top') {
      this.store.setPosition(id, this.store.minPosition() - 1, Math.max(...q.map((i) => i.priority)));
    } else {
      const other = q[where === 'up' ? idx - 1 : idx + 1];
      if (!other) return;
      const a = this.store.rawQueueState(item.id)!;
      const b = this.store.rawQueueState(other.id)!;
      this.store.setPosition(item.id, b.position, b.priority);
      this.store.setPosition(other.id, a.position, a.priority);
    }
    this.deps.onChange();
    this.engine.prefetch();
  }

  approve(id: number, ok: boolean) {
    const it = this.store.item(id);
    if (!it || it.status !== 'pending_approval') return;
    this.store.setStatus(id, ok ? 'queued' : 'rejected', this.now(), ok ? null : '거절됨');
    if (ok) this.engine.kick(this.policy().interruptStation);
    this.deps.onChange();
  }

  cancelOwn(viewer: Viewer): string {
    const it = this.store.lastActiveFor(viewerKey(viewer));
    if (!it) return `${viewer.nickname}님, 취소할 신청곡이 없습니다`;
    this.store.setStatus(it.id, 'cancelled', this.now(), '본인 취소');
    this.deps.onChange();
    return `${viewer.nickname}님, "${it.track.title}" 신청을 취소했습니다`;
  }

  undo(): string | null {
    const op = this.store.peekUndo();
    if (!op) return null;
    this.store.dropUndo(op.id);
    const u = op.undo as
      | { kind: 'restore'; items: { id: number; status: any; position: number; priority: number }[] }
      | { kind: 'requeue'; id: number; prev: { status: any; position: number; priority: number } };
    if (u.kind === 'restore') {
      for (const i of u.items) {
        this.store.setStatus(i.id, i.status, this.now(), null);
        this.store.setPosition(i.id, i.position, i.priority);
      }
    } else {
      // 스킵 되돌리기: 맨 앞에 다시 넣고 바로 재생
      this.store.setStatus(u.id, 'queued', this.now(), null);
      this.store.setPosition(u.id, this.store.minPosition() - 1, 1);
      const interrupted = this.engine.np?.queueId ?? null;
      if (this.engine.np) this.engine.skip('되돌리기');
      // 그 사이 재생되던 신청곡은 잃지 않고 대기열로 돌려놓음
      if (interrupted && interrupted !== u.id) this.store.setStatus(interrupted, 'queued', this.now(), null);
    }
    this.engine.kick(false);
    this.deps.onChange();
    return op.label;
  }

  // ───────────────────────── 스테이션 ─────────────────────────

  async createStation(i: { name: string; kind: 'manual' | 'local'; mode?: Station['mode']; links?: string; folder?: string }) {
    const name = i.name.trim() || (i.kind === 'local' ? '내 음악 폴더' : '새 스테이션');
    if (i.kind === 'local') {
      const folder = resolve((i.folder ?? '').trim());
      if (!i.folder?.trim() || !existsSync(folder) || !statSync(folder).isDirectory()) {
        return { ok: false as const, error: '폴더를 찾을 수 없습니다' };
      }
      const id = this.store.createStation(name, 'local', i.mode ?? 'shuffle', folder);
      const n = this.scanFolder(id);
      if (!this.activeStationId()) this.activateStation(id);
      this.deps.onChange();
      return { ok: true as const, id, added: n };
    }
    const ids = [...new Set((i.links ?? '').split(/\s+/).map((l) => findYouTubeId(l)).filter((x): x is string => !!x))];
    if (!ids.length) return { ok: false as const, error: 'YouTube 링크를 한 줄에 하나씩 넣어 주세요' };
    const id = this.store.createStation(name, 'manual', i.mode ?? 'shuffle', null);
    await this.addLinks(id, ids);
    if (!this.activeStationId()) this.activateStation(id);
    this.deps.onChange();
    return { ok: true as const, id, added: ids.length };
  }

  async addToStation(stationId: number, links: string) {
    const ids = [...new Set(links.split(/\s+/).map((l) => findYouTubeId(l)).filter((x): x is string => !!x))];
    await this.addLinks(stationId, ids);
    this.deps.onChange();
    return ids.length;
  }

  private async addLinks(stationId: number, ids: string[]) {
    // 제목은 천천히 채움 (4개씩). 실패해도 스테이션은 만들어짐
    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(
        ids.slice(i, i + 4).map(async (vid) => {
          const existing = this.store.findTrack('youtube', vid);
          let title = existing?.title ?? `YouTube ${vid}`;
          let author: string | null = null;
          if (!existing || title.startsWith('YouTube ')) {
            const o = await this.oembed(vid);
            if (o.ok === true) ({ title, author } = { title: o.title, author: o.author });
            const t = this.store.upsertTrack('youtube', vid, title, author);
            if (o.ok === false) this.store.setPlayable(t.id, false, null);
          }
          const t = this.store.findTrack('youtube', vid)!;
          this.store.addStationTrack(stationId, t.id);
        }),
      );
    }
  }

  scanFolder(stationId: number): number {
    const s = this.store.station(stationId);
    if (!s?.folder) return 0;
    let files: string[] = [];
    try {
      files = (readdirSync(s.folder, { recursive: true }) as string[])
        .filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()))
        .slice(0, 5000)
        .sort();
    } catch (err) {
      log.warn(`folder scan failed: ${s.folder}`, String(err));
      return 0;
    }
    this.store.clearStationTracks(stationId);
    for (const f of files) {
      const full = join(s.folder, f);
      const t = this.store.upsertTrack('local', full, basename(f, extname(f)));
      this.store.addStationTrack(stationId, t.id);
    }
    log.info(`scanned ${files.length} files in ${s.folder}`);
    this.deps.onChange();
    return files.length;
  }

  activateStation(id: number | null) {
    setSetting(this.deps.db, 'songs.activeStation', id);
    this.deps.onChange();
    if (!this.engine.np) this.engine.kick(false);
  }

  deleteStation(id: number) {
    this.store.deleteStation(id);
    if (this.activeStationId() === null) setSetting(this.deps.db, 'songs.activeStation', null);
    this.deps.onChange();
  }

  setStationMode(id: number, mode: Station['mode']) {
    this.store.setStationMode(id, mode);
    this.deps.onChange();
  }

  /** 로컬 곡 파일 경로 (미디어 서빙용) */
  localFile(trackId: number): string | null {
    const t = this.store.track(trackId);
    return t?.source === 'local' ? t.ref : null;
  }

  // ───────────────────────── 엔진 호스트 ─────────────────────────

  private pickStationTrack(stationId: number, localOnly: boolean): Track | null {
    const s = this.store.station(stationId);
    if (!s) return null;
    const rows = this.store.stationCandidates(stationId, localOnly);
    if (!rows.length) return null;
    if (s.mode === 'sequential') {
      const next = rows.find((r) => r.ord > s.cursor) ?? rows[0]!;
      this.store.setCursor(stationId, next.ord);
      return toTrack(next);
    }
    // 셔플: 최근 N곡은 다시 안 나오게
    const noRepeat = Math.min(this.policy().stationNoRepeat, rows.length - 1);
    const recent = new Set(
      [...rows].filter((r) => r.last_played_at).sort((a, b) => b.last_played_at! - a.last_played_at!).slice(0, noRepeat).map((r) => r.id),
    );
    const pool = rows.filter((r) => !recent.has(r.id));
    const pick = (pool.length ? pool : rows)[Math.floor(this.random() * (pool.length || rows.length))]!;
    return toTrack(pick);
  }

  private host(): EngineHost {
    return {
      now: () => this.now(),

      pickNext: (localOnly): Pick | null => {
        if (!localOnly) {
          const q = this.store.queued()[0];
          if (q) return { kind: 'request', queueId: q.id, track: q.track, requesterName: q.requesterName };
        }
        const active = this.activeStationId();
        const stations = this.store.stations();
        const order = localOnly
          ? [...stations.filter((s) => s.id === active && s.kind === 'local'), ...stations.filter((s) => s.kind === 'local')]
          : stations.filter((s) => s.id === active);
        for (const s of order) {
          const t = this.pickStationTrack(s.id, localOnly);
          if (t) return { kind: 'station', stationId: s.id, track: t };
        }
        if (localOnly) {
          // 로컬 비상 스테이션이 없으면 침묵보다는 원래대로 계속 시도
          const q = this.store.queued()[0];
          if (q) return { kind: 'request', queueId: q.id, track: q.track, requesterName: q.requesterName };
          if (active) {
            const t = this.pickStationTrack(active, false);
            if (t) return { kind: 'station', stationId: active, track: t };
          }
        }
        return null;
      },

      peekUnverified: () => {
        const next = this.store.queued().find((q) => q.id !== this.engine.np?.queueId);
        return next && next.track.source === 'youtube' && next.track.playable === null ? next.track : null;
      },

      onStarted: (np) => {
        if (np.queueId) this.store.setStatus(np.queueId, 'playing', this.now());
        this.store.trackStarted(np.track.id, this.now());
      },

      onFinished: (np, outcome: Outcome, reason, code) => {
        const t = this.now();
        if (np.queueId) {
          const st = outcome === 'played' ? 'played' : outcome === 'failed' ? 'failed' : 'skipped';
          this.store.setStatus(np.queueId, st, t, reason);
        }
        if (outcome === 'skipped') this.store.trackSkipped(np.track.id);
        if (outcome === 'failed') {
          const permanent = typeof code === 'number' && PERMANENT_YT_ERRORS.has(code);
          this.store.trackFailed(np.track.id, permanent);
          if (np.kind === 'request') this.deps.reply(`⚠️ ${np.requesterName ?? ''}님 신청곡 "${np.track.title}" — 재생할 수 없어 넘어갑니다 (${reason})`);
          else this.deps.notify('warn', `스테이션 곡 재생 실패로 넘어감: ${np.track.title} (${reason})`);
        }
        // 끝까지 들은 신청곡은 "인기 신청곡" 스테이션에 자동 추가
        if (outcome === 'played' && np.kind === 'request' && np.track.source === 'youtube') {
          this.store.addStationTrack(this.popularStationId(), np.track.id);
        }
      },

      onVerified: (trackId, ok, duration, code) => {
        const t = this.store.track(trackId);
        if (!t) return;
        const max = this.policy().maxDurationSec;
        if (!ok) {
          this.store.setPlayable(trackId, false, null);
          for (const it of this.store.failQueuedWithTrack(trackId, this.now(), `재생 불가 (${code})`)) {
            this.deps.reply(`⚠️ ${it.requesterName ?? ''}님 신청곡 "${t.title}" — 재생할 수 없는 영상이라 대기열에서 뺐습니다`);
          }
        } else {
          this.store.setPlayable(trackId, true, duration);
          if (duration && duration > max + 5) {
            for (const it of this.store.queued().filter((q) => q.track.id === trackId && q.via !== 'dashboard')) {
              this.store.setStatus(it.id, 'rejected', this.now(), '너무 긴 곡');
              this.deps.reply(`⚠️ ${it.requesterName ?? ''}님 신청곡 "${t.title}" — ${Math.floor(max / 60)}분이 넘어서 대기열에서 뺐습니다`);
            }
          }
        }
        this.deps.onChange();
      },

      onDurationKnown: (np, duration) => {
        if (!np.track.durationSec) this.store.setDuration(np.track.id, duration);
        if (np.kind !== 'request' || !np.queueId) return 'ok';
        const it = this.store.item(np.queueId);
        return it && it.via !== 'dashboard' && duration > this.policy().maxDurationSec + 5 ? 'skip' : 'ok';
      },

      notify: (level, message) => this.deps.notify(level, message),
      persist: (np: NowPlaying | null, paused, volume) => this.store.savePlayer(np, paused, volume, this.now()),
      changed: () => this.deps.onChange(),
    };
  }

  private popularStationId(): number {
    const s = this.store.stations().find((x) => x.kind === 'popular');
    return s ? s.id : this.store.createStation(POPULAR_NAME, 'popular', 'shuffle', null);
  }
}

function fail(message: string): RequestResult {
  return { ok: false, message };
}

function hasPermission(viewer: Viewer | null, need: SongPolicy['permission']): boolean {
  if (need === 'everyone') return true;
  const roles = viewer?.roles ?? [];
  if (roles.includes('streamer') || roles.includes('manager')) return true;
  return need === 'subscriber' && roles.includes('subscriber');
}

function sanitizePolicy(p: Partial<SongPolicy>): Partial<SongPolicy> {
  const out: Partial<SongPolicy> = {};
  const nums = ['maxDurationSec', 'perUserLimit', 'recentBlockMinutes', 'donationMinKRW', 'donationPriorityKRW', 'stationNoRepeat'] as const;
  for (const k of nums) if (p[k] !== undefined && Number.isFinite(Number(p[k]))) out[k] = Math.max(0, Math.floor(Number(p[k])));
  const bools = ['open', 'allowChat', 'allowDonation', 'dedupQueue', 'approvalMode', 'interruptStation'] as const;
  for (const k of bools) if (typeof p[k] === 'boolean') out[k] = p[k];
  if (p.permission && ['everyone', 'subscriber', 'manager'].includes(p.permission)) out.permission = p.permission;
  if (Array.isArray(p.blacklistVideos)) out.blacklistVideos = p.blacklistVideos.map((v) => findYouTubeId(String(v)) ?? String(v).trim()).filter(Boolean);
  if (Array.isArray(p.blacklistKeywords)) out.blacklistKeywords = p.blacklistKeywords.map((v) => String(v).trim()).filter(Boolean);
  return out;
}
