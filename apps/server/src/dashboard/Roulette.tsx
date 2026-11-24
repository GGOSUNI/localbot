import type { Roulette, RouletteItem, RouletteState, RouletteTrigger } from '@localbot/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, post, toast, won } from './store.ts';

const COLORS = ['#ff5470', '#ffb020', '#00d564', '#3fa9f5', '#a78bfa', '#ff7ac6', '#2dd4bf', '#f97316'];
const DEFAULT_TEMPLATE = '🎰 {user}님 [{roulette}] 결과: {result}';

// 서버 parseItems 와 같은 규칙 (미리보기용)
function parseItems(text: string): RouletteItem[] {
  const out: RouletteItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let stock: number | null = null;
    const s = line.match(/\s*\[\s*재고\s*(\d+)\s*\]\s*$/);
    if (s) { stock = Number(s[1]); line = line.slice(0, s.index).trim(); }
    let weight = 1;
    const w = line.match(/\s+[xX×*]\s*(\d+(?:\.\d+)?)$/);
    if (w) { weight = Number(w[1]); line = line.slice(0, w.index).trim(); }
    if (line && weight > 0) out.push({ label: line, weight, stock });
  }
  return out;
}
const formatItems = (items: RouletteItem[]) =>
  items.map((i) => `${i.label}${i.weight !== 1 ? ` x${i.weight}` : ''}${i.stock !== null ? ` [재고 ${i.stock}]` : ''}`).join('\n');

export function triggerText(t: RouletteTrigger) {
  if (t.type === 'per-amount') return `${won(t.price)}당 1회${t.carry ? ' · 잔액 이월' : ''} · 최대 ${t.maxPerDonation}회`;
  if (t.type === 'exact') return `정확히 ${won(t.amount)} 후원 시`;
  return '수동 (버튼으로만)';
}

export function RoulettePage({ r }: { r: RouletteState }) {
  const [editing, setEditing] = useState<Roulette | 'new' | null>(null);
  return (
    <main>
      {!r.overlayOnline && (
        <div className="alert">
          룰렛 오버레이가 OBS에 연결되어 있지 않습니다. 결과는 연출 없이 바로 기록·발표됩니다. (📺 OBS 설정 탭에서 추가)
        </div>
      )}
      <div className="cols">
        <div className="stack">
          {editing ? (
            <Editor initial={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
          ) : (
            <section>
              <h2>
                룰렛 <span className="badge">{r.roulettes.length}</span>
                <span className="spacer" />
                <ImportButton />
                <button className="primary" onClick={() => setEditing('new')}>+ 새 룰렛</button>
              </h2>
              {r.roulettes.length ? r.roulettes.map((x, i) => (
                <RouletteCard key={x.id} x={x} first={i === 0} last={i === r.roulettes.length - 1} onEdit={() => setEditing(x)} />
              )) : (
                <div className="empty">
                  아직 룰렛이 없습니다.<br />
                  <button className="primary" style={{ marginTop: 12 }} onClick={() => setEditing('new')}>30초 만에 만들기</button>
                </div>
              )}
              <div className="muted small" style={{ marginTop: 12 }}>
                후원이 오면: <b>정확 금액</b> 룰렛이 먼저, 없으면 <b>금액당</b> 룰렛 중 후원액으로 돌릴 수 있는 가장 비싼 룰렛이 돌아갑니다.
              </div>
            </section>
          )}
          <SpinsCard r={r} />
        </div>
        <div className="stack">
          <PenaltiesCard r={r} />
        </div>
      </div>
    </main>
  );
}

function RouletteCard({ x, first, last, onEdit }: { x: Roulette; first: boolean; last: boolean; onEdit: () => void }) {
  const testAmount = x.trigger.type === 'per-amount' ? x.trigger.price : x.trigger.type === 'exact' ? x.trigger.amount : 0;
  return (
    <div className="rcard">
      <Pie items={x.items} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="name">{x.name} {!x.enabled && <span className="badge">꺼짐</span>}</div>
        <div className="muted small">{triggerText(x.trigger)} · {x.items.length}개 항목</div>
      </div>
      <label className="switch" title="켜기/끄기">
        <input type="checkbox" checked={x.enabled} onChange={(e) => post(`/api/roulette/${x.id}`, { enabled: e.target.checked })} />
        <span className="track" />
      </label>
      <div className="row" style={{ gap: 4 }}>
        <button className="sm" onClick={() => post(`/api/roulette/${x.id}/spin`, { times: 1 })} title="지금 1번 돌리기">▶ 돌리기</button>
        {testAmount > 0 && (
          <button className="sm" title={`가짜 후원 ${won(testAmount)}으로 실제처럼 테스트`}
            onClick={() => post('/api/mock/donation', { nickname: '테스트시청자', amount: testAmount, text: '룰렛 테스트' })}>테스트 후원</button>
        )}
        <button className="sm" onClick={onEdit}>수정</button>
        <button className="sm ghost" title="공유 코드 복사" onClick={async () => {
          const r = await api<{ code: string }>(`/api/roulette/${x.id}/share`);
          if (r.ok) {
            await navigator.clipboard?.writeText(r.data.code).catch(() => {});
            prompt('공유 코드 (복사해서 다른 스트리머에게 주세요)', r.data.code);
          }
        }}>공유</button>
        <button className="sm ghost" disabled={first} onClick={() => post(`/api/roulette/${x.id}/move`, { dir: -1 })}>↑</button>
        <button className="sm ghost" disabled={last} onClick={() => post(`/api/roulette/${x.id}/move`, { dir: 1 })}>↓</button>
        <button className="sm ghost danger" onClick={() => confirm(`"${x.name}" 룰렛을 삭제할까요?`) && post(`/api/roulette/${x.id}/delete`)}>✕</button>
      </div>
    </div>
  );
}

function ImportButton() {
  return (
    <button className="ghost" onClick={async () => {
      const code = prompt('공유 코드를 붙여넣으세요 (LB1-로 시작)');
      if (!code) return;
      const r = await post('/api/roulette/import', { code });
      if (r.ok) toast('룰렛을 가져왔습니다 (꺼진 상태로 추가됨)');
    }}>코드로 가져오기</button>
  );
}

function Editor({ initial, onDone }: { initial: Roulette | null; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [text, setText] = useState(initial ? formatItems(initial.items) : '');
  const [trigger, setTrigger] = useState<RouletteTrigger>(initial?.trigger ?? { type: 'per-amount', price: 1000, maxPerDonation: 10, carry: false });
  const [tpl, setTpl] = useState(initial?.chatTemplate ?? DEFAULT_TEMPLATE);
  const [track, setTrack] = useState(initial?.trackPenalties ?? true);
  const [templates, setTemplates] = useState<{ name: string; items: string; trigger: RouletteTrigger }[]>([]);
  const [stats, setStats] = useState<{ label: string; count: number }[]>([]);
  const items = useMemo(() => parseItems(text), [text]);

  useEffect(() => {
    void api('/api/roulette/templates').then((r) => r.ok && setTemplates(r.data));
    if (initial) void api(`/api/roulette/${initial.id}/stats`).then((r) => r.ok && setStats(r.data));
  }, [initial]);

  const per = trigger.type === 'per-amount' ? trigger : { type: 'per-amount' as const, price: 1000, maxPerDonation: 10, carry: false };
  const exact = trigger.type === 'exact' ? trigger : { type: 'exact' as const, amount: 3333 };
  const total = items.reduce((s, i) => s + (i.stock === 0 ? 0 : i.weight), 0);
  const statTotal = stats.reduce((s, x) => s + x.count, 0);

  const save = async () => {
    const body = { name, itemsText: text, trigger, chatTemplate: tpl, trackPenalties: track };
    const r = await post(initial ? `/api/roulette/${initial.id}` : '/api/roulette', body);
    if (r.ok) {
      toast(initial ? '저장했습니다' : '룰렛을 만들었습니다');
      onDone();
    }
  };

  return (
    <section>
      <h2>{initial ? `룰렛 수정 — ${initial.name}` : '새 룰렛'}<span className="spacer" /><button className="ghost" onClick={onDone}>닫기</button></h2>
      {!initial && templates.length > 0 && (
        <div className="chips" style={{ marginBottom: 12 }}>
          <span className="muted small">템플릿:</span>
          {templates.map((t) => (
            <button key={t.name} className="chip" onClick={() => { setName(t.name); setText(t.items); setTrigger(t.trigger); }}>{t.name}</button>
          ))}
        </div>
      )}
      <div className="editor">
        <div className="form">
          <input placeholder="룰렛 이름 (예: 벌칙 룰렛)" value={name} onChange={(e) => setName(e.target.value)} />
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>① 항목 — 한 줄에 하나. 뒤에 <code>x5</code> = 5배 잘 나옴, <code>[재고 1]</code> = 1번 나오면 끝</div>
            <textarea style={{ minHeight: 170 }} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={'노래 한 곡\n스쿼트 10개 x2\n꽝 x5\n치킨 기프티콘 [재고 1]'} />
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>② 언제 돌릴까</div>
            <div className="radio">
              <label>
                <input type="radio" checked={trigger.type === 'per-amount'} onChange={() => setTrigger(per)} />
                후원 <input type="number" min={1} step={100} value={per.price} onChange={(e) => setTrigger({ ...per, price: Number(e.target.value) })} />원당 1회
                <span className="muted small">(최대</span>
                <input type="number" min={1} max={100} style={{ width: 60 }} value={per.maxPerDonation} onChange={(e) => setTrigger({ ...per, maxPerDonation: Number(e.target.value) })} />
                <span className="muted small">회)</span>
              </label>
              {trigger.type === 'per-amount' && (
                <label className="small" style={{ paddingLeft: 24 }}>
                  <input type="checkbox" checked={per.carry} onChange={(e) => setTrigger({ ...per, carry: e.target.checked })} />
                  잔액 이월 (500원 + 500원 = 1회)
                </label>
              )}
              <label>
                <input type="radio" checked={trigger.type === 'exact'} onChange={() => setTrigger(exact)} />
                정확히 <input type="number" min={1} value={exact.amount} onChange={(e) => setTrigger({ type: 'exact', amount: Number(e.target.value) })} />원 후원했을 때만
              </label>
              <label><input type="radio" checked={trigger.type === 'manual'} onChange={() => setTrigger({ type: 'manual' })} />수동 (대시보드 버튼으로만)</label>
            </div>
          </div>
          <details>
            <summary className="muted small" style={{ cursor: 'pointer' }}>고급 설정</summary>
            <div className="form" style={{ marginTop: 8 }}>
              <label className="small">결과 메시지 <span className="muted">{'{user} {roulette} {result} {count}'}</span>
                <input style={{ width: '100%' }} value={tpl} onChange={(e) => setTpl(e.target.value)} />
              </label>
              <label className="small"><input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} /> 결과를 벌칙 체크리스트에 추가 (꽝 제외)</label>
            </div>
          </details>
          <div className="row">
            <button className="primary" onClick={save} disabled={items.length < 2}>{initial ? '저장' : '만들기'}</button>
            <button className="ghost" onClick={onDone}>취소</button>
            {items.length < 2 && <span className="muted small">항목을 2개 이상 넣어 주세요</span>}
          </div>
        </div>
        <div>
          <Pie items={items} size={240} />
          <ul className="prob">
            {items.map((it, i) => (
              <li key={i}>
                <span className="sw" style={{ background: COLORS[i % COLORS.length] }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                {it.stock !== null && <span className="badge">재고 {it.stock}</span>}
                <span className="p">{total && it.stock !== 0 ? ((it.weight / total) * 100).toFixed(1) : '0'}%</span>
              </li>
            ))}
          </ul>
          {statTotal > 0 && (
            <>
              <h3 className="small">실제 결과 ({statTotal}회)</h3>
              <ul className="prob">
                {stats.map((s) => (
                  <li key={s.label}><span>{s.label}</span><span className="p">{s.count}회 · {((s.count / statTotal) * 100).toFixed(1)}%</span></li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** 원판 미리보기 (SVG) */
function Pie({ items, size }: { items: RouletteItem[]; size: number }) {
  const live = items.map((it, i) => ({ ...it, color: COLORS[i % COLORS.length]! })).filter((i) => i.stock !== 0 && i.weight > 0);
  const total = live.reduce((s, i) => s + i.weight, 0);
  const r = size / 2;
  if (!total) return <svg width={size} height={size} style={{ display: 'block', margin: '0 auto' }}><circle cx={r} cy={r} r={r - 2} fill="#262a33" /></svg>;
  let a = -Math.PI / 2;
  const paths = live.map((it, i) => {
    const span = (it.weight / total) * Math.PI * 2;
    const [x1, y1] = [r + (r - 2) * Math.cos(a), r + (r - 2) * Math.sin(a)];
    a += span;
    const [x2, y2] = [r + (r - 2) * Math.cos(a), r + (r - 2) * Math.sin(a)];
    if (live.length === 1) return <circle key={i} cx={r} cy={r} r={r - 2} fill={it.color} />;
    return <path key={i} d={`M${r},${r} L${x1},${y1} A${r - 2},${r - 2} 0 ${span > Math.PI ? 1 : 0} 1 ${x2},${y2} Z`} fill={it.color} stroke="#0f1115" strokeWidth={1.5} />;
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', margin: '0 auto', flex: 'none' }}>
      {paths}
      <circle cx={r} cy={r} r={size * 0.08} fill="#0f1115" stroke="#fff" strokeWidth={2} />
    </svg>
  );
}

function SpinsCard({ r }: { r: RouletteState }) {
  return (
    <section>
      <h2>최근 결과 {r.pendingShows > 0 && <span className="badge wait">연출 대기 {r.pendingShows}</span>}</h2>
      {r.recentSpins.length ? (
        <ul className="list">
          {r.recentSpins.map((s) => (
            <li key={s.id}>
              <span className="muted small" style={{ flex: 'none' }}>{new Date(s.createdAt).toLocaleTimeString('ko-KR', { hour12: false })}</span>
              <span className="t"><b>{s.viewerName}</b> <span className="muted">[{s.rouletteName}]</span> → {summarize(s.results)}</span>
              {s.amountKRW > 0 && <span className="badge gold">{won(s.amountKRW)}</span>}
            </li>
          ))}
        </ul>
      ) : <div className="empty">아직 돌린 적이 없습니다</div>}
    </section>
  );
}

function PenaltiesCard({ r }: { r: RouletteState }) {
  const todo = r.penalties.filter((p) => !p.done);
  const done = r.penalties.filter((p) => p.done);
  return (
    <section>
      <h2>
        ✅ 벌칙 체크리스트 <span className="badge">{todo.length}</span>
        <span className="spacer" />
        {done.length > 0 && <button className="sm ghost" onClick={() => post('/api/penalties/clear-done')}>완료 항목 지우기</button>}
      </h2>
      {r.penalties.length ? (
        <ul className="list">
          {[...todo, ...done].map((p) => (
            <li key={p.id} style={{ opacity: p.done ? 0.5 : 1 }}>
              <input type="checkbox" checked={p.done} onChange={(e) => post(`/api/penalties/${p.id}`, { done: e.target.checked })} />
              <span className="t" style={{ textDecoration: p.done ? 'line-through' : 'none' }}>{p.label}</span>
              <span className="muted small">{p.viewerName}</span>
            </li>
          ))}
        </ul>
      ) : <div className="empty">룰렛 결과 중 해야 할 것들이 여기에 쌓입니다</div>}
    </section>
  );
}

function summarize(results: string[]) {
  if (results.length === 1) return results[0];
  const m = new Map<string, number>();
  for (const x of results) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(', ');
}
