import { createLogger } from '../../core/logger.ts';

const log = createLogger('tts');

/**
 * 윈도우 내장 음성(SAPI)으로 스피커에 바로 말하기. 인터넷·설치 필요 없음.
 * 문장은 명령줄이 아니라 환경 변수로 넘김 (따옴표·한글 깨짐 방지).
 */
export interface Speaker {
  available: boolean;
  /** 다 읽으면 끝나는 Promise. cancel()로 중간에 끊기 */
  speak(text: string, opts: { voice: string; rate: number; volume: number }): { done: Promise<void>; cancel(): void };
  voices(): Promise<string[]>;
}

const PS = ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command'];

export class WindowsSpeaker implements Speaker {
  available = process.platform === 'win32';

  speak(text: string, opts: { voice: string; rate: number; volume: number }) {
    if (!this.available) return { done: Promise.resolve(), cancel() {} };
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      // 목소리 지정이 없으면 한국어 목소리 우선
      'if ($env:LB_VOICE) { try { $s.SelectVoice($env:LB_VOICE) } catch {} } else { $k = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq "ko-KR" } | Select-Object -First 1; if ($k) { $s.SelectVoice($k.VoiceInfo.Name) } }',
      '$s.Rate = [int]$env:LB_RATE',
      '$s.Volume = [int]$env:LB_VOL',
      '$s.SetOutputToDefaultAudioDevice()',
      '$s.Speak($env:LB_TEXT)',
    ].join('; ');
    const p = Bun.spawn([...PS, script], {
      env: { ...process.env, LB_TEXT: text, LB_VOICE: opts.voice, LB_RATE: String(opts.rate), LB_VOL: String(opts.volume) },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const done = Promise.race([p.exited, Bun.sleep(60_000)]).then(async (code) => {
      if (typeof code === 'number' && code !== 0) log.warn(`speech failed (code ${code})`, (await new Response(p.stderr).text()).slice(0, 300));
      if (p.exitCode === null) p.kill();
    });
    return { done, cancel: () => p.kill() };
  }

  async voices(): Promise<string[]> {
    if (!this.available) return [];
    const p = Bun.spawn([...PS, 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }'], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    const out = await new Response(p.stdout).text();
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
}
