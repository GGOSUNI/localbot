import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerReport } from '@localbot/shared';
import { WindowPlayer } from '../apps/server/src/modules/songs/window-player.ts';

/**
 * 실제 크로미움을 띄워 유튜브 창 플레이어를 조종해 봄.
 * youtube.com 대신 같은 구조(#movie_player, video.html5-main-video, ?v=)의 가짜 시청 페이지를 씀.
 */
const CHROME = '/opt/pw-browsers/chromium';
const hasChrome = await Bun.file(CHROME).exists().catch(() => false);
let dir: string;
let server: ReturnType<typeof Bun.serve>;

function wav(seconds: number) {
  const rate = 8000, n = rate * seconds;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return b;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-win-'));
  writeFileSync(join(dir, 'a.wav'), wav(4));
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === '/a.wav') return new Response(Bun.file(join(dir, 'a.wav')), { headers: { 'content-type': 'audio/wav' } });
      if (u.pathname === '/watch') {
        const t = Number((u.searchParams.get('t') ?? '0').replace('s', '')) || 0;
        const bad = u.searchParams.get('v') === 'brokenvideo';
        return new Response(`<!doctype html><title>fake yt</title><div id="movie_player">
          ${bad ? '<div class="ytp-error" style="display:block">동영상을 재생할 수 없음</div>' : ''}
          <video class="html5-main-video" src="/a.wav" autoplay></video></div>
          <script>const v=document.querySelector('video'); v.currentTime=${t};</script>`, { headers: { 'content-type': 'text/html' } });
      }
      return new Response('nf', { status: 404 });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  Bun.spawnSync(['pkill', '-f', 'lb-win-']);
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasChrome)('유튜브 창 플레이어 (실제 크로미움)', () => {
  test('창을 띄워 재생 → 진행 보고 → 끝남 보고, 볼륨 적용', async () => {
    const reports: PlayerReport[] = [];
    const wp = new WindowPlayer({
      dataDir: dir, debugPort: 9333, enabled: () => true, report: (r) => reports.push(r),
      browserPath: CHROME, watchBase: `http://127.0.0.1:${server.port}/watch`, extraArgs: ['--headless=new', '--no-sandbox', '--mute-audio'],
    });
    expect(wp.available()).toBe(true);
    wp.send({ op: 'play', seq: 7, position: 0, volume: 30, paused: false, track: { id: 1, source: 'youtube', ref: 'abcdefghijk', title: 'x' } });
    for (let i = 0; i < 60 && !reports.some((r) => r.type === 'player.ended'); i++) await Bun.sleep(250);
    const hbs = reports.filter((r): r is Extract<PlayerReport, { type: 'player.hb' }> => r.type === 'player.hb' && r.state === 'playing');
    expect(hbs.length).toBeGreaterThan(1);
    expect(hbs.at(-1)!.time).toBeGreaterThan(hbs[0]!.time); // 실제로 진행됨
    expect(hbs.every((h) => h.seq === 7)).toBe(true);
    expect(reports.some((r) => r.type === 'player.ended' && r.seq === 7)).toBe(true);
    expect(wp.status).toBe('playing');
    // 다음 곡 + 중간 위치
    reports.length = 0;
    wp.send({ op: 'play', seq: 8, position: 2, volume: 50, paused: false, track: { id: 2, source: 'youtube', ref: 'second12345', title: 'y' } });
    for (let i = 0; i < 20 && !reports.some((r) => r.type === 'player.hb' && r.seq === 8 && r.state === 'playing'); i++) await Bun.sleep(250);
    const first = reports.find((r) => r.type === 'player.hb' && r.seq === 8 && r.state === 'playing') as any;
    expect(first.time).toBeGreaterThanOrEqual(1.9); // &t=2s 반영
    // 멈춤
    wp.send({ op: 'stop', seq: 9 });
    await Bun.sleep(500);
    expect(wp.status).toBe('idle');
    // 페이지 오류 → 오류 보고
    reports.length = 0;
    wp.send({ op: 'play', seq: 10, position: 0, volume: 50, paused: false, track: { id: 3, source: 'youtube', ref: 'brokenvideo', title: 'z' } });
    for (let i = 0; i < 30 && !reports.some((r) => r.type === 'player.error'); i++) await Bun.sleep(250);
    expect(reports.some((r) => r.type === 'player.error' && r.seq === 10)).toBe(true);
    await wp.shutdown();
  }, 30_000);

  test('브라우저가 없으면 사용 불가로 표시', () => {
    const wp = new WindowPlayer({ dataDir: dir, debugPort: 9334, enabled: () => true, report: () => {}, browserPath: null });
    expect(wp.available()).toBe(false);
    expect(wp.status).toBe('unavailable');
    const off = new WindowPlayer({ dataDir: dir, debugPort: 9335, enabled: () => false, report: () => {}, browserPath: CHROME });
    expect(off.available()).toBe(false);
    expect(off.status).toBe('off');
  });
});
