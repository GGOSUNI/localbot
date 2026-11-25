import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { config } from './core/config.ts';
import { createLogger } from './core/logger.ts';
import { dashboardKeyPath, dataDir, isCompiled, lockPath } from './core/paths.ts';
import { ensureDesktopShortcut } from './core/shortcut.ts';
import { showErrorBox, takeOverPort } from './core/takeover.ts';

const log = createLogger('supervisor');

const PORT_IN_USE = 3;
const HEALTHY_AFTER_MS = 60_000;

/**
 * LocalBot.exe 의 본체. 실제 일은 --worker 자식 프로세스가 하고,
 * 여기서는 워커가 죽으면 즉시 다시 띄우는 것만 합니다. (DESIGN.md §2, §5.1 자가 복구)
 */
export async function runSupervisor(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });

  const other = lockHolder();
  if (other) {
    log.info(`이미 실행 중입니다 (pid ${other}). 대시보드를 엽니다.`);
    openDashboard(ensureDashboardKey());
    return;
  }
  writeFileSync(lockPath, String(process.pid));
  ensureDesktopShortcut();

  // 다른 폴더의 (예전) LocalBot이 켜져 있으면 끄고 이어받음 — 마지막에 실행한 것이 이김
  const port = await takeOverPort(config.host, config.port);
  if (port === 'taken-over') log.info('예전 LocalBot을 종료하고 이어받았습니다');
  if (port === 'foreign') {
    const msg = `포트 ${config.port}을(를) 다른 프로그램이 쓰고 있어서 LocalBot을 시작할 수 없습니다.\n그 프로그램을 끄고 다시 실행해 주세요.`;
    log.error(msg);
    showErrorBox(msg);
    releaseLock();
    process.exit(1);
  }

  const key = ensureDashboardKey();
  const url = dashboardUrl(key);
  log.info(`대시보드: ${url}`);

  let child: Subprocess | null = null;
  let stopping = false;
  let browserOpened = false;
  const recentCrashes: number[] = [];

  const spawnWorker = () => {
    const startedAt = Date.now();
    child = Bun.spawn([process.execPath, ...workerArgs()], {
      // 콘솔 없는 exe에서는 상속할 콘솔이 없음 → 로그는 data/logs 파일로만
      stdio: isCompiled && process.platform === 'win32' ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'inherit', 'inherit'],
      env: process.env,
      ipc(message: { type?: string; pid?: number }) {
        if (message?.type === 'quit') {
          void stop();
          return;
        }
        if (message?.type === 'ready') {
          log.info(`worker ready (pid ${message.pid})`);
          if (!browserOpened && config.openBrowser) openDashboard(key);
          browserOpened = true;
        }
      },
      onExit(_proc, code, signal) {
        if (stopping) return;
        const now = Date.now();
        if (now - startedAt > HEALTHY_AFTER_MS) recentCrashes.length = 0;
        recentCrashes.push(now);
        const n = recentCrashes.length;
        // 처음 3번은 즉시(0.3초), 그 뒤로는 지수 백오프 최대 10초 — 무한 크래시 루프가 CPU를 태우지 않게
        let delay = n <= 3 ? 300 : Math.min(10_000, 1000 * 2 ** (n - 3));
        if (code === PORT_IN_USE) delay = 5_000;
        log.warn(`worker exited (code=${code}, signal=${signal}). ${delay}ms 후 재시작 (연속 ${n}회)`);
        setTimeout(spawnWorker, delay);
      },
    });
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info('stopping');
    const c = child as Subprocess | null;
    if (c && c.exitCode === null) {
      c.kill('SIGTERM');
      await Promise.race([c.exited, Bun.sleep(3000)]);
      if (c.exitCode === null) c.kill('SIGKILL');
    }
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  spawnWorker();
}

function workerArgs(): string[] {
  // 컴파일된 exe: 자기 자신을 --worker 로 다시 실행. 개발 중: bun <entry> --worker
  return isCompiled ? ['--worker'] : [Bun.main, '--worker'];
}

export function ensureDashboardKey(): string {
  if (existsSync(dashboardKeyPath)) return readFileSync(dashboardKeyPath, 'utf8').trim();
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = Buffer.from(bytes).toString('base64url');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(dashboardKeyPath, key, { mode: 0o600 });
  return key;
}

function dashboardUrl(key: string) {
  return `http://127.0.0.1:${config.port}/login?key=${key}`;
}

function lockHolder(): number | null {
  if (!existsSync(lockPath)) return null;
  const pid = Number(readFileSync(lockPath, 'utf8'));
  if (!Number.isInteger(pid) || pid === process.pid) return null;
  try {
    process.kill(pid, 0); // 살아 있는지만 확인
    return pid;
  } catch {
    return null; // 비정상 종료로 남은 락 → 무시
  }
}

function releaseLock() {
  try {
    if (readFileSync(lockPath, 'utf8') === String(process.pid)) rmSync(lockPath);
  } catch {
    /* 이미 없음 */
  }
}

function openDashboard(key: string) {
  if (!config.openBrowser) return;
  const url = dashboardUrl(key);
  const cmd =
    process.platform === 'win32'
      ? ['rundll32', 'url.dll,FileProtocolHandler', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    /* 브라우저를 못 열어도 콘솔 주소로 접속 가능 */
  }
}
