import { describe, expect, test } from 'bun:test';
import { chatServerIndex, parseChannelInput, parseFrame } from '../apps/server/src/adapters/chzzk/parse.ts';

// 2026-11 실제 방송 프레임 구조 그대로 (닉네임·ID만 가짜로 바꿈)
const profile = (nick: string, role = 'common_user', extra: object = {}) =>
  JSON.stringify({ userIdHash: `hash-${nick}`, nickname: nick, userRoleCode: role, badge: null, streamingProperty: { nicknameColor: { colorCode: 'CC000' } }, viewerBadges: [], ...extra });

describe('parseChannelInput', () => {
  const id = 'a7e175625fdea5a7d98428302b7aa57f';
  test.each([
    [`https://chzzk.naver.com/live/${id}`],
    [`https://chzzk.naver.com/${id}`],
    [`https://m.chzzk.naver.com/live/${id}?t=1`],
    [`  ${id}  `],
    [`chzzk.naver.com/live/${id.toUpperCase()}/`],
  ])('%s', (input) => expect(parseChannelInput(input)).toBe(id));
  test('잘못된 입력', () => {
    expect(parseChannelInput('https://chzzk.naver.com/')).toBeNull();
    expect(parseChannelInput('탬탬버린')).toBeNull();
    expect(parseChannelInput(`${id}0`)).toBeNull();
  });
});

test('chatServerIndex는 1~9', () => {
  for (const cid of ['N2s_A9', 'abc', 'zzzzzz']) {
    const n = chatServerIndex(cid);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(9);
  }
});

describe('parseFrame', () => {
  test('일반 채팅 (93101)', () => {
    const [e] = parseFrame({
      cmd: 93101,
      bdy: [{ svcid: 'game', cid: 'N2s_A9', uid: 'u1', profile: profile('시청자'), msg: '안녕하세요', msgTypeCode: 1, msgStatusType: 'NORMAL', extras: '{"osType":"PC"}', msgTime: 1795498432151 }],
    });
    expect(e!.ts).toBe(1795498432151);
    expect(e!.event).toMatchObject({ type: 'chat', text: '안녕하세요', viewer: { id: 'hash-시청자', nickname: '시청자', roles: ['viewer'] } });
  });

  test('익명 후원 (93102, profile null)', () => {
    const [e] = parseFrame({
      cmd: 93102,
      bdy: [{ uid: 'anonymous', profile: null, msg: '응원합니다', msgTypeCode: 10, extras: JSON.stringify({ isAnonymous: true, payType: 'CURRENCY', payAmount: 1000, donationId: 'D1', donationType: 'CHAT' }), msgTime: 1 }],
    });
    expect(e!.event).toEqual({ type: 'donation', viewer: null, amountKRW: 1000, text: '응원합니다', kind: 'chat', externalId: 'D1' });
  });

  test('닉네임 후원 + 영상 후원', () => {
    const [e] = parseFrame({
      cmd: 93102,
      bdy: [{ uid: 'u2', profile: profile('치즈왕'), msg: '', msgTypeCode: 10, extras: JSON.stringify({ isAnonymous: false, payAmount: 10000, donationId: 'D2', donationType: 'VIDEO' }), msgTime: 2 }],
    });
    expect(e!.event).toMatchObject({ type: 'donation', amountKRW: 10000, kind: 'video', viewer: { nickname: '치즈왕' } });
    expect((e!.event as any).text).toBeUndefined();
  });

  test('구독 + 역할(매니저, 구독자)', () => {
    const [e] = parseFrame({
      cmd: 93102,
      bdy: [{ uid: 'u3', profile: profile('매니저님', 'streaming_chat_manager', { streamingProperty: { subscription: { accumulativeMonth: 5, tier: 1 } } }), msg: '', msgTypeCode: 11, extras: '{"month":5,"tierName":"티어1"}', msgTime: 3 }],
    });
    expect(e!.event).toMatchObject({ type: 'subscription', months: 5, tier: '티어1', viewer: { roles: ['manager', 'subscriber'] } });
  });

  test('최근 채팅 형식(userId/content/messageTypeCode)도 처리', () => {
    const [e] = parseFrame({ cmd: 93101, bdy: [{ userId: 'u4', profile: profile('옛날채팅'), content: 'hi', messageTypeCode: 1, messageTime: 4 }] });
    expect(e!.event).toMatchObject({ type: 'chat', text: 'hi' });
  });

  test('망가진 메시지가 섞여도 나머지는 살림, 모르는 cmd는 무시', () => {
    const evs = parseFrame({ cmd: 93101, bdy: [{ msgTypeCode: 1, profile: '{broken', msg: 'x' }, null as any, { uid: 'u5', profile: profile('정상'), msg: 'ok', msgTypeCode: 1, msgTime: 5 }] });
    expect(evs.map((e) => (e.event as any).text)).toEqual(['ok']);
    expect(parseFrame({ cmd: 94008, bdy: [] })).toEqual([]);
    expect(parseFrame({ cmd: 93101, bdy: 'nope' })).toEqual([]);
  });
});
