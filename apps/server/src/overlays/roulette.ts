import type { RouletteItem, Spin } from '@localbot/shared';
import { connectOverlay, el, params } from './common.ts';

/**
 * 룰렛 오버레이. 결과는 서버가 이미 정했고, 여기서는 그 칸에 멈추도록 연출만 합니다.
 * ?sound=0 이면 효과음 끔. ?spin=5 회전 시간(초)
 */
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('wheel') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const SPIN_MS = Math.max(2, Math.min(15, Number(params.get('spin') ?? 5))) * 1000;
const SOUND = params.get('sound') !== '0';
const COLORS = ['#ff5470', '#ffb020', '#00d564', '#3fa9f5', '#a78bfa', '#ff7ac6', '#2dd4bf', '#f97316'];

const queue: Spin[] = [];
let busy = false;

const conn = connectOverlay('overlay', (m) => {
  if (m.type !== 'roulette.show') return;
  if (queue.some((s) => s.id === m.spin.id)) return;
  queue.push(m.spin);
  if (!busy) void runNext();
});

async function runNext() {
  const spin = queue.shift();
  if (!spin) return;
  busy = true;
  try {
    await play(spin);
  } finally {
    conn.send({ type: 'roulette.done', spinId: spin.id });
    busy = false;
    if (queue.length) void runNext();
  }
}

interface Seg { label: string; start: number; end: number; color: string }

function segments(items: RouletteItem[]): Seg[] {
  const live = items.filter((i) => i.stock !== 0 && i.weight > 0);
  const total = live.reduce((s, i) => s + i.weight, 0) || 1;
  let a = 0;
  return live.map((i, n) => {
    const s = { label: i.label, start: a, end: a + (i.weight / total) * Math.PI * 2, color: COLORS[n % COLORS.length]! };
    a = s.end;
    return s;
  });
}

function draw(segs: Seg[], rot: number) {
  const W = canvas.width;
  const R = W / 2 - 8;
  ctx.clearRect(0, 0, W, W);
  ctx.save();
  ctx.translate(W / 2, W / 2);
  ctx.rotate(rot);
  for (const s of segs) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, s.start, s.end);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.lineWidth = 3;
    ctx.stroke();
    const span = s.end - s.start;
    if (span < 0.06) continue; // 너무 좁은 칸은 글자 생략
    ctx.save();
    ctx.rotate(s.start + span / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const size = Math.max(16, Math.min(40, span * 120));
    ctx.font = `800 ${size}px "Malgun Gothic", system-ui, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 4;
    const label = s.label.length > 12 ? s.label.slice(0, 11) + '…' : s.label;
    ctx.fillText(label, R - 24, 0);
    ctx.restore();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(W / 2, W / 2, 46, 0, Math.PI * 2);
  ctx.fillStyle = '#0f1115';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 6;
  ctx.stroke();
}

// ── 효과음 (WebAudio, 파일 없음) ──
let audioCtx: AudioContext | null = null;
function beep(freq: number, dur: number, vol = 0.08) {
  if (!SOUND) return;
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch {
    /* 소리 실패는 무시 */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);

async function play(spin: Spin) {
  const segs = segments(spin.items);
  const target = spin.results[0]!;
  const matches = segs.filter((s) => s.label === target);
  const seg = matches[Math.floor(Math.random() * matches.length)] ?? segs[0]!;
  // 핀은 위쪽(-90°). 결과 칸의 안쪽 어딘가가 핀 아래로 오게
  const inside = seg.start + (seg.end - seg.start) * (0.2 + Math.random() * 0.6);
  const finalRot = -Math.PI / 2 - inside + Math.PI * 2 * 6;

  $('head').innerHTML = '';
  $('head').append(document.createTextNode(`${spin.viewerName ?? '익명'}님의 ${spin.rouletteName}`));
  if (spin.results.length > 1) $('head').append(el('small', '', `${spin.results.length}연속`));
  $('result').classList.remove('show');
  $('result').textContent = '';
  $('cards').replaceChildren();
  $('stage').classList.add('show');

  const t0 = performance.now();
  let lastSeg = -1;
  await new Promise<void>((resolve) => {
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / SPIN_MS);
      const rot = finalRot * easeOut(t);
      draw(segs, rot);
      // 칸이 바뀔 때마다 틱 소리
      const at = (((-Math.PI / 2 - rot) % (Math.PI * 2)) + Math.PI * 4) % (Math.PI * 2);
      const idx = segs.findIndex((s) => at >= s.start && at < s.end);
      if (idx !== lastSeg) {
        lastSeg = idx;
        beep(900, 0.03, 0.04);
      }
      t < 1 ? requestAnimationFrame(frame) : resolve();
    };
    requestAnimationFrame(frame);
  });

  beep(660, 0.12);
  setTimeout(() => beep(990, 0.25), 120);
  $('result').textContent = spin.results.length > 1 ? summarize(spin.results) : target;
  $('result').classList.add('show');

  if (spin.results.length > 1) {
    const cards = spin.results.slice(0, 30).map((r) => $('cards').appendChild(el('div', 'card', r)));
    for (const c of cards) {
      await sleep(Math.max(40, 600 / cards.length));
      c.classList.add('show');
    }
    await sleep(3500);
  } else {
    await sleep(3000);
  }
  $('stage').classList.remove('show');
  await sleep(500);
}

function summarize(results: string[]): string {
  const m = new Map<string, number>();
  for (const r of results) m.set(r, (m.get(r) ?? 0) + 1);
  return [...m].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(' · ');
}
