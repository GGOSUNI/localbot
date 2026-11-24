import type { Envelope } from '@localbot/shared';
import { type FormEvent, useState } from 'react';
import { type AppState, post, won } from './store.ts';

const ROLE: Record<string, string> = { streamer: '스트리머', manager: '매니저', subscriber: '구독' };

export function Home({ app }: { app: AppState }) {
  return (
    <main>
      <Connection app={app} />
      <div className="cols">
        <section>
          <h2>실시간 채팅 · 후원 · 봇</h2>
          <Feed events={app.events} />
        </section>
        <div className="stack">
          <Summary app={app} />
          <TestTools />
        </div>
      </div>
    </main>
  );
}

function Connection({ app }: { app: AppState }) {
  const c = app.connection!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const connect = async (input: string) => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setErr('');
    const r = await post('/api/connection', { input });
    setBusy(false);
    if (!r.ok) setErr(r.data.error ?? '연결에 실패했습니다');
  };

  if (!c.channelId) {
    return (
      <section className="setup">
        <h2>치지직 채널 주소를 붙여넣으세요</h2>
        <p className="muted">로그인이나 설정 없이 바로 채팅과 후원을 받기 시작합니다.</p>
        <form onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void connect(new FormData(e.currentTarget).get('input') as string);
        }}>
          <input name="input" placeholder="https://chzzk.naver.com/live/…" autoComplete="off" autoFocus
            onPaste={(e) => {
              const v = e.clipboardData.getData('text');
              setTimeout(() => void connect(v), 0);
            }} />
          <button className="primary" disabled={busy}>{busy ? '확인 중…' : '연결'}</button>
        </form>
        <div className="err">{err}</div>
      </section>
    );
  }

  const chat = {
    connected: ['채팅 연결됨', 'ok'], connecting: ['연결 중…', 'wait'], reconnecting: ['재연결 중…', 'wait'],
    waiting: ['방송 시작 대기 중', 'wait'], idle: ['연결 안 됨', 'bad'],
  }[c.chat];
  return (
    <section>
      <div className="row">
        <span style={{ fontSize: 18, fontWeight: 800 }}>{c.channelName}</span>
        <span className={`badge ${c.live ? 'live' : ''}`}>{c.live ? 'LIVE' : '방송 꺼짐'}</span>
        {c.error ? <span className="badge bad">{c.error}</span> : <span className={`badge ${chat[1]}`}>{chat[0]}</span>}
        <span className="spacer" />
        <button className="ghost" onClick={() => confirm('채널 연결을 해제하고 다른 채널을 입력할까요?') && post('/api/connection/clear')}>채널 변경</button>
      </div>
      {c.live && c.liveTitle && <div className="muted" style={{ marginTop: 6 }}>{c.liveTitle}</div>}
      <div className="muted small" style={{ marginTop: 6 }}>
        읽기 전용 연결 — 채팅·후원·구독을 받습니다. 봇의 답장은 아래 목록에 🤖로 표시됩니다 (채팅방에 직접 쓰려면 공식 연결 필요, 준비 중).
      </div>
    </section>
  );
}

function Summary({ app }: { app: AppState }) {
  const s = app.songs!;
  const r = app.roulette!;
  const pending = r.penalties.filter((p) => !p.done).length;
  return (
    <section>
      <h2>한눈에 보기</h2>
      <ul className="list">
        <li><span className="t">🎵 {s.now ? s.now.track.title : '재생 중인 곡 없음'}</span>
          <span className={`badge ${s.playerOnline ? 'ok' : 'bad'}`}>{s.playerOnline ? '플레이어 연결됨' : '플레이어 없음'}</span></li>
        <li><span className="t">📋 대기 중인 신청곡</span><b>{s.queue.length}곡</b></li>
        <li><span className="t">🔒 신청곡 접수</span><span className={`badge ${s.policy.open ? 'ok' : ''}`}>{s.policy.open ? '받는 중' : '마감'}</span></li>
        <li><span className="t">🎰 켜진 룰렛</span><b>{r.roulettes.filter((x) => x.enabled).length}개</b></li>
        <li><span className="t">✅ 남은 벌칙</span><b>{pending}개</b></li>
      </ul>
    </section>
  );
}

function TestTools() {
  const [nick, setNick] = useState('테스트시청자');
  const [amount, setAmount] = useState(5000);
  const [text, setText] = useState('https://youtu.be/dQw4w9WgXcQ 신청합니다!');
  const [chat, setChat] = useState('!현재곡');
  const [mgr, setMgr] = useState(false);
  return (
    <section>
      <h2>테스트 도구 <span className="muted small">(방송 없이 확인)</span></h2>
      <div className="form">
        <div className="row">
          <input className="grow" value={nick} onChange={(e) => setNick(e.target.value)} placeholder="닉네임 (비우면 익명)" />
          <input type="number" style={{ width: 110 }} value={amount} min={1} onChange={(e) => setAmount(Number(e.target.value))} />
        </div>
        <div className="row">
          <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="후원 메시지" />
          <button onClick={() => post('/api/mock/donation', { nickname: nick, amount, text })}>가짜 후원</button>
        </div>
        <div className="row">
          <input className="grow" value={chat} onChange={(e) => setChat(e.target.value)} />
          <label className="row small"><input type="checkbox" checked={mgr} onChange={(e) => setMgr(e.target.checked)} />매니저</label>
          <button onClick={() => post('/api/mock/chat', { nickname: nick || '시청자', text: chat, manager: mgr })}>가짜 채팅</button>
        </div>
        <button className="ghost small" onClick={() => post('/api/debug/crash')}>자가 복구 테스트 (내부 프로세스 강제 종료)</button>
      </div>
    </section>
  );
}

function Feed({ events }: { events: Envelope[] }) {
  if (!events.length) return <div className="empty">아직 이벤트가 없습니다</div>;
  return (
    <ul className="feed">
      {events.map((env) => <FeedItem key={env.id} env={env} />)}
    </ul>
  );
}

function FeedItem({ env }: { env: Envelope }) {
  const e = env.event;
  const time = new Date(env.ts).toLocaleTimeString('ko-KR', { hour12: false });
  let body: React.ReactNode;
  if (e.type === 'chat') {
    body = <span>{e.viewer.roles.map((r) => ROLE[r] && <span key={r} className="role">{ROLE[r]}</span>)}<span className="who">{e.viewer.nickname}</span>{e.text}</span>;
  } else if (e.type === 'donation') {
    const kind = e.kind === 'video' ? ' (영상)' : e.kind === 'mission' ? ' (미션)' : '';
    body = <span className="t-donation"><span className="who">💰 {e.viewer?.nickname ?? '익명'}</span>{won(e.amountKRW)}{kind}{e.text ? ` — ${e.text}` : ''}</span>;
  } else if (e.type === 'subscription') {
    body = <span className="t-sub"><span className="who">⭐ {e.viewer.nickname}</span>{e.months}개월 구독{e.tier ? ` (${e.tier})` : ''}</span>;
  } else if (e.type === 'bot') {
    body = <span className="t-bot">🤖 {e.text}{!e.delivered && <span className="muted small"> · 채팅 미전송</span>}</span>;
  } else if (e.type === 'stream') {
    body = <span className="t-system">{e.state === 'online' ? '🔴 방송 시작' : '⚫ 방송 종료'}</span>;
  } else {
    body = <span className={`t-system ${e.level}`}>⚙ {e.message}</span>;
  }
  return (
    <li>
      <time>{time}</time>
      {body}
      {env.source === 'mock' && <span className="badge" style={{ marginLeft: 'auto' }}>테스트</span>}
    </li>
  );
}
