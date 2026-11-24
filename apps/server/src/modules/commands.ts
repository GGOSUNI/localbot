import type { BotEvent, Envelope, Viewer } from '@localbot/shared';
import { createLogger } from '../core/logger.ts';

const log = createLogger('commands');

type ChatEvent = Extract<BotEvent, { type: 'chat' }>;

export interface CommandContext {
  viewer: Viewer;
  args: string;
  env: Envelope<ChatEvent>;
  isManager: boolean;
  reply(text: string): void;
}

type Handler = (ctx: CommandContext) => void | Promise<void>;

interface Registered {
  handler: Handler;
  managerOnly: boolean;
  cooldownMs: number;
}

/** `!명령어 인자` 처리. 권한·쿨다운을 한곳에서 */
export class CommandRouter {
  private commands = new Map<string, Registered>();
  private lastUsed = new Map<string, number>();

  constructor(
    private reply: (text: string, env: Envelope) => void,
    private now: () => number = Date.now,
  ) {}

  register(names: string[], handler: Handler, opts: { managerOnly?: boolean; cooldownMs?: number } = {}) {
    for (const n of names) {
      this.commands.set(n.toLowerCase(), { handler, managerOnly: !!opts.managerOnly, cooldownMs: opts.cooldownMs ?? 0 });
    }
  }

  async handle(env: Envelope): Promise<boolean> {
    if (env.event.type !== 'chat') return false;
    const text = env.event.text.trim();
    if (!text.startsWith('!')) return false;
    const [rawName = '', ...rest] = text.split(/\s+/);
    const cmd = this.commands.get(rawName.toLowerCase());
    if (!cmd) return false;

    const viewer = env.event.viewer;
    const isManager = viewer.roles.includes('manager') || viewer.roles.includes('streamer');
    if (cmd.managerOnly && !isManager) return true;

    if (cmd.cooldownMs > 0 && !isManager) {
      const key = `${rawName}:${viewer.id}`;
      const last = this.lastUsed.get(key) ?? 0;
      if (this.now() - last < cmd.cooldownMs) return true;
      this.lastUsed.set(key, this.now());
    }

    try {
      await cmd.handler({
        viewer, args: rest.join(' '), env: env as Envelope<ChatEvent>, isManager,
        reply: (t) => this.reply(t, env),
      });
    } catch (err) {
      log.error(`command ${rawName} failed`, err);
    }
    return true;
  }
}
