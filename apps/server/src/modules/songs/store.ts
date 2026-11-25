import type { Database } from 'bun:sqlite';
import type { NowPlaying, QueueItem, QueueStatus, Station, Track, TrackSource } from '@localbot/shared';

/** 신청곡/스테이션 DB 접근. SQL은 여기에만 둡니다. */

type TrackRow = {
  id: number; source: TrackSource; ref: string; title: string; artist: string | null;
  duration_sec: number | null; playable: number | null; last_played_at: number | null; embed_blocked?: number;
};
type QueueRow = {
  id: number; track_id: number; requester_key: string | null; requester_name: string | null; priority: number;
  position: number; status: QueueStatus; reason: string | null; via: QueueItem['via']; paid_krw: number; requested_at: number;
};

export const ACTIVE_STATUSES: QueueStatus[] = ['queued', 'pending_approval', 'playing'];

export function toTrack(r: TrackRow): Track {
  return {
    id: r.id, source: r.source, ref: r.ref, title: r.title, artist: r.artist,
    durationSec: r.duration_sec, playable: r.playable === null ? null : r.playable === 1,
    embedBlocked: r.embed_blocked === 1,
  };
}

export class SongStore {
  constructor(readonly db: Database) {}

  // ── tracks ──
  track(id: number): Track | null {
    const r = this.db.query('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | null;
    return r ? toTrack(r) : null;
  }
  trackRow(id: number): TrackRow | null {
    return this.db.query('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | null;
  }
  findTrack(source: TrackSource, ref: string): (Track & { lastPlayedAt: number | null }) | null {
    const r = this.db.query('SELECT * FROM tracks WHERE source = ? AND ref = ?').get(source, ref) as TrackRow | null;
    return r ? { ...toTrack(r), lastPlayedAt: r.last_played_at } : null;
  }
  upsertTrack(source: TrackSource, ref: string, title: string, artist: string | null = null): Track {
    this.db
      .query(
        `INSERT INTO tracks(source, ref, title, artist) VALUES(?, ?, ?, ?)
         ON CONFLICT(source, ref) DO UPDATE SET
           title = CASE WHEN excluded.title LIKE 'YouTube %' THEN tracks.title ELSE excluded.title END,
           artist = COALESCE(excluded.artist, tracks.artist)`,
      )
      .run(source, ref, title, artist);
    return this.findTrack(source, ref)!;
  }
  setPlayable(id: number, playable: boolean, durationSec: number | null) {
    this.db.query('UPDATE tracks SET playable = ?, duration_sec = COALESCE(?, duration_sec) WHERE id = ?')
      .run(playable ? 1 : 0, durationSec, id);
  }
  /** 유튜브 밖 재생 금지 → 유튜브 창으로만 재생 가능 (확인된 것으로 처리해 다시 미리 확인하지 않음) */
  setEmbedBlocked(id: number) {
    this.db.query('UPDATE tracks SET embed_blocked = 1, playable = 1 WHERE id = ?').run(id);
  }
  setDuration(id: number, durationSec: number) {
    this.db.query('UPDATE tracks SET duration_sec = ? WHERE id = ?').run(durationSec, id);
  }
  trackStarted(id: number, at: number) {
    this.db.query('UPDATE tracks SET last_played_at = ?, play_count = play_count + 1 WHERE id = ?').run(at, id);
  }
  trackSkipped(id: number) {
    this.db.query('UPDATE tracks SET skip_count = skip_count + 1 WHERE id = ?').run(id);
  }
  trackFailed(id: number, permanent: boolean) {
    this.db.query(`UPDATE tracks SET fail_count = fail_count + 1 ${permanent ? ', playable = 0' : ''} WHERE id = ?`).run(id);
  }

  // ── queue ──
  private toItem(r: QueueRow): QueueItem {
    return {
      id: r.id, track: this.track(r.track_id)!, requesterName: r.requester_name, requesterKey: r.requester_key,
      priority: r.priority, status: r.status, reason: r.reason, via: r.via, paidKRW: r.paid_krw, requestedAt: r.requested_at,
    };
  }
  item(id: number): QueueItem | null {
    const r = this.db.query('SELECT * FROM queue WHERE id = ?').get(id) as QueueRow | null;
    return r ? this.toItem(r) : null;
  }
  /** 재생 순서: 우선(후원) → position */
  queued(): QueueItem[] {
    return (this.db.query("SELECT * FROM queue WHERE status = 'queued' ORDER BY priority DESC, position").all() as QueueRow[])
      .map((r) => this.toItem(r));
  }
  pending(): QueueItem[] {
    return (this.db.query("SELECT * FROM queue WHERE status = 'pending_approval' ORDER BY position").all() as QueueRow[])
      .map((r) => this.toItem(r));
  }
  history(limit = 30): QueueItem[] {
    return (this.db.query(
      "SELECT * FROM queue WHERE status IN ('played','skipped','failed','cancelled','rejected') ORDER BY COALESCE(ended_at, requested_at) DESC LIMIT ?",
    ).all(limit) as QueueRow[]).map((r) => this.toItem(r));
  }
  addToQueue(i: {
    trackId: number; requesterKey: string | null; requesterName: string | null; priority: number;
    status: QueueStatus; via: QueueItem['via']; paidKRW: number; at: number; query?: string | null;
  }): QueueItem {
    const pos = (this.db.query('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM queue').get() as { p: number }).p;
    const r = this.db
      .query(
        `INSERT INTO queue(track_id, requester_key, requester_name, priority, position, status, via, paid_krw, requested_at, query)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(i.trackId, i.requesterKey, i.requesterName, i.priority, pos, i.status, i.via, i.paidKRW, i.at, i.query ?? null) as { id: number };
    return this.item(r.id)!;
  }
  setStatus(id: number, status: QueueStatus, at: number, reason: string | null = null) {
    const col = status === 'playing' ? 'started_at' : ['queued', 'pending_approval'].includes(status) ? null : 'ended_at';
    this.db.query(`UPDATE queue SET status = ?, reason = ? ${col ? `, ${col} = ${Number(at)}` : ''} WHERE id = ?`)
      .run(status, reason, id);
  }
  setPosition(id: number, position: number, priority?: number) {
    if (priority === undefined) this.db.query('UPDATE queue SET position = ? WHERE id = ?').run(position, id);
    else this.db.query('UPDATE queue SET position = ?, priority = ? WHERE id = ?').run(position, priority, id);
  }
  queueQuery(id: number): string | null {
    return (this.db.query('SELECT query FROM queue WHERE id = ?').get(id) as { query: string | null } | null)?.query ?? null;
  }
  rawQueueState(id: number): { status: QueueStatus; position: number; priority: number } | null {
    return this.db.query('SELECT status, position, priority FROM queue WHERE id = ?').get(id) as any;
  }
  minPosition(): number {
    return (this.db.query("SELECT COALESCE(MIN(position), 1) AS p FROM queue WHERE status = 'queued'").get() as { p: number }).p;
  }
  activeCountFor(requesterKey: string): number {
    return (this.db.query(
      "SELECT COUNT(*) AS n FROM queue WHERE requester_key = ? AND status IN ('queued','pending_approval')",
    ).get(requesterKey) as { n: number }).n;
  }
  isTrackActive(trackId: number): boolean {
    return !!this.db.query(
      "SELECT 1 FROM queue WHERE track_id = ? AND status IN ('queued','pending_approval','playing') LIMIT 1",
    ).get(trackId);
  }
  lastActiveFor(requesterKey: string): QueueItem | null {
    const r = this.db.query(
      "SELECT * FROM queue WHERE requester_key = ? AND status IN ('queued','pending_approval') ORDER BY id DESC LIMIT 1",
    ).get(requesterKey) as QueueRow | null;
    return r ? this.toItem(r) : null;
  }
  failQueuedWithTrack(trackId: number, at: number, reason: string): QueueItem[] {
    const rows = this.db.query(
      "SELECT * FROM queue WHERE track_id = ? AND status IN ('queued','pending_approval')",
    ).all(trackId) as QueueRow[];
    for (const r of rows) this.setStatus(r.id, 'failed', at, reason);
    return rows.map((r) => this.toItem(r));
  }
  /** 이전 실행에서 'playing'으로 남은 항목 (복원용) */
  danglingPlaying(): number[] {
    return (this.db.query("SELECT id FROM queue WHERE status = 'playing'").all() as { id: number }[]).map((r) => r.id);
  }

  // ── stations ──
  stations(): Station[] {
    return this.db
      .query(
        `SELECT s.*, (SELECT COUNT(*) FROM station_tracks st WHERE st.station_id = s.id) AS track_count
         FROM stations s ORDER BY s.id`,
      )
      .all()
      .map((r: any) => ({ id: r.id, name: r.name, kind: r.kind, mode: r.mode, folder: r.folder, trackCount: r.track_count }));
  }
  station(id: number) {
    return this.db.query('SELECT * FROM stations WHERE id = ?').get(id) as
      | { id: number; name: string; kind: Station['kind']; mode: Station['mode']; folder: string | null; cursor: number }
      | null;
  }
  /** 최근에 재생된 YouTube 곡 (자동 스테이션의 기준곡). notSkipped면 스킵된 적 있는 곡 제외 */
  recentYoutube(limit: number, notSkipped = false): Track[] {
    return (this.db.query(
      `SELECT * FROM tracks WHERE source = 'youtube' AND last_played_at IS NOT NULL AND (playable IS NULL OR playable = 1)
       ${notSkipped ? 'AND skip_count = 0' : ''} ORDER BY last_played_at DESC LIMIT ?`,
    ).all(limit) as TrackRow[]).map(toTrack);
  }
  /** 시청자가 신청해서 끝까지 재생된 곡 (최근 순, 중복 곡 제외) */
  recentPlayedRequests(limit: number): Track[] {
    return (this.db.query(
      `SELECT t.* FROM tracks t JOIN (
         SELECT track_id, MAX(ended_at) AS e FROM queue WHERE status = 'played' GROUP BY track_id
       ) q ON q.track_id = t.id
       WHERE t.source = 'youtube' AND (t.playable IS NULL OR t.playable = 1) AND t.skip_count = 0
       ORDER BY q.e DESC LIMIT ?`,
    ).all(limit) as TrackRow[]).map(toTrack);
  }
  stationHas(stationId: number, trackId: number): boolean {
    return !!this.db.query('SELECT 1 FROM station_tracks WHERE station_id = ? AND track_id = ?').get(stationId, trackId);
  }
  createStation(name: string, kind: Station['kind'], mode: Station['mode'], folder: string | null): number {
    return (this.db.query('INSERT INTO stations(name, kind, mode, folder) VALUES(?, ?, ?, ?) RETURNING id')
      .get(name, kind, mode, folder) as { id: number }).id;
  }
  deleteStation(id: number) {
    this.db.query('DELETE FROM station_tracks WHERE station_id = ?').run(id);
    this.db.query('DELETE FROM stations WHERE id = ?').run(id);
  }
  setStationMode(id: number, mode: Station['mode']) {
    this.db.query('UPDATE stations SET mode = ? WHERE id = ?').run(mode, id);
  }
  setCursor(id: number, cursor: number) {
    this.db.query('UPDATE stations SET cursor = ? WHERE id = ?').run(cursor, id);
  }
  addStationTrack(stationId: number, trackId: number) {
    const ord = (this.db.query('SELECT COALESCE(MAX(ord), 0) + 1 AS o FROM station_tracks WHERE station_id = ?')
      .get(stationId) as { o: number }).o;
    this.db.query('INSERT OR IGNORE INTO station_tracks(station_id, track_id, ord) VALUES(?, ?, ?)').run(stationId, trackId, ord);
  }
  clearStationTracks(stationId: number) {
    this.db.query('DELETE FROM station_tracks WHERE station_id = ?').run(stationId);
  }
  /** 스테이션 후보 곡 (재생 불가로 확정된 곡 제외) */
  stationCandidates(stationId: number, localOnly: boolean) {
    return this.db
      .query(
        `SELECT t.*, st.ord FROM station_tracks st JOIN tracks t ON t.id = st.track_id
         WHERE st.station_id = ? AND (t.playable IS NULL OR t.playable = 1) ${localOnly ? "AND t.source = 'local'" : ''}
         ORDER BY st.ord`,
      )
      .all(stationId) as (TrackRow & { ord: number })[];
  }

  // ── player_state ──
  loadPlayer(): { now: NowPlaying | null; paused: boolean; volume: number } {
    const r = this.db.query('SELECT * FROM player_state WHERE id = 1').get() as { now: string | null; paused: number; volume: number };
    return { now: r.now ? (JSON.parse(r.now) as NowPlaying) : null, paused: r.paused === 1, volume: r.volume };
  }
  savePlayer(now: NowPlaying | null, paused: boolean, volume: number, at: number) {
    this.db.query('UPDATE player_state SET now = ?, paused = ?, volume = ?, updated_at = ? WHERE id = 1')
      .run(now ? JSON.stringify(now) : null, paused ? 1 : 0, volume, at);
  }

  // ── undo ──
  pushUndo(label: string, undo: unknown, at: number) {
    this.db.query('INSERT INTO op_log(ts, label, undo) VALUES(?, ?, ?)').run(at, label, JSON.stringify(undo));
    this.db.query('DELETE FROM op_log WHERE id NOT IN (SELECT id FROM op_log ORDER BY id DESC LIMIT 20)').run();
  }
  peekUndo(): { id: number; label: string; undo: any } | null {
    const r = this.db.query('SELECT * FROM op_log ORDER BY id DESC LIMIT 1').get() as { id: number; label: string; undo: string } | null;
    return r ? { id: r.id, label: r.label, undo: JSON.parse(r.undo) } : null;
  }
  dropUndo(id: number) {
    this.db.query('DELETE FROM op_log WHERE id = ?').run(id);
  }
}
