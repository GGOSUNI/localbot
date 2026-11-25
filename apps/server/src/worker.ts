import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { Envelope } from '@localbot/shared';
import { ChzzkOfficial } from './adapters/chzzk/official.ts';
import { MockAdapter } from './adapters/mock.ts';
import { EventBus, envelope } from './core/bus.ts';
import { config } from './core/config.ts';
import { ChzzkConnection } from './core/connection.ts';
import { backup, getSetting, openDatabase, setSetting } from './core/db.ts';
import { Ingest } from './core/ingest.ts';
import { createLogger } from './core/logger.ts';
import { backupDir, dashboardKeyPath, dataDir, dbPath } from './core/paths.ts';
import { type HttpHandle, startHttp } from './http/server.ts';
import { CommandRouter } from './modules/commands.ts';
import { RouletteService } from './modules/roulette/service.ts';
import { registerSongCommands } from './modules/songs/commands.ts';
import { SongService } from './modules/songs/service.ts';
import { ensureDashboardKey } from './supervisor.ts';

const log = createLogger('worker');

/** Worker 종료 코드: Supervisor가 재시작 전략을 고르는 데 씀 */
export const EXIT = { OK: 0, CRASH: 1, PORT_IN_USE: 3 } as const;

export async function runWorker(): Promise<void> {
  const startedAt = Date.now();

  // 상태를 망가뜨린 채 계속 도는 것보다, 죽고 Supervisor가 깨끗하게 다시 띄우는 편이 안전합니다.
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception — exiting for supervisor restart', err);
    process.exit(EXIT.CRASH);
  });
  process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection — exiting for supervisor restart', err);
    process.exit(EXIT.CRASH);
  });
  // Supervisor가 사라지면(IPC 끊김) 고아 프로세스로 남지 않음
  process.on('disconnect', () => process.exit(EXIT.OK));

  mkdirSync(dataDir, { recursive: true });
  const dashboardKey = existsSync(dashboardKeyPath) ? readFileSync(dashboardKeyPath, 'utf8').trim() : ensureDashboardKey();

  const db = openDatabase(dbPath, backupDir);
  const bus = new EventBus();
  const ingest = new Ingest(db, bus, config.donationDedupWindowMs);
  let http: HttpHandle | null = null;

  // 오버레이(OBS) 키: 대시보드 키와 분리. 방송 화면에 URL이 노출돼도 재발급하면 끝
  const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
  if (!getSetting<string | null>(db, 'overlay.key', null)) setSetting(db, 'overlay.key', newKey());
  let overlayKey = getSetting<string>(db, 'overlay.key', '');

  const mock = new MockAdapter();
  await mock.start((env) => ingest.push(env));
  const connection = new ChzzkConnection(db, ingest, (s) => http?.broadcastConnection(s));

  const official = new ChzzkOfficial(db, config.port, () => http?.broadcastOfficial(official.status()), fetch, Date.now, config.relayUrl || null);

  // 봇 응답: 공식 연결로 로그인돼 있으면 치지직 채팅방에, 아니면 대시보드에만 표시
  const reply = (text: string, origin?: Envelope) => {
    if (origin?.source === 'mock') {
      void mock.sendChat(text);
      ingest.push(envelope('system', { type: 'bot', text, delivered: true }));
      return;
    }
    if (official.canSend) {
      void official.sendChat(text).then((ok) => ingest.push(envelope('system', { type: 'bot', text, delivered: ok })));
      return;
    }
    ingest.push(envelope('system', { type: 'bot', text, delivered: false }));
  };
  const notify = (level: 'info' | 'warn', message: string) => ingest.push(envelope('system', { type: 'system', level, message }));

  const songs = new SongService({ db, notify, reply: (t) => reply(t), onChange: () => http?.broadcastSongs() });
  const roulette = new RouletteService({ db, reply: (t) => reply(t), onChange: () => http?.broadcastRoulette() });

  const commands = new CommandRouter(reply);
  registerSongCommands(commands, songs);

  bus.on(async (env) => {
    const e = env.event;
    if (e.type === 'chat') await commands.handle(env);
    if (e.type === 'donation') {
      roulette.onDonation(e.viewer, e.amountKRW);
      await songs.onDonation(e.viewer, e.amountKRW, e.text);
    }
    if (e.type === 'stream' && e.state === 'online') backup(db, backupDir, 'stream-start');
  });

  try {
    http = startHttp({
      host: config.host,
      port: config.port,
      dashboardKey,
      overlayKey: () => overlayKey,
      regenerateOverlayKey: () => {
        overlayKey = newKey();
        setSetting(db, 'overlay.key', overlayKey);
        return overlayKey;
      },
      bus, ingest, mock, connection, songs, roulette, official,
      // 공식 로그인한 채널로 채팅·후원 수신도 맞춤
      onOfficialLogin: async (channelId) => {
        if (connection.state.channelId !== channelId) await connection.setChannel(channelId);
      },
      workerStartedAt: startedAt,
      onCrashRequested: () => {
        log.warn('crash requested from dashboard');
        process.exit(EXIT.CRASH);
      },
      onQuitRequested: () => {
        // Supervisor에게 앱 전체 종료를 요청 (없으면 자기만 종료)
        if (process.send) process.send({ type: 'quit' });
        else shutdown();
      },
    });
  } catch (err) {
    log.error(`cannot listen on ${config.host}:${config.port} (이미 사용 중인 포트일 수 있음)`, err);
    process.exit(EXIT.PORT_IN_USE);
  }

  songs.start();
  ingest.push(envelope('system', { type: 'system', level: 'info', message: `LocalBot 시작 (pid ${process.pid})` }));
  await connection.restore(); // 지난번 채널로 자동 연결

  function shutdown() {
    log.info('shutting down');
    songs.stop();
    http?.stop();
    db.close();
    process.exit(EXIT.OK);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.send?.({ type: 'ready', pid: process.pid });
}
