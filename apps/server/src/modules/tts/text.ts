/** TTS로 읽을 문장 만들기 (순수 함수 — 테스트 쉬움) */
import type { TtsSettings } from '@localbot/shared';

export type { TtsSettings };

/** 예전 기본값 — 저장돼 있으면 새 기본값(메시지만)으로 바꿔 줌 */
export const OLD_DEFAULT_TEMPLATES = ['{user}님 {amount}원 후원. {message}'];

export const DEFAULT_TTS: TtsSettings = {
  enabled: true,
  minAmountKRW: 1000,
  // 후원 메시지만 읽음 (닉네임·금액 안내 없음)
  template: '{message}',
  maxChars: 80,
  voice: '',
  rate: 0,
  volume: 100,
  duck: true,
  bannedWords: [],
  readAnonymous: true,
};

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/** 후원 메시지 정리: 링크·이모지 제거, 반복 글자 줄이기, 금지어 가리기, 길이 제한 */
export function cleanMessage(text: string, s: Pick<TtsSettings, 'maxChars' | 'bannedWords'>): string {
  let t = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\{:[^}]*:\}/g, ' ') // 치지직 이모티콘 코드
    .replace(EMOJI, ' ')
    .replace(/(.)\1{2,}/gu, '$1$1') // ㅋㅋㅋㅋㅋ → ㅋㅋ, !!!!! → !!
    .replace(/\s+/g, ' ')
    .trim();
  for (const w of s.bannedWords) {
    if (!w.trim()) continue;
    t = t.split(w.trim()).join('삐');
  }
  if (t.length > s.maxChars) t = `${t.slice(0, s.maxChars)}`;
  return t;
}

/** 금액 읽기: 1000 → "천", 15000 → "만 오천" 대신 숫자 그대로 쓰면 TTS가 알아서 읽음 */
export function speechFor(input: { nickname: string | null; amountKRW: number; text?: string }, s: TtsSettings): string {
  const raw = input.text?.trim() ?? '';
  // 명령어(!신청곡 …)는 메시지를 읽지 않음
  const message = raw.startsWith('!') ? '' : cleanMessage(raw, s);
  return s.template
    .replace(/\{user\}/g, input.nickname ?? '익명')
    .replace(/\{amount\}/g, String(input.amountKRW))
    .replace(/\{message\}/g, message)
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeTts(p: Partial<TtsSettings>): Partial<TtsSettings> {
  const out: Partial<TtsSettings> = {};
  if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
  if (typeof p.duck === 'boolean') out.duck = p.duck;
  if (typeof p.readAnonymous === 'boolean') out.readAnonymous = p.readAnonymous;
  const num = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
  if (p.minAmountKRW !== undefined && Number.isFinite(Number(p.minAmountKRW))) out.minAmountKRW = num(p.minAmountKRW, 0, 10_000_000);
  if (p.maxChars !== undefined && Number.isFinite(Number(p.maxChars))) out.maxChars = num(p.maxChars, 5, 300);
  if (p.rate !== undefined && Number.isFinite(Number(p.rate))) out.rate = num(p.rate, -10, 10);
  if (p.volume !== undefined && Number.isFinite(Number(p.volume))) out.volume = num(p.volume, 0, 100);
  if (typeof p.template === 'string') out.template = p.template.slice(0, 200) || DEFAULT_TTS.template;
  if (typeof p.voice === 'string') out.voice = p.voice.slice(0, 120);
  if (Array.isArray(p.bannedWords)) out.bannedWords = p.bannedWords.map((w) => String(w).trim()).filter(Boolean).slice(0, 200);
  return out;
}
