import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logDir } from './paths.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

let ready = false;
function file(): string {
  if (!ready) {
    mkdirSync(logDir, { recursive: true });
    ready = true;
  }
  return join(logDir, `localbot-${new Date().toISOString().slice(0, 10)}.log`);
}

export function createLogger(scope: string) {
  const write = (level: Level, msg: string, extra?: unknown) => {
    const line = `${new Date().toISOString()} [${level}] [${scope}] ${msg}${
      extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.stack : JSON.stringify(extra))
    }`;
    (level === 'error' ? console.error : console.log)(line);
    try {
      appendFileSync(file(), line + '\n');
    } catch {
      /* 로그 실패로 앱이 죽으면 안 됨 */
    }
  };
  return {
    debug: (m: string, e?: unknown) => process.env.LOCALBOT_DEBUG && write('debug', m, e),
    info: (m: string, e?: unknown) => write('info', m, e),
    warn: (m: string, e?: unknown) => write('warn', m, e),
    error: (m: string, e?: unknown) => write('error', m, e),
  };
}
export type Logger = ReturnType<typeof createLogger>;
