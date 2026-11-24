import type { OverlayMessage, OverlayReport } from '@localbot/shared';

export const params = new URLSearchParams(location.search);
export const overlayKey = params.get('key') ?? '';
export const inOBS = typeof (window as any).obsstudio !== 'undefined';

/** 오버레이 ↔ 서버 연결. 끊기면 계속 다시 붙습니다 (LocalBot 재시작, 워커 복구 등) */
export function connectOverlay(role: 'player' | 'overlay', onMessage: (m: OverlayMessage) => void, onStatus?: (up: boolean) => void) {
  let ws: WebSocket | null = null;
  let retry = 0;
  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws/overlay?role=${role}&key=${encodeURIComponent(overlayKey)}`);
    ws.onopen = () => {
      retry = 0;
      onStatus?.(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = () => {
      onStatus?.(false);
      setTimeout(open, Math.min(5000, 300 * 2 ** retry++));
    };
  };
  open();
  return {
    send(m: OverlayReport) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
