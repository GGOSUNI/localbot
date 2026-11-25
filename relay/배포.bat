@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo  LocalBot 간편 로그인 서버 배포 (처음 한 번만)
echo  필요: Node.js (https://nodejs.org) , 무료 Cloudflare 계정
echo ============================================
echo.
echo [1/4] Cloudflare 로그인 - 브라우저가 열리면 "Allow"를 누르세요
call npx -y wrangler@3 login || goto :err
echo.
echo [2/4] 서버 올리는 중...
call npx -y wrangler@3 deploy || goto :err
echo.
echo  위에 나온 https://localbot-relay.○○○.workers.dev 주소를 기억하세요.
echo.
echo  [치지직 개발자센터] https://developers.chzzk.naver.com 에서 앱 등록:
echo    - 로그인 리디렉션 URL : 위 주소 + /callback
echo    - API 권한 : 유저 정보 조회, 채팅 메시지 쓰기
echo  등록이 끝나면 아무 키나 누르세요.
pause >nul
echo.
echo [3/4] 치지직 앱의 Client ID를 붙여넣고 Enter
call npx -y wrangler@3 secret put CHZZK_CLIENT_ID || goto :err
echo.
echo [4/4] 치지직 앱의 Client Secret을 붙여넣고 Enter
call npx -y wrangler@3 secret put CHZZK_CLIENT_SECRET || goto :err
echo.
echo ✅ 끝! workers.dev 주소를 Claude에게 알려주세요. LocalBot에 넣어서 다시 빌드합니다.
pause
exit /b 0
:err
echo.
echo ⚠️ 실패했습니다. 이 창을 캡처해서 보내 주세요.
pause
exit /b 1
