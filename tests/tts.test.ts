import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OverlayMessage, Viewer } from '@localbot/shared';
import { openDatabase, setSetting } from '../apps/server/src/core/db.ts';
import { TtsService } from '../apps/server/src/modules/tts/service.ts';
import type { Speaker } from '../apps/server/src/modules/tts/speaker.ts';
import { cleanMessage, DEFAULT_TTS, sanitizeTts, speechFor } from '../apps/server/src/modules/tts/text.ts';

const viewer = (nick: string, roles: Viewer['roles'] = ['viewer']): Viewer => ({ platform: 'chzzk', id: `id-${nick}`, nickname: nick, roles });

describe('읽을 문장 만들기', () => {
  test('링크·이모지·치지직 이모티콘 제거, 반복 줄이기', () => {
    expect(cleanMessage('안녕ㅋㅋㅋㅋㅋㅋ https://youtu.be/abc 😀😀 {:d_51:} 굿!!!!!', DEFAULT_TTS)).toBe('안녕ㅋㅋ 굿!!');
  });
  test('금지어는 삐, 길이 제한', () => {
    expect(cleanMessage('바보야 바보', { maxChars: 80, bannedWords: ['바보'] })).toBe('삐야 삐');
    expect(cleanMessage('가나다라마바사', { maxChars: 5, bannedWords: [] })).toBe('가나다라마');
  });
  test('기본: 메시지만 읽음 · 명령어 메시지는 안 읽음 · 템플릿으로 닉네임/금액 추가 가능', () => {
    expect(speechFor({ nickname: '꼬순이', amountKRW: 5000, text: '방송 재밌어요' }, DEFAULT_TTS)).toBe('방송 재밌어요');
    expect(speechFor({ nickname: null, amountKRW: 1000, text: '' }, DEFAULT_TTS)).toBe('');
    expect(speechFor({ nickname: 'a', amountKRW: 1000, text: '!신청곡 아이유 밤편지' }, DEFAULT_TTS)).toBe('');
    const t = { ...DEFAULT_TTS, template: '{user}님 {amount}원. {message}' };
    expect(speechFor({ nickname: '꼬순이', amountKRW: 5000, text: '안녕' }, t)).toBe('꼬순이님 5000원. 안녕');
    expect(speechFor({ nickname: null, amountKRW: 1000, text: '' }, t)).toBe('익명님 1000원.');
    expect(speechFor({ nickname: '시청자', amountKRW: 0, text: '안녕' }, { ...DEFAULT_TTS, template: '{user}님 {amount}원 {message}' })).toBe('시청자님 안녕'); // 채팅엔 금액 없음
  });
  test('설정값 정리', () => {
    expect(sanitizeTts({ rate: 99, volume: -5, maxChars: 1, minAmountKRW: 'x' as unknown as number, template: '' })).toEqual({
      rate: 10, volume: 0, maxChars: 5, template: DEFAULT_TTS.template,
    });
    expect(sanitizeTts({ bannedWords: [' a ', '', 'b'] }).bannedWords).toEqual(['a', 'b']);
  });
});

/** 가짜 스피커: 말한 문장을 기록하고, finish()를 부를 때까지 "말하는 중" */
class FakeSpeaker implements Speaker {
  available = true;
  spoken: string[] = [];
  cancelled = 0;
  private finishers: (() => void)[] = [];
  speak(text: string) {
    this.spoken.push(text);
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    this.finishers.push(finish);
    return { done, cancel: () => { this.cancelled++; finish(); } };
  }
  finish() { this.finishers.shift()?.(); }
  async voices() { return ['Microsoft Heami Desktop|ko-KR']; }
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await Bun.sleep(10);
  }
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lb-tts-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'db.sqlite'), join(dir, 'backups'));
  const speaker = new FakeSpeaker();
  const ducks: boolean[] = [];
  const tts = new TtsService(db, speaker, { duck: (on) => ducks.push(on), onChange: () => {} });
  return { db, speaker, ducks, tts };
}

describe('후원 TTS 대기열', () => {
  test('순서대로 하나씩, 읽는 동안만 노래 줄이기, 알림 카드 표시·숨김', async () => {
    const { speaker, ducks, tts } = setup();
    const overlay: OverlayMessage[] = [];
    tts.addOverlay('o1', (m) => overlay.push(m));
    tts.onDonation(viewer('가'), 1000, '첫번째');
    tts.onDonation(viewer('나'), 2000, '두번째');
    await until(() => speaker.spoken.length === 1);
    expect(speaker.spoken[0]).toBe('첫번째');
    expect(tts.state().queue.length).toBe(1);
    expect(ducks).toEqual([true]);
    expect(overlay[0]).toMatchObject({ type: 'alert.show', alert: { nickname: '가', amountKRW: 1000 } });
    speaker.finish();
    await until(() => speaker.spoken.length === 2);
    expect(ducks).toEqual([true]); // 연달아 읽는 동안 노래는 계속 줄인 채로
    expect(overlay.map((m) => m.type)).toEqual(['alert.show', 'alert.hide', 'alert.show']);
    speaker.finish();
    await until(() => tts.state().speaking === null && ducks.length === 2);
    expect(ducks).toEqual([true, false]);
  });

  test('최소 금액 · 익명 · 끄기', async () => {
    const { speaker, tts } = setup();
    tts.setSettings({ minAmountKRW: 3000, readAnonymous: false });
    tts.onDonation(viewer('a'), 2000, '적음');
    tts.onDonation(null, 5000, '익명');
    expect(tts.state().queue.length + (tts.state().speaking ? 1 : 0)).toBe(0);
    tts.setSettings({ enabled: false });
    tts.onDonation(viewer('a'), 9000, '꺼짐');
    expect(tts.state().speaking).toBeNull();
    tts.setSettings({ enabled: true });
    tts.onDonation(viewer('a'), 3000, '딱 맞음');
    await until(() => speaker.spoken.length === 1);
    expect(speaker.spoken[0]).toContain('딱 맞음');
  });

  test('건너뛰기 (말하기 전이든 중이든) · 모두 취소', async () => {
    const { speaker, ducks, tts } = setup();
    tts.onDonation(viewer('a'), 1000, '1');
    tts.skip(); // 노래 줄이는 중(말하기 전)에 건너뛰기 → 안 읽고 넘어감
    tts.onDonation(viewer('b'), 1000, '2');
    await until(() => speaker.spoken.length === 1);
    expect(speaker.spoken[0]).toBe('2');
    tts.skip(); // 읽는 중 건너뛰기
    expect(speaker.cancelled).toBe(1);
    tts.onDonation(viewer('c'), 1000, '3');
    tts.onDonation(viewer('d'), 1000, '4');
    await until(() => speaker.spoken.length === 2);
    tts.clear();
    await until(() => tts.state().speaking === null);
    await Bun.sleep(500);
    expect(speaker.spoken.length).toBe(2); // d는 안 읽힘
    expect(ducks.filter((d) => d).length).toBe(ducks.filter((d) => !d).length); // 소리 줄인 만큼 되돌림
  });

  test('메시지 없는 후원은 안 읽고 노래도 안 줄임 (카드만)', async () => {
    const { speaker, ducks, tts } = setup();
    const overlay: OverlayMessage[] = [];
    tts.addOverlay('o', (m) => overlay.push(m));
    tts.onDonation(viewer('a'), 1000, '');
    tts.onDonation(viewer('b'), 1000, '읽어줘');
    await until(() => speaker.spoken.length === 1, 6000);
    expect(speaker.spoken).toEqual(['읽어줘']);
    expect(ducks).toEqual([true]);
    expect(overlay[0]).toMatchObject({ type: 'alert.show', alert: { nickname: 'a' } });
  });

  test('예전 기본 문장(닉네임님 금액원 후원)이 저장돼 있으면 메시지만 읽기로 바뀜', () => {
    const { db } = setup();
    setSetting(db, 'tts.settings', { ...DEFAULT_TTS, template: '{user}님 {amount}원 후원. {message}', minAmountKRW: 3000 });
    const t = new TtsService(db, new FakeSpeaker(), { duck: () => {}, onChange: () => {} });
    expect(t.settings().template).toBe('{message}');
    expect(t.settings().minAmountKRW).toBe(3000);
  });

  test('일반 채팅 읽기: 메시지만, 명령어·스트리머 본인(봇 답장)·무시 닉네임은 안 읽음, 알림 카드 없음', async () => {
    const { speaker, tts } = setup();
    const overlay: OverlayMessage[] = [];
    tts.addOverlay('o', (m) => overlay.push(m));
    tts.onChat(viewer('시청자1'), '!신청곡 아이유');
    tts.onChat(viewer('꼬순이', ['streamer']), '🎵 지금 재생 중: 밤편지');
    tts.setSettings({ ignoreNames: ['뚜봇'] });
    tts.onChat(viewer('뚜봇'), '출석체크 완료');
    tts.onChat(viewer('시청자2'), '안녕하세요ㅋㅋㅋㅋ {:d_51:}');
    await until(() => speaker.spoken.length === 1);
    expect(speaker.spoken).toEqual(['안녕하세요ㅋㅋ']);
    expect(tts.state().speaking).toMatchObject({ kind: 'chat', nickname: '시청자2' });
    expect(overlay).toHaveLength(0);
  });

  test('채팅 대상: 구독자만 / 매니저만, 끄기', async () => {
    const { speaker, tts } = setup();
    tts.setSettings({ chatWho: 'subscriber' });
    tts.onChat(viewer('일반'), '1');
    tts.onChat(viewer('구독', ['subscriber']), '2');
    await until(() => speaker.spoken.length === 1);
    speaker.finish();
    tts.setSettings({ chatWho: 'manager' });
    tts.onChat(viewer('구독', ['subscriber']), '3');
    tts.onChat(viewer('매니저', ['manager']), '4');
    await until(() => speaker.spoken.length === 2);
    speaker.finish();
    tts.setSettings({ readChat: false });
    tts.onChat(viewer('매니저', ['manager']), '5');
    await Bun.sleep(700);
    expect(speaker.spoken).toEqual(['2', '4']);
  });

  test('채팅이 밀리면 오래된 채팅부터 버림 (후원은 안 버림)', async () => {
    const { speaker, tts } = setup();
    tts.setSettings({ maxQueue: 2 });
    tts.onChat(viewer('a'), '첫채팅'); // 바로 읽기 시작
    await until(() => speaker.spoken.length === 1);
    tts.onChat(viewer('a'), 'c1');
    tts.onDonation(viewer('b'), 1000, '후원');
    tts.onChat(viewer('a'), 'c2');
    tts.onChat(viewer('a'), 'c3');
    expect(tts.state().queue.map((q) => q.message)).toEqual(['후원', 'c2', 'c3']);
  });

  test('설정은 DB에 저장', () => {
    const { db, tts } = setup();
    tts.setSettings({ template: '{user} {amount}', bannedWords: ['x'] });
    const again = new TtsService(db, new FakeSpeaker(), { duck: () => {}, onChange: () => {} });
    expect(again.settings().template).toBe('{user} {amount}');
    expect(again.settings().bannedWords).toEqual(['x']);
  });
});
