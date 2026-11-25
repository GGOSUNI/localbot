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
    {
      name: '💰 후원 알림 (TTS)', path: '/o/alert', size: '1920 × 1080', online: null,
      desc: 'TTS가 읽는 동안 화면 위쪽에 후원 카드를 띄웁니다. 소리는 LocalBot이 스피커로 직접 내므로 오디오 설정은 필요 없어요. (선택)',
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
        <h2>
          <span style={{ color: 'var(--text)', fontSize: 15 }}>📺 유튜브 창 (외부 재생 금지 곡)</span>
          <span className={`badge ${app.songs!.windowPlayer === 'playing' ? 'ok' : ''}`}>
            {{ off: '꺼짐', unavailable: '엣지/크롬 없음', idle: '대기', starting: '여는 중', playing: '재생 중' }[app.songs!.windowPlayer]}
          </span>
        </h2>
        <div className="muted small" style={{ lineHeight: 1.8 }}>
          애니 OP·음반사 곡처럼 <b>유튜브 밖 재생이 막힌 곡</b>은 LocalBot이 작은 <b>"LocalBot 유튜브 플레이어"</b> 창(엣지/크롬)을 띄워 재생합니다.<br />
          · OBS에서 <b>데스크톱 오디오</b>를 쓰면 따로 할 것 없음 — 그대로 방송에 나갑니다.<br />
          · 따로 잡으려면: OBS 소스 <b>+ → 응용 프로그램 오디오 캡처</b> → 창: <b>LocalBot 유튜브 플레이어</b> → 창 일치 우선순위: <b>창 제목 일치</b><br />
          · 그 창에서 유튜브에 로그인해 두면 유지됩니다 (유튜브 프리미엄이면 광고 없음). 창을 닫아도 다음 곡 때 다시 열립니다.
        </div>
      </section>
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
