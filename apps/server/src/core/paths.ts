import { dirname, join, resolve } from 'node:path';

/** bun build --compile 로 만든 exe 안에서 실행 중인지 */
export const isCompiled =
  import.meta.path.includes('$bunfs') || import.meta.path.includes('~BUN');

/**
 * 포터블 원칙: 모든 데이터는 exe 옆 data/ 폴더. (DESIGN.md §5.1)
 * 개발 중에는 저장소 루트의 data/. LOCALBOT_HOME 으로 덮어쓸 수 있음(테스트용).
 */
export const appDir =
  process.env.LOCALBOT_HOME ??
  (isCompiled ? dirname(process.execPath) : resolve(import.meta.dir, '../../../..'));

export const dataDir = join(appDir, 'data');
export const logDir = join(dataDir, 'logs');
export const backupDir = join(dataDir, 'backups');
export const dbPath = join(dataDir, 'bot.db');
export const lockPath = join(dataDir, 'localbot.lock');
export const dashboardKeyPath = join(dataDir, 'dashboard.key');
