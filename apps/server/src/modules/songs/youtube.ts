/** YouTube 링크 파싱과 1차 검증 (API 키 없이). DESIGN.md §3.4-1 */

const ID = '([A-Za-z0-9_-]{11})';
const PATTERNS = [
  new RegExp(`youtu\\.be/${ID}`),
  new RegExp(`youtube\\.com/(?:watch\\?(?:[^\\s#]*&)?v=|shorts/|live/|embed/|v/)${ID}`),
  new RegExp(`music\\.youtube\\.com/watch\\?(?:[^\\s#]*&)?v=${ID}`),
];

/** 텍스트 어디든 들어 있는 첫 번째 YouTube 링크의 영상 ID */
export function findYouTubeId(text: string): string | null {
  for (const p of PATTERNS) {
    const m = text.match(p);
    if (m) return m[1]!;
  }
  return null;
}

/** `!신청곡 <링크 또는 영상ID>` 인자 파싱 */
export function parseRequestArg(arg: string): string | null {
  const t = arg.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  return findYouTubeId(t);
}

export type OEmbedResult =
  | { ok: true; title: string; author: string | null }
  | { ok: false; reason: string }
  /** 네트워크 문제 등으로 확인 불가 → 막지 않고 재생 전 2차 검증에 맡김 */
  | { ok: 'unknown' };

export async function checkOEmbed(videoId: string, fetchImpl: typeof fetch = fetch): Promise<OEmbedResult> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: '퍼가기가 금지된 영상' };
    if (r.status === 400 || r.status === 404) return { ok: false, reason: '없거나 비공개인 영상' };
    if (!r.ok) return { ok: 'unknown' };
    const j = (await r.json()) as { title?: string; author_name?: string };
    return { ok: true, title: j.title || videoId, author: j.author_name ?? null };
  } catch {
    return { ok: 'unknown' };
  }
}
