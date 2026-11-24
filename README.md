# LocalBot (가칭)

치지직 스트리머를 위한 **로컬 자립형** 봇. `LocalBot.exe` 하나로 실행되고, 외부 서버나 API 키 없이 동작합니다.

핵심 기능: **절대 고장 안 나는 신청곡 스테이션** · **손쉬운 룰렛** · **완벽한 스탠드얼론**
설계: [docs/DESIGN.md](docs/DESIGN.md)

## 현재 상태: M0 (뼈대)

- Supervisor/Worker 구조: 워커가 죽으면 1초 안에 자동 재시작 (실측 약 0.3~0.4초)
- 이벤트 버스, SQLite(WAL) + 마이그레이션 + 자동 백업
- 후원 중복 제거 (공식/읽기전용 연결이 겹칠 때 룰렛이 두 번 도는 것 방지)
- Mock 어댑터 + 대시보드 (가짜 후원/채팅, 실시간 이벤트, 워커 강제 종료 버튼)
- 로컬 보안: Host 헤더 검증, 세션 쿠키, CSRF 헤더

## 개발

```bash
bun install
bun run dev        # http://127.0.0.1:7777 (콘솔에 접속 주소 표시)
bun test
bun run typecheck
bun run build:win  # dist/LocalBot.exe
```

환경 변수: `LOCALBOT_PORT` `LOCALBOT_HOME` (데이터 위치) `LOCALBOT_NO_BROWSER=1`
