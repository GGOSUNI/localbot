import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OverlayMessage, Roulette, Viewer } from '@localbot/shared';
import { openDatabase } from '../apps/server/src/core/db.ts';
import {
  draw, formatItems, fromShareCode, matchRoulette, parseItems, probabilities, secureRandom, spinsForDonation, toShareCode,
} from '../apps/server/src/modules/roulette/logic.ts';
import { RouletteService, summarize } from '../apps/server/src/modules/roulette/service.ts';

const viewer = (nick: string): Viewer => ({ platform: 'chzzk', id: `id-${nick}`, nickname: nick, roles: ['viewer'] });

describe('항목 문법', () => {
  test('가중치·재고·빈 줄', () => {
    const items = parseItems('노래 한 곡\n\n스쿼트 10개 x2\n꽝 X5\n치킨 기프티콘 x1 [재고 1]\n잘못된 x0\n소원 ×3');
    expect(items).toEqual([
      { label: '노래 한 곡', weight: 1, stock: null },
      { label: '스쿼트 10개', weight: 2, stock: null },
      { label: '꽝', weight: 5, stock: null },
      { label: '치킨 기프티콘', weight: 1, stock: 1 },
      { label: '소원', weight: 3, stock: null },
    ]);
    expect(parseItems(formatItems(items))).toEqual(items); // 왕복
  });
  test('"10개" 같은 숫자가 라벨에 있어도 가중치로 오해하지 않음', () => {
    expect(parseItems('팔굽혀펴기 20개')[0]).toEqual({ label: '팔굽혀펴기 20개', weight: 1, stock: null });
  });
  test('확률', () => {
    expect(probabilities(parseItems('a x1\nb x3'))).toEqual([25, 75]);
    expect(probabilities(parseItems('a [재고 0]\nb'))).toEqual([0, 100]);
  });
});

describe('뽑기', () => {
  test('가중치 대로 (결정적 난수)', () => {
    const items = parseItems('a x1\nb x3');
    expect(draw(items, 1, () => 0.2).results).toEqual(['a']); // 0.2*4=0.8 < 1
    expect(draw(items, 1, () => 0.3).results).toEqual(['b']);
    expect(draw(items, 1, () => 0.9999).results).toEqual(['b']);
  });
  test('재고: 한정 항목은 소진되면 안 나옴, 원본은 그대로', () => {
    const items = parseItems('치킨 [재고 1]\n꽝 x0.0001');
    const r = draw(items, 3, () => 0);
    expect(r.results).toEqual(['치킨', '꽝', '꽝']);
    expect(r.items[0]!.stock).toBe(0);
    expect(items[0]!.stock).toBe(1);
  });
  test('모든 재고 소진 시 빈 결과', () => {
    expect(draw(parseItems('a [재고 0]\nb [재고 0]'), 2).results).toEqual([]);
  });
  test('secureRandom 분포가 대략 균등 (조작 의혹 대비 실측)', () => {
    const items = parseItems('a\nb\nc\nd');
    const n = 40_000;
    const counts: Record<string, number> = {};
    for (const r of draw(items, n, secureRandom).results) counts[r] = (counts[r] ?? 0) + 1;
    for (const k of ['a', 'b', 'c', 'd']) expect(Math.abs(counts[k]! / n - 0.25)).toBeLessThan(0.015);
  });
});

describe('후원 → 횟수', () => {
  const per = (price: number, max = 10, carry = false) => ({ type: 'per-amount' as const, price, maxPerDonation: max, carry });
  test('금액당', () => {
    expect(spinsForDonation(per(1000), 3500)).toEqual({ spins: 3, carry: 0 });
    expect(spinsForDonation(per(1000), 999)).toEqual({ spins: 0, carry: 0 });
  });
  test('최대 횟수 상한', () => {
    expect(spinsForDonation(per(1000, 5), 50_000).spins).toBe(5);
  });
  test('잔액 이월: 500 + 500 = 1회, 2500 → 2회 + 500 이월', () => {
    expect(spinsForDonation(per(1000, 10, true), 500, 0)).toEqual({ spins: 0, carry: 500 });
    expect(spinsForDonation(per(1000, 10, true), 500, 500)).toEqual({ spins: 1, carry: 0 });
    expect(spinsForDonation(per(1000, 10, true), 2500, 0)).toEqual({ spins: 2, carry: 500 });
  });
  test('정확 금액', () => {
    expect(spinsForDonation({ type: 'exact', amount: 3333 }, 3333).spins).toBe(1);
    expect(spinsForDonation({ type: 'exact', amount: 3333 }, 3334).spins).toBe(0);
  });
});

describe('어떤 룰렛이 돌까', () => {
  const R = (id: number, trigger: Roulette['trigger'], enabled = true): Roulette => ({
    id, name: `r${id}`, items: parseItems('a\nb'), trigger, enabled, chatTemplate: '', trackPenalties: true, sortOrder: id,
  });
  const list = [
    R(1, { type: 'per-amount', price: 1000, maxPerDonation: 10, carry: false }),
    R(2, { type: 'per-amount', price: 10_000, maxPerDonation: 10, carry: false }),
    R(3, { type: 'exact', amount: 3333 }),
    R(4, { type: 'exact', amount: 5000 }, false),
  ];
  test('정확 금액 우선', () => expect(matchRoulette(list, 3333)?.id).toBe(3));
  test('돌릴 수 있는 가장 비싼 금액당 룰렛', () => {
    expect(matchRoulette(list, 15_000)?.id).toBe(2);
    expect(matchRoulette(list, 9000)?.id).toBe(1);
  });
  test('꺼진 룰렛 무시, 해당 없음', () => {
    expect(matchRoulette(list, 5000)?.id).toBe(1);
    expect(matchRoulette(list, 500)).toBeNull();
  });
});

test('공유 코드 왕복, 잘못된 코드', () => {
  const r = { name: '벌칙', items: parseItems('a x2\nb [재고 3]'), trigger: { type: 'exact' as const, amount: 777 }, chatTemplate: 'x {result}', trackPenalties: false };
  expect(fromShareCode(toShareCode(r))).toEqual(r);
  expect(fromShareCode('LB1-garbage!!')).toBeNull();
  expect(fromShareCode('hello')).toBeNull();
});

test('결과 요약', () => {
  expect(summarize(['꽝', '스쿼트', '꽝'])).toBe('꽝 x2, 스쿼트');
  expect(summarize(['a'])).toBe('a');
});

// ───────────── 서비스 ─────────────
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(rand = () => 0) {
  const dir = mkdtempSync(join(tmpdir(), 'lb-rl-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
  const replies: string[] = [];
  const svc = new RouletteService({ db, rand, reply: (t) => replies.push(t), onChange: () => {} });
  return { db, svc, replies };
}

describe('RouletteService', () => {
  test('오버레이가 없으면 바로 결과 발표 + 벌칙 체크리스트(꽝 제외)', () => {
    const { svc, replies } = setup(() => 0);
    svc.save(null, { name: '벌칙', itemsText: '스쿼트\n꽝', trigger: { type: 'per-amount', price: 1000, maxPerDonation: 10 } });
    const spin = svc.onDonation(viewer('치즈'), 2000)!;
    expect(spin.results).toEqual(['스쿼트', '스쿼트']);
    expect(replies.at(-1)).toBe('🎰 치즈님 [벌칙] 결과: 스쿼트 x2');
    const st = svc.state();
    expect(st.recentSpins[0]!.status).toBe('done');
    expect(st.penalties.map((p) => p.label)).toEqual(['스쿼트', '스쿼트']);
  });

  test('오버레이 연출: 하나씩 보여주고, 끝났다는 신호 후에 발표·다음', () => {
    const { svc, replies } = setup(() => 0.99);
    svc.save(null, { name: 'R', itemsText: '스쿼트\n꽝', trigger: { type: 'per-amount', price: 1000, maxPerDonation: 10 } });
    const shown: OverlayMessage[] = [];
    svc.addOverlay('o1', (m) => shown.push(m));
    const a = svc.onDonation(viewer('a'), 1000)!;
    const b = svc.onDonation(viewer('b'), 1000)!;
    expect(shown.map((m) => m.type === 'roulette.show' && m.spin.id)).toEqual([a.id]); // b는 대기
    expect(replies).toHaveLength(0); // 연출 끝나기 전엔 스포일러 없음
    svc.overlayDone(a.id);
    expect(replies).toEqual(['🎰 a님 [R] 결과: 꽝']);
    expect(shown.map((m) => m.type === 'roulette.show' && m.spin.id)).toEqual([a.id, b.id]);
    expect(svc.state().penalties).toHaveLength(0); // 꽝은 체크리스트 제외
  });

  test('OBS 새로고침 중이던 연출은 다시 보내고, 재시작 시 보여주다 만 건 다시 큐로', () => {
    const { db, svc } = setup();
    svc.save(null, { name: 'R', itemsText: 'a\nb', trigger: { type: 'manual' } });
    const r = svc.list()[0]!;
    const got1: OverlayMessage[] = [];
    svc.addOverlay('o1', (m) => got1.push(m));
    const s = svc.manualSpin(r.id)!;
    svc.removeOverlay('o1');
    const got2: OverlayMessage[] = [];
    svc.addOverlay('o2', (m) => got2.push(m));
    expect(got2.some((m) => m.type === 'roulette.show' && m.spin.id === s.id)).toBe(true);

    const svc2 = new RouletteService({ db, reply: () => {}, onChange: () => {} });
    expect(svc2.state().recentSpins[0]!.status).toBe('queued');
  });

  test('재고 항목은 당첨되면 줄고 DB에 반영', () => {
    const { svc } = setup(() => 0);
    svc.save(null, { name: 'R', itemsText: '치킨 [재고 1]\n꽝', trigger: { type: 'per-amount', price: 1000, maxPerDonation: 10 } });
    svc.onDonation(viewer('a'), 1000);
    expect(svc.list()[0]!.items[0]!.stock).toBe(0);
    expect(svc.onDonation(viewer('b'), 1000)!.results).toEqual(['꽝']);
  });

  test('시청자별 잔액 이월 (익명은 이월 안 함)', () => {
    const { svc } = setup();
    svc.save(null, { name: 'R', itemsText: 'a\nb', trigger: { type: 'per-amount', price: 1000, maxPerDonation: 10, carry: true } });
    expect(svc.onDonation(viewer('a'), 600)).toBeNull();
    expect(svc.onDonation(viewer('b'), 600)).toBeNull();
    expect(svc.onDonation(viewer('a'), 400)!.results).toHaveLength(1);
    expect(svc.onDonation(null, 600)).toBeNull();
    expect(svc.onDonation(null, 600)).toBeNull();
  });

  test('항목이 2개 미만이면 저장 거부, 통계', () => {
    const { svc } = setup(() => 0);
    expect(svc.save(null, { itemsText: '하나' }).ok).toBe(false);
    const r = svc.save(null, { name: 'R', itemsText: 'a\nb', trigger: { type: 'manual' } });
    if (!r.ok) throw new Error();
    svc.manualSpin(r.roulette.id, 3);
    expect(svc.stats(r.roulette.id)).toEqual([{ label: 'a', count: 3 }]);
  });
});
