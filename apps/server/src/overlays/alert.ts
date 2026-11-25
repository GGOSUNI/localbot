import { connectOverlay } from './common.ts';

/** 후원 알림 카드. TTS가 읽는 동안 표시 (소리는 LocalBot이 스피커로 직접 냄) */
const $ = (id: string) => document.getElementById(id)!;
let current = -1;

connectOverlay('alert', (m) => {
  if (m.type === 'alert.show') {
    current = m.alert.id;
    $('who').replaceChildren();
    const b = document.createElement('b');
    b.textContent = `${m.alert.amountKRW.toLocaleString('ko-KR')}원`;
    $('who').append(document.createTextNode(`💰 ${m.alert.nickname ?? '익명'}님 `), b);
    $('msg').textContent = m.alert.message.startsWith('!') ? '' : m.alert.message;
    $('card').classList.add('show');
  } else if (m.type === 'alert.hide' && m.id === current) {
    $('card').classList.remove('show');
  }
});
