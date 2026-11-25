import { createHash, randomUUID } from 'node:crypto';

/**
 * 자연스러운 인터넷 목소리 (키·가입 없음)
 * - Edge 신경망 음성: 엣지 브라우저 "소리 내어 읽기"가 쓰는 서버 (선희·인준·현수)
 * - 구글 번역 음성
 * 둘 다 mp3를 받아 옴. 안 되면 TTS 쪽에서 윈도우 내장 목소리로 바꿔 읽음.
 */

export const DEFAULT_VOICE = 'edge:ko-KR-SunHiNeural';

export interface VoiceOption {
  id: string;
  label: string;
  group: '자연스러운 목소리' | '구글' | '윈도우 내장';
}

export const ONLINE_VOICES: VoiceOption[] = [
  { id: 'edge:ko-KR-SunHiNeural', label: '선희 (여자 · 추천)', group: '자연스러운 목소리' },
  { id: 'edge:ko-KR-InJoonNeural', label: '인준 (남자)', group: '자연스러운 목소리' },
  { id: 'edge:ko-KR-HyunsuMultilingualNeural', label: '현수 (남자)', group: '자연스러운 목소리' },
  { id: 'google:ko', label: '구글 번역기 (여자)', group: '구글' },
];

export function voiceLabel(id: string): string {
  const v = ONLINE_VOICES.find((x) => x.id === (id || DEFAULT_VOICE));
  if (v) return v.label;
  return `윈도우: ${id.replace(/^sapi:/, '') || '기본'}`;
}

// ── Edge ──
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '130.0.2849.68';
const EDGE_WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const WIN_EPOCH_S = 11644473600;

/** 서버가 요구하는 시간 기반 토큰 (5분 단위) */
export function secMsGec(nowMs: number): string {
  let s = Math.floor(nowMs / 1000) + WIN_EPOCH_S;
  s -= s % 300;
  const ticks = BigInt(s) * 10_000_000n; // 100ns 단위
  return createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const stamp = () => new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');

export async function edgeSynthesize(
  text: string,
  voice: string,
  rate: number,
  opts: { url?: string; now?: () => number; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const now = opts.now ?? Date.now;
  const url = `${opts.url ?? EDGE_WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec(now())}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}&ConnectionId=${randomUUID().replace(/-/g, '')}`;
  const proxy = opts.url ? undefined : process.env.HTTPS_PROXY || process.env.https_proxy;
  const major = CHROMIUM_FULL_VERSION.split('.')[0];
  const ws = new WebSocket(url, {
    headers: {
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `muid=${randomUUID().replace(/-/g, '').toUpperCase()};`,
    },
    ...(proxy ? { proxy } : {}),
  } as any);
  ws.binaryType = 'arraybuffer';
  const pct = Math.max(-10, Math.min(10, Math.round(rate))) * 5;
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ko-KR'><voice name='${xml(voice)}'><prosody pitch='+0Hz' rate='${pct >= 0 ? '+' : ''}${pct}%' volume='+0%'>${xml(text)}</prosody></voice></speak>`;

  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const timer = setTimeout(() => finish(new Error('edge tts timeout')), opts.timeoutMs ?? 10_000);
    let done = false;
    function finish(err: Error | null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      if (err) return reject(err);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      if (!total) return reject(new Error('edge tts: no audio'));
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      resolve(out);
    }
    ws.onopen = () => {
      ws.send(
        `X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
      );
      ws.send(`X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        if (e.data.includes('Path:turn.end')) finish(null);
        return;
      }
      const b = new Uint8Array(e.data as ArrayBuffer);
      if (b.length < 2) return;
      const hl = (b[0]! << 8) | b[1]!;
      const head = new TextDecoder().decode(b.subarray(2, 2 + hl));
      if (head.includes('Path:audio')) chunks.push(b.slice(2 + hl));
    };
    ws.onerror = () => finish(new Error('edge tts connection failed'));
    ws.onclose = (e) => finish(chunks.length ? null : new Error(`edge tts closed (${e.code})`));
  });
}

// ── Google ──
export async function googleSynthesize(text: string, fetchImpl: typeof fetch = fetch, base = 'https://translate.google.com/translate_tts'): Promise<Uint8Array> {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > 180) {
    let cut = rest.lastIndexOf(' ', 180);
    if (cut < 60) cut = 180;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  const out: Uint8Array[] = [];
  for (const [i, q] of parts.entries()) {
    const u = `${base}?ie=UTF-8&client=tw-ob&tl=ko&total=${parts.length}&idx=${i}&textlen=${q.length}&q=${encodeURIComponent(q)}`;
    const r = await fetchImpl(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`google tts ${r.status}`);
    out.push(new Uint8Array(await r.arrayBuffer()));
  }
  const total = out.reduce((n, c) => n + c.length, 0);
  if (!total) throw new Error('google tts: no audio');
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of out) {
    buf.set(c, o);
    o += c.length;
  }
  return buf;
}

// ── mp3 길이 (재생 끝 시점 계산용) ──
const BITRATES: Record<string, number[]> = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** MPEG-1/2/2.5 Layer III 프레임을 세서 길이(초)를 구함 */
export function mp3Duration(b: Uint8Array): number {
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b.length > 10) {
    i = 10 + (((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f));
  }
  let seconds = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const ver = (b[i + 1]! >> 3) & 3; // 3: MPEG1, 2: MPEG2, 0: MPEG2.5
    const layer = (b[i + 1]! >> 1) & 3; // 1: Layer III
    const br = (b[i + 2]! >> 4) & 15;
    const sr = (b[i + 2]! >> 2) & 3;
    const pad = (b[i + 2]! >> 1) & 1;
    if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) {
      i++;
      continue;
    }
    const kbps = (ver === 3 ? BITRATES.v1 : BITRATES.v2)![br]!;
    const rate = RATES[ver]![sr]!;
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
    if (len < 4) {
      i++;
      continue;
    }
    seconds += samples / rate;
    i += len;
  }
  return seconds;
}
