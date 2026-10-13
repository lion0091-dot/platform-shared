# platform-shared

플랫폼 공용 코드(wholesale·shipping-prj 등이 가져다 쓴다). 공개 저장소(비밀값 금지), 소스(.ts)를 그대로 두고 쓰는 앱이 빌드한다.

## 들어 있는 것
- `@platform/shared/push/fcm` — FCM(HTTP v1) 서버 발송. 환경변수 `FCM_PROJECT_ID`·`FCM_CLIENT_EMAIL`·`FCM_PRIVATE_KEY` 가 없으면 아무것도 안 보낸다.
- `@platform/shared/push/native` — Capacitor 앱 안에서 알림 권한·토큰 등록·알림 탭 이동. `createNativePush({ tapPath, channel })` 로 앱마다 다른 경로·채널 문구를 넣는다.

- `@platform/shared/account` — account(회계 장부) 연동의 순수 계산: `buildSignedCall`(정지·해제·접근 모드·보류 읽기·대표 이전 호출의 본문+서명), `signSsoToken`(SSO 토큰), `classifyAccountResponse`(응답 → 성공/재시도/멈춤). 약속은 account 저장소 `docs/contract/integration-contract.md`, 시험 벡터는 `src/account/__vectors__/`(account 것의 복사본 — 약속이 바뀌면 다시 복사). DB·큐·네트워크 전송은 들어 있지 않다(각 앱이 한다).

## 쓰는 법(앱 쪽)
1. `package.json`: `"@platform/shared": "github:lion0091-dot/platform-shared#v0.1.0"` (버전은 태그로 고정, 올릴 때 두 앱을 같이 올린다).
2. `next.config`: `transpilePackages: ["@platform/shared"]`.
3. vitest: `test.server.deps.inline: [/@platform\/shared/]`.

## 규칙
- 공용 코드를 고치면 쓰는 앱 모두에 영향 — 여기 시험(`npm test`)과 쓰는 앱의 시험을 같이 통과시킨다.
- **공개 저장소다 — 비밀값(키·토큰·비밀번호)과 실제 데이터는 절대 넣지 않는다.** 서명 방식 같은 알고리즘은 넣어도 된다(보안은 알고리즘이 아니라 비밀키에 있다, 사장님 결정 2026-10-13). 업무 규칙(주문·재고·배차)과 SQL 은 넣지 않는다. 담당: wholesale 세션(대표 역할, 사장님 지정 2026-10-13).
