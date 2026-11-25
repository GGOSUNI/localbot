import { readFileSync, readlinkSync } from 'node:fs';
import { createLogger } from './logger.ts';

const log = createLogger('takeover');

/**
 * 포트(7777)를 다른 폴더의 LocalBot이 쓰고 있으면 끄고 이어받습니다.
 * 새 버전을 다른 폴더에 풀어 실행했는데 예전 버전이 켜져 있어서 "실행이 안 되는" 문제 방지.
 * @returns free: 비어 있음 · taken-over: 예전 LocalBot을 끄고 비움 · foreign: LocalBot이 아닌 프로그램이 사용 중
 */
export async function takeOverPort(host: string, port: number): Promise<'free' | 'taken-over' | 'foreign'> {
  const health = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? (r.json() as Promise<{ ok?: boolean; pid?: number; version?: string }>) : null))
    .catch(() => null);

  if (!health?.ok || !health.pid) return portFree(host, port) ? 'free' : 'foreign';
  if (health.pid === process.pid) return 'free';

  log.warn(`다른 LocalBot(v${health.version ?? '?'}, worker pid ${health.pid})이 포트 ${port}을 쓰고 있어 종료하고 이어받습니다`);
  await killLocalBot(health.pid);
  for (let i = 0; i < 50; i++) {
    if (portFree(host, port)) return 'taken-over';
    await Bun.sleep(100);
  }
  return 'foreign';
}

function portFree(host: string, port: number): boolean {
  try {
    const s = Bun.listen({ hostname: host, port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** 워커와, 같은 실행 파일인 경우에만 그 부모(감시 프로세스)까지 종료 — 엉뚱한 프로그램은 건드리지 않음 */
async function killLocalBot(workerPid: number) {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      '$w=Get-CimInstance Win32_Process -Filter "ProcessId=$env:LB_PID"',
      'if ($w) {',
      '  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($w.ParentProcessId)"',
      '  if ($p -and $p.ExecutablePath -eq $w.ExecutablePath) { Stop-Process -Id $p.ProcessId -Force }',
      '  Stop-Process -Id $w.ProcessId -Force',
      '}',
    ].join('; ');
    const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      env: { ...process.env, LB_PID: String(workerPid) },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    await Promise.race([p.exited, Bun.sleep(8000)]);
    return;
  }
  // Linux (개발·테스트용)
  try {
    const ppid = Number(readFileSync(`/proc/${workerPid}/stat`, 'utf8').split(') ')[1]!.split(' ')[1]);
    if (ppid > 1 && readlinkSync(`/proc/${ppid}/exe`) === readlinkSync(`/proc/${workerPid}/exe`)) process.kill(ppid, 'SIGKILL');
  } catch {
    /* 이미 없음 */
  }
  try {
    process.kill(workerPid, 'SIGKILL');
  } catch {
    /* 이미 없음 */
  }
}

/** 콘솔 없는 Windows exe에서 사용자에게 오류를 보여 줄 유일한 방법 */
export function showErrorBox(message: string) {
  if (process.platform !== 'win32') return;
  try {
    Bun.spawn(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:LB_MSG, 'LocalBot') | Out-Null"],
      { env: { ...process.env, LB_MSG: message }, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
    );
  } catch {
    /* 무시 */
  }
}
