import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '@localbot/shared';
import { EventBus, envelope } from '../apps/server/src/core/bus.ts';
import { backup, getSetting, openDatabase, setSetting } from '../apps/server/src/core/db.ts';
import { Ingest } from '../apps/server/src/core/ingest.ts';
import { migrations } from '../apps/server/src/core/migrations.ts';

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'localbot-'));
  db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('EventBus', () => {
  test('한 핸들러가 예외를 던져도 나머지는 계속 받는다', () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.on(() => {
      throw new Error('boom');
    });
    bus.on(async () => {
      throw new Error('async boom');
    });
    bus.on((e) => void got.push(e.event.type));
    bus.publish(envelope('mock', { type: 'stream', state: 'online' }));
    expect(got).toEqual(['stream']);
  });
});

describe('database', () => {
  test('마이그레이션은 최신 버전까지 적용되고, 다시 열어도 멱등', () => {
    const latest = Math.max(...migrations.map((m) => m.version));
    expect((db.query('PRAGMA user_version').get() as any).user_version).toBe(latest);
    db.close();
    db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
    expect((db.query('PRAGMA user_version').get() as any).user_version).toBe(latest);
  });

  test('WAL 모드', () => {
    expect((db.query('PRAGMA journal_mode').get() as any).journal_mode).toBe('wal');
  });

  test('settings 왕복', () => {
    expect(getSetting(db, 'x', 1)).toBe(1);
    setSetting(db, 'x', { a: [1, 2] });
    expect(getSetting(db, 'x', null)).toEqual({ a: [1, 2] });
  });

  test('백업은 최대 7개만 유지', () => {
    for (let i = 0; i < 9; i++) backup(db, join(dir, 'backups'), `t${i}`);
    expect(readdirSync(join(dir, 'backups')).length).toBe(7);
  });
});

describe('Ingest — 후원 중복 제거', () => {
  const viewer = { platform: 'chzzk' as const, id: 'u1', nickname: '치즈러버', roles: ['viewer' as const] };
  const donation = (ts: number, text = '룰렛!', source: Envelope['source'] = 'chzzk-official') =>
    envelope(source, { type: 'donation', viewer, amountKRW: 5000, text, kind: 'chat' }, ts);

  test('공식/읽기전용 연결에서 3초 안에 같은 후원이 오면 한 번만 발행', () => {
    const bus = new EventBus();
    const seen: Envelope[] = [];
    bus.on((e) => void seen.push(e));
    const ingest = new Ingest(db, bus, 3000);
    const t = 1_700_000_000_000;

    expect(ingest.push(donation(t, '룰렛!', 'chzzk-official'))).toBe(true);
    expect(ingest.push(donation(t + 1200, '룰렛!', 'chzzk-readonly'))).toBe(false); // 중복
    expect(ingest.push(donation(t + 500, '다른 메시지'))).toBe(true); // 메시지가 다르면 별개
    expect(ingest.push(donation(t + 10_000, '룰렛!'))).toBe(true); // 시간 창 밖 = 진짜 재후원

    expect(seen.length).toBe(3);
    expect((db.query('SELECT COUNT(*) n FROM donations').get() as any).n).toBe(3);
  });

  test('시청자 정보가 저장되고, recent()는 시간순', () => {
    const ingest = new Ingest(db, new EventBus(), 3000);
    ingest.push(envelope('mock', { type: 'chat', viewer, text: 'a', msgId: '1' }, 1));
    ingest.push(envelope('mock', { type: 'chat', viewer: { ...viewer, nickname: '새닉' }, text: 'b', msgId: '2' }, 2));
    expect((db.query('SELECT nickname FROM viewers WHERE id = ?').get('chzzk:u1') as any).nickname).toBe('새닉');
    expect(ingest.recent(10).map((e) => (e.event as any).text)).toEqual(['a', 'b']);
  });
});
