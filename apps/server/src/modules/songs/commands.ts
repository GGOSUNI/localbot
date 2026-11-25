import type { CommandRouter } from '../commands.ts';
import type { SongService } from './service.ts';

export function registerSongCommands(router: CommandRouter, songs: SongService) {
  router.register(['!신청곡', '!sr'], async ({ viewer, args, reply }) => {
    const r = await songs.requestByInput({ text: args, viewer, via: 'chat' });
    reply(r.ok ? `${viewer.nickname}님 ${r.message}` : `${viewer.nickname}님, ${r.message}`);
  }, { cooldownMs: 3000 });

  router.register(['!현재곡', '!노래'], ({ reply }) => {
    const np = songs.engine.np;
    if (!np) return reply('지금 재생 중인 곡이 없습니다');
    reply(`🎵 지금 재생 중: ${np.track.title}${np.requesterName ? ` (신청: ${np.requesterName})` : ''}`);
  }, { cooldownMs: 10_000 });

  router.register(['!대기열', '!신청목록'], ({ reply }) => {
    const q = songs.store.queued().filter((i) => i.id !== songs.engine.np?.queueId);
    if (!q.length) return reply('대기 중인 신청곡이 없습니다');
    reply(`📋 대기 ${q.length}곡: ${q.slice(0, 5).map((i, n) => `${n + 1}. ${i.track.title}`).join(' / ')}${q.length > 5 ? ' …' : ''}`);
  }, { cooldownMs: 10_000 });

  router.register(['!신청취소'], ({ viewer, reply }) => reply(songs.cancelOwn(viewer)));

  // 매니저
  router.register(['!스킵', '!skip'], ({ reply }) => {
    const np = songs.engine.np;
    if (!np) return;
    songs.skip();
    reply(`⏭ 스킵: ${np.track.title}`);
  }, { managerOnly: true });
  router.register(['!신청마감'], ({ reply }) => {
    songs.setPolicy({ open: false });
    reply('🔒 신청곡을 마감했습니다');
  }, { managerOnly: true });
  router.register(['!신청오픈'], ({ reply }) => {
    songs.setPolicy({ open: true });
    reply('🔓 신청곡을 받습니다! !신청곡 <유튜브 링크>');
  }, { managerOnly: true });
  router.register(['!일시정지'], () => songs.engine.pause(), { managerOnly: true });
  router.register(['!재생'], () => songs.engine.resume(), { managerOnly: true });
  router.register(['!볼륨'], ({ args, reply }) => {
    const v = Number(args.trim());
    if (!Number.isFinite(v)) return reply(`🔊 현재 볼륨 ${songs.engine.volume}`);
    songs.engine.setVolume(v);
    reply(`🔊 볼륨 ${songs.engine.volume}`);
  }, { managerOnly: true });
}
