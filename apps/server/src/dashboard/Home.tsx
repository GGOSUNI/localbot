import type { Envelope } from '@localbot/shared';
import { type FormEvent, useState } from 'react';
import type { OfficialStatus } from '@localbot/shared';
import { type AppState, post, toast, won } from './store.ts';

const ROLE: Record<string, string> = { streamer: '스트리머', manager: '매니저', subscriber: '구독' };

export function Home({ app }: { app: AppState }) {
  return (
    <main>
      <Connection app={app} />
      {app.connection?.channelId && app.official && <Official o={app.official} />}
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
      {c.chat === 'waiting' && (
        <div className="alert" style={{ marginTop: 10 }}>
          <b>방송이 켜지면 10초 안에 자동으로 연결됩니다.</b> 지금은 열린 채팅방이 없어서 기다리는 중이에요.
          <div className="small" style={{ marginTop: 4 }}>
            ※ <b>리허설·비공개 방송</b>은 외부에 공개되지 않아서 봇이 채팅을 볼 수 없습니다. 방송 전에 확인하려면:
            ① 아래 <b>테스트 도구</b>로 가짜 후원·채팅 보내기, ② <b>채널 변경</b>으로 지금 방송 중인 다른 채널에 잠깐 연결해 보기
          </div>
        </div>
      )}
      <div className="muted small" style={{ marginTop: 6 }}>
        {app.official?.loggedIn
          ? `채팅·후원·구독을 받고, 봇 답장은 "${app.official.channelName}" 계정으로 채팅방에 올라갑니다.`
          : '채팅·후원·구독을 받습니다. 봇 답장을 채팅방에 올리려면 아래 "봇 답장 켜기"를 설정하세요.'}
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
  const [text, setText] = useState('!신청곡 아이유 밤편지');
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

function Official({ o }: { o: OfficialStatus }) {
  const [open, setOpen] = useState(!o.loggedIn && !o.configured);
  const [id, setId] = useState(o.clientId ?? '');
  const [secret, setSecret] = useState('');
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('복사했습니다'), () => prompt('복사하세요', t));

  if (o.loggedIn) {
    return (
      <section>
        <div className="row">
          <span className="badge ok">봇 답장 켜짐</span>
          <span>🤖 <b>{o.channelName}</b> 계정으로 채팅방에 답장합니다.</span>
          <span className="spacer" />
          <button className="sm" onClick={async () => { const r = await post('/api/official/test', { message: '🤖 LocalBot 연결 테스트입니다' }); if (r.ok) toast('채팅방에 테스트 메시지를 보냈습니다'); }}>테스트 메시지</button>
          <button className="sm ghost" onClick={() => confirm('봇 답장 로그인을 해제할까요?') && post('/api/official/logout')}>로그아웃</button>
        </div>
        {o.error && <div className="err">{o.error}</div>}
      </section>
    );
  }

  // 간편 로그인: 버튼 하나
  if (o.easyLogin && !o.clientId) {
    return (
      <section>
        <div className="row">
          <span>🤖 <b>봇 답장 켜기</b> <span className="muted small">— 봇이 치지직 채팅방에 직접 답하게 합니다</span></span>
          <span className="spacer" />
          <a href="/api/official/login"><button className="primary">치지직으로 로그인</button></a>
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>치지직 동의 화면에서 "동의"를 누르면 자동으로 돌아옵니다. 키 입력은 필요 없어요.</div>
        {o.error && <div className="err">{o.error}</div>}
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ cursor: 'pointer', marginBottom: open ? 12 : 0 }} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 🤖 봇 답장 켜기 <span className="muted small">(봇이 치지직 채팅방에 직접 답하게 — 처음 한 번만, 5분)</span>
        <span className="spacer" />
        {o.configured && <a href="/api/official/login" onClick={(e) => e.stopPropagation()}><button className="primary sm">치지직으로 로그인</button></a>}
      </h2>
      {open && (
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>
            <a href="https://developers.chzzk.naver.com" target="_blank" rel="noreferrer">치지직 개발자센터</a>에 로그인 → <b>애플리케이션 등록</b>
            <div className="muted small">앱 이름에 "치지직", "chzzk", "네이버", "naver"는 넣을 수 없어요. 예) 누메드봇</div>
          </li>
          <li>
            <b>로그인 리디렉션 URL</b>에 아래 주소를 그대로 넣기
            <div className="row" style={{ margin: '4px 0' }}>
              <code className="url grow">{o.redirectUri}</code>
              <button className="sm" onClick={() => copy(o.redirectUri)}>복사</button>
            </div>
          </li>
          <li><b>API 권한</b>에서 <b>유저 정보 조회</b>, <b>채팅 메시지 쓰기</b> 체크 → 등록</li>
          <li>
            발급된 <b>Client ID</b>와 <b>Client Secret</b>을 여기에 붙여넣고 저장
            <div className="row" style={{ marginTop: 4 }}>
              <input className="grow" placeholder="Client ID" value={id} onChange={(e) => setId(e.target.value)} />
              <input className="grow" type="password" placeholder={o.configured ? 'Client Secret (저장됨 — 바꿀 때만 입력)' : 'Client Secret'} value={secret} onChange={(e) => setSecret(e.target.value)} />
              <button className="primary" disabled={!id || (!secret && !o.configured)} onClick={async () => {
                if (!secret) return toast('Client Secret을 넣어 주세요', true);
                const r = await post('/api/official/config', { clientId: id, clientSecret: secret });
                if (r.ok) { setSecret(''); toast('저장했습니다. 이제 "치지직으로 로그인"을 누르세요'); }
              }}>저장</button>
            </div>
            <div className="muted small">Client Secret은 이 PC의 LocalBot에만 저장됩니다. 다른 곳(채팅·메신저)에 붙여넣지 마세요.</div>
          </li>
          <li>
            <a href="/api/official/login"><button className="primary" disabled={!o.configured}>치지직으로 로그인</button></a>
            <span className="muted small"> — 치지직 동의 화면에서 "동의"를 누르면 자동으로 돌아옵니다</span>
          </li>
        </ol>
      )}
      {o.error && <div className="err">{o.error}</div>}
    </section>
  );
}
