# QA 대시보드

DoHands QA팀을 위한 실시간 QA 대시보드. GitHub Pages로 호스팅되고, 15분마다 GitHub Actions가 Jira / Confluence / Slack에서 데이터를 가져와 `data.json`을 갱신합니다.

## 라이브 사이트

Settings → Pages 에서 활성화한 뒤 `https://<계정>.github.io/qa-ops-console/` 로 접속합니다.

## 필요한 설정 (저장소 소유자가 직접 등록)

**절대 API 토큰/비밀번호를 AI 에이전트나 제3자에게 대신 입력시키지 마세요.** 아래 값은 반드시 GitHub 저장소 소유자 본인이 `Settings → Secrets and variables → Actions → New repository secret`에서 등록해야 합니다.

| Secret 이름 | 설명 | 발급 위치 |
|---|---|---|
| `JIRA_EMAIL` | Atlassian 계정 이메일 | - |
| `JIRA_API_TOKEN` | Atlassian API 토큰 | https://id.atlassian.com/manage-profile/security/api-tokens |
| `SLACK_BOT_TOKEN` | Slack Bot 토큰 (xoxb-...) | https://api.slack.com/apps 에서 앱 생성 후 Bot Token Scopes: `channels:history`, `channels:read`, `channels:join`, `groups:history`, `groups:read`, `users:read` 부여. **private 채널(#기술-qa팀, #sigint, #sigvise)은 봇을 채널에 직접 초대해야 읽을 수 있습니다.** |

시크릿을 등록한 뒤에는 Actions 탭 → "Sync QA data" 워크플로 → "Run workflow"로 한 번 수동 실행해 정상 동작을 확인하세요.

## 데이터 소스별 상태

- **Jira** — project `QA`/`BE`/`FE`/`PRODUCT` 실 데이터 (버그 심각도별 현황, 티켓 퍼널, 주간 심각도 유입 추이, 마감일 기반 캘린더 이벤트)
- **Confluence** — `QA팀` 스페이스(`qa`)의 최근 수정 문서 4건
- **Slack** — 채널: `기술-로보틱스팀`, `기술-휴가`, `기술-qa팀`, `기술조직`, `sigint`, `sigvise`, 그리고 `기술과제-`로 시작하는 모든 채널. 메시지는 `#기술-qa팀` 채널 멤버(QA팀)가 작성한 것만 표시됩니다. `#기술-qa팀`에 봇이 없으면 피드가 비어 있습니다.
- **수동 값 (매뉴얼 배지 표시)** — 회귀 테스트 통과율, P0 SLA 준수율, 커버리지, MTTR, 온콜 일정, 환경 상태, Flaky 테스트 목록. 연동 가능한 소스가 정해지면 `scripts/sync.mjs`에 추가하세요.

## 파일 구성

- `index.html` — 대시보드 (data.json을 fetch해서 렌더링)
- `data.json` — 최신 데이터 (Actions가 자동 갱신)
- `scripts/sync.mjs` — 동기화 스크립트
- `.github/workflows/sync.yml` — 15분마다 실행되는 스케줄 워크플로
