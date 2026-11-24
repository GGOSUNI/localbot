import type { Envelope } from '@localbot/shared';

export type AdapterStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

export interface AdapterCapabilities {
  sendChat: boolean; // 읽기 전용 연결은 false
  deleteMessage: boolean;
  timeoutUser: boolean;
}

/** 플랫폼 연결. 정규화(플랫폼 형식 → Envelope)만 하고 로직은 갖지 않습니다. */
export interface PlatformAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  start(emit: (env: Envelope) => void): Promise<void>;
  stop(): Promise<void>;
  sendChat(text: string): Promise<void>;
  status(): AdapterStatus;
}
