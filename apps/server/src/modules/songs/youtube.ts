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

export interface SearchHit {
  videoId: string;
  title: string;
  author: string | null;
  durationSec: number | null;
}

/** "4:29" / "1:02:03" → 초 */
export function parseDuration(text: string | undefined): number | null {
  if (!text) return null;
  const parts = text.trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((s, n) => s * 60 + n, 0);
}

/**
 * API 키 없이 YouTube 검색 (검색 결과 페이지에 들어 있는 데이터를 읽음).
 * 공식 API가 아니라 YouTube가 페이지 구조를 바꾸면 깨질 수 있습니다 → 실패하면 빈 배열, 링크 신청은 계속 동작.
 */
export async function searchYouTube(query: string, fetchImpl: typeof fetch = fetch): Promise<SearchHit[]> {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D&hl=ko&gl=KR`;
    const r = await fetchImpl(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'accept-language': 'ko-KR,ko;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    return parseSearchHtml(await r.text());
  } catch {
    return [];
  }
}

export function parseSearchHtml(html: string): SearchHit[] {
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[1]!);
  } catch {
    return [];
  }
  const hits: SearchHit[] = [];
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 40 || hits.length >= 15) return;
    const v = o.videoRenderer;
    if (v?.videoId) {
      hits.push({
        videoId: v.videoId,
        title: v.title?.runs?.map((x: any) => x.text).join('') ?? v.videoId,
        author: v.ownerText?.runs?.[0]?.text ?? null,
        // 생방송은 길이가 없음 → null
        durationSec: parseDuration(v.lengthText?.simpleText),
      });
      return;
    }
    for (const k in o) walk(o[k], depth + 1);
  };
  walk(data, 0);
  return hits;
}
