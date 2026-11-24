import type { Roulette, RouletteItem, RouletteTrigger } from '@localbot/shared';

/**
 * 룰렛의 순수 로직 (DB·네트워크 없음 → 테스트 쉬움). DESIGN.md §4
 */

/**
 * 한 줄에 항목 하나.
 *   노래 한 곡
 *   스쿼트 10개 x2        ← 가중치 2
 *   치킨 기프티콘 x1 [재고 1]  ← 1번 나오면 끝
 */
export function parseItems(text: string): RouletteItem[] {
  const items: RouletteItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let stock: number | null = null;
    const s = line.match(/\s*\[\s*재고\s*(\d+)\s*\]\s*$/);
    if (s) {
      stock = Number(s[1]);
      line = line.slice(0, s.index).trim();
    }
    let weight = 1;
    const w = line.match(/\s+[xX×*]\s*(\d+(?:\.\d+)?)$/);
    if (w) {
      weight = Number(w[1]);
      line = line.slice(0, w.index).trim();
    }
    if (!line || !(weight > 0)) continue;
    items.push({ label: line.slice(0, 60), weight: Math.min(weight, 10_000), stock });
  }
  return items;
}

export function formatItems(items: RouletteItem[]): string {
  return items
    .map((i) => `${i.label}${i.weight !== 1 ? ` x${i.weight}` : ''}${i.stock !== null ? ` [재고 ${i.stock}]` : ''}`)
    .join('\n');
}

/** 각 항목의 확률(%) — 재고가 0인 항목은 0 */
export function probabilities(items: RouletteItem[]): number[] {
  const total = items.reduce((s, i) => s + (i.stock === 0 ? 0 : i.weight), 0);
  return items.map((i) => (total && i.stock !== 0 ? (i.weight / total) * 100 : 0));
}

/** 암호학적 난수 [0, 1) — 조작 의혹에 대비해 Math.random 대신 사용 */
export function secureRandom(): number {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  // 53비트 정밀도
  return (a[0]! * 2 ** 21 + (a[1]! >>> 11)) / 2 ** 53;
}

/**
 * n번 뽑기. 재고가 있는 항목은 뽑힐 때마다 줄어듦.
 * @returns 결과 라벨들과 갱신된 항목 (재고 반영)
 */
export function draw(items: RouletteItem[], n: number, rand: () => number = secureRandom) {
  const pool = items.map((i) => ({ ...i }));
  const results: string[] = [];
  for (let k = 0; k < n; k++) {
    const live = pool.filter((i) => i.stock !== 0 && i.weight > 0);
    if (!live.length) break;
    const total = live.reduce((s, i) => s + i.weight, 0);
    let r = rand() * total;
    let picked = live[live.length - 1]!;
    for (const i of live) {
      if (r < i.weight) {
        picked = i;
        break;
      }
      r -= i.weight;
    }
    results.push(picked.label);
    if (picked.stock !== null) picked.stock--;
  }
  return { results, items: pool };
}

/**
 * 후원 금액 → 몇 번 돌릴지.
 * @param carryKRW 이전에 남은 금액 (잔액 이월 옵션)
 */
export function spinsForDonation(trigger: RouletteTrigger, amountKRW: number, carryKRW = 0): { spins: number; carry: number } {
  if (trigger.type === 'exact') return { spins: amountKRW === trigger.amount ? 1 : 0, carry: carryKRW };
  if (trigger.type !== 'per-amount' || trigger.price <= 0) return { spins: 0, carry: carryKRW };
  const total = amountKRW + (trigger.carry ? carryKRW : 0);
  const raw = Math.floor(total / trigger.price);
  const spins = Math.min(raw, Math.max(1, trigger.maxPerDonation));
  // 상한에 걸려 못 돈 금액은 이월하지 않음 (상한의 의미를 지키기 위해)
  const carry = trigger.carry ? (raw > spins ? 0 : total - spins * trigger.price) : 0;
  return { spins, carry };
}

/**
 * 후원 하나에 어떤 룰렛이 반응할지.
 *  1) 정확 금액 일치
 *  2) 금액당 룰렛 중 단가가 후원액 이하인 것 가운데 가장 비싼 것 (1천원 룰렛 + 1만원 룰렛 → 1만원 후원은 1만원 룰렛)
 *  3) 단가에 못 미쳐도 잔액 이월이 켜진 룰렛 (목록 순서)
 */
export function matchRoulette(roulettes: Roulette[], amountKRW: number): Roulette | null {
  const on = roulettes.filter((r) => r.enabled && r.items.length);
  const exact = on.find((r) => r.trigger.type === 'exact' && r.trigger.amount === amountKRW);
  if (exact) return exact;
  const per = on.filter((r): r is Roulette & { trigger: Extract<RouletteTrigger, { type: 'per-amount' }> } =>
    r.trigger.type === 'per-amount' && r.trigger.price > 0);
  const affordable = per.filter((r) => amountKRW >= r.trigger.price).sort((a, b) => b.trigger.price - a.trigger.price);
  return affordable[0] ?? per.find((r) => r.trigger.carry) ?? null;
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

// ── 공유 코드: 룰렛 설정을 문자열 하나로 ──
type ShareShape = Pick<Roulette, 'name' | 'items' | 'trigger' | 'chatTemplate' | 'trackPenalties'>;

export function toShareCode(r: ShareShape): string {
  const json = JSON.stringify({ v: 1, n: r.name, i: r.items, t: r.trigger, c: r.chatTemplate, p: r.trackPenalties });
  return 'LB1-' + Buffer.from(json, 'utf8').toString('base64url');
}

export function fromShareCode(code: string): ShareShape | null {
  try {
    const m = code.trim().match(/^LB1-([A-Za-z0-9_-]+)$/);
    if (!m) return null;
    const o = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8'));
    if (o.v !== 1 || !Array.isArray(o.i)) return null;
    const items = parseItems(formatItems(o.i.map((x: any) => ({ label: String(x.label), weight: Number(x.weight) || 1, stock: x.stock ?? null }))));
    return {
      name: String(o.n ?? '가져온 룰렛').slice(0, 40),
      items,
      trigger: sanitizeTrigger(o.t),
      chatTemplate: String(o.c ?? DEFAULT_TEMPLATE).slice(0, 200),
      trackPenalties: o.p !== false,
    };
  } catch {
    return null;
  }
}

export const DEFAULT_TEMPLATE = '🎰 {user}님 [{roulette}] 결과: {result}';

export function sanitizeTrigger(t: any): RouletteTrigger {
  if (t?.type === 'exact') return { type: 'exact', amount: Math.max(1, Math.floor(Number(t.amount) || 1000)) };
  if (t?.type === 'manual') return { type: 'manual' };
  return {
    type: 'per-amount',
    price: Math.max(1, Math.floor(Number(t?.price) || 1000)),
    maxPerDonation: Math.max(1, Math.min(100, Math.floor(Number(t?.maxPerDonation) || 10))),
    carry: t?.carry === true,
  };
}

export const TEMPLATES: { name: string; items: string; trigger: RouletteTrigger }[] = [
  {
    name: '벌칙 룰렛',
    items: '스쿼트 10개 x3\n애교 한 번 x2\n노래 한 소절 x2\n성대모사 x2\n꽝 x5',
    trigger: { type: 'per-amount', price: 1000, maxPerDonation: 10, carry: false },
  },
  {
    name: '꽝 많은 룰렛',
    items: '꽝 x20\n한 번 더! x3\n소원 들어주기 x1',
    trigger: { type: 'per-amount', price: 1000, maxPerDonation: 10, carry: true },
  },
  {
    name: '대박 룰렛 (1%)',
    items: '대박! 방장 소원권 x1 [재고 1]\n꽝 x99',
    trigger: { type: 'exact', amount: 7777 },
  },
];
