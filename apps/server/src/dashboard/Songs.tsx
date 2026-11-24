import type { QueueItem, SongPolicy, SongsState, Station } from '@localbot/shared';
import { useEffect, useState } from 'react';
import { fmtTime, post, toast, useOverlayKey } from './store.ts';

export function Songs({ s }: { s: SongsState }) {
  return (
    <main>
      <div className="cols">
        <div className="stack">
          <NowCard s={s} />
          <QueueCard s={s} />
          {s.pending.length > 0 && <PendingCard items={s.pending} />}
          <HistoryCard items={s.history} />
        </div>
        <div className="stack">
          <PolicyCard p={s.policy} />
          <StationsCard s={s} />
        </div>
      </div>
    </main>
  );
}

function useProgress(s: SongsState) {
  const [, force] = useState(0);
  const [base] = useState(() => ({ at: Date.now(), pos: 0, id: -1 }));
  if (s.now && (base.id !== s.now.startedAt || Math.abs(base.pos - s.now.position) > 0.01)) {
    base.at = Date.now();
    base.pos = s.now.position;
    base.id = s.now.startedAt;
  }
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!s.now) return 0;
  return base.pos + (s.paused || !s.playerOnline ? 0 : (Date.now() - base.at) / 1000);
}

function NowCard({ s }: { s: SongsState }) {
  const [key] = useOverlayKey();
  const pos = useProgress(s);
  const np = s.now;
  const dur = np?.duration ?? np?.track.durationSec ?? null;
  const [vol, setVol] = useState(s.volume);
  useEffect(() => setVol(s.volume), [s.volume]);

  return (
    <section>
      <h2>
        지금 재생 중
        <span className="spacer" />
        {s.fallbackUntil && <>
          <span className="badge wait">YouTube 장애 → 로컬 음악 재생 중</span>
          <button className="sm" onClick={() => post('/api/songs/retry-youtube')}>YouTube 다시 시도</button>
        </>}
        <span className={`badge ${s.playerOnline ? 'ok' : 'bad'}`}>{s.playerOnline ? '플레이어 연결됨' : '플레이어 없음'}</span>
      </h2>
      {!s.playerOnline && (
        <div className="alert bad" style={{ marginBottom: 12 }}>
          소리를 낼 플레이어가 없습니다. <b>OBS에 플레이어 소스를 추가</b>하거나(📺 OBS 설정 탭),
          {' '}<a href={`/o/player?key=${key}`} target="_blank" rel="noreferrer">이 브라우저에서 재생 ↗</a> 을 여세요.
          <div className="small muted">플레이어가 없는 동안 대기열은 그대로 유지됩니다.</div>
        </div>
      )}
      {s.playerBlocked && (
        <div className="alert" style={{ marginBottom: 12 }}>
          브라우저가 자동재생을 막았습니다. <a href={`/o/player?key=${key}`} target="_blank" rel="noreferrer">플레이어 탭</a>에서 <b>"클릭해서 소리 켜기"</b>를 눌러 주세요. (OBS에서는 생기지 않습니다)
        </div>
      )}
      {np ? (
        <div className="now">
          <div className="thumb" style={np.track.source === 'youtube' ? { backgroundImage: `url(https://i.ytimg.com/vi/${np.track.ref}/mqdefault.jpg)` } : {}}>
            {np.track.source === 'local' ? '🎵' : ''}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="title">
              {np.track.source === 'youtube'
                ? <a href={`https://youtu.be/${np.track.ref}`} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{np.track.title}</a>
                : np.track.title}
            </div>
            <div className="muted">{np.kind === 'request' ? `🙋 ${np.requesterName ?? '익명'}님 신청` : '📻 스테이션'}{s.paused && ' · 일시정지됨'}</div>
            <div className="bar"><i style={{ width: dur ? `${Math.min(100, (pos / dur) * 100)}%` : '0' }} /></div>
            <div className="muted small">{fmtTime(pos)} / {fmtTime(dur)}</div>
          </div>
        </div>
      ) : (
        <div className="empty">재생 중인 곡이 없습니다{!s.activeStationId && ' · 스테이션을 켜면 신청곡이 없을 때 자동으로 음악이 나옵니다'}</div>
      )}
      <div className="controls">
        {s.paused
          ? <button className="primary" onClick={() => post('/api/songs/resume')}>▶ 재생</button>
          : <button onClick={() => post('/api/songs/pause')}>⏸ 일시정지</button>}
        <button onClick={() => post('/api/songs/skip')} disabled={!np}>⏭ 스킵</button>
        <button onClick={async () => {
          const r = await post('/api/songs/undo');
          if (r.ok && r.data.undone) toast(`되돌림: ${r.data.undone}`);
        }} disabled={!s.canUndo} title={s.canUndo ?? ''}>↩ 되돌리기</button>
        <span className="spacer" />
        <span className="muted">🔊</span>
        <input type="range" min={0} max={100} value={vol} style={{ width: 140 }}
          onChange={(e) => setVol(Number(e.target.value))}
          onPointerUp={() => post('/api/songs/volume', { volume: vol })}
          onKeyUp={() => post('/api/songs/volume', { volume: vol })} />
        <span className="muted small" style={{ width: 28 }}>{vol}</span>
      </div>
    </section>
  );
}

function QueueCard({ s }: { s: SongsState }) {
  const [input, setInput] = useState('');
  const queue = s.queue.filter((q) => q.id !== s.now?.queueId);
  const add = async () => {
    if (!input.trim()) return;
    const r = await post('/api/songs/request', { input });
    if (r.ok) {
      toast(r.data.message);
      setInput('');
    }
  };
  return (
    <section>
      <h2>
        대기열 <span className="badge">{queue.length}곡</span>
        <span className="spacer" />
        <button className="sm ghost danger" disabled={!queue.length} onClick={() => confirm('대기열을 모두 비울까요? (되돌리기 가능)') && post('/api/songs/clear')}>비우기</button>
      </h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="grow" placeholder="YouTube 링크로 직접 추가 (스트리머 추가는 제한 없음)" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="primary" onClick={add}>추가</button>
      </div>
      {queue.length ? (
        <ul className="list">
          {queue.map((q, i) => (
            <li key={q.id}>
              <span className="n">{i + 1}</span>
              <span className="t" title={q.track.title}>
                {q.priority > 0 && <span className="badge gold" style={{ marginRight: 6 }}>우선</span>}
                {q.track.title}
                <span className="muted small"> · {q.requesterName ?? '익명'}{q.paidKRW ? ` · ${q.paidKRW.toLocaleString()}원` : ''}</span>
              </span>
              <TrackBadge item={q} />
              <button className="sm ghost" title="맨 위로" onClick={() => post(`/api/songs/queue/${q.id}/top`)}>⤒</button>
              <button className="sm ghost" title="위로" disabled={i === 0} onClick={() => post(`/api/songs/queue/${q.id}/up`)}>↑</button>
              <button className="sm ghost" title="아래로" disabled={i === queue.length - 1} onClick={() => post(`/api/songs/queue/${q.id}/down`)}>↓</button>
              <button className="sm ghost danger" title="삭제" onClick={() => post(`/api/songs/queue/${q.id}/remove`)}>✕</button>
            </li>
          ))}
        </ul>
      ) : <div className="empty">대기 중인 신청곡이 없습니다. 시청자는 채팅에 <b>!신청곡 유튜브링크</b> 로 신청합니다.</div>}
    </section>
  );
}

function TrackBadge({ item }: { item: QueueItem }) {
  const t = item.track;
  if (t.playable === false) return <span className="badge bad">재생 불가</span>;
  if (t.durationSec) return <span className="badge ok" title="재생 확인됨">{fmtTime(t.durationSec)}</span>;
  if (t.playable === null && t.source === 'youtube') return <span className="badge" title="재생 전에 자동으로 확인합니다">확인 대기</span>;
  return null;
}

function PendingCard({ items }: { items: QueueItem[] }) {
  return (
    <section>
      <h2>승인 대기 <span className="badge wait">{items.length}</span></h2>
      <ul className="list">
        {items.map((q) => (
          <li key={q.id}>
            <span className="t"><a href={`https://youtu.be/${q.track.ref}`} target="_blank" rel="noreferrer">{q.track.title}</a>
              <span className="muted small"> · {q.requesterName}</span></span>
            <button className="sm primary" onClick={() => post(`/api/songs/queue/${q.id}/approve`)}>승인</button>
            <button className="sm danger" onClick={() => post(`/api/songs/queue/${q.id}/reject`)}>거절</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS: Record<string, [string, string]> = {
  played: ['재생함', 'ok'], skipped: ['스킵', ''], failed: ['실패', 'bad'], cancelled: ['취소', ''], rejected: ['거절', 'wait'],
};

function HistoryCard({ items }: { items: QueueItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h2 style={{ cursor: 'pointer', marginBottom: open ? 12 : 0 }} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 최근 기록 <span className="badge">{items.length}</span>
      </h2>
      {open && (items.length ? (
        <ul className="list">
          {items.map((q) => (
            <li key={q.id}>
              <span className={`badge ${STATUS[q.status]?.[1] ?? ''}`}>{STATUS[q.status]?.[0] ?? q.status}</span>
              <span className="t">{q.track.title}<span className="muted small"> · {q.requesterName}{q.reason ? ` · ${q.reason}` : ''}</span></span>
              {q.status !== 'played' && q.track.source === 'youtube' && (
                <button className="sm ghost" title="다시 신청" onClick={() => post('/api/songs/request', { input: q.track.ref })}>↻</button>
              )}
            </li>
          ))}
        </ul>
      ) : <div className="empty">아직 기록이 없습니다</div>)}
    </section>
  );
}

function PolicyCard({ p }: { p: SongPolicy }) {
  const set = (patch: Partial<SongPolicy>) => post('/api/songs/policy', patch);
  const num = (k: keyof SongPolicy, label: string, unit: string, scale = 1) => (
    <label className="f">
      <span>{label}</span>
      <span className="row" style={{ flexWrap: 'nowrap' }}>
        <input type="number" min={0} defaultValue={Math.round((p[k] as number) / scale)} key={`${k}-${p[k]}`}
          onBlur={(e) => Number(e.target.value) * scale !== p[k] && set({ [k]: Number(e.target.value) * scale })} />
        <span className="muted small" style={{ width: 24 }}>{unit}</span>
      </span>
    </label>
  );
  const sw = (k: keyof SongPolicy, label: string, hint?: string) => (
    <label className="switch" title={hint}>
      <input type="checkbox" checked={p[k] as boolean} onChange={(e) => set({ [k]: e.target.checked })} />
      <span className="track" />{label}
    </label>
  );
  return (
    <section>
      <h2>신청 설정</h2>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="switch" style={{ fontSize: 16, fontWeight: 800 }}>
          <input type="checkbox" checked={p.open} onChange={(e) => set({ open: e.target.checked })} />
          <span className="track" />{p.open ? '신청곡 받는 중' : '신청 마감'}
        </label>
      </div>
      <div className="form">
        {sw('allowChat', '채팅 신청 (!신청곡)')}
        {sw('allowDonation', '후원 메시지 링크로 신청')}
        <label className="f"><span>채팅 신청 가능</span>
          <select value={p.permission} onChange={(e) => set({ permission: e.target.value as SongPolicy['permission'] })}>
            <option value="everyone">누구나</option><option value="subscriber">구독자 이상</option><option value="manager">매니저만</option>
          </select>
        </label>
        {num('maxDurationSec', '최대 곡 길이', '분', 60)}
        {num('perUserLimit', '1인당 대기 곡 수', '곡')}
        {num('recentBlockMinutes', '최근 재생곡 재신청 금지', '분')}
        {num('donationMinKRW', '후원 신청 최소 금액', '원')}
        {num('donationPriorityKRW', '이 금액 이상 후원은 우선 재생', '원')}
        {sw('dedupQueue', '대기열 중복 곡 막기')}
        {sw('approvalMode', '승인 모드 (내가 승인해야 대기열에 들어감)')}
        {sw('interruptStation', '신청곡이 오면 스테이션 곡 바로 끊기')}
        <label className="f" style={{ gridTemplateColumns: '1fr' }}>
          <span>금지 키워드 <span className="muted small">(쉼표로 구분, 제목에 포함되면 거절)</span></span>
          <input defaultValue={p.blacklistKeywords.join(', ')} key={p.blacklistKeywords.join()}
            onBlur={(e) => set({ blacklistKeywords: e.target.value.split(',') })} />
        </label>
      </div>
    </section>
  );
}

function StationsCard({ s }: { s: SongsState }) {
  const [mode, setMode] = useState<'manual' | 'local' | null>(null);
  const [name, setName] = useState('');
  const [links, setLinks] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    const r = await post('/api/songs/stations', { name, kind: mode, links, folder });
    setBusy(false);
    if (r.ok) {
      toast(`스테이션을 만들었습니다 (${r.data.added}곡)`);
      setMode(null);
      setName('');
      setLinks('');
      setFolder('');
    }
  };
  return (
    <section>
      <h2>📻 스테이션 <span className="muted small">신청곡이 없을 때 자동 재생</span></h2>
      <ul className="list">
        <li>
          <label className="row t" style={{ cursor: 'pointer' }}>
            <input type="radio" checked={!s.activeStationId} onChange={() => post('/api/songs/stations/off')} /> 끄기 (신청곡만)
          </label>
        </li>
        {s.stations.map((st) => <StationRow key={st.id} st={st} active={s.activeStationId === st.id} />)}
      </ul>
      {mode === null ? (
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => setMode('manual')}>+ YouTube 링크로 만들기</button>
          <button onClick={() => setMode('local')}>+ 내 음악 폴더</button>
        </div>
      ) : (
        <div className="form" style={{ marginTop: 12 }}>
          <input placeholder={mode === 'local' ? '이름 (예: 비상용 BGM)' : '이름 (예: 잔잔한 노래)'} value={name} onChange={(e) => setName(e.target.value)} />
          {mode === 'manual'
            ? <textarea placeholder={'YouTube 링크를 한 줄에 하나씩\nhttps://youtu.be/...\nhttps://www.youtube.com/watch?v=...'} value={links} onChange={(e) => setLinks(e.target.value)} />
            : <>
                <input placeholder="음악 폴더 경로 (예: C:\Users\나\Music\방송BGM)" value={folder} onChange={(e) => setFolder(e.target.value)} />
                <div className="muted small">mp3·flac·ogg·wav·m4a 파일을 찾습니다. YouTube가 안 될 때 <b>비상 스테이션</b>으로도 쓰입니다.</div>
              </>}
          <div className="row">
            <button className="primary" disabled={busy} onClick={create}>{busy ? '만드는 중…' : '만들기'}</button>
            <button className="ghost" onClick={() => setMode(null)}>취소</button>
          </div>
        </div>
      )}
      {!s.stations.some((x) => x.kind === 'local') && (
        <div className="muted small" style={{ marginTop: 10 }}>💡 내 음악 폴더 스테이션을 하나 만들어 두면, YouTube가 막혀도 음악이 끊기지 않습니다.</div>
      )}
    </section>
  );
}

function StationRow({ st, active }: { st: Station; active: boolean }) {
  const [adding, setAdding] = useState(false);
  const [links, setLinks] = useState('');
  const icon = st.kind === 'local' ? '💾' : st.kind === 'popular' ? '🔥' : '▶';
  return (
    <li style={{ flexWrap: 'wrap' }}>
      <label className="row t" style={{ cursor: 'pointer' }}>
        <input type="radio" checked={active} onChange={() => post(`/api/songs/stations/${st.id}/activate`)} />
        {icon} {st.name} <span className="muted small">{st.trackCount}곡</span>
      </label>
      <select className="sm" value={st.mode} onChange={(e) => post(`/api/songs/stations/${st.id}/mode`, { mode: e.target.value })} style={{ padding: '2px 6px', fontSize: 12 }}>
        <option value="shuffle">셔플</option><option value="sequential">순서대로</option>
      </select>
      {st.kind === 'local' && <button className="sm ghost" title="폴더 다시 읽기" onClick={() => post(`/api/songs/stations/${st.id}/rescan`)}>↻</button>}
      {st.kind === 'manual' && <button className="sm ghost" onClick={() => setAdding(!adding)}>+곡</button>}
      <button className="sm ghost danger" onClick={() => confirm(`"${st.name}" 스테이션을 삭제할까요?`) && post(`/api/songs/stations/${st.id}/delete`)}>✕</button>
      {adding && (
        <div className="row" style={{ width: '100%' }}>
          <textarea style={{ minHeight: 60 }} placeholder="추가할 YouTube 링크 (한 줄에 하나)" value={links} onChange={(e) => setLinks(e.target.value)} />
          <button className="primary sm" onClick={async () => {
            const r = await post(`/api/songs/stations/${st.id}/links`, { links });
            if (r.ok) {
              toast(`${r.data.added}곡 추가`);
              setLinks('');
              setAdding(false);
            }
          }}>추가</button>
        </div>
      )}
    </li>
  );
}
