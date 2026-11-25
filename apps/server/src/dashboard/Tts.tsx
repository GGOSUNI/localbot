import type { TtsSettings, TtsState } from '@localbot/shared';
import { useEffect, useState } from 'react';
import { post, won } from './store.ts';

/** 🔊 후원 TTS 설정 */
export function TtsPage({ t }: { t: TtsState }) {
  const s = t.settings;
  const save = (p: Partial<TtsSettings>) => post('/api/tts/settings', p);
  const [template, setTemplate] = useState(s.template);
  const [banned, setBanned] = useState(s.bannedWords.join(', '));
  const [ignore, setIgnore] = useState(s.ignoreNames.join(', '));
  useEffect(() => setIgnore(s.ignoreNames.join(', ')), [s.ignoreNames.join('\n')]);
  const [testText, setTestText] = useState('테스트입니다. 잘 들리나요?');
  useEffect(() => setTemplate(s.template), [s.template]);
  useEffect(() => setBanned(s.bannedWords.join(', ')), [s.bannedWords.join('\n')]);

  return (
    <main>
      <section>
        <h2>
          🔊 TTS — 채팅 읽어 주기
          <span className={`badge ${s.enabled ? 'ok' : ''}`}>{s.enabled ? '켜짐' : '꺼짐'}</span>
          <span className="spacer" />
          <label className="row"><input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />TTS 켜기</label>
        </h2>
        <div className="row" style={{ marginBottom: 12, gap: 18 }}>
          <label className="row"><input type="checkbox" checked={s.readChat} onChange={(e) => save({ readChat: e.target.checked })} /><b>일반 채팅 읽기</b></label>
          <label className="row"><input type="checkbox" checked={s.readDonations} onChange={(e) => save({ readDonations: e.target.checked })} /><b>후원 메시지 읽기</b></label>
        </div>
        {!t.available && (
          <div className="alert" style={{ marginBottom: 12 }}>이 PC에서는 음성을 낼 수 없습니다 (윈도우에서만 동작). 알림 카드만 표시됩니다.</div>
        )}
        <p className="muted small" style={{ marginTop: 0 }}>
          시청자 채팅을 자연스러운 목소리(기본: 선희)로 <b>스피커에 바로</b> 읽습니다. 인터넷 목소리가 안 되면 윈도우 목소리로 대신 읽어요. OBS는 <b>데스크톱 오디오</b>에 그대로 잡혀요 (따로 추가할 소스 없음).
          읽는 동안 노래 소리는 자동으로 줄어듭니다.
        </p>

        <div className="ttsnow">
          {t.speaking ? (
            <>
              <span className={`badge ${t.speaking.kind === 'donation' ? 'gold' : 'ok'}`}>{t.speaking.kind === 'donation' ? '후원' : '채팅'}</span>
              {t.speaking.nickname && <b>{t.speaking.nickname}</b>}
              <span className="t">{t.speaking.speech}</span>
              <button className="sm" onClick={() => post('/api/tts/skip')}>⏭ 건너뛰기</button>
            </>
          ) : <span className="muted">지금 읽는 메시지 없음</span>}
          {t.queue.length > 0 && (
            <>
              <span className="badge">대기 {t.queue.length}</span>
              <button className="sm danger" onClick={() => post('/api/tts/clear')}>모두 취소</button>
            </>
          )}
        </div>
      </section>

      <div className="cols">
        <section>
          <h2>읽는 방법</h2>
          <div className="form">
            <label className="field">
              <span>채팅 읽을 대상</span>
              <select value={s.chatWho} onChange={(e) => save({ chatWho: e.target.value as TtsSettings['chatWho'] })}>
                <option value="all">모든 시청자</option>
                <option value="subscriber">구독자 · 매니저만</option>
                <option value="manager">매니저만</option>
              </select>
            </label>
            <label className="row"><input type="checkbox" checked={s.readStreamer} onChange={(e) => save({ readStreamer: e.target.checked })} />스트리머 본인 채팅도 읽기 <span className="muted small">(봇 답장도 본인 계정으로 나가서 꺼 두는 걸 추천)</span></label>
            <label className="field col">
              <span>안 읽을 닉네임 <span className="muted small">쉼표로 구분 · 다른 봇 등</span></span>
              <div className="row">
                <input className="grow" value={ignore} onChange={(e) => setIgnore(e.target.value)} placeholder="예: 뚜봇, 나디아봇" />
                <button disabled={ignore === s.ignoreNames.join(', ')} onClick={() => save({ ignoreNames: ignore.split(',') })}>저장</button>
              </div>
            </label>
            <label className="field">
              <span>채팅 밀림 한도</span>
              <input type="number" min={1} max={50} defaultValue={s.maxQueue} key={`q${s.maxQueue}`}
                onBlur={(e) => Number(e.target.value) !== s.maxQueue && save({ maxQueue: Number(e.target.value) })} />
              <span className="muted small">개 넘게 밀리면 오래된 채팅부터 건너뜀</span>
            </label>
            <label className="field">
              <span>후원 최소 금액</span>
              <input type="number" min={0} step={100} defaultValue={s.minAmountKRW} key={`m${s.minAmountKRW}`}
                onBlur={(e) => Number(e.target.value) !== s.minAmountKRW && save({ minAmountKRW: Number(e.target.value) })} />
              <span className="muted small">{won(s.minAmountKRW)} 이상 후원 메시지만 읽음</span>
            </label>
            <label className="field col">
              <span>읽는 문장 <span className="muted small">기본은 메시지만 · 원하면 {'{user}'} 닉네임 · {'{amount}'} 후원 금액 추가</span></span>
              <div className="row">
                <input className="grow" value={template} onChange={(e) => setTemplate(e.target.value)} />
                <button disabled={template === s.template} onClick={() => save({ template })}>저장</button>
              </div>
            </label>
            <label className="field">
              <span>메시지 최대 길이</span>
              <input type="number" min={5} max={300} defaultValue={s.maxChars} key={`c${s.maxChars}`}
                onBlur={(e) => Number(e.target.value) !== s.maxChars && save({ maxChars: Number(e.target.value) })} />
              <span className="muted small">글자 (넘으면 잘라서 읽음)</span>
            </label>
            <label className="field col">
              <span>금지어 <span className="muted small">쉼표로 구분 · "삐"로 바꿔 읽음</span></span>
              <div className="row">
                <input className="grow" value={banned} onChange={(e) => setBanned(e.target.value)} placeholder="예: 욕설1, 욕설2" />
                <button disabled={banned === s.bannedWords.join(', ')} onClick={() => save({ bannedWords: banned.split(',') })}>저장</button>
              </div>
            </label>
            <label className="row"><input type="checkbox" checked={s.readAnonymous} onChange={(e) => save({ readAnonymous: e.target.checked })} />익명 후원도 읽기</label>
            <label className="row"><input type="checkbox" checked={s.duck} onChange={(e) => save({ duck: e.target.checked })} />읽는 동안 노래 소리 줄이기</label>
            <p className="muted small" style={{ margin: 0 }}>링크·이모티콘은 빼고, ㅋㅋㅋㅋㅋ 같은 반복은 줄여서 읽습니다. <code>!신청곡</code> 같은 명령어 메시지는 읽지 않아요.</p>
          </div>
        </section>

        <div className="stack">
          <section>
            <h2>목소리</h2>
            <div className="form">
              <label className="field">
                <span>목소리</span>
                <select value={t.voiceSelected} onChange={(e) => save({ voice: e.target.value })}>
                  {[...new Set(t.voiceOptions.map((v) => v.group))].map((g) => (
                    <optgroup key={g} label={g}>
                      {t.voiceOptions.filter((v) => v.group === g).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {t.voiceUsed && <div className="muted small">마지막으로 읽은 목소리: <b>{t.voiceUsed}</b></div>}
              {t.voiceError && <div className="alert small">{t.voiceError}</div>}
              <label className="field">
                <span>빠르기</span>
                <input type="range" min={-10} max={10} defaultValue={s.rate} key={`r${s.rate}`} onPointerUp={(e) => save({ rate: Number(e.currentTarget.value) })} onKeyUp={(e) => save({ rate: Number(e.currentTarget.value) })} />
                <b style={{ width: 28 }}>{s.rate}</b>
              </label>
              <label className="field">
                <span>음량</span>
                <input type="range" min={0} max={100} defaultValue={s.volume} key={`v${s.volume}`} onPointerUp={(e) => save({ volume: Number(e.currentTarget.value) })} onKeyUp={(e) => save({ volume: Number(e.currentTarget.value) })} />
                <b style={{ width: 28 }}>{s.volume}</b>
              </label>
              {t.voiceSelected.startsWith('sapi:') && t.available && t.voices.length > 0 && !t.voices.some((v) => v.endsWith('|ko-KR')) && (
                <div className="alert small">한국어 윈도우 목소리가 없습니다 → 위에서 <b>선희</b> 같은 자연스러운 목소리를 고르세요</div>
              )}
            </div>
          </section>
          <section>
            <h2>들어 보기</h2>
            <div className="row">
              <input className="grow" value={testText} onChange={(e) => setTestText(e.target.value)} />
              <button className="primary" onClick={() => post('/api/tts/test', { text: testText })}>▶ 테스트</button>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>홈 탭의 <b>가짜 채팅 · 가짜 후원</b>으로 실제 흐름을 확인할 수 있어요.</p>
          </section>
        </div>
      </div>
    </main>
  );
}
