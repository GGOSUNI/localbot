@echo off
cd /d "%~dp0"
title LocalBot 간편 로그인 서버 배포
echo ============================================================
echo   LocalBot 간편 로그인 서버 배포 (처음 한 번만)
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js 가 없습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤
  echo     이 파일을 다시 실행하세요.
  echo     설치 없이 하려면: 같은 폴더의 "browser-deploy.txt" 를 따라 하세요.
  start "" https://nodejs.org
  goto :end
)
echo [1/4] Cloudflare 로그인 - 브라우저가 열리면 Allow 를 누르세요
call npx --yes wrangler@3 login
if errorlevel 1 goto :fail
echo.
echo [2/4] 서버 올리는 중...
call npx --yes wrangler@3 deploy
if errorlevel 1 goto :fail
echo.
echo ------------------------------------------------------------
echo  위에 나온 https://localbot-relay.XXXX.workers.dev 주소를 확인하세요.
echo.
echo  치지직 개발자센터 https://developers.chzzk.naver.com 에서 앱 등록:
echo    - 로그인 리디렉션 URL : 위 주소 뒤에 /callback
echo    - API 권한 : 유저 정보 조회, 채팅 메시지 쓰기
echo  등록을 마치면 아무 키나 누르세요.
echo ------------------------------------------------------------
start "" https://developers.chzzk.naver.com
pause >nul
echo.
echo [3/4] Client ID 를 붙여넣고 Enter (마우스 오른쪽 클릭 = 붙여넣기)
call npx --yes wrangler@3 secret put CHZZK_CLIENT_ID
if errorlevel 1 goto :fail
echo.
echo [4/4] Client Secret 을 붙여넣고 Enter
call npx --yes wrangler@3 secret put CHZZK_CLIENT_SECRET
if errorlevel 1 goto :fail
echo.
echo ============================================================
echo  완료! workers.dev 주소를 Claude 에게 알려주세요.
echo ============================================================
goto :end
:fail
echo.
echo [!] 실패했습니다. 이 창을 캡처해서 보내 주세요.
:end
echo.
pause
