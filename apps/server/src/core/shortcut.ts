import { createLogger } from './logger.ts';
import { isCompiled } from './paths.ts';

const log = createLogger('shortcut');

/**
 * 바탕화면 "LocalBot" 바로가기를 지금 실행 중인 exe로 맞춥니다.
 * 새 버전을 다른 폴더에 풀어도 한 번 실행하면 바로가기가 새 exe를 가리킵니다.
 * 끄려면 LOCALBOT_NO_SHORTCUT=1. 실패해도 앱은 계속 동작합니다.
 */
export function ensureDesktopShortcut() {
  if (!isCompiled || process.platform !== 'win32' || process.env.LOCALBOT_NO_SHORTCUT === '1') return;
  // 경로(한글·공백)는 명령줄이 아니라 환경 변수로 넘겨 인코딩·따옴표 문제를 피함
  const script = [
    "$ErrorActionPreference='Stop'",
    "$desk=[Environment]::GetFolderPath('Desktop')",
    "$lnk=Join-Path $desk 'LocalBot.lnk'",
    '$sh=New-Object -ComObject WScript.Shell',
    '$s=$sh.CreateShortcut($lnk)',
    'if ($s.TargetPath -ne $env:LB_TARGET) {',
    '  $s.TargetPath=$env:LB_TARGET',
    '  $s.WorkingDirectory=$env:LB_WORKDIR',
    '  $s.IconLocation="$env:LB_TARGET,0"',
    "  $s.Description='LocalBot - 치지직 스트리머 봇'",
    '  $s.Save()',
    "  'updated'",
    '}',
  ].join('; ');
  try {
    const exe = process.execPath;
    const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      env: { ...process.env, LB_TARGET: exe, LB_WORKDIR: exe.replace(/[\\/][^\\/]+$/, '') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    void p.exited.then(async (code) => {
      const out = (await new Response(p.stdout).text()).trim();
      if (code === 0) {
        if (out.includes('updated')) log.info('desktop shortcut created/updated');
      } else {
        log.warn(`desktop shortcut failed (code ${code})`, (await new Response(p.stderr).text()).slice(0, 300));
      }
    });
  } catch (err) {
    log.warn('desktop shortcut failed', String(err));
  }
}
