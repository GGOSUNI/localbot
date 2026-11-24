import type { Database } from 'bun:sqlite';
import type { OverlayMessage, Penalty, Roulette, RouletteItem, RouletteState, Spin, Viewer } from '@localbot/shared';
import { viewerKey } from '../../core/ingest.ts';
import { createLogger } from '../../core/logger.ts';
import { DEFAULT_TEMPLATE, draw, matchRoulette, parseItems, renderTemplate, sanitizeTrigger, secureRandom, spinsForDonation } from './logic.ts';

const log = createLogger('roulette');

/** 오버레이가 "끝났다"고 알려주지 않을 때 다음으로 넘어가는 시간 */
const SHOW_TIMEOUT_MS = 30_000;

export interface RouletteDeps {
  db: Database;
  now?: () => number;
  rand?: () => number;
  reply: (text: string) => void;
  onChange: () => void;
}

export interface RouletteInput {
  name?: string;
  itemsText?: string;
  items?: RouletteItem[];
  trigger?: unknown;
  enabled?: boolean;
  chatTemplate?: string;
  trackPenalties?: boolean;
}

type Row = { id: number; name: string; items: string; trigger: string; enabled: number; chat_template: string; track_penalties: number; sort_order: number };
type SpinRow = {
  id: number; roulette_id: number; roulette_name: string; viewer_key: string | null; viewer_name: string | null;
  amount_krw: number; results: string; items: string; status: Spin['status']; created_at: number;
};

export class RouletteService {
  private now: () => number;
  private rand: () => number;
  private overlays = new Map<string, (m: OverlayMessage) => void>();
  private showing: { spinId: number; timer: Timer } | null = null;

  constructor(private deps: RouletteDeps) {
    this.now = deps.now ?? Date.now;
    this.rand = deps.rand ?? secureRandom;
    // 이전 실행에서 보여주다 만 결과는 다시 보여줌
    deps.db.query("UPDATE roulette_spins SET status = 'queued' WHERE status = 'showing'").run();
  }

  // ── CRUD ──
  list(): Roulette[] {
    return (this.deps.db.query('SELECT * FROM roulettes ORDER BY sort_order, id').all() as Row[]).map(toRoulette);
  }
  get(id: number): Roulette | null {
    const r = this.deps.db.query('SELECT * FROM roulettes WHERE id = ?').get(id) as Row | null;
    return r ? toRoulette(r) : null;
  }

  save(id: number | null, input: RouletteInput): { ok: true; roulette: Roulette } | { ok: false; error: string } {
    const prev = id ? this.get(id) : null;
    if (id && !prev) return { ok: false, error: '룰렛을 찾을 수 없습니다' };
    const items = input.itemsText !== undefined ? parseItems(input.itemsText) : input.items ?? prev?.items ?? [];
    if (items.length < 2) return { ok: false, error: '항목을 2개 이상 넣어 주세요' };
    const name = (input.name ?? prev?.name ?? '').trim().slice(0, 40) || '룰렛';
    const trigger = sanitizeTrigger(input.trigger ?? prev?.trigger);
    const enabled = input.enabled ?? prev?.enabled ?? true;
    const tpl = (input.chatTemplate ?? prev?.chatTemplate ?? DEFAULT_TEMPLATE).slice(0, 200) || DEFAULT_TEMPLATE;
    const track = input.trackPenalties ?? prev?.trackPenalties ?? true;
    const args = [name, JSON.stringify(items), JSON.stringify(trigger), enabled ? 1 : 0, tpl, track ? 1 : 0] as const;
    let rid = id;
    if (id) {
      this.deps.db.query('UPDATE roulettes SET name=?, items=?, trigger=?, enabled=?, chat_template=?, track_penalties=? WHERE id=?').run(...args, id);
    } else {
      const order = (this.deps.db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS o FROM roulettes').get() as { o: number }).o;
      rid = (this.deps.db.query(
        'INSERT INTO roulettes(name, items, trigger, enabled, chat_template, track_penalties, sort_order) VALUES(?,?,?,?,?,?,?) RETURNING id',
      ).get(...args, order) as { id: number }).id;
    }
    this.deps.onChange();
    return { ok: true, roulette: this.get(rid!)! };
  }

  remove(id: number) {
    this.deps.db.query('DELETE FROM roulettes WHERE id = ?').run(id);
    this.deps.onChange();
  }

  move(id: number, dir: -1 | 1) {
    const list = this.list();
    const i = list.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    list.forEach((r, n) => this.deps.db.query('UPDATE roulettes SET sort_order = ? WHERE id = ?').run(n, r.id));
    this.deps.onChange();
  }

  // ── 돌리기 ──
  onDonation(viewer: Viewer | null, amountKRW: number): Spin | null {
    const r = matchRoulette(this.list(), amountKRW);
    if (!r) return null;
    const key = viewer ? viewerKey(viewer) : null;
    const carryRow = key
      ? (this.deps.db.query('SELECT krw FROM roulette_carry WHERE roulette_id = ? AND viewer_key = ?').get(r.id, key) as { krw: number } | null)
      : null;
    // 익명 후원은 누구 잔액인지 알 수 없으니 이월하지 않음
    const { spins, carry } = spinsForDonation(r.trigger, amountKRW, key ? (carryRow?.krw ?? 0) : 0);
    if (key && r.trigger.type === 'per-amount' && r.trigger.carry) {
      this.deps.db.query(
        'INSERT INTO roulette_carry(roulette_id, viewer_key, krw) VALUES(?,?,?) ON CONFLICT(roulette_id, viewer_key) DO UPDATE SET krw = excluded.krw',
      ).run(r.id, key, carry);
    }
    if (spins <= 0) {
      this.deps.onChange();
      return null;
    }
    return this.spin(r, spins, viewer, amountKRW);
  }

  /** 대시보드 버튼 */
  manualSpin(id: number, times = 1): Spin | null {
    const r = this.get(id);
    if (!r) return null;
    return this.spin(r, Math.max(1, Math.min(100, Math.floor(times))), null, 0, '스트리머');
  }

  private spin(r: Roulette, times: number, viewer: Viewer | null, amountKRW: number, nameOverride?: string): Spin | null {
    const snapshot = r.items.map((i) => ({ ...i }));
    const { results, items } = draw(r.items, times, this.rand);
    if (!results.length) {
      this.deps.reply(`🎰 [${r.name}] 남은 항목이 없습니다 (재고 소진)`);
      return null;
    }
    // 재고 반영
    if (r.items.some((i) => i.stock !== null)) {
      this.deps.db.query('UPDATE roulettes SET items = ? WHERE id = ?').run(JSON.stringify(items), r.id);
    }
    const viewerName = nameOverride ?? viewer?.nickname ?? '익명';
    const row = this.deps.db.query(
      `INSERT INTO roulette_spins(roulette_id, roulette_name, viewer_key, viewer_name, amount_krw, results, items, status, created_at)
       VALUES(?,?,?,?,?,?,?,'queued',?) RETURNING *`,
    ).get(r.id, r.name, viewer ? viewerKey(viewer) : null, viewerName, amountKRW, JSON.stringify(results), JSON.stringify(snapshot), this.now()) as SpinRow;
    log.info(`spin #${row.id} [${r.name}] x${results.length} for ${viewerName}: ${results.join(', ')}`);
    this.deps.onChange();
    this.showNext();
    return toSpin(row);
  }

  // ── 무대 큐 (오버레이 연출) ──
  addOverlay(id: string, send: (m: OverlayMessage) => void) {
    this.overlays.set(id, send);
    if (this.showing) {
      // 새로고침된 오버레이: 보여주던 걸 다시 보냄
      const s = this.spinById(this.showing.spinId);
      if (s) send({ type: 'roulette.show', spin: s });
    }
    this.showNext();
    this.deps.onChange();
  }
  removeOverlay(id: string) {
    this.overlays.delete(id);
    this.deps.onChange();
  }

  overlayDone(spinId: number) {
    if (this.showing?.spinId === spinId) this.complete(spinId);
  }

  private showNext() {
    if (this.showing) return;
    const row = this.deps.db.query("SELECT * FROM roulette_spins WHERE status = 'queued' ORDER BY id LIMIT 1").get() as SpinRow | null;
    if (!row) return;
    if (!this.overlays.size) {
      // 오버레이가 없으면 연출 없이 바로 결과 발표 (결과가 묻히지 않게)
      this.complete(row.id);
      return;
    }
    this.deps.db.query("UPDATE roulette_spins SET status = 'showing' WHERE id = ?").run(row.id);
    const spin = toSpin({ ...row, status: 'showing' });
    for (const send of this.overlays.values()) send({ type: 'roulette.show', spin });
    this.showing = { spinId: row.id, timer: setTimeout(() => this.complete(row.id), SHOW_TIMEOUT_MS) };
    this.deps.onChange();
  }

  private complete(spinId: number) {
    if (this.showing?.spinId === spinId) {
      clearTimeout(this.showing.timer);
      this.showing = null;
    }
    const s = this.spinById(spinId);
    if (!s || s.status === 'done') return this.showNext();
    this.deps.db.query("UPDATE roulette_spins SET status = 'done' WHERE id = ?").run(spinId);

    const r = this.get(s.rouletteId);
    this.deps.reply(renderTemplate(r?.chatTemplate ?? DEFAULT_TEMPLATE, {
      user: s.viewerName ?? '익명', roulette: s.rouletteName, result: summarize(s.results), count: String(s.results.length),
    }));
    if (r?.trackPenalties ?? true) {
      const ins = this.deps.db.query('INSERT INTO penalties(spin_id, label, viewer_name, done, created_at) VALUES(?,?,?,0,?)');
      for (const label of s.results) if (!/꽝|한 번 더/.test(label)) ins.run(s.id, label, s.viewerName, this.now());
    }
    this.deps.onChange();
    this.showNext();
  }

  private spinById(id: number): Spin | null {
    const r = this.deps.db.query('SELECT * FROM roulette_spins WHERE id = ?').get(id) as SpinRow | null;
    return r ? toSpin(r) : null;
  }

  // ── 벌칙 목록 ──
  setPenaltyDone(id: number, done: boolean) {
    this.deps.db.query('UPDATE penalties SET done = ? WHERE id = ?').run(done ? 1 : 0, id);
    this.deps.onChange();
  }
  clearDonePenalties() {
    this.deps.db.query('DELETE FROM penalties WHERE done = 1').run();
    this.deps.onChange();
  }

  /** 항목별 실제 당첨 횟수 (조작 의혹 대응) */
  stats(rouletteId: number): { label: string; count: number }[] {
    const rows = this.deps.db.query('SELECT results FROM roulette_spins WHERE roulette_id = ?').all(rouletteId) as { results: string }[];
    const m = new Map<string, number>();
    for (const r of rows) for (const l of JSON.parse(r.results) as string[]) m.set(l, (m.get(l) ?? 0) + 1);
    return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  }

  state(): RouletteState {
    const spins = (this.deps.db.query('SELECT * FROM roulette_spins ORDER BY id DESC LIMIT 30').all() as SpinRow[]).map(toSpin);
    const penalties = this.deps.db
      .query('SELECT * FROM penalties ORDER BY done, id DESC LIMIT 100')
      .all()
      .map((p: any): Penalty => ({ id: p.id, spinId: p.spin_id, label: p.label, viewerName: p.viewer_name, done: p.done === 1, createdAt: p.created_at }));
    const pending = (this.deps.db.query("SELECT COUNT(*) AS n FROM roulette_spins WHERE status != 'done'").get() as { n: number }).n;
    return { roulettes: this.list(), recentSpins: spins, penalties, overlayOnline: this.overlays.size > 0, pendingShows: pending };
  }
}

function toRoulette(r: Row): Roulette {
  return {
    id: r.id, name: r.name, items: JSON.parse(r.items), trigger: JSON.parse(r.trigger), enabled: r.enabled === 1,
    chatTemplate: r.chat_template, trackPenalties: r.track_penalties === 1, sortOrder: r.sort_order,
  };
}

function toSpin(r: SpinRow): Spin {
  return {
    id: r.id, rouletteId: r.roulette_id, rouletteName: r.roulette_name, viewerName: r.viewer_name, amountKRW: r.amount_krw,
    results: JSON.parse(r.results), items: JSON.parse(r.items), createdAt: r.created_at, status: r.status,
  };
}

/** ["꽝","스쿼트","꽝"] → "꽝 x2, 스쿼트" */
export function summarize(results: string[]): string {
  if (results.length === 1) return results[0]!;
  const m = new Map<string, number>();
  for (const r of results) m.set(r, (m.get(r) ?? 0) + 1);
  return [...m].map(([l, n]) => (n > 1 ? `${l} x${n}` : l)).join(', ');
}
