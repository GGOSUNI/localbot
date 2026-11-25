import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../core/logger.ts';
import { DEFAULT_VOICE, edgeSynthesize, googleSynthesize, mp3Duration, voiceLabel } from './online.ts';

const log = createLogger('tts');

/**
 * 윈도우 내장 음성(SAPI)으로 스피커에 바로 말하기. 인터넷·설치 필요 없음.
 * 문장은 명령줄이 아니라 환경 변수로 넘김 (따옴표·한글 깨짐 방지).
 */
export interface Speaker {
  available: boolean;
  lastUsed?: string | null;
  lastError?: string | null;
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

/** mp3 파일을 스피커로 재생 (윈도우 기본 미디어 플레이어 구성요소, 설치 필요 없음) */
function playMp3(file: string, volume: number, ms: number): { done: Promise<void>; cancel(): void } {
  const script = [
    'Add-Type -AssemblyName PresentationCore',
    '$p = New-Object System.Windows.Media.MediaPlayer',
    '$p.Open([Uri]::new($env:LB_FILE))',
    '$p.Volume = [double]$env:LB_VOL / 100',
    '$p.Play()',
    'Start-Sleep -Milliseconds ([int]$env:LB_MS)',
    '$p.Stop(); $p.Close()',
  ].join('; ');
  const p = Bun.spawn([...PS, script], {
    env: { ...process.env, LB_FILE: file, LB_VOL: String(volume), LB_MS: String(Math.round(ms)) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const done = Promise.race([p.exited, Bun.sleep(ms + 15_000)]).then(async (code) => {
    if (typeof code === 'number' && code !== 0) log.warn(`mp3 play failed (code ${code})`, (await new Response(p.stderr).text()).slice(0, 300));
    if (p.exitCode === null) p.kill();
  });
  return { done, cancel: () => p.kill() };
}

/** 'edge:…' / 'google:…' / 'sapi:…' (접두사 없는 예전 값은 윈도우 목소리) */
export function normalizeVoice(v: string): string {
  if (!v) return DEFAULT_VOICE;
  return /^(edge|google|sapi):/.test(v) ? v : `sapi:${v}`;
}

/**
 * 자연스러운 인터넷 목소리로 읽고, 인터넷 목소리가 안 되면 윈도우 내장 목소리로 읽음.
 * 어떤 목소리로 읽었는지/왜 바꿨는지는 lastUsed·lastError로 대시보드에 표시.
 */
export class NaturalSpeaker implements Speaker {
  available = process.platform === 'win32';
  lastUsed: string | null = null;
  lastError: string | null = null;
  private n = 0;

  constructor(
    private sapi: WindowsSpeaker,
    private dir: string,
    private synth: { edge: typeof edgeSynthesize; google: (t: string) => Promise<Uint8Array> } = { edge: edgeSynthesize, google: (t) => googleSynthesize(t) },
    private play: typeof playMp3 = playMp3,
  ) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }

  speak(text: string, opts: { voice: string; rate: number; volume: number }) {
    let cancelled = false;
    let inner: { cancel(): void } | null = null;
    const voice = normalizeVoice(opts.voice);
    const sapiSpeak = async (name: string) => {
      this.lastUsed = voiceLabel(`sapi:${name}`);
      const h = this.sapi.speak(text, { ...opts, voice: name });
      inner = h;
      await h.done;
    };
    const done = (async () => {
      if (voice.startsWith('sapi:')) return sapiSpeak(voice.slice(5));
      let mp3: Uint8Array;
      try {
        mp3 = voice.startsWith('edge:') ? await this.synth.edge(text, voice.slice(5), opts.rate) : await this.synth.google(text);
        this.lastUsed = voiceLabel(voice);
        this.lastError = null;
      } catch (err) {
        this.lastError = `${voiceLabel(voice)} 실패 → 윈도우 목소리로 읽음 (${String((err as Error)?.message ?? err).slice(0, 80)})`;
        log.warn(this.lastError);
        if (cancelled) return;
        return sapiSpeak('');
      }
      if (cancelled) return;
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${Date.now()}-${this.n++}.mp3`);
      writeFileSync(file, mp3);
      const h = this.play(file, opts.volume, mp3Duration(mp3) * 1000 + 300);
      inner = h;
      await h.done;
      try {
        rmSync(file, { force: true });
      } catch {
        /* 재생기가 아직 잡고 있으면 다음 시작 때 지움 */
      }
    })();
    return {
      done,
      cancel: () => {
        cancelled = true;
        inner?.cancel();
      },
    };
  }

  voices() {
    return this.sapi.voices();
  }
}
