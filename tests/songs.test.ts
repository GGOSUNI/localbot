import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OverlayMessage, PlayerCommand, Viewer } from '@localbot/shared';
import { openDatabase } from '../apps/server/src/core/db.ts';
import { WATCHDOG } from '../apps/server/src/modules/songs/engine.ts';
import { SongService } from '../apps/server/src/modules/songs/service.ts';
import { findYouTubeId, parseRequestArg } from '../apps/server/src/modules/songs/youtube.ts';
import type { OEmbedResult } from '../apps/server/src/modules/songs/youtube.ts';

/**
 * 신청곡 "절대 고장 안 나는" 검증 (DESIGN.md §3.4).
 * 가짜 시계 + 가짜 플레이어로 장애 상황을 강제로 만들어 봅니다.
 */

const V = (n: number) => `vid${String(n).padStart(8, '0')}`; // 11자 영상 ID
const viewer = (nick: string, roles: Viewer['roles'] = ['viewer']): Viewer => ({ platform: 'chzzk', id: `id-${nick}`, nickname: nick, roles });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { oembed?: Record<string, OEmbedResult>; dir?: string; db?: Database } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'lb-songs-'));
  if (!opts.dir) dirs.push(dir);
  const db = opts.db ?? openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
  const clock = { t: 1_800_000_000_000 };
  const replies: string[] = [];
  const notes: string[] = [];
  const svc = new SongService({
    db,
    now: () => clock.t,
    random: () => 0.5,
    oembed: async (id) => opts.oembed?.[id] ?? { ok: true, title: `곡 ${id}`, author: null },
    search: async () => [],
    mix: async () => [],
    notify: (_l, m) => notes.push(m),
    reply: (m) => replies.push(m),
    onChange: () => {},
  });
  return { dir, db, svc, clock, replies, notes, advance: (ms: number) => ((clock.t += ms), svc.engine.tick()) };
}

/** 가짜 OBS 플레이어 */
function player(svc: SongService, id = 'p1') {
  const msgs: OverlayMessage[] = [];
  svc.engine.addPlayer(id, (m) => msgs.push(m));
  const cmds = () => msgs.filter((m): m is Extract<OverlayMessage, { type: 'player.cmd' }> => m.type === 'player.cmd').map((m) => m.cmd);
  const lastPlay = () => cmds().filter((c): c is Extract<PlayerCommand, { op: 'play' }> => c.op === 'play').at(-1);
  const seq = () => lastPlay()!.seq;
  return {
    msgs, cmds, lastPlay,
    plays: () => cmds().filter((c) => c.op === 'play').length,
    hb: (time: number, duration: number | null = 200, state: 'playing' | 'buffering' = 'playing') =>
      svc.engine.report(id, { type: 'player.hb', seq: seq(), state, time, duration }),
    ended: () => svc.engine.report(id, { type: 'player.ended', seq: seq() }),
    error: (code: number | string) => svc.engine.report(id, { type: 'player.error', seq: seq(), code }),
    verified: (trackId: number, ok: boolean, duration: number | null, code?: number) =>
      svc.engine.report(id, { type: 'player.verified', trackId, ok, duration, code }),
    disconnect: () => svc.engine.removePlayer(id),
  };
}

describe('YouTube 링크 파싱', () => {
  test.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD', 'dQw4w9WgXcQ'],
    ['이거 신청해요 https://youtu.be/dQw4w9WgXcQ 감사합니다', 'dQw4w9WgXcQ'],
  ])('%s', (input, id) => expect(findYouTubeId(input)).toBe(id));
  test('ID만 / 잘못된 입력', () => {
    expect(parseRequestArg(' dQw4w9WgXcQ ')).toBe('dQw4w9WgXcQ');
    expect(parseRequestArg('아이유 밤편지')).toBeNull();
    expect(findYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });
});

describe('신청 정책', () => {
  test('퍼가기 금지·없는 영상은 신청 단계에서 거절', async () => {
    const { svc } = setup({ oembed: { [V(1)]: { ok: false, reason: '퍼가기가 금지된 영상' } } });
    const r = await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('퍼가기');
  });

  test('YouTube 확인이 안 될 때(네트워크)는 막지 않고 받아둔다', async () => {
    const { svc } = setup({ oembed: { [V(1)]: { ok: 'unknown' } } });
    expect((await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' })).ok).toBe(true);
  });

  test('중복·1인 제한·마감·권한·최소 후원액', async () => {
    const { svc } = setup();
    const a = viewer('a');
    expect((await svc.request({ videoId: V(1), viewer: a, via: 'chat' })).ok).toBe(true);
    expect((await svc.request({ videoId: V(1), viewer: viewer('b'), via: 'chat' })).message).toContain('이미 대기열');
    expect((await svc.request({ videoId: V(2), viewer: a, via: 'chat' })).ok).toBe(true);
    expect((await svc.request({ videoId: V(3), viewer: a, via: 'chat' })).message).toContain('최대 2곡');
    // 매니저는 제한 없음
    const m = viewer('m', ['manager']);
    for (const n of [4, 5, 6]) expect((await svc.request({ videoId: V(n), viewer: m, via: 'chat' })).ok).toBe(true);

    svc.setPolicy({ open: false });
    expect((await svc.request({ videoId: V(7), viewer: viewer('c'), via: 'chat' })).message).toContain('받지 않습니다');
    expect((await svc.request({ videoId: V(7), viewer: null, via: 'dashboard' })).ok).toBe(true); // 스트리머는 항상

    svc.setPolicy({ open: true, permission: 'subscriber' });
    expect((await svc.request({ videoId: V(8), viewer: viewer('d'), via: 'chat' })).message).toContain('구독자');
    expect((await svc.request({ videoId: V(8), viewer: viewer('s', ['subscriber']), via: 'chat' })).ok).toBe(true);

    svc.setPolicy({ donationMinKRW: 3000 });
    expect((await svc.request({ videoId: V(9), viewer: viewer('e'), via: 'donation', paidKRW: 1000 })).ok).toBe(false);
  });

  test('후원 신청은 우선 재생 (금액 기준 이상)', async () => {
    const { svc } = setup();
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    await svc.onDonation(viewer('c'), 5000, `이거요 https://youtu.be/${V(3)}`);
    expect(svc.store.queued().map((q) => q.track.ref)).toEqual([V(3), V(1), V(2)]);
  });

  test('금지 키워드, 최근 재생곡', async () => {
    const { svc, clock } = setup({ oembed: { [V(1)]: { ok: true, title: '금지된 노래', author: null } } });
    svc.setPolicy({ blacklistKeywords: ['금지'] });
    expect((await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' })).ok).toBe(false);

    const p = player(svc);
    await svc.request({ videoId: V(2), viewer: viewer('a'), via: 'chat' });
    p.hb(1);
    p.ended();
    clock.t += 60_000;
    expect((await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' })).message).toContain('최근에 재생');
  });

  test('승인 모드', async () => {
    const { svc } = setup();
    svc.setPolicy({ approvalMode: true });
    const r = await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    expect(r.ok && r.item.status).toBe('pending_approval');
    expect(svc.store.queued()).toHaveLength(0);
    svc.approve(r.ok ? r.item.id : 0, true);
    expect(svc.store.queued()).toHaveLength(1);
  });
});

describe('재생 엔진 — 기본 흐름', () => {
  test('신청 → 재생 → 끝나면 다음 곡 → 큐가 비면 스테이션', async () => {
    const { svc } = setup();
    const p = player(svc);
    expect(svc.engine.np).toBeNull();
    await svc.createStation({ name: 'BGM', kind: 'manual', links: `https://youtu.be/${V(90)}\nhttps://youtu.be/${V(91)}` });
    expect(svc.engine.np?.kind).toBe('station'); // 스테이션 켜지자마자 재생

    svc.setPolicy({ interruptStation: false });
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    expect(svc.engine.np?.kind).toBe('station'); // 스테이션 곡은 끝까지
    p.hb(5);
    p.ended();
    expect(svc.engine.np?.track.ref).toBe(V(1)); // 신청곡
    expect(svc.engine.np?.requesterName).toBe('a');
    p.hb(3);
    p.ended();
    expect(svc.engine.np?.kind).toBe('station'); // 다시 스테이션
    expect(svc.store.history()[0]!.status).toBe('played');
  });

  test('신청곡이 오면 스테이션 즉시 전환 옵션', async () => {
    const { svc } = setup();
    player(svc);
    await svc.createStation({ name: 'BGM', kind: 'manual', links: `https://youtu.be/${V(90)}` });
    svc.setPolicy({ interruptStation: true });
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    expect(svc.engine.np?.track.ref).toBe(V(1));
  });

  test('스킵 되돌리기: 스킵한 곡이 맨 앞으로 돌아와 다시 재생되고, 그 사이 곡도 잃지 않음', async () => {
    const { svc } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    p.hb(10);
    svc.skip();
    expect(svc.engine.np?.track.ref).toBe(V(2));
    expect(svc.undo()).toContain('스킵');
    expect(svc.engine.np?.track.ref).toBe(V(1));
    expect(svc.store.queued().map((q) => q.track.ref)).toContain(V(2));
  });

  test('삭제·비우기 되돌리기', async () => {
    const { svc } = setup();
    for (const n of [1, 2, 3]) await svc.request({ videoId: V(n), viewer: viewer(`v${n}`), via: 'chat' });
    svc.remove(svc.store.queued()[1]!.id);
    expect(svc.store.queued()).toHaveLength(2);
    svc.undo();
    expect(svc.store.queued().map((q) => q.track.ref)).toEqual([V(1), V(2), V(3)]);
    svc.clearQueue();
    expect(svc.store.queued()).toHaveLength(0);
    svc.undo();
    expect(svc.store.queued()).toHaveLength(3);
  });
});

describe('재생 엔진 — 장애 대응 (카오스)', () => {
  test('#1 재생 전 2차 검증: 다음 곡이 재생 불가면 차례가 오기 전에 빠진다', async () => {
    const { svc, replies } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    const pre = p.cmds().find((c) => c.op === 'prefetch') as Extract<PlayerCommand, { op: 'prefetch' }>;
    expect(pre.ref).toBe(V(2));
    p.verified(pre.trackId, false, null, 150);
    expect(svc.store.queued()).toHaveLength(0); // V(2)가 빠짐 (V(1)은 재생 중)
    await Bun.sleep(5); // 다른 영상으로 바꾸기를 먼저 시도 → 대체 영상이 없으면 안내
    expect(replies.at(-1)).toContain('재생할 수 없는 영상');
    expect(svc.store.track(pre.trackId)!.playable).toBe(false);
  });

  test('#1b 검증에서 너무 긴 곡이면 미리 뺀다', async () => {
    const { svc } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    const pre = p.cmds().find((c) => c.op === 'prefetch') as Extract<PlayerCommand, { op: 'prefetch' }>;
    p.verified(pre.trackId, true, 3600);
    expect(svc.store.history()[0]!.reason).toBe('너무 긴 곡');
  });

  test('#2 재생 중 멈춤 → 다시 불러오지 않고 바로 다음 곡 (같은 곡 반복 없음)', async () => {
    const { svc, advance } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    p.hb(30);
    p.hb(31); // 진행 확인
    advance(WATCHDOG.stallMs - 2000); // 잠깐 버퍼링은 기다려 줌
    expect(svc.engine.np?.track.ref).toBe(V(1));
    advance(3000); // 위치가 계속 안 움직임
    expect(svc.engine.np?.track.ref).toBe(V(2));
    expect(p.cmds().filter((c) => c.op === 'play' && c.track.ref === V(1))).toHaveLength(1);
    expect(svc.store.history()[0]).toMatchObject({ status: 'failed', reason: '재생이 멈춤' });
    expect(svc.engine.fallbackUntil).toBeNull(); // 중간에 멈춘 건 영상 문제일 수 있음 → 비상 전환 안 함
  });

  test('#2d YouTube 자체가 안 됨(시작조차 안 됨) → 곡 하나 만에 로컬 비상 전환, 버튼으로 복귀', async () => {
    const { svc, dir, advance } = setup();
    const music = join(dir, 'm');
    mkdirSync(music);
    writeFileSync(join(music, 'a.mp3'), 'x');
    await svc.createStation({ name: '비상', kind: 'local', folder: music });
    svc.activateStation(null);
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    advance(WATCHDOG.firstProgressGraceMs + 1000); // 시작 안 됨 → 다시 불러오지 않고 바로 비상 전환
    // 무음은 최대 30초
    expect(svc.engine.np?.track.source).toBe('local');
    expect(svc.store.queued().map((q) => q.track.ref)).toEqual([V(2)]);
    svc.engine.endFallback();
    expect(svc.engine.np?.track.ref).toBe(V(2));
    expect(p.lastPlay()!.track.ref).toBe(V(2));
  });

  test('#2b 광고·로딩 중에는 유예 시간 동안 기다린다', async () => {
    const { svc, advance } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    advance(WATCHDOG.firstProgressGraceMs - 5000); // 첫 진행 전 → 아직 괜찮음
    expect(p.plays()).toBe(1);
    p.hb(0.5);
    p.hb(1.5);
    expect(svc.engine.np?.track.ref).toBe(V(1));
  });

  test('#2c 끝부분에서 멈추면(ended 누락) 정상 종료로 처리', async () => {
    const { svc, advance } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    p.hb(10, 200);
    p.hb(199.5, 200);
    advance(WATCHDOG.stallMs + 1000);
    expect(svc.store.history()[0]!.status).toBe('played');
  });

  test('#3 재생 오류(퍼가기 금지 150)는 즉시 다음 곡, 영상은 재생 불가로 기록', async () => {
    const { svc } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    const failedId = svc.engine.np!.track.id;
    p.error(150);
    expect(svc.engine.np?.track.ref).toBe(V(2));
    expect(svc.store.track(failedId)!.playable).toBe(false);
  });

  test('#4 OBS 재시작(플레이어 끊김→재연결): 곡이 넘어가지 않고 같은 위치에서 이어짐', async () => {
    const { svc, advance } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    p.hb(40);
    p.hb(41);
    p.disconnect();
    advance(120_000); // 2분 동안 플레이어 없음
    expect(svc.engine.np?.track.ref).toBe(V(1)); // 그대로
    expect(svc.store.queued().map((q) => q.track.ref)).toEqual([V(2)]); // 대기열도 그대로
    const p2 = player(svc, 'p2');
    expect(p2.lastPlay()).toMatchObject({ position: 41, track: { ref: V(1) } });
  });

  test('#5 LocalBot 재시작(워커 크래시): DB에서 현재 곡·위치·볼륨 복원', async () => {
    const a = setup();
    const p = player(a.svc);
    await a.svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await a.svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    a.svc.engine.setVolume(35);
    p.hb(77);
    a.clock.t += 3000;
    p.hb(78); // 2초 주기 저장
    // 크래시 (stop 호출 없이) → 같은 DB로 새 서비스
    const b = setup({ dir: a.dir, db: a.db });
    expect(b.svc.engine.np?.track.ref).toBe(V(1));
    const p2 = player(b.svc);
    expect(p2.lastPlay()).toMatchObject({ position: 78, volume: 35, track: { ref: V(1) } });
    expect(b.svc.store.queued().map((q) => q.track.ref)).toEqual([V(2)]);
  });

  test('#6 YouTube 연속 실패 → 로컬 비상 스테이션, 신청곡은 대기열에 보존 → 5분 뒤 복귀', async () => {
    const { svc, dir, notes, clock } = setup();
    const music = join(dir, 'music');
    mkdirSync(music);
    for (const f of ['a.mp3', 'b.ogg', 'readme.txt']) writeFileSync(join(music, f), 'x');
    const local = await svc.createStation({ name: '비상', kind: 'local', folder: music });
    expect(local.ok && local.added).toBe(2);
    await svc.createStation({ name: '유튜브', kind: 'manual', links: `https://youtu.be/${V(90)}` });
    svc.activateStation(svc.store.stations().find((s) => s.name === '유튜브')!.id);

    const p = player(svc);
    for (const n of [1, 2, 3, 4, 5]) await svc.request({ videoId: V(n), viewer: viewer(`v${n}`), via: 'chat' });
    p.error('youtube-unreachable');
    p.error('youtube-unreachable');
    expect(svc.engine.fallbackUntil).not.toBeNull();
    expect(notes.join()).toContain('로컬 비상 스테이션');
    expect(svc.engine.np?.track.source).toBe('local');
    // 실패: 스테이션 곡(V90) → V1. 남은 신청곡은 보존
    expect(svc.store.queued().map((q) => q.track.ref)).toEqual([V(2), V(3), V(4), V(5)]);

    clock.t += WATCHDOG.fallbackMs + 1;
    p.hb(1);
    p.ended();
    expect(svc.engine.fallbackUntil).toBeNull();
    expect(svc.engine.np?.track.ref).toBe(V(2));
  });

  test('#7 플레이어가 없으면 대기열은 멈춘 채 보존 (곡이 그냥 넘어가지 않음)', async () => {
    const { svc, advance } = setup();
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    advance(600_000);
    expect(svc.engine.np).toBeNull();
    expect(svc.store.queued()).toHaveLength(1);
    const p = player(svc);
    expect(p.lastPlay()!.track.ref).toBe(V(1));
  });

  test('#8 마스터 리스: 플레이어가 둘이어도 소리는 하나, 마스터가 나가면 다음이 이어받음', async () => {
    const { svc } = setup();
    const a = player(svc, 'a');
    const b = player(svc, 'b');
    await svc.request({ videoId: V(1), viewer: viewer('x'), via: 'chat' });
    expect(a.plays()).toBe(1);
    expect(b.plays()).toBe(0);
    a.hb(20);
    svc.engine.report('b', { type: 'player.hb', seq: 1, state: 'playing', time: 999, duration: 200 }); // 보조 플레이어의 보고는 무시
    expect(svc.engine.np!.position).toBe(20);
    a.disconnect();
    expect(b.lastPlay()).toMatchObject({ position: 20 });
  });

  test('#9 늦게 도착한 이전 곡 보고는 무시 (seq)', async () => {
    const { svc } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    const oldSeq = p.lastPlay()!.seq;
    p.hb(5);
    p.ended();
    svc.engine.report('p1', { type: 'player.ended', seq: oldSeq }); // 중복 ended
    expect(svc.engine.np?.track.ref).toBe(V(2));
  });

  test('#10 재생 중 실제 길이가 제한을 넘으면 스킵 (대시보드 추가 곡은 예외)', async () => {
    const { svc } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: null, via: 'dashboard' });
    p.hb(1, 3600);
    expect(svc.store.history()[0]!.reason).toContain('너무 긴 곡');
    p.hb(1, 3600);
    expect(svc.engine.np?.track.ref).toBe(V(2));
  });

  test('끝까지 들은 신청곡은 "인기 신청곡" 스테이션에 쌓임', async () => {
    const { svc } = setup();
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    p.hb(1);
    p.ended();
    const pop = svc.store.stations().find((s) => s.kind === 'popular');
    expect(pop?.trackCount).toBe(1);
  });
});

describe('스테이션', () => {
  test('셔플: 최근 재생곡은 다시 안 나옴', async () => {
    const { svc, clock } = setup();
    const p = player(svc);
    const links = [1, 2, 3, 4, 5].map((n) => `https://youtu.be/${V(n)}`).join('\n');
    await svc.createStation({ name: 'S', kind: 'manual', links });
    svc.setPolicy({ stationNoRepeat: 3 });
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      seen.push(svc.engine.np!.track.ref);
      clock.t += 1000;
      p.hb(1);
      p.ended();
    }
    for (let i = 3; i < seen.length; i++) expect(seen.slice(i - 3, i)).not.toContain(seen[i]);
  });

  test('순서대로 모드', async () => {
    const { svc } = setup();
    const p = player(svc);
    await svc.createStation({ name: 'S', kind: 'manual', mode: 'sequential', links: [1, 2, 3].map((n) => `https://youtu.be/${V(n)}`).join('\n') });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(svc.engine.np!.track.ref);
      p.hb(1);
      p.ended();
    }
    expect(seen).toEqual([V(1), V(2), V(3), V(1)]);
  });
});

describe('곡 이름으로 신청 (검색)', () => {
  const hits = (list: [string, string, number | null][]) => async () =>
    list.map(([videoId, title, durationSec]) => ({ videoId, title, author: null, durationSec }));

  function setupSearch(list: [string, string, number | null][], oembed: Record<string, OEmbedResult> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'lb-search-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
    const replies: string[] = [];
    const svc = new SongService({
      db, now: () => 1_800_000_000_000, notify: () => {}, reply: (t) => replies.push(t), onChange: () => {},
      oembed: async (id) => oembed[id] ?? { ok: true, title: `제목 ${id}`, author: null },
      search: hits(list),
      mix: async () => [],
    });
    return { svc, replies };
  }

  test('!신청곡 곡이름 → 검색 첫 결과 신청, 길이도 미리 앎', async () => {
    const { svc } = setupSearch([[V(1), '백넘버 - 히로인', 269]]);
    const r = await svc.requestByInput({ text: '백넘버', viewer: viewer('a'), via: 'chat' });
    expect(r.ok).toBe(true);
    expect(svc.store.queued()[0]!.track).toMatchObject({ ref: V(1), durationSec: 269 });
  });

  test('생방송·너무 긴 것·퍼가기 금지는 건너뛰고 다음 후보', async () => {
    const { svc } = setupSearch(
      [[V(1), '라이브', null], [V(2), '1시간 모음', 3600], [V(3), '퍼가기 금지', 200], [V(4), '정상', 210]],
      { [V(3)]: { ok: false, reason: '퍼가기가 금지된 영상' } },
    );
    const r = await svc.requestByInput({ text: '노래', viewer: viewer('a'), via: 'chat' });
    expect(r.ok && r.item.track.ref).toBe(V(4));
  });

  test('링크는 검색 없이 바로, 검색 끄면 링크만', async () => {
    const { svc } = setupSearch([]);
    expect((await svc.requestByInput({ text: `https://youtu.be/${V(9)}`, viewer: viewer('a'), via: 'chat' })).ok).toBe(true);
    svc.setPolicy({ allowSearch: false });
    expect((await svc.requestByInput({ text: '아이유', viewer: viewer('b'), via: 'chat' })).message).toContain('링크로');
  });

  test('검색 결과 없음 / 빈 입력', async () => {
    const { svc } = setupSearch([]);
    expect((await svc.requestByInput({ text: '없는노래', viewer: viewer('a'), via: 'chat' })).message).toContain('검색 결과가 없습니다');
    expect((await svc.requestByInput({ text: '  ', viewer: viewer('a'), via: 'chat' })).message).toContain('곡 이름');
  });

  test('후원 메시지 "!신청곡 곡이름"도 신청 + 우선 재생', async () => {
    const { svc, replies } = setupSearch([[V(5), '구공탄 - 탕탕탕', 156]]);
    await svc.request({ videoId: V(1), viewer: viewer('x'), via: 'chat' });
    await svc.onDonation(viewer('치즈왕'), 5000, '!신청곡 구공탄');
    expect(svc.store.queued()[0]!.track.ref).toBe(V(5));
    expect(replies.at(-1)).toContain('치즈왕님');
    await svc.onDonation(viewer('y'), 1000, '그냥 응원합니다'); // 신청 아님
    expect(svc.store.queued()).toHaveLength(2);
  });
});

test('YouTube 검색 결과 페이지 파싱', async () => {
  const { parseSearchHtml, parseDuration } = await import('../apps/server/src/modules/songs/youtube.ts');
  const data = { contents: { a: [{ videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: '곡 ' }, { text: '제목' }] }, lengthText: { simpleText: '1:02:03' }, ownerText: { runs: [{ text: '채널' }] } } }, { videoRenderer: { videoId: 'livelivelive', title: { runs: [{ text: 'LIVE' }] } } }] } };
  const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
  expect(parseSearchHtml(html)).toEqual([
    { videoId: 'abcdefghijk', title: '곡 제목', author: '채널', durationSec: 3723 },
    { videoId: 'livelivelive', title: 'LIVE', author: null, durationSec: null },
  ]);
  expect(parseSearchHtml('<html>nothing</html>')).toEqual([]);
  expect(parseDuration('4:29')).toBe(269);
});

describe('🎧 자동 스테이션 (YouTube 알고리즘)', () => {
  const H = (n: number, dur = 200) => ({ videoId: V(n), title: `추천곡 ${n}`, author: '가수', durationSec: dur });

  function setupAuto(opts: { mix?: (id: string) => any[]; search?: (q: string) => any[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'lb-auto-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
    const calls = { mix: [] as string[], search: [] as string[] };
    const make = (d: string) => new SongService({
      db, now: () => clock.t, random: () => 0, notify: () => {}, reply: () => {}, onChange: () => {},
      oembed: async (id) => ({ ok: true, title: `곡 ${id}`, author: null }),
      mix: async (id) => (calls.mix.push(id), opts.mix?.(id) ?? []),
      search: async (q) => (calls.search.push(q), opts.search?.(q) ?? []),
    });
    const clock = { t: 1_800_000_000_000 };
    return { svc: make(dir), make: () => make(dir), calls, clock };
  }

  test('설정 없이도 처음부터 자동 스테이션이 켜져 있음', () => {
    const { svc } = setupAuto();
    const auto = svc.store.stations().find((s) => s.kind === 'auto')!;
    expect(svc.activeStationId()).toBe(auto.id);
  });

  test('기록이 없으면 인기곡 검색으로 채워서 바로 재생', async () => {
    const { svc, calls } = setupAuto({ search: () => [H(1), H(2), H(3)] });
    player(svc);
    expect(svc.engine.np).toBeNull(); // 아직 비어 있음 → 채우기 시작
    await svc.fillAuto();
    expect(calls.search.length).toBeGreaterThan(0);
    expect(svc.engine.np?.kind).toBe('station');
    expect(svc.engine.np?.track.ref).toBe(V(1));
  });

  test('신청곡을 기준으로 YouTube 믹스를 이어 붙임 (라디오처럼)', async () => {
    const { svc, calls } = setupAuto({ mix: (id) => (id === V(50) ? [H(51), H(52), H(53), H(54)] : []) });
    const p = player(svc);
    await svc.request({ videoId: V(50), viewer: viewer('a'), via: 'chat' });
    p.hb(1);
    p.ended(); // 신청곡 끝 → 대기열 빔 → 자동 스테이션
    await svc.fillAuto();
    expect(calls.mix).toContain(V(50));
    expect(svc.engine.np?.track.ref).toBe(V(51));
    p.hb(1);
    p.ended();
    expect(svc.engine.np?.track.ref).toBe(V(52)); // 순서대로 이어짐
  });

  test('믹스가 막히면 "비슷한 노래" 검색으로 대체, 너무 길거나 생방송은 제외', async () => {
    const { svc, calls } = setupAuto({ search: () => [H(70, 3600), { ...H(71), durationSec: null }, H(72)] });
    await svc.request({ videoId: V(60), viewer: viewer('a'), via: 'chat' }); // 플레이어 연결 전에 신청
    const p = player(svc);
    p.hb(1);
    p.ended();
    await svc.fillAuto();
    expect(calls.mix).toContain(V(60));
    expect(calls.search.at(-1)).toContain(V(60)); // 기준곡 제목으로 비슷한 노래 검색
    expect(svc.engine.np?.track.ref).toBe(V(72));
  });

  test('사용자가 끄면 다시 켜지지 않음 (재시작 후에도)', () => {
    const { svc, make } = setupAuto();
    svc.activateStation(null);
    expect(make().activeStationId()).toBeNull();
  });

  test('영상 하나의 문제(퍼가기 금지 150)는 YouTube 장애로 세지 않음', async () => {
    const { svc } = setupAuto({ search: () => [H(1), H(2), H(3), H(4)] });
    const p = player(svc);
    await svc.fillAuto();
    p.error(150);
    p.error(150);
    p.error(101);
    expect(svc.engine.fallbackUntil).toBeNull();
  });
});

test('YouTube 믹스 응답 파싱 / 비슷한 노래 검색어', async () => {
  const { parseMix, relatedQuery } = await import('../apps/server/src/modules/songs/youtube.ts');
  const data = { a: { b: [
    { playlistPanelVideoRenderer: { videoId: 'seedseedsee', title: { simpleText: '기준곡' } } },
    { playlistPanelVideoRenderer: { videoId: 'nextnextnex', title: { simpleText: '다음 곡' }, lengthText: { simpleText: '3:30' }, shortBylineText: { runs: [{ text: '가수' }] } } },
    { playlistPanelVideoRenderer: { videoId: 'nextnextnex', title: { simpleText: '중복' } } },
  ] } };
  expect(parseMix(data, 'seedseedsee')).toEqual([{ videoId: 'nextnextnex', title: '다음 곡', author: '가수', durationSec: 210 }]);
  expect(relatedQuery('BIBI - 나쁜년 (Official M/V)', 'BIBI - Topic')).toBe('BIBI 노래');
  expect(relatedQuery('[MV] 아이유 - 밤편지', null)).toBe('아이유 - 밤편지');
});

describe('🎧 자동 스테이션 — 추천 규칙', () => {
  const H = (n: number, author = `가수${n}`, dur = 200) => ({ videoId: V(n), title: `${author} - 곡${n}`, author, durationSec: dur });

  function setupRules(mixFor: Record<string, any[]>) {
    const dir = mkdtempSync(join(tmpdir(), 'lb-rules-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
    const calls: string[] = [];
    const clock = { t: 1_800_000_000_000 };
    const svc = new SongService({
      db, now: () => clock.t, random: () => 0, notify: () => {}, reply: () => {}, onChange: () => {},
      oembed: async (id) => ({ ok: true, title: `곡 ${id}`, author: null }),
      mix: async (id) => (calls.push(id), mixFor[id] ?? []),
      search: async () => [],
    });
    return { svc, calls, clock };
  }
  const autoTracks = (svc: SongService) =>
    svc.store.stationCandidates(svc.store.stations().find((s) => s.kind === 'auto')!.id, false).map((r) => r.ref);

  test('미리 넣는 곡은 5개', async () => {
    const { svc } = setupRules({ [V(1)]: Array.from({ length: 20 }, (_, i) => H(100 + i)) });
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    p.hb(1);
    p.ended();
    await svc.fillAuto();
    expect(autoTracks(svc)).toHaveLength(5);
  });

  test('기준곡은 신청곡 우선 (스테이션이 튼 곡은 안 씀), 최근 신청곡 3개의 믹스를 번갈아 섞음', async () => {
    const { svc, calls } = setupRules({
      [V(1)]: [H(11), H(12)], [V(2)]: [H(21), H(22)], [V(3)]: [H(31), H(32)],
    });
    const p = player(svc);
    for (const n of [1, 2, 3]) await svc.request({ videoId: V(n), viewer: viewer(`v${n}`), via: 'chat' });
    for (let i = 0; i < 3; i++) {
      p.hb(1);
      p.ended();
    }
    (svc as any).lastFillAt = 0;
    await svc.fillAuto();
    // 마지막 채우기는 신청곡 3개 모두를 기준으로 (스테이션 곡은 기준이 아님)
    expect(new Set(calls.slice(-3))).toEqual(new Set([V(1), V(2), V(3)]));
    const tracks = autoTracks(svc);
    for (const n of [21, 31]) expect(tracks).toContain(V(n)); // 여러 믹스가 섞여 들어옴
  });

  test('스킵한 신청곡은 기준곡에서 빠지고, 스킵한 스테이션 곡의 가수는 한동안 안 나옴', async () => {
    const { svc, calls } = setupRules({
      [V(1)]: [H(11, '싫은가수'), H(12, '싫은가수'), H(13), H(14), H(15), H(16), H(17)],
      [V(2)]: [],
    });
    const p = player(svc);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    p.hb(1);
    p.ended(); // V1 끝까지
    p.hb(1);
    svc.skip(); // V2 스킵
    await svc.fillAuto();
    expect(calls).not.toContain(V(2));
    // 자동 스테이션의 첫 곡(싫은가수)을 스킵 → 그 가수는 다음 채우기에서 제외
    expect(svc.engine.np?.track.ref).toBe(V(11));
    svc.skip();
    const before = autoTracks(svc).length;
    (svc as any).lastFillAt = 0;
    await svc.fillAuto();
    const added = autoTracks(svc).slice(before);
    expect(added).not.toContain(V(12));
  });

  test('같은 가수 3연속 방지', async () => {
    const { svc } = setupRules({ [V(1)]: [H(11, '같은가수'), H(12, '같은가수'), H(13, '다른가수')] });
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    // 신청곡 자체도 '같은가수'로 만들어 두고 재생 시작
    svc.store.db.query('UPDATE tracks SET artist = ? WHERE ref = ?').run('같은가수', V(1));
    const p = player(svc);
    p.hb(1);
    p.ended();
    await svc.fillAuto();
    // 방금 나온 신청곡이 같은가수였어도 1곡이므로 같은가수 곡 하나는 OK
    const seen = [svc.engine.np!.track.ref];
    p.hb(1);
    p.ended();
    seen.push(svc.engine.np!.track.ref);
    // 같은가수가 이미 2연속(신청곡 + V11) → 다음은 다른가수가 먼저
    expect(seen).toEqual([V(11), V(13)]);
  });
});

test('가수 이름 정리', async () => {
  const { artistKey } = await import('../apps/server/src/modules/songs/service.ts');
  expect(artistKey('IVE - Topic', 'I AM')).toBe('ive');
  expect(artistKey('BIBI Official', 'x')).toBe('bibi');
  expect(artistKey(null, '아이유 - 밤편지')).toBe('아이유');
  expect(artistKey(null, '[MV] 화사 - Maria')).toBe('화사');
  expect(artistKey(null, '그냥 제목')).toBeNull();
});

test('스킵 직후 이전 곡의 늦은 "끝남" 신호로 다음 곡들이 연쇄로 넘어가지 않음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lb-skip-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
  const svc = new SongService({
    db, notify: () => {}, reply: () => {}, onChange: () => {}, search: async () => [], mix: async () => [],
    oembed: async (id) => ({ ok: true, title: `곡 ${id}`, author: null }),
  });
  const p = player(svc);
  for (const n of [1, 2, 3, 4]) await svc.request({ videoId: V(n), viewer: viewer(`v${n}`), via: 'chat' });
  p.hb(10);
  p.hb(11);
  svc.skip(); // → V2 시작
  // 플레이어가 이전 곡 정지 때문에 새 seq로 '끝남'을 잘못 보냄 (여러 번)
  p.ended();
  p.ended();
  p.ended();
  expect(svc.engine.np?.track.ref).toBe(V(2));
  expect(svc.store.queued().map((q) => q.track.ref)).toEqual([V(3), V(4)]);
  // 정상적으로 재생되다 끝나면 그때 다음 곡
  p.hb(1);
  p.hb(2);
  p.ended();
  expect(svc.engine.np?.track.ref).toBe(V(3));
});

test('신청곡 영상이 재생 금지(150)면 같은 곡의 다른 영상으로 자동 교체, 순서 유지', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lb-repl-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
  const replies: string[] = [];
  const svc = new SongService({
    db, notify: () => {}, reply: (t) => replies.push(t), onChange: () => {}, mix: async () => [],
    oembed: async (id) => ({ ok: true, title: `곡 ${id}`, author: null }),
    search: async () => [
      { videoId: V(20), title: '밤편지 MV', author: '아이유', durationSec: 250 },
      { videoId: V(21), title: '밤편지 가사', author: '가사채널', durationSec: 250 },
    ],
  });
  const p = player(svc);
  await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
  await svc.requestByInput({ text: '아이유 밤편지', viewer: viewer('b'), via: 'chat' });
  await svc.request({ videoId: V(3), viewer: viewer('c'), via: 'chat' });
  const pre = p.cmds().find((c) => c.op === 'prefetch') as any;
  expect(pre.ref).toBe(V(20));
  p.verified(pre.trackId, false, null, 150); // 공식 MV는 퍼가기 금지
  await Bun.sleep(5);
  expect(svc.store.queued().map((q) => q.track.ref)).toEqual([V(21), V(3)]); // 가사 영상으로, 같은 자리
  expect(svc.store.queued()[0]!.requesterName).toBe('b');
  expect(replies.at(-1)).toContain('다른 영상으로 바꿨어요');
});

describe('유튜브 창 하나로만 재생 (기본 모드)', () => {
  function setupWin() {
    const dir = mkdtempSync(join(tmpdir(), 'lb-winmode-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'bot.db'), join(dir, 'backups'));
    const svc = new SongService({
      db, notify: () => {}, reply: () => {}, onChange: () => {}, search: async () => [], mix: async () => [],
      oembed: async (id) => ({ ok: true, title: `곡 ${id}`, author: null }),
    });
    const cmds: any[] = [];
    svc.attachWindowPlayer({ available: () => true, always: () => svc.policy().playbackMode === 'window', status: 'idle', send: (c) => cmds.push(c) });
    const seq = () => cmds.filter((c) => c.op === 'play').at(-1)!.seq;
    const report = (r: any) => svc.engine.report('youtube-window', r);
    return { svc, cmds, seq, report };
  }

  test('OBS 플레이어 없이도 신청곡이 유튜브 창에서 재생되고 다음 곡으로 넘어감', async () => {
    const { svc, cmds, seq, report } = setupWin();
    expect(svc.engine.playerOnline).toBe(true);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    expect(cmds.at(-1)).toMatchObject({ op: 'play', track: { ref: V(1) } });
    expect(cmds.some((c) => c.op === 'prefetch')).toBe(false); // 막힌 곡이 없으니 미리 확인 안 함
    report({ type: 'player.hb', seq: seq(), state: 'ad', time: 0, duration: null }); // 광고
    report({ type: 'player.hb', seq: seq(), state: 'playing', time: 3, duration: 200 });
    report({ type: 'player.ended', seq: seq() });
    expect(svc.engine.np?.track.ref).toBe(V(2));
    expect(cmds.at(-1)).toMatchObject({ op: 'play', track: { ref: V(2) } });
  });

  test('재생 금지(150) 걱정 없음: 창 모드에서는 OBS 쪽으로 절대 안 보냄', async () => {
    const { svc, cmds } = setupWin();
    const obs: any[] = [];
    svc.engine.addPlayer('obs', (m) => obs.push(m));
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    expect(cmds.at(-1)).toMatchObject({ op: 'play', track: { ref: V(1) } });
    expect(obs.filter((m) => m.type === 'player.cmd' && m.cmd.op === 'play')).toHaveLength(0);
  });

  test('TTS 읽는 동안 노래 소리 30%로 줄였다가 원래대로 (저장된 볼륨은 그대로)', async () => {
    const { svc, cmds } = setupWin();
    svc.engine.setVolume(80);
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    svc.engine.setDuck(true);
    expect(cmds.at(-1)).toEqual({ op: 'volume', volume: 24 });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    svc.skip();
    expect(cmds.filter((c) => c.op === 'play').at(-1)).toMatchObject({ volume: 24 }); // 읽는 중 넘어간 곡도 작게
    svc.engine.setDuck(false);
    expect(cmds.at(-1)).toEqual({ op: 'volume', volume: 80 });
    expect(svc.state().volume).toBe(80);
  });

  test('곡 끝에서 유튜브가 다른 영상으로 넘어가도 같은 곡을 처음부터 다시 틀지 않고 다음 곡으로', async () => {
    const { svc, cmds, seq, report } = setupWin();
    const clock = { t: Date.now() };
    (svc.engine as any).host.now = () => clock.t;
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    for (let t = 0; t <= 196; t += 4) {
      clock.t += 4000;
      report({ type: 'player.hb', seq: seq(), state: 'playing', time: t, duration: 200 });
    }
    // 끝나자마자 자동재생으로 딴 영상 → 위치 0, 진행 없음
    for (let i = 0; i < 25; i++) {
      clock.t += 1000;
      report({ type: 'player.hb', seq: seq(), state: 'loading', time: 0, duration: null });
      svc.engine.tick();
    }
    expect(svc.engine.np?.track.ref).toBe(V(2));
    expect(cmds.filter((c) => c.op === 'play' && c.track.ref === V(1))).toHaveLength(1); // 같은 곡 다시 안 틂
  });

  test('곡 중간에 멈추면 다시 불러오지 않고 다음 곡, "다시 불러옵니다" 알림 없음', async () => {
    const { svc, cmds, seq, report } = setupWin();
    const notes: string[] = [];
    (svc as any).deps.notify = (_l: string, m: string) => notes.push(m);
    const clock = { t: Date.now() };
    (svc.engine as any).host.now = () => clock.t;
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    await svc.request({ videoId: V(2), viewer: viewer('b'), via: 'chat' });
    for (let t = 0; t <= 100; t += 4) {
      clock.t += 4000;
      report({ type: 'player.hb', seq: seq(), state: 'playing', time: t, duration: 300 });
    }
    for (let i = 0; i < 25; i++) {
      clock.t += 1000;
      report({ type: 'player.hb', seq: seq(), state: 'buffering', time: 100, duration: 300 });
      svc.engine.tick();
    }
    expect(svc.engine.np?.track.ref).toBe(V(2));
    expect(cmds.filter((c) => c.op === 'play' && c.track.ref === V(1))).toHaveLength(1);
    expect(notes.some((n) => n.includes('다시 불러옵니다'))).toBe(false);
  });

  test('광고가 길어도 멈춘 걸로 치지 않음', async () => {
    const { svc, seq, report } = setupWin();
    await svc.request({ videoId: V(1), viewer: viewer('a'), via: 'chat' });
    for (let i = 0; i < 5; i++) report({ type: 'player.hb', seq: seq(), state: 'ad', time: 0, duration: null });
    svc.engine.tick();
    expect(svc.engine.np?.track.ref).toBe(V(1));
  });
});
