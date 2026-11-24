import { type AppState, toast, useOverlayKey } from './store.ts';

export function Overlays({ app }: { app: AppState }) {
  const [key, regen] = useOverlayKey();
  const base = `${location.protocol}//${location.host}`;
  const rows = [
    {
      name: '🎵 신청곡 플레이어', path: '/o/player', size: '아무 크기 (화면에 안 보여도 됨)', online: app.songs!.playerOnline,
      desc: '신청곡·스테이션 소리를 내는 소스입니다. 꼭 "OBS를 통해 오디오 제어"를 켜세요. 하나만 추가하세요.',
    },
    { name: '🎶 현재 곡 표시', path: '/o/nowplaying', size: '1920 × 1080', online: null, desc: '왼쪽 아래에 지금 나오는 곡과 신청자를 보여줍니다.' },
    {
      name: '🎰 룰렛', path: '/o/roulette', size: '1920 × 1080', online: app.roulette!.overlayOnline,
      desc: '후원으로 룰렛이 돌면 원판이 돌아갑니다. 효과음을 끄려면 주소 끝에 &sound=0',
    },
  ];
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('주소를 복사했습니다');
    } catch {
      prompt('주소를 복사하세요', text);
    }
  };
  return (
    <main>
      <section>
        <h2>OBS에 추가하는 방법</h2>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>OBS → 소스 목록의 <b>+</b> → <b>브라우저</b></li>
          <li>아래 주소를 <b>URL</b>에 붙여넣고, 너비·높이를 맞춥니다</li>
          <li>신청곡 플레이어는 <b>"OBS를 통해 오디오 제어"</b>를 체크해야 방송에 소리가 나갑니다</li>
        </ol>
      </section>
      {rows.map((r) => {
        const url = `${base}${r.path}?key=${key}`;
        return (
          <section key={r.path}>
            <h2>
              <span style={{ color: 'var(--text)', fontSize: 15 }}>{r.name}</span>
              {r.online !== null && <span className={`badge ${r.online ? 'ok' : ''}`}>{r.online ? '연결됨' : '연결 안 됨'}</span>}
              <span className="spacer" />
              <span className="muted small">{r.size}</span>
            </h2>
            <div className="row">
              <code className="url grow">{key ? url : '불러오는 중…'}</code>
              <button className="primary" onClick={() => copy(url)}>복사</button>
              <a href={url} target="_blank" rel="noreferrer"><button>열기 ↗</button></a>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>{r.desc}</div>
          </section>
        );
      })}
      <section>
        <h2>보안</h2>
        <div className="row">
          <span className="grow muted">주소가 방송 화면에 노출됐다면 키를 새로 만드세요. 그 뒤 OBS의 주소도 바꿔야 합니다.</span>
          <button className="danger" onClick={() => confirm('오버레이 키를 새로 만들까요? 기존 OBS 소스는 주소를 바꾸기 전까지 동작하지 않습니다.') && regen()}>키 새로 만들기</button>
        </div>
      </section>
    </main>
  );
}
