import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerReport } from '@localbot/shared';
import { jpegSize, WindowPlayer } from '../apps/server/src/modules/songs/window-player.ts';

/**
 * 실제 크로미움을 띄워 유튜브 창 플레이어를 조종해 봄.
 * youtube.com 대신 같은 구조(#movie_player, video.html5-main-video, ?v=)의 가짜 시청 페이지를 씀.
 */
const CHROME = '/opt/pw-browsers/chromium';
const hasChrome = await Bun.file(CHROME).exists().catch(() => false);
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let pageState: Record<string, string> | null = null;


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
  writeFileSync(join(dir, 'ad.wav'), wav(30)); // 30초짜리 못 건너뛰는 광고
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === '/a.wav' || u.pathname === '/ad.wav') return new Response(Bun.file(join(dir, u.pathname.slice(1))), { headers: { 'content-type': 'audio/wav' } });
      if (u.pathname === '/state') {
        pageState = Object.fromEntries(u.searchParams);
        return new Response('ok');
      }
      if (u.pathname === '/watch' && u.searchParams.get('v') === 'adtest12345') {
        // 유튜브처럼: 광고 중엔 #movie_player에 ad-showing, 광고가 끝나면 같은 video로 본편 재생
        return new Response(`<!doctype html><title>fake yt</title>
          <div id="movie_player" class="html5-video-player ad-showing">
            <div class="html5-video-container"><video class="html5-main-video" src="/ad.wav" autoplay></video></div>
            <div class="ytp-chrome-bottom" style="width:300px;height:40px;background:red">controls</div>
            <button class="ytp-ad-skip-button-modern" onclick="window.__skip=(window.__skip||0)+1">광고 건너뛰기</button>
          </div>
          <script>
            const v = document.querySelector('video'), p = document.getElementById('movie_player');
            let adMuted = false, adSound = false;
            setInterval(() => { if (p.classList.contains('ad-showing') && !v.paused) { if (v.muted) adMuted = true; else if (v.currentTime > 0.5) adSound = true; } }, 20);
            v.addEventListener('ended', () => {
              if (!p.classList.contains('ad-showing')) return;
              p.classList.remove('ad-showing'); v.src = '/a.wav'; v.play();
              setTimeout(() => fetch('/state?adMuted=' + adMuted + '&adSound=' + adSound + '&skip=' + (window.__skip || 0) + '&muted=' + v.muted + '&rate=' + v.playbackRate + '&ctrl=' + getComputedStyle(document.querySelector('.ytp-chrome-bottom')).opacity), 600);
            });
          </script>`, { headers: { 'content-type': 'text/html' } });
      }
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

  test('광고: 소리 끄고 끝으로 감아서 바로 본편 → 본편은 소리 켜고 정상 속도, 대시보드 화면은 16:9', async () => {
    const reports: PlayerReport[] = [];
    const frames: string[] = [];
    const wp = new WindowPlayer({
      dataDir: join(dir, 'ad'), debugPort: 9336, enabled: () => true, report: (r) => reports.push(r), onFrame: (j) => frames.push(j),
      browserPath: CHROME, watchBase: `http://127.0.0.1:${server.port}/watch`, extraArgs: ['--headless=new', '--no-sandbox', '--mute-audio'],
    });
    const started = Date.now();
    wp.send({ op: 'play', seq: 1, position: 0, volume: 50, paused: false, track: { id: 9, source: 'youtube', ref: 'adtest12345', title: 'ad' } });
    for (let i = 0; i < 60 && !pageState; i++) await Bun.sleep(200);
    expect(pageState).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000); // 30초 광고를 기다리지 않음
    expect(pageState!.adMuted).toBe('true'); // 광고 소리 꺼짐
    expect(pageState!.adSound).toBe('false'); // 광고 소리가 난 적 없음
    expect(Number(pageState!.skip)).toBeGreaterThan(0); // 건너뛰기 버튼도 누름
    expect(pageState!.muted).toBe('false'); // 본편은 소리 켬
    expect(pageState!.rate).toBe('1'); // 본편은 정상 속도
    expect(pageState!.ctrl).toBe('0'); // 컨트롤 바는 화면에 안 보임
    for (let i = 0; i < 20 && !reports.some((r) => r.type === 'player.hb' && r.state === 'playing'); i++) await Bun.sleep(250);
    expect(reports.some((r) => r.type === 'player.hb' && r.state === 'playing')).toBe(true);
    for (let i = 0; i < 20 && !frames.length; i++) await Bun.sleep(250);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(jpegSize(f)).toEqual({ w: 640, h: 360 }); // 찌그러진 프레임은 대시보드로 안 보냄
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
