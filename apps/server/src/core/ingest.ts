import type { Database } from 'bun:sqlite';
import type { Envelope } from '@localbot/shared';
import type { EventBus } from './bus.ts';
import { createLogger } from './logger.ts';

const log = createLogger('ingest');

/**
 * 어댑터 → 버스 사이의 관문. 모든 외부 이벤트는 반드시 여기를 지납니다.
 *  1) 후원 중복 제거 — 공식/읽기전용 연결이 겹쳐 같은 후원이 두 번 오면 룰렛이 두 번 돌기 때문
 *  2) 영속화 (events_log, donations, viewers)
 *  3) 버스 발행
 */
export class Ingest {
  private insertEvent;
  private insertDonation;
  private findDup;
  private upsertViewer;

  constructor(
    private db: Database,
    private bus: EventBus,
    private dedupWindowMs: number,
  ) {
    this.insertEvent = db.query(
      'INSERT INTO events_log(id, ts, source, type, payload) VALUES(?, ?, ?, ?, ?)',
    );
    this.insertDonation = db.query(
      `INSERT INTO donations(id, ts, source, viewer_id, nickname, amount_krw, text, kind, dedup_key)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findDup = db.query(
      'SELECT id FROM donations WHERE dedup_key = ? AND ts BETWEEN ? AND ? LIMIT 1',
    );
    this.upsertViewer = db.query(
      `INSERT INTO viewers(id, nickname, roles, first_seen, last_seen) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, roles = excluded.roles, last_seen = excluded.last_seen`,
    );
  }

  /** @returns 발행되었으면 true, 중복으로 버려졌으면 false */
  push(env: Envelope): boolean {
    const e = env.event;
    let accepted = true;

    this.db.transaction(() => {
      if (e.type === 'donation') {
        // 플랫폼 후원 ID가 있으면 그걸로 (시간 제한 없이) 판정, 없으면 내용+시간 창으로 판정
        const key = e.externalId
          ? `ext:${e.externalId}`
          : donationKey(e.viewer?.id ?? null, e.viewer?.nickname ?? null, e.amountKRW, e.text);
        const w = e.externalId ? Number.MAX_SAFE_INTEGER / 4 : this.dedupWindowMs;
        if (this.findDup.get(key, env.ts - w, env.ts + w)) {
          accepted = false;
          return;
        }
        this.insertDonation.run(
          env.id, env.ts, env.source, e.viewer ? viewerKey(e.viewer) : null,
          e.viewer?.nickname ?? null, e.amountKRW, e.text ?? null, e.kind, key,
        );
      }
      if ('viewer' in e && e.viewer) {
        this.upsertViewer.run(viewerKey(e.viewer), e.viewer.nickname, JSON.stringify(e.viewer.roles), env.ts, env.ts);
      }
      this.insertEvent.run(env.id, env.ts, env.source, e.type, JSON.stringify(env));
    })();

    if (!accepted) {
      log.info(`duplicate donation dropped (${env.source})`);
      return false;
    }
    this.bus.publish(env);
    return true;
  }

  recent(limit = 50): Envelope[] {
    const rows = this.db
      .query('SELECT payload FROM events_log ORDER BY ts DESC LIMIT ?')
      .all(limit) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as Envelope).reverse();
  }
}

export const viewerKey = (v: { platform: string; id: string }) => `${v.platform}:${v.id}`;

function donationKey(id: string | null, nick: string | null, amount: number, text?: string): string {
  const raw = `${id ?? 'anon:' + (nick ?? '')}|${amount}|${(text ?? '').trim()}`;
  return new Bun.CryptoHasher('sha1').update(raw).digest('hex');
}
