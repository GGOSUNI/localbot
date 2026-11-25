import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './Home.tsx';
import { Overlays } from './Overlays.tsx';
import { RoulettePage } from './Roulette.tsx';
import { Songs } from './Songs.tsx';
import { TtsPage } from './Tts.tsx';
import { markQuitting, post, startConnection, useApp, useToast } from './store.ts';

const TABS = [
  ['home', '홈'],
  ['songs', '🎵 신청곡'],
  ['roulette', '🎰 룰렛'],
  ['tts', '🔊 TTS'],
  ['overlays', '📺 OBS 설정'],
] as const;
type Tab = (typeof TABS)[number][0];

function App() {
  const app = useApp();
  const t = useToast();
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'home');
  const [quit, setQuit] = useState(false);
  const go = (x: Tab) => {
    setTab(x);
    history.replaceState(null, '', `#${x}`);
  };

  if (quit) {
    return (
      <main><section className="setup"><h2>LocalBot이 종료되었습니다</h2>
        <p className="muted">다시 쓰려면 LocalBot.exe를 실행하세요. 이 탭은 닫아도 됩니다.</p></section></main>
    );
  }
  if (app.server === 'locked') {
    return (
      <main><section className="setup"><h2>🔒 LocalBot 대시보드</h2>
        <p className="muted">LocalBot.exe를 다시 실행하면 대시보드가 로그인된 상태로 열립니다.</p></section></main>
    );
  }

  const serverBadge = app.server === 'up' ? ['정상 작동 중', 'ok'] : app.server === 'down' ? ['복구 중…', 'bad'] : ['연결 중…', 'wait'];
  return (
    <>
      <header>
        <h1>LocalBot</h1>
        <nav>
          {TABS.map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>{label}</button>
          ))}
        </nav>
        <span className="spacer" />
        <span className={`badge ${serverBadge[1]}`}>{serverBadge[0]}</span>
        <button className="ghost" onClick={async () => {
          if (!confirm('LocalBot을 종료할까요? (OBS 오버레이와 봇이 모두 멈춥니다)')) return;
          markQuitting();
          await post('/api/app/quit');
          setQuit(true);
        }}>종료</button>
      </header>
      {app.connection && app.songs && app.roulette ? (
        tab === 'home' ? <Home app={app} /> :
        tab === 'songs' ? <Songs s={app.songs} /> :
        tab === 'roulette' ? <RoulettePage r={app.roulette} /> :
        tab === 'tts' ? (app.tts ? <TtsPage t={app.tts} /> : <main><div className="empty">불러오는 중…</div></main>) :
        <Overlays app={app} />
      ) : <main><div className="empty">불러오는 중…</div></main>}
      {t && <div className={`toast ${t.bad ? 'bad' : ''}`}>{t.text}</div>}
    </>
  );
}

startConnection();
createRoot(document.getElementById('root')!).render(<App />);
