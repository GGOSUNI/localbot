import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { MockAdapter } from './adapters/mock.ts';
import { EventBus, envelope } from './core/bus.ts';
import { config } from './core/config.ts';
import { openDatabase } from './core/db.ts';
import { Ingest } from './core/ingest.ts';
import { createLogger } from './core/logger.ts';
import { backupDir, dashboardKeyPath, dataDir, dbPath } from './core/paths.ts';
import { startHttp } from './http/server.ts';
import { ensureDashboardKey } from './supervisor.ts';

const log = createLogger('worker');

/** Worker 종료 코드: Supervisor가 재시작 전략을 고르는 데 씀 */
export const EXIT = { OK: 0, CRASH: 1, PORT_IN_USE: 3 } as const;

export async function runWorker(): Promise<void> {
  const startedAt = Date.now();

  // 상태를 망가뜨린 채 계속 도는 것보다, 죽고 Supervisor가 깨끗하게 다시 띄우는 편이 안전합니다.
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception — exiting for supervisor restart', err);
    process.exit(EXIT.CRASH);
  });
  process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection — exiting for supervisor restart', err);
    process.exit(EXIT.CRASH);
  });
  // Supervisor가 사라지면(IPC 끊김) 고아 프로세스로 남지 않음
  process.on('disconnect', () => process.exit(EXIT.OK));

  mkdirSync(dataDir, { recursive: true });
  const dashboardKey = existsSync(dashboardKeyPath)
    ? readFileSync(dashboardKeyPath, 'utf8').trim()
    : ensureDashboardKey();

  const db = openDatabase(dbPath, backupDir);
  const bus = new EventBus();
  const ingest = new Ingest(db, bus, config.donationDedupWindowMs);

  const mock = new MockAdapter();
  await mock.start((env) => ingest.push(env));

  let server;
  try {
    server = startHttp({
      host: config.host,
      port: config.port,
      dashboardKey,
      bus,
      ingest,
      mock,
      workerStartedAt: startedAt,
      onCrashRequested: () => {
        log.warn('crash requested from dashboard');
        process.exit(EXIT.CRASH);
      },
    });
  } catch (err) {
    log.error(`cannot listen on ${config.host}:${config.port} (이미 사용 중인 포트일 수 있음)`, err);
    process.exit(EXIT.PORT_IN_USE);
  }

  ingest.push(envelope('system', { type: 'system', level: 'info', message: `워커 시작 (pid ${process.pid})` }));

  const shutdown = () => {
    log.info('shutting down');
    server.stop(true);
    db.close();
    process.exit(EXIT.OK);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.send?.({ type: 'ready', pid: process.pid });
}
