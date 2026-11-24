import type { Database } from 'bun:sqlite';
import type { ConnectionState } from '@localbot/shared';
import { ChannelNotFoundError, ChzzkReadonlyAdapter, fetchChannelName } from '../adapters/chzzk/readonly.ts';
import { parseChannelInput } from '../adapters/chzzk/parse.ts';
import { getSetting, setSetting } from './db.ts';
import type { Ingest } from './ingest.ts';
import { createLogger } from './logger.ts';

const log = createLogger('connection');
const KEY = 'chzzk.channel';

const IDLE: ConnectionState = {
  channelId: null, channelName: null, live: false, liveTitle: null, chat: 'idle', mode: null, error: null,
};

/** "채널 주소 붙여넣기 → 끝"을 담당. 설정을 저장해 두고 다음 실행 때 자동 연결합니다. */
export class ChzzkConnection {
  private adapter: ChzzkReadonlyAdapter | null = null;
  state: ConnectionState = { ...IDLE };

  constructor(
    private db: Database,
    private ingest: Ingest,
    private onState: (s: ConnectionState) => void,
  ) {}

  async restore() {
    const saved = getSetting<{ channelId: string; channelName: string } | null>(this.db, KEY, null);
    if (saved) await this.start(saved.channelId, saved.channelName);
  }

  async setChannel(input: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const channelId = parseChannelInput(input);
    if (!channelId) return { ok: false, error: '치지직 채널 주소를 확인해 주세요. 예) https://chzzk.naver.com/live/…' };
    let channelName: string;
    try {
      channelName = await fetchChannelName(channelId);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof ChannelNotFoundError ? '존재하지 않는 채널입니다' : '치지직 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요',
      };
    }
    setSetting(this.db, KEY, { channelId, channelName });
    await this.start(channelId, channelName);
    return { ok: true };
  }

  async clear() {
    await this.adapter?.stop();
    this.adapter = null;
    this.db.query('DELETE FROM settings WHERE key = ?').run(KEY);
    this.update({ ...IDLE });
  }

  private async start(channelId: string, channelName: string) {
    await this.adapter?.stop();
    log.info(`connecting to ${channelName} (${channelId})`);
    const adapter = new ChzzkReadonlyAdapter(channelId, channelName, (s) => {
      if (this.adapter === adapter) this.update(s);
    });
    this.adapter = adapter;
    this.update({ ...adapter.state });
    await adapter.start((env) => this.ingest.push(env));
  }

  private update(s: ConnectionState) {
    this.state = s;
    this.onState(s);
  }
}
