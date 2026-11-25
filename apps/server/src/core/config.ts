export const VERSION = '0.5.0';

/** 배포한 로그인 중계 서버 주소. 예) https://localbot-relay.ggosuni.workers.dev */
export const RELAY_URL = 'https://localbot-relay.ggosuni.workers.dev';

export const config = {
  host: process.env.LOCALBOT_HOST ?? '127.0.0.1',
  /** 오버레이 URL이 바뀌면 안 되므로 랜덤 포트를 쓰지 않습니다. */
  port: Number(process.env.LOCALBOT_PORT ?? 7777),
  openBrowser: process.env.LOCALBOT_NO_BROWSER !== '1',
  /**
   * 간편 로그인 중계 서버 (relay/ 폴더의 Cloudflare Worker). 배포 후 주소를 여기 넣고 빌드하면
   * 모든 사용자가 키 입력 없이 "치지직으로 로그인" 버튼 하나로 봇 답장을 켤 수 있습니다.
   */
  relayUrl: process.env.LOCALBOT_RELAY ?? RELAY_URL,
  /** 후원 중복 제거 시간 창 (ms) — 공식/읽기전용 연결이 겹칠 때 */
  donationDedupWindowMs: 3000,
};
