# LocalBot 간편 로그인 서버

모든 LocalBot 사용자가 **키 입력 없이 "치지직으로 로그인" 버튼 하나**로 봇 답장을 켤 수 있게 해 주는 작은 서버입니다.
치지직 앱의 Client Secret은 이 서버에만 있고(사용자 exe에는 없음), 서버는 아무것도 저장하지 않습니다.

## 배포 (개발자가 처음 한 번만, 무료)
Windows: **`deploy.bat` 더블클릭** (Node.js 필요) · Node 없이: `browser-deploy.txt` 따라 브라우저에서 → 안내대로 진행.

직접 하려면:
```bash
npx wrangler login
npx wrangler deploy                      # → https://localbot-relay.<계정>.workers.dev
# 치지직 개발자센터 앱 등록: 리디렉션 URL = 위 주소 + /callback, 권한 = 유저 정보 조회 + 채팅 메시지 쓰기
npx wrangler secret put CHZZK_CLIENT_ID
npx wrangler secret put CHZZK_CLIENT_SECRET
```
그다음 `apps/server/src/core/config.ts`의 `RELAY_URL`에 주소를 넣고 빌드하면 끝.

## 동작
| 경로 | 하는 일 |
|---|---|
| `GET /login?port&nonce` | 치지직 동의 화면으로 |
| `GET /callback` | 토큰 발급 → `http://localhost:<port>/oauth/relay#…` 로 전달 (주소 # 뒤라 서버 로그에 안 남음) |
| `POST /refresh` | 토큰 갱신 (하루 1번) |
| `POST /revoke` | 로그아웃 |

Cloudflare Workers 무료 한도(하루 10만 요청)면 사용자 수천 명도 충분합니다.
