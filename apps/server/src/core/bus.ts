import type { BotEvent, Envelope, EventSource } from '@localbot/shared';
import { createLogger } from './logger.ts';

const log = createLogger('bus');

type Handler = (env: Envelope) => void | Promise<void>;

/**
 * 모듈 간 유일한 통신 경로.
 * 한 핸들러가 예외를 던져도 다른 핸들러와 버스는 계속 동작해야 합니다.
 */
export class EventBus {
  private handlers = new Set<Handler>();

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publish(env: Envelope): void {
    for (const h of this.handlers) {
      try {
        const r = h(env);
        if (r instanceof Promise) r.catch((err) => log.error(`handler failed (${env.event.type})`, err));
      } catch (err) {
        log.error(`handler failed (${env.event.type})`, err);
      }
    }
  }
}

export function envelope(source: EventSource, event: BotEvent, ts = Date.now()): Envelope {
  return { id: crypto.randomUUID(), ts, source, event };
}
