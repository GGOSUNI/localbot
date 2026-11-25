import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_VOICE, edgeSynthesize, googleSynthesize, mp3Duration, secMsGec } from '../apps/server/src/modules/tts/online.ts';
import { NaturalSpeaker, normalizeVoice, WindowsSpeaker } from '../apps/server/src/modules/tts/speaker.ts';

/** 24kHz 48kbps 모노 MPEG-2 Layer III 프레임 n개 (Edge가 주는 형식) */
function fakeMp3(frames: number) {
  const len = Math.floor((576 / 8) * 48000 / 24000); // 144바이트
  const b = new Uint8Array(len * frames);
  for (let i = 0; i < frames; i++) b.set([0xff, 0xf3, 0x64, 0xc4], i * len); // MPEG2, L3, 48kbps(idx 6), 24kHz
  return b;
}

describe('인터넷 목소리', () => {
  test('보안 토큰: 64자리 대문자 16진수, 5분 단위로 같음', () => {
    const t = Date.UTC(2026, 10, 25, 12, 0, 10);
    expect(secMsGec(t)).toMatch(/^[0-9A-F]{64}$/);
    expect(secMsGec(t)).toBe(secMsGec(t + 200_000));
    expect(secMsGec(t)).not.toBe(secMsGec(t + 300_000));
  });

  test('mp3 길이 계산', () => {
    expect(mp3Duration(fakeMp3(125))).toBeCloseTo(3, 1); // 125 × 576 / 24000 = 3초
    expect(mp3Duration(new Uint8Array(10))).toBe(0);
  });

  test('Edge 프로토콜: 설정·SSML 보내고, 오디오 조각을 모아 mp3로', async () => {
    const got: { url: string; msgs: string[] } = { url: '', msgs: [] };
    const audio = fakeMp3(10);
    const srv = Bun.serve({
      port: 0,
      fetch(req, s) {
        got.url = req.url;
        return s.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        message(ws, m) {
          got.msgs.push(String(m));
          if (!String(m).includes('Path:ssml')) return;
          ws.send('X-RequestId:1\r\nPath:turn.start\r\n\r\n{}');
          for (const part of [audio.slice(0, 700), audio.slice(700)]) {
            const head = new TextEncoder().encode('X-RequestId:1\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n');
            const frame = new Uint8Array(2 + head.length + part.length);
            frame[0] = head.length >> 8;
            frame[1] = head.length & 255;
            frame.set(head, 2);
            frame.set(part, 2 + head.length);
            ws.send(frame);
          }
          ws.send('X-RequestId:1\r\nPath:turn.end\r\n\r\n{}');
        },
      },
    });
    const mp3 = await edgeSynthesize('안녕 <b>&"\'', 'ko-KR-SunHiNeural', 4, { url: `ws://127.0.0.1:${srv.port}/` });
    srv.stop(true);
    expect(mp3).toEqual(audio);
    expect(got.url).toMatch(/TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC=[0-9A-F]{64}&Sec-MS-GEC-Version=1-[\d.]+&ConnectionId=[0-9a-f]{32}/);
    expect(got.msgs[0]).toContain('Path:speech.config');
    expect(got.msgs[0]).toContain('audio-24khz-48kbitrate-mono-mp3');
    expect(got.msgs[1]).toContain("<voice name='ko-KR-SunHiNeural'>");
    expect(got.msgs[1]).toContain("rate='+20%'");
    expect(got.msgs[1]).toContain('안녕 &lt;b&gt;&amp;&quot;&apos;');
  });

  test('Edge 서버가 연결을 끊으면 오류 (→ 윈도우 목소리로 대체됨)', async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response('forbidden', { status: 403 }) });
    await expect(edgeSynthesize('a', 'ko-KR-SunHiNeural', 0, { url: `ws://127.0.0.1:${srv.port}/`, timeoutMs: 3000 })).rejects.toThrow();
    srv.stop(true);
  });

  test('구글: 긴 문장은 나눠 받아 이어 붙임', async () => {
    const urls: string[] = [];
    const fake = (async (u: string) => {
      urls.push(u);
      return new Response(new Uint8Array([1, 2]));
    }) as unknown as typeof fetch;
    const out = await googleSynthesize(`${'가나다 '.repeat(50)}끝`, fake);
    expect(urls.length).toBe(2);
    expect(urls[0]).toContain('tl=ko');
    expect(out).toEqual(new Uint8Array([1, 2, 1, 2]));
  });
});

class FakeSapi extends WindowsSpeaker {
  spoken: { text: string; voice: string }[] = [];
  override speak(text: string, o: { voice: string; rate: number; volume: number }) {
    this.spoken.push({ text, voice: o.voice });
    return { done: Promise.resolve(), cancel() {} };
  }
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('목소리 고르기 · 실패하면 윈도우 목소리', () => {
  const mk = (edge: (t: string, v: string, r: number) => Promise<Uint8Array>) => {
    const dir = mkdtempSync(join(tmpdir(), 'lb-voice-'));
    dirs.push(dir);
    const sapi = new FakeSapi();
    const played: { file: string; volume: number; ms: number; bytes: number }[] = [];
    const sp = new NaturalSpeaker(sapi, join(dir, 'tts'), { edge, google: async () => fakeMp3(25) }, (file, volume, ms) => {
      played.push({ file, volume, ms, bytes: readFileSync(file).length });
      return { done: Promise.resolve(), cancel() {} };
    });
    return { sp, sapi, played };
  };

  test('기본은 선희 (Edge) → mp3 받아서 그 길이만큼 재생, 다 읽으면 파일 지움', async () => {
    const calls: string[] = [];
    const { sp, sapi, played } = mk(async (_t, v) => (calls.push(v), fakeMp3(125)));
    await sp.speak('안녕하세요', { voice: '', rate: 0, volume: 80 }).done;
    expect(calls).toEqual(['ko-KR-SunHiNeural']);
    expect(played).toHaveLength(1);
    expect(played[0]!.volume).toBe(80);
    expect(played[0]!.ms).toBeGreaterThan(3000);
    expect(existsSync(played[0]!.file)).toBe(false);
    expect(sapi.spoken).toHaveLength(0);
    expect(sp.lastUsed).toContain('선희');
  });

  test('인터넷 목소리가 실패하면 윈도우 목소리로 읽고 이유를 남김', async () => {
    const { sp, sapi, played } = mk(async () => { throw new Error('edge tts closed (1006)'); });
    await sp.speak('안녕', { voice: 'edge:ko-KR-InJoonNeural', rate: 0, volume: 100 }).done;
    expect(played).toHaveLength(0);
    expect(sapi.spoken).toEqual([{ text: '안녕', voice: '' }]);
    expect(sp.lastError).toContain('인준');
  });

  test('구글 · 윈도우 목소리 직접 고르기, 예전 설정값(접두사 없음)은 윈도우 목소리', async () => {
    const { sp, sapi, played } = mk(async () => fakeMp3(1));
    await sp.speak('a', { voice: 'google:ko', rate: 0, volume: 100 }).done;
    expect(played).toHaveLength(1);
    await sp.speak('b', { voice: 'Microsoft Heami Desktop', rate: 0, volume: 100 }).done;
    expect(sapi.spoken).toEqual([{ text: 'b', voice: 'Microsoft Heami Desktop' }]);
    expect(normalizeVoice('')).toBe(DEFAULT_VOICE);
    expect(normalizeVoice('sapi:X')).toBe('sapi:X');
  });
});
