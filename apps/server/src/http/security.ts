/**
 * 로컬 서버라도 악성 웹페이지가 브라우저를 통해 localhost를 찌를 수 있습니다. (DESIGN.md §10)
 *  - Host 헤더 검증: DNS rebinding 차단
 *  - 대시보드 세션: HttpOnly + SameSite=Strict 쿠키
 *  - 변경 요청: 커스텀 헤더 필수 → 교차 출처 요청은 CORS preflight에서 막힘
 */
export const SESSION_COOKIE = 'lb_session';
export const CSRF_HEADER = 'x-localbot';

export function hostAllowed(req: Request, port: number): boolean {
  const host = req.headers.get('host');
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function hasSession(req: Request, key: string): boolean {
  const cookie = req.headers.get('cookie') ?? '';
  return cookie.split(/;\s*/).some((c) => c === `${SESSION_COOKIE}=${key}`);
}

export function csrfOk(req: Request): boolean {
  return req.headers.get(CSRF_HEADER) === '1';
}

export function sessionCookie(key: string): string {
  return `${SESSION_COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
