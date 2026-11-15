# platform-shared

플랫폼 공용 코드(wholesale·shipping-prj 등이 가져다 쓴다). 공개 저장소(비밀값 금지), 소스(.ts)를 그대로 두고 쓰는 앱이 빌드한다.

## 들어 있는 것
- `@platform/shared/push/fcm` — FCM(HTTP v1) 서버 발송. 환경변수 `FCM_PROJECT_ID`·`FCM_CLIENT_EMAIL`·`FCM_PRIVATE_KEY` 가 없으면 아무것도 안 보낸다.
- `@platform/shared/push/native` — Capacitor 앱 안에서 알림 권한·토큰 등록·알림 탭 이동. `createNativePush({ tapPath, channel })` 로 앱마다 다른 경로·채널 문구를 넣는다.

- `@platform/shared/account` — account(회계 장부) 연동의 순수 계산: `buildSignedCall`(정지·해제·접근 모드·보류 읽기·대표 이전 호출의 본문+서명), `signSsoToken`(SSO 토큰), `classifyAccountResponse`(응답 → 성공/재시도/멈춤). 약속은 account 저장소 `docs/contract/integration-contract.md`, 시험 벡터는 `src/account/__vectors__/`(account 것의 복사본 — 약속이 바뀌면 다시 복사). DB·큐·네트워크 전송은 들어 있지 않다(각 앱이 한다).
- `@platform/shared/payments` — 토스페이먼츠 승인·조회·취소 호출과 오류 분류(`createTossClient`, `interpretPayment`, 멱등키 함수). 사용법·분류표는 `docs/payments-api-draft.md`. DB·상태머신·결제창 SDK 는 앱 몫.
  - 시험: `npm test` 는 fetch 모의만(외부 호출 없음). 계약 전에도 개발자센터 테스트 키로 실제 토스 테스트 환경을 부를 수 있다: bash 는 `TOSS_TEST_SECRET_KEY=test_sk_… npm run test:toss`, PowerShell 은 `$env:TOSS_TEST_SECRET_KEY="test_sk_…"; npm run test:toss`(별도 설정으로만 돌아 `npm test` 에는 안 걸림, 키가 없으면 실패, live 키 거부). 결제 1건 전 과정 시험 절차는 문서 §12.

- `@platform/shared/secrets` — 테넌트별 비밀(결제 키·알림 자격정보 등)을 DB 에 넣기 전에 앱 서버에서 암호화하는 공용 봉투(AES-256-GCM). `sealSecret`/`openSecret`(`ENC:v2:<kid>:…`, AAD=테넌트 id+종류), `loadKeyring`(현재 키+이전 키 로테이션, hex 64자·base64 모두 허용), 기존 두 형식의 읽기 전용 레거시 지원, `resolveSecret`(ok/absent/unavailable 3상태). **서버 전용**(`node:crypto`), 키·평문은 오류·로그에 나오지 않는다. 설계: `docs/tenant-secrets-envelope-design.md`. 시험 벡터는 가짜 키만(`src/secrets/__vectors__/`).
- `@platform/shared/inapp` — 카카오톡 인앱 브라우저 판별(`isKakaoInApp`)·외부 브라우저로 열기 주소(`kakaoExternalOpenUrl`)·경로 접두어 판정(`matchesPathPrefixes`). 순수 함수만 있고, 안내 화면과 경로 목록은 앱이 가진다.

- `@platform/shared/board` — 이원화 게시판의 공용 계약(`board_contract_version` v1): 코드값(분류·상태·작성자 유형·답글 가시성)·가시 범위/답글/승격/전이 판정(`canView`·`canReply`·`canEscalate`·`canTransition`)·`detectPii`·`validateEscalation`·작성 제한과 허용 범위·안내 문구 상수·첨부 규칙 상수와 `validateAttachmentMeta`·감사 이벤트 코드와 2인 승인 요청 계약 상수. 순수 함수·상수만 있고 화면·표·RPC·알림·저장은 앱이 가진다. 계약 문서 `docs/board-contract.md`.
- `@platform/shared/kst` — 서울(Asia/Seoul) 날짜 헬퍼. 업무 날짜는 서울 하나로 통일한다(서버·DB·CI 는 UTC). `kstToday`·`kstDateOf`·`kstDaysAgo`·`kstMonth`, 하루/월의 UTC 구간 `kstDayRange`·`kstMonthRange`(끝 미포함, timestamptz 비교용), `parseKstDate`, 서식 전용 `formatKstDate`. 날짜 계산은 +9시간 보정(Intl 비의존), 시계는 인자로 주입한다. 순수 함수, 의존성 0.
- `@platform/shared/kst/check` — 서울 날짜 규칙 정적 검사(Node 내장만, CI 용). `node node_modules/@platform/shared/src/kst/check.mjs [--all | --changed-since origin/main] [--warn-only] [--json] [--config .kst-check.json]`. 기본은 기준 브랜치와 비교해 «바뀐 줄»만 검사하고(`fetch-depth: 0` 필요), `--all` 은 전수 점검용. 종료 코드 0 통과 / 1 error / 2 사용법·설정 오류. 허용은 같은 줄·윗줄 주석 `kst-ok: <규칙ID> <사유>`(사유 필수) 또는 `.kst-check.json` 의 `allow`(file·rule·match·reason 필수, `expires` 선택, 공백 무시 매칭). 정규식 휴리스틱이라 오탐은 허용 목록으로 처리한다. 규칙 목록은 `RULES` export.
- `@platform/shared/ai-usage-line` — 이음·미트가 월 AI 사용 합계 «한 줄»을 레저코어로 보낼 때 쓰는 **순수 계산** 모음(계약 v1). `buildAiUsageLine`(입력 키 허용 목록·범위·소수 4자리·서울 월·`as_of` 검사, 회사·사용자 정보 혼입 거부), `estimateAiUsageUsd`(모델별 합산 뒤 한 번만 4자리 반올림, 단가 없는 모델은 거부), `classifyAiUsageResponse`(계약 §4 응답 분류), `aiUsageMonthsToSend`(서울 0·6·12·18시 슬롯, 1일은 직전 달 먼저), `buildAiUsageCall`(`buildSignedCall` 래퍼). 시계·비밀은 인자로 받고 네트워크·DB·환경변수는 쓰지 않는다. 호출·집계·크론·켜기는 앱 몫.
- `@platform/shared/ai-usage-tenant-line` — 이음·미트가 «테넌트(운영사·업체)별 월 AI 토큰» 한 줄을 레저코어로 **배치**로 보낼 때 쓰는 순수 계산 모음(계약 v1). `buildAiUsageTenantLine`(허용 키 7개·`ext_id`·범위·서울 월·`as_of` 검사, 이름·금액·사용자·모델·기능 혼입 거부), `checkAiUsageTenantBatch`(배치 선검증: 1~50건·중복·허용 키), `splitAiUsageTenantBatches`(50건·16KB 분할), `buildAiUsageTenantCall`(봉투 7키·`lines`, 16KB 검사), `classifyAiUsageTenantResponse`(200 `{status:"OK",received,stored}`·오류 분류). 읽기 호출(`ai_usage_read`, 레저코어 → 앱 값 조회): `splitAiUsageReadIds`(200개·8,192바이트 중 먼저 닿는 쪽으로 분할), `buildAiUsageReadCall`(본문 검사·서명), `classifyAiUsageReadResponse`(요청한 id·알려진 4개 키·정수만 남기는 응답 정제, R1). 시계·비밀은 인자, 네트워크·DB·환경변수 없음. 어떤 테넌트를 보낼지·호출·집계·크론·켜기는 앱 몫.

## 쓰는 법(앱 쪽)
1. `package.json`: `"@platform/shared": "github:lion0091-dot/platform-shared#v0.1.0"` (버전은 태그로 고정, 올릴 때 두 앱을 같이 올린다).
2. `next.config`: `transpilePackages: ["@platform/shared"]`.
3. vitest: `test.server.deps.inline: [/@platform\/shared/]`.

## 규칙
- 공용 코드를 고치면 쓰는 앱 모두에 영향 — 여기 시험(`npm test`)과 쓰는 앱의 시험을 같이 통과시킨다.
- **공개 저장소다 — 비밀값(키·토큰·비밀번호)과 실제 데이터는 절대 넣지 않는다.** 서명 방식 같은 알고리즘은 넣어도 된다(보안은 알고리즘이 아니라 비밀키에 있다, 사장님 결정 2026-10-13). 업무 규칙(주문·재고·배차)과 SQL 은 넣지 않는다. 담당: wholesale 세션(대표 역할, 사장님 지정 2026-10-13).
