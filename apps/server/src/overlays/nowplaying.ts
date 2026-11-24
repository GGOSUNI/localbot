import type { NowPlaying } from '@localbot/shared';
import { connectOverlay, params } from './common.ts';

/** 현재 곡 오버레이. ?next=0 이면 다음 곡 줄 숨김 */
const $ = (id: string) => document.getElementById(id)!;
let np: NowPlaying | null = null;
let paused = false;
let syncedAt = 0;

connectOverlay('overlay', (m) => {
  if (m.type !== 'songs') return;
  const prevId = np?.track.id;
  np = m.state.now;
  paused = m.state.paused;
  syncedAt = Date.now();
  const card = $('card');
  if (!np) return card.classList.remove('show');
  card.classList.add('show');
  $('title').textContent = np.track.title;
  $('who').textContent = np.requesterName ? `🙋 ${np.requesterName}` : '📻 스테이션';
  $('label').textContent = paused ? 'PAUSED' : 'NOW PLAYING';
  if (prevId !== np.track.id) {
    const t = $('thumb');
    if (np.track.source === 'youtube') {
      t.textContent = '';
      t.style.backgroundImage = `url(https://i.ytimg.com/vi/${np.track.ref}/mqdefault.jpg)`;
    } else {
      t.style.backgroundImage = '';
      t.textContent = '🎵';
    }
  }
  const next = m.state.queue.find((q) => q.id !== np!.queueId);
  $('next').textContent = params.get('next') !== '0' && next ? `다음 곡 ▸ ${next.track.title}` : '';
});

// 서버 위치 + 경과 시간으로 진행 바를 부드럽게
setInterval(() => {
  if (!np?.duration) return;
  const pos = np.position + (paused ? 0 : (Date.now() - syncedAt) / 1000);
  ($('bar').firstElementChild as HTMLElement).style.width = `${Math.min(100, (pos / np.duration) * 100)}%`;
}, 500);
