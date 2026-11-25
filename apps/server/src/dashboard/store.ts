import type { ConnectionState, Envelope, OfficialStatus, RouletteState, ServerMessage, SongsState } from '@localbot/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';

export interface AppState {
  server: 'connecting' | 'up' | 'down' | 'locked';
  connection: ConnectionState | null;
  songs: SongsState | null;
  roulette: RouletteState | null;
  official: OfficialStatus | null;
  events: Envelope[];
}

let state: AppState = { server: 'connecting', connection: null, songs: null, roulette: null, official: null, events: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<AppState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function useApp(): AppState {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);
}

let started = false;
export function startConnection() {
  if (started) return;
  started = true;
  let retry = 0;
  const open = async () => {
    const s = await fetch('/api/session').then((r) => r.json()).catch(() => null);
    if (s && !s.authed) return set({ server: 'locked' });
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      set({ server: 'up' });
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.type === 'hello') set({ connection: m.connection, songs: m.songs, roulette: m.roulette, official: m.official, events: m.recent.slice().reverse() });
      else if (m.type === 'official') set({ official: m.state });
      else if (m.type === 'frame') {
        frame = { jpeg: m.jpeg, at: Date.now() };
        frameListeners.forEach((l) => l());
      }
      else if (m.type === 'event') set({ events: [m.envelope, ...state.events].slice(0, 500) });
      else if (m.type === 'connection') set({ connection: m.state });
      else if (m.type === 'songs') set({ songs: m.state });
      else if (m.type === 'roulette') set({ roulette: m.state });
    };
    ws.onclose = () => {
      if (quitting) return;
      set({ server: 'down' });
      setTimeout(open, Math.min(5000, 300 * 2 ** retry++));
    };
  };
  void open();
}

/** 숨겨 둔 유튜브 창의 최신 화면 */
let frame: { jpeg: string; at: number } | null = null;
const frameListeners = new Set<() => void>();
export function useFrame() {
  return useSyncExternalStore((l) => (frameListeners.add(l), () => frameListeners.delete(l)), () => frame);
}

export let quitting = false;
export const markQuitting = () => (quitting = true);

// ── API ──
type Result<T> = { ok: boolean; data: T };
export async function api<T = any>(path: string, body?: unknown): Promise<Result<T>> {
  try {
    const r = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-localbot': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) toast(data.error || data.message || `요청 실패 (${r.status})`, true);
    return { ok: r.ok, data };
  } catch {
    toast('LocalBot에 연결할 수 없습니다', true);
    return { ok: false, data: {} as T };
  }
}
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, body);

// ── 토스트 ──
type Toast = { text: string; bad: boolean; id: number } | null;
let toastState: Toast = null;
const toastListeners = new Set<() => void>();
export function toast(text: string, bad = false) {
  const id = Date.now();
  toastState = { text, bad, id };
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    if (toastState?.id === id) {
      toastState = null;
      toastListeners.forEach((l) => l());
    }
  }, 3500);
}
export function useToast(): Toast {
  return useSyncExternalStore((l) => (toastListeners.add(l), () => toastListeners.delete(l)), () => toastState);
}

/** 오버레이 키 (URL 만들기용) */
export function useOverlayKey(): [string, () => void] {
  const [key, setKey] = useState('');
  useEffect(() => {
    void api<{ key: string }>('/api/overlay-key').then((r) => r.ok && setKey(r.data.key));
  }, []);
  const regen = async () => {
    const r = await post<{ key: string }>('/api/overlay-key/regenerate');
    if (r.ok) setKey(r.data.key);
  };
  return [key, regen];
}

export const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
export const fmtTime = (s: number | null | undefined) => {
  if (s === null || s === undefined || !Number.isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
