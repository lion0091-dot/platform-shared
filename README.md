# platform-shared

플랫폼 공용 코드(wholesale·shipping-prj 등이 가져다 쓴다). 공개 저장소(비밀값 금지), 소스(.ts)를 그대로 두고 쓰는 앱이 빌드한다.

## 들어 있는 것
- `@platform/shared/push/fcm` — FCM(HTTP v1) 서버 발송. 환경변수 `FCM_PROJECT_ID`·`FCM_CLIENT_EMAIL`·`FCM_PRIVATE_KEY` 가 없으면 아무것도 안 보낸다.
- `@platform/shared/push/native` — Capacitor 앱 안에서 알림 권한·토큰 등록·알림 탭 이동. `createNativePush({ tapPath, channel })` 로 앱마다 다른 경로·채널 문구를 넣는다.

- `@platform/shared/account` — account(회계 장부) 연동의 순수 계산: `buildSignedCall`(정지·해제·접근 모드·보류 읽기·대표 이전 호출의 본문+서명), `signSsoToken`(SSO 토큰), `classifyAccountResponse`(응답 → 성공/재시도/멈춤). 약속은 account 저장소 `docs/contract/integration-contract.md`, 시험 벡터는 `src/account/__vectors__/`(account 것의 복사본 — 약속이 바뀌면 다시 복사). DB·큐·네트워크 전송은 들어 있지 않다(각 앱이 한다).
- `@platform/shared/payments` — 토스페이먼츠 승인·조회·취소 호출과 오류 분류(`createTossClient`, `interpretPayment`, 멱등키 함수). 사용법·분류표는 `docs/payments-api-draft.md`. DB·상태머신·결제창 SDK 는 앱 몫.
  - 시험: `npm test` 는 fetch 모의만(외부 호출 없음). 계약 전에도 개발자센터 테스트 키로 실제 토스 테스트 환경을 부를 수 있다: `TOSS_TEST_SECRET_KEY=test_sk_… npm run test:toss`(키 없으면 건너뜀, live 키 거부). 결제 1건 전 과정 시험 절차는 문서 §12.

- `@platform/shared/secrets` — 테넌트별 비밀(결제 키·알림 자격정보 등)을 DB 에 넣기 전에 앱 서버에서 암호화하는 공용 봉투(AES-256-GCM). `sealSecret`/`openSecret`(`ENC:v2:<kid>:…`, AAD=테넌트 id+종류), `loadKeyring`(현재 키+이전 키 로테이션, hex 64자·base64 모두 허용), 기존 두 형식의 읽기 전용 레거시 지원, `resolveSecret`(ok/absent/unavailable 3상태). **서버 전용**(`node:crypto`), 키·평문은 오류·로그에 나오지 않는다. 설계: `docs/tenant-secrets-envelope-design.md`. 시험 벡터는 가짜 키만(`src/secrets/__vectors__/`).
- `@platform/shared/inapp` — 카카오톡 인앱 브라우저 판별(`isKakaoInApp`)·외부 브라우저로 열기 주소(`kakaoExternalOpenUrl`)·경로 접두어 판정(`matchesPathPrefixes`). 순수 함수만 있고, 안내 화면과 경로 목록은 앱이 가진다.

## 쓰는 법(앱 쪽)
1. `package.json`: `"@platform/shared": "github:lion0091-dot/platform-shared#v0.1.0"` (버전은 태그로 고정, 올릴 때 두 앱을 같이 올린다).
2. `next.config`: `transpilePackages: ["@platform/shared"]`.
3. vitest: `test.server.deps.inline: [/@platform\/shared/]`.

## 규칙
- 공용 코드를 고치면 쓰는 앱 모두에 영향 — 여기 시험(`npm test`)과 쓰는 앱의 시험을 같이 통과시킨다.
- **공개 저장소다 — 비밀값(키·토큰·비밀번호)과 실제 데이터는 절대 넣지 않는다.** 서명 방식 같은 알고리즘은 넣어도 된다(보안은 알고리즘이 아니라 비밀키에 있다, 사장님 결정 2026-10-13). 업무 규칙(주문·재고·배차)과 SQL 은 넣지 않는다. 담당: wholesale 세션(대표 역할, 사장님 지정 2026-10-13).
