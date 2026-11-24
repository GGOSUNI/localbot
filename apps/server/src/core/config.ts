export const VERSION = '0.0.1';

export const config = {
  host: process.env.LOCALBOT_HOST ?? '127.0.0.1',
  /** 오버레이 URL이 바뀌면 안 되므로 랜덤 포트를 쓰지 않습니다. */
  port: Number(process.env.LOCALBOT_PORT ?? 7777),
  openBrowser: process.env.LOCALBOT_NO_BROWSER !== '1',
  /** 후원 중복 제거 시간 창 (ms) — 공식/읽기전용 연결이 겹칠 때 */
  donationDedupWindowMs: 3000,
};
