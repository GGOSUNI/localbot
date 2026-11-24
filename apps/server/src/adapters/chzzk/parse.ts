import type { BotEvent, Role, Viewer } from '@localbot/shared';

/**
 * 치지직 채팅 프레임 → 정규화 이벤트. 순수 함수라 실제 방송 없이 테스트할 수 있습니다.
 * 형식은 2026-11 실제 방송에서 받은 프레임 기준 (tests/fixtures 참고).
 */

export const CMD = {
  PING: 0,
  PONG: 10000,
  CONNECT: 100,
  CONNECTED: 10100,
  CHAT: 93101,
  DONATION: 93102,
} as const;

/** 채널 주소/ID 아무거나 → 32자리 채널 ID */
export function parseChannelInput(input: string): string | null {
  const m = input.trim().match(/(?:^|[/=])([0-9a-f]{32})(?:$|[/?#&])/i) ?? input.trim().match(/^([0-9a-f]{32})$/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** 채팅 서버 번호 (kr-ss1~9). 치지직 웹 클라이언트와 같은 계산 */
export function chatServerIndex(chatChannelId: string): number {
  let sum = 0;
  for (const ch of chatChannelId) sum += ch.charCodeAt(0);
  return (Math.abs(sum) % 9) + 1;
}

interface RawMessage {
  uid?: string;
  userId?: string;
  msg?: string;
  content?: string;
  msgTypeCode?: number;
  messageTypeCode?: number;
  msgStatusType?: string;
  profile?: string | null;
  extras?: string | null;
  msgTime?: number;
  messageTime?: number;
  ctime?: number;
}

interface Profile {
  userIdHash?: string;
  nickname?: string;
  userRoleCode?: string;
  streamingProperty?: { subscription?: { accumulativeMonth?: number; tier?: number } };
}

interface Extras {
  isAnonymous?: boolean;
  payAmount?: number;
  donationId?: string;
  donationType?: string;
  month?: number;
  tierName?: string;
}

export interface ParsedEvent {
  event: BotEvent;
  ts: number;
}

export function parseFrame(frame: { cmd?: number; bdy?: unknown }): ParsedEvent[] {
  if ((frame.cmd !== CMD.CHAT && frame.cmd !== CMD.DONATION) || !Array.isArray(frame.bdy)) return [];
  const out: ParsedEvent[] = [];
  for (const raw of frame.bdy as RawMessage[]) {
    try {
      const ev = parseMessage(raw);
      if (ev) out.push(ev);
    } catch {
      /* 형식이 이상한 메시지 하나 때문에 나머지를 잃지 않음 */
    }
  }
  return out;
}

function parseMessage(raw: RawMessage): ParsedEvent | null {
  const type = raw.msgTypeCode ?? raw.messageTypeCode;
  const text = raw.msg ?? raw.content ?? '';
  const ts = raw.msgTime ?? raw.messageTime ?? raw.ctime ?? Date.now();
  const profile = json<Profile>(raw.profile);
  const extras = json<Extras>(raw.extras) ?? {};
  const uid = raw.uid ?? raw.userId ?? '';
  const anonymous = extras.isAnonymous === true || uid === 'anonymous' || !profile;
  const viewer = anonymous ? null : toViewer(uid, profile!);

  switch (type) {
    case 1: // 일반 채팅
      if (!viewer || raw.msgStatusType === 'HIDDEN') return null;
      return { ts, event: { type: 'chat', viewer, text, msgId: `${uid}:${ts}` } };

    case 10: // 후원
      return {
        ts,
        event: {
          type: 'donation',
          viewer,
          amountKRW: Number(extras.payAmount) || 0,
          text: text || undefined,
          kind: donationKind(extras.donationType),
          externalId: extras.donationId,
        },
      };

    case 11: // 구독
      if (!viewer) return null;
      return { ts, event: { type: 'subscription', viewer, months: Number(extras.month) || 1, tier: extras.tierName } };

    default:
      return null;
  }
}

function toViewer(uid: string, p: Profile): Viewer {
  const roles: Role[] = [];
  switch (p.userRoleCode) {
    case 'streamer':
      roles.push('streamer');
      break;
    case 'streaming_channel_manager':
    case 'streaming_chat_manager':
    case 'streaming_channel_admin':
      roles.push('manager');
      break;
  }
  if (p.streamingProperty?.subscription) roles.push('subscriber');
  if (!roles.length) roles.push('viewer');
  return { platform: 'chzzk', id: p.userIdHash ?? uid, nickname: p.nickname ?? '(알 수 없음)', roles };
}

function donationKind(t?: string): 'chat' | 'video' | 'mission' {
  if (t === 'VIDEO') return 'video';
  if (t?.startsWith('MISSION')) return 'mission';
  return 'chat';
}

function json<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
