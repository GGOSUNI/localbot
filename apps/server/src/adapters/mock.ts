import type { Envelope, Viewer } from '@localbot/shared';
import { envelope } from '../core/bus.ts';
import { createLogger } from '../core/logger.ts';
import type { AdapterStatus, PlatformAdapter } from './types.ts';

const log = createLogger('mock');

/** 방송 없이 개발·테스트하기 위한 가짜 플랫폼. 대시보드의 "테스트" 버튼도 이걸 씁니다. */
export class MockAdapter implements PlatformAdapter {
  readonly id = 'mock';
  readonly capabilities = { sendChat: true, deleteMessage: false, timeoutUser: false };
  readonly outbox: string[] = [];
  private emit: ((env: Envelope) => void) | null = null;

  async start(emit: (env: Envelope) => void) {
    this.emit = emit;
  }
  async stop() {
    this.emit = null;
  }
  status(): AdapterStatus {
    return this.emit ? 'connected' : 'disconnected';
  }
  async sendChat(text: string) {
    this.outbox.push(text);
    log.info(`[bot → chat] ${text}`);
  }

  chat(nickname: string, text: string, roles: Viewer['roles'] = ['viewer']) {
    this.push({ type: 'chat', viewer: mockViewer(nickname, roles), text, msgId: crypto.randomUUID() });
  }

  donation(nickname: string | null, amountKRW: number, text?: string) {
    this.push({
      type: 'donation',
      viewer: nickname ? mockViewer(nickname, ['viewer']) : null,
      amountKRW,
      text,
      kind: 'chat',
    });
  }

  private push(event: Envelope['event']) {
    if (!this.emit) throw new Error('mock adapter not started');
    this.emit(envelope('mock', event));
  }
}

function mockViewer(nickname: string, roles: Viewer['roles']): Viewer {
  return { platform: 'chzzk', id: `mock-${nickname}`, nickname, roles };
}
