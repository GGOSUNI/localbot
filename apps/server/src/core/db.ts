import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.ts';
import { migrations } from './migrations.ts';

const log = createLogger('db');
const BACKUP_KEEP = 7;

export function openDatabase(path: string, backupDir: string): Database {
  const existed = existsSync(path);
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  if (pending.length && existed && current > 0) backup(db, backupDir, `pre-migrate-v${current}`);

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    })();
    log.info(`migration applied: v${m.version} ${m.name}`);
  }
  return db;
}

/** 온라인 백업 (WAL 상태에서도 일관된 스냅샷). 오래된 것부터 지워 BACKUP_KEEP개 유지. */
export function backup(db: Database, backupDir: string, label: string): string {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(backupDir, `bot-${stamp}-${label}.db`);
  db.query('VACUUM INTO ?').run(file);
  const files = readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
    rmSync(join(backupDir, old), { force: true });
  }
  log.info(`backup created: ${file}`);
  return file;
}

export function getSetting<T>(db: Database, key: string, fallback: T): T {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(db: Database, key: string, value: unknown): void {
  db.query('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
