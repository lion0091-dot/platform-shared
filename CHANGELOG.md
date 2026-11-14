# CHANGELOG

`@platform/shared/payments`·`@platform/shared/secrets` 의 변경 이력. 형식은 단순 목록이며, 소비 앱 전환 안내는 `docs/payments-api-draft.md` §9.

## 다음 rc (미배포) — ai-shared-key 서브패스 (신규)

신규 서브패스 3개, 추가형(기존 API 변경 없음, 핀을 올리지 않으면 영향 없음). 설계: `docs/design-ai-shared-key-module-2026-11.md`.
- `@platform/shared/ai-shared-key`(서버 전용): 공용 AI 키(방식 B)의 키 모양 검사·힌트·봉인·호출 직전 복호화(`withPlatformAiKey`)·예약·기록(`onRecorded` 훅, 2초 타임아웃·실패 격리)·401/403 무효 표시·관리 액션·`anthropicVerifier`·`createAiSharedKey` 팩토리.
- `@platform/shared/ai-shared-key/types`(클라이언트 가능): 타입·예약 코드 6종·`filterAiRows`·`assertNoForbiddenKeys`·`estimateCostUsd`(항상 «추정»).
- `@platform/shared/ai-shared-key/contract`: `checkRpcContract(sqlText, rpcNames?)` — 앱 마이그 SQL 을 RPC 계약 v1 과 정적 대조(DB 접속 없음).
- **마스터 키 환경변수 이름은 기본값이 없다**(`masterKeyEnv` 필수, 앱별). 키·암호문·마스터 키 값은 이 저장소 어디에도 없다.
- SQL 템플릿(`templates/`)과 레저코어 전환은 이번 범위가 아니다(후속).

## v0.4.0-rc.5 — 개인정보 공용 부품(pii-display·free-text), ai-guard 보강, kst 서브패스

신규 서브패스는 모두 추가형이다(기존 API 변경 없음, 핀을 올리지 않으면 영향 없음). 이 버전에는 kst 서브패스(아래 «kst 서브패스» 항목)도 함께 실린다.
- `@platform/shared/pii-display`(규칙 A): 구조화 필드의 기본 마스킹 표시·해제 판정·열람 기록 보조.
- `@platform/shared/free-text`(규칙 B): `maskFreeText` 로 자유 문장 저장 전에 주민(외국인)등록번호·전화·카드·계좌·이메일·사업자번호·키 모양 문자열을 가림. 규칙 버전 `free-text-rules/1`. 실패(길이 초과 등)하면 원문을 돌려주지 않으므로 앱은 저장을 거부해야 한다.
- **이름·주소는 가리지 않는다**: `maskFreeText` 는 이름·주소를 가리지 않고 경고 코드(`NAME_CUE`·`ADDRESS_CUE`, 건수만)만 돌려준다. 한글로 풀어 쓴 숫자도 경고만. 이름·주소가 자유 문장에 섞여 저장되지 않게 하는 것은 앱의 입력 안내·구조화 필드 몫이다.
- ai-guard 보강 5건(`GUARD_RULES_VERSION` `ai-guard-rules/2`): 구분자 변형 탐지, 이름 단서어, 스팬 합치기, 정책 동결, 주소 단서 경고. **동작 주의**: 정책은 컴파일 시점에 복사·동결되어, 그 뒤 원본 정책 객체를 바꿔도 반영되지 않는다.
- 문서: `docs/pii-access-log-sql-example.md`(열람 기록 SQL 예시).

### kst 서브패스 (신규)


`@platform/shared/kst`(서울 날짜 헬퍼: 미트 `lib/time/kst.ts` 승격 + `kstDayRange`·`kstMonthRange`·`parseKstDate`)와 `@platform/shared/kst/check`(서울 날짜 규칙 정적 검사 CLI) 추가. 기존 API 변경 없음, 의존성 0.
- **동작 주의 1 (미트 `kst.ts` 와 다름)**: `kstDateOf` 는 오프셋 없는 시각 문자열(`2026-11-11T23:30:00`, `2026-11-11 23:30:00`)을 **UTC 로 읽는다**. 원본은 실행 환경 시간대에 따라 결과가 갈렸다(개발 PC 와 UTC 서버가 다름). 오프셋이 있으면(`Z`·`+09`·`+09:00`) 그대로 따른다. DB 의 `timestamp without time zone` 을 서울 시각으로 쓰는 앱은 이 가정이 틀리므로 도입 때 확인한다.
- **동작 주의 2 (검사기)**: `ts-iso-slice` 는 `toISOString().slice(0, 7)`(UTC 월)도 error 로 본다.

## v0.4.0-rc.4 — ai-guard 서브패스 (신규, 코어)

`@platform/shared/ai-guard` 추가(기존 API 변경 없음, 의존성 0). 외부 AI 전송 전 개인정보 검사·가림. 순수 함수 `guard(input, policy)` 하나가 가린 결과를 돌려준다.
- 필드 허용(경로·text/enum/number/boolean), 선언 밖 키 `DROP`/`BLOCK`(기본 BLOCK, 키 이름은 기록하지 않음).
- 패턴: 주민(외국인)등록번호·사업자번호(체크섬)·전화(대표번호 포함)·계좌(하이픈 유/무)·이메일·카드(Luhn)·차량번호(기본 OFF)·키 모양 문자열(항상 차단). 날짜·금액·소수는 오탐 제외.
- 이름·상호 표지(보수적·의심 스팬), 앱 사전 `knownTerms` 정확 일치, `extraOrgMarkers`/`extraPersonCues`, 동기 `extraDetectors`(스팬만, 합집합만, 실패=차단).
- 종류별 처리 `kinds`: MASK/BLOCK/PASS/OFF (주민·카드·계좌·키 모양은 PASS/OFF 불가). `level`: STRICT(의심=차단)/STANDARD(의심=가림 후 재검사).
- 토큰 치환 `[KIND_n]`, `restore()`(`restoreKinds` 필수, 모르는 토큰·비복원 토큰 분리 보고), 토큰 모양 충돌 `ESCAPE`/`BLOCK`.
- fail-closed: 절대 throw 안 함, 길이·치환 수 상한, 치환 결과 재검사(post-check, 앱 감지기 포함), 리포트·오류에 원문 없음. `reasonCodes()`, `GUARD_KINDS`/`GUARD_REASONS`.
- 확장(guardBatch·narrowPolicy·normalizeOrgName·scan·restoreDeep·AMOUNT·tags·guardAsync)은 포함하지 않음. 설계: 로컬 문서(공개 저장소 미반영).

## v0.4.0-rc.3 — 보안 수정 (account 서명·SSO 입력 검증, board 실패 시 닫힘·이메일 감지 시간 상한)

공개 API 이름·시그니처 변경 없음. 정상 입력의 동작은 그대로이고, 아래 잘못된 입력은 이제 오류로 거부되거나 닫힘으로 처리된다(동작 변경).
- `buildSignedCall`: `fields` 에 예약 키(`system`·`action`·`ext_tenant`·`jti`·`iat`·`exp`)가 있으면 `CALL_RESERVED_FIELD` 오류. 빈 비밀·문자열이 아닌 비밀은 `SIGN_SECRET_INVALID`, 유한한 양수가 아닌 `ttl` 은 `SIGN_TTL_INVALID`, 유한하지 않은 `now` 는 `SIGN_NOW_INVALID`. `ttl` 은 여전히 최대 60초로 줄인다.
- `signSsoToken`: 같은 비밀·`ttl`·`now` 검증. `ssoTarget` 은 `/ledger` 아래에서 `.`·`..` 구간(퍼센트 인코딩·이중 인코딩 포함), 인코딩된 구분자, 제어문자, 깨진 퍼센트 인코딩이 있으면 `/ledger` 로 되돌린다.
- `canTransition`: `actorSide` 가 `PLATFORM` 이 아닌 알 수 없는 값(오타·소문자·널)은 플랫폼 권한으로 취급하지 않고 거부(실패 시 닫힘).
- `detectPii` 이메일 패턴: 로컬 파트를 64자로 묶어 `@` 없는 긴 입력에서의 이차 시간을 막음. 「포함 여부」 판정 결과는 같다.
- 문서만: `docs/design-two-tier-board-shared-2026-11.md` 공개용 정리(내부 식별자·약점 메모·운영 절차 제거).
- 소비 앱: 위 거부 동작이 영향을 줄 수 있는 호출(예약 키를 fields 로 넘김, 빈 비밀·잘못된 ttl/now, 비정상 `to`, 알 수 없는 `actorSide`)이 없는지 핀을 올릴 때 각 앱이 시험으로 확인한다.

## v0.4.0-rc.2 — board: 2층 승격은 직원 전원

`board_contract_version` v1 유지(값·코드 이름 변경 없음, 권한 규칙만 완화).
- `canEscalate`·`canTransition(NONE→RECEIVED, TENANT)`·`validateEscalation`: 승격은 테넌트 직원(STAFF) 전원 가능. `hasEscalateRole` 은 승격 판정에서 무시(옵션·호환용, `validateEscalation` 입력에서는 생략 가능). 승격 때 `NOT_AUTHORIZED` 는 더 이상 나오지 않음.
- 그대로: 재오픈(DONE→RECEIVED)은 `hasEscalateRole`(대표·매니저급)만. 내용 지우기·설정·첨부 삭제는 앱이 기존대로 관리 권한자에게만.
- 첨부: 업로더 유형 `BOARD_ATTACH_UPLOADER_KINDS`(`STAFF`·`PLATFORM_ADMIN`)와 `canAttachToReply` 추가(하위호환 추가). 플랫폼 운영자는 본인 답글 단위만, 개인정보 확인 문구는 업로더별 구분, 정지·만료(LIMITED) 허용·해지(CLOSED) 거부(앱 판정)를 계약 §9 에 명시.
- 벡터 `transitions.json`: `NONE→RECEIVED TENANT 권한 false` 가 거부에서 허용으로 이동. 앱은 DB 전이 대조 시험을 이 벡터로 갱신.
- 문서만: `docs/board-contract.md` §5-1 동시성·중복 호출 요구(앱 필수), `docs/payments-app-checklist.md` 신규(결제 앱 체크리스트 초안). 코드 변경 없음.
- 버전 표기: 태그 v0.4.0-rc.1 시점의 package.json 은 0.3.0-rc.3 으로 남아 있었다(태그는 옮기지 않음). 이 버전부터 package.json 이 태그와 같다.

## v0.4.0-rc.1 — board 서브패스 (신규)

`@platform/shared/board` 추가(기존 API 변경 없음). 설계 `docs/design-two-tier-board-shared-2026-11.md`, 계약 `docs/board-contract.md`(`board_contract_version` v1). 순수 함수·상수만, 의존성 추가 없음(EXIF 제거 라이브러리는 포함하지 않음 — 앱, 별도 승인).
- 코드값: 1층 분류 4(`NOTICE`·`QUESTION`·`HANDOVER`·`SUGGESTION`), 2층 분류 4, 2층 상태 5, 작성자 유형 `STAFF`/`USER`, 답글 가시성 `AUTHOR`/`TENANT_ONLY`/`PLATFORM`, 앱 키 3, 분석 뷰 `board_escalations_v`와 열 목록, 오류 코드.
- 판정: `canView`·`canViewReply`·`canReply`·`allowedReplyVisibilities`·`canEscalate`·`canTransition`·`requiresReason`·`validateEscalation`·`needsStaffReply`, `detectPii`(전화·주민번호·계좌·이메일 형태, 종류만 반환).
- 설정: 작성 제한 기본값·허용 범위(`BOARD_SETTINGS`)와 `validateSetting`·`clampSetting`·`effectiveSetting`·`writeLimits`·`exceedsLimit`, 안내 문구 상수(`locked` 포함)와 `validateOverride`·`resolveNotice`.
- 첨부: 상수(5개·4MB·합계 15MB·허용 확장자·금지 확장자)와 `validateAttachmentMeta`(이름·크기·앞부분 바이트)·`sanitizeDisplayName`·`exceedsAttachLimit`·`exceedsDailyAttachBytes`.
- 감사·승인: 감사 action 코드(`board.*`)·위험 단계 표·사유 검증·2인 승인 요청 표 열/상태 계약 상수와 `validateApprovalDecision`·`approvalExpiresAt`. 2인 승인 장치는 2단계(오픈 전 필수).
- 시험 벡터 `src/board/__vectors__/`(전이표·개인정보). package.json 버전은 태그 승인 때 정한다.

## v0.3.0-rc.3 — inapp 서브패스 (신규)

`@platform/shared/inapp` 추가(기존 API 변경 없음). 카카오톡 인앱 브라우저 처리 중 두 소비 앱이 각자 갖고 있던 순수 로직만 공용화.
- `isKakaoInApp(userAgent)`: UA 에 `kakaotalk`(대소문자 무관)가 있으면 참, null·undefined·빈 문자열은 거짓.
- `kakaoExternalOpenUrl(pageUrl)`: `kakaotalk://web/openExternal?url=<encodeURIComponent(pageUrl)>`.
- `matchesPathPrefixes(pathname, prefixes)`: 정확 일치 또는 `접두어/` 로 시작하면 참(`/shopping` 은 `/shop` 에 안 걸림), null 거짓. 경로 목록은 앱이 넘긴다.
- 안내 화면(React)·쿠키·로그인·앱별 경로 목록은 공용에 없다. 정규식 규칙(예: `/o/<코드>` 처럼 코드 세그먼트 필수)이 필요한 앱은 접두어 판정 대신 자기 정규식을 유지한다.

## v0.3.0-rc.2 — secrets 서브패스 (신규; 태그는 사장님 승인 후 생성)

`@platform/shared/secrets` 추가(payments 와 별개, 기존 API 변경 없음). 설계 `docs/tenant-secrets-envelope-design.md`.
- 봉투 `ENC:v2:<kid>:<base64url(iv‖태그‖암호문)>`, AES-256-GCM, AAD = 테넌트 id(소문자)+provider. 쓰기는 항상 v2·현재 키.
- 키 로더 `loadKeyring(env, { current?, previous? })`: hex 64자·base64/base64url 32바이트, 현재 키+`<이름>_PREVIOUS`(쉼표 다수) 로테이션, kid = 키 SHA-256 앞 4바이트.
- 읽기 전용 레거시: 접두 `ENC:v1:`(AAD=테넌트 id 문자열), 접두 없는 `iv.태그.암호문`(AAD 없음) → `needsRewrite: true`.
- `resolveSecret`/`readFailed`/`jsonSecret`: ok/absent/unavailable 3상태.
- 오류는 코드 문자열만(`SECRET_*`), 키링은 키 바이트를 노출하지 않음. 서버 전용(`node:crypto`).

## v0.3.0-rc.2 — payments (태그는 사장님 승인 후 생성, main 병합 없음)

기준: v0.3.0-rc.1(`0db3db3`) 대비. 두 소비 앱은 아직 `#v0.2.2`(payments 없음)에 고정이라 **지금 깨지는 곳은 없고, 핀을 올릴 때부터 적용**된다.

> **버전 메모**: v0.3.0-rc.1 이 이미 공개 태그인데 이 변경에서 breaking 이 다시 들어간다(rc 는 안정 API 약속 없음, 소비 앱은 아직 `#v0.2.2`). 다음 버전은 **`0.3.0-rc.2`** 로 결정됨(사장님). 태그 생성·공개 push 는 사장님이 platform 세션에서 직접 승인한 뒤에만 한다.

### BREAKING (타입·분기 영향)
- `TossConfig.expectedMode` **필수**(`"test" | "live" | "unchecked"`). 생략하면 `KEY_MODE_REQUIRED` 를 던진다. 접두사(`test_sk_`·`live_sk_`, 위젯 `gsk`)와 다르면 `KEY_MODE_MISMATCH`. `"unchecked"` 는 토스 도메인이 아닌 `baseUrl`(모의 서버)에서만 허용(아니면 `KEY_MODE_UNCHECKED_FORBIDDEN`).
- `ConfirmOutcome` 에 `{ kind: "waiting_for_deposit"; payment }` 추가 — `switch` 를 exhaustive 하게 쓰는 소비자는 분기 추가 필요.
- `PaymentInterpretation` 에 `"waiting_for_deposit"` 추가(이전엔 `in_progress`).
- `ConfirmMismatchReason` 에 `"CURRENCY_MISMATCH"`(승인 응답 통화가 KRW 가 아님)·`"TAX_FREE_MISMATCH"`(`expectedTaxFreeAmount` 지정 시 면세 금액 불일치) 추가.
- `getPayment` 가 `async` 함수가 됨: 입력 오류가 동기 throw 가 아니라 rejected Promise 로 나온다(`await`/`.catch` 를 쓰면 동일).
- `TossPayment.secret` 은 열거되지 않는 속성: `JSON.stringify`·스프레드·`Object.keys` 에 나오지 않고 **`structuredClone`·큐·캐시 직렬화를 거치면 사라진다**(`payment.secret` 직접 읽기는 원본에서 동일). 직렬화 전에 읽을 때는 `getPaymentSecret(payment)`(신규).

### 동작 변경 (타입은 그대로, 결과가 달라질 수 있음)
- `FDS_ERROR`(confirm) `fatal` → `uncertain`(본인 인증 뒤 결제가 이어질 수 있음).
- 본문 없는 `HTTP_401`: 조회·취소 → `fatal`(전엔 `uncertain`), **승인은 `uncertain` 유지**(일시 앞단 장애로 승인된 결제가 FAILED 가 되는 것 방지; 앱은 `HTTP_401` 코드를 알림 대상으로). 본문 없는 `HTTP_403` 은 `uncertain` 유지.
- 조회 `not_found` 는 코드가 `NOT_FOUND_PAYMENT` 일 때만. 코드 없는/다른 코드의 404 는 `uncertain`.
- 취소: `NOT_CANCELABLE_AMOUNT` 인데 조회로 이미 반영된 취소로 확인되면 `not_cancelable` 대신 `canceled`(`alreadyCanceled:true`). 부분 취소는 누계 일치 + 취소 이력의 (금액, 사유) 일치까지 확인(다른 경로의 같은 금액 취소를 오판하지 않음, 한계는 docs 참조) — `cancelReason` 에 요청별 고유값 권장.
- 취소: 부분 취소 요청의 `ALREADY_CANCELED_PAYMENT` 는 현재 누계 = 요청 전 누계+금액일 때만 `canceled`(`alreadyCanceled:true`), 결제가 다른 이유로 전액 취소돼 있으면 `not_cancelable`.
- 취소: 부분 취소 응답 누계 불일치 시 모듈이 조회 1회 추가 — 적용 확인되면 `canceled`, 아니면 `uncertain`(`CANCEL_NOT_APPLIED`/`CANCEL_TOTAL_MISMATCH`)에 `currentCanceledTotal`.
- 취소 항목의 `cancelStatus` 가 `DONE`(또는 값 없음)이 아니면(진행 중·실패) 취소 누계·완전 취소 판정·응답 검증에서 제외.
- 취소 응답: `balanceAmount` 없는 `PARTIAL_CANCELED` 도 `cancels` 합 = `totalAmount` 이면 완전 취소 판정.
- 취소 사유가 비어 있으면 throw(`INVALID_CANCEL_REASON`), `paymentKey` 형식 검사(`INVALID_PAYMENT_KEY`), `timeoutMs` 상한 120000ms·비정상 값은 15000ms.
- 키 앞뒤 공백·개행은 지우고 판정·전송.
- 확정 거절(`fatal`) 코드 추가: `EXCEED_MAX_*`, `NOT_ALLOWED_POINT_USE`, `BELOW_MINIMUM_AMOUNT`, `NOT_AVAILABLE_PAYMENT`, `NOT_AVAILABLE_BANK`, `INVALID_PASSWORD` 등(공식 에러 코드 페이지 2026-10-17). 취소 `not_cancelable` 추가: `EXCEED_CANCEL_LIMIT`, `REFUND_REJECTED`, `NOT_ALLOWED_PARTIAL_REFUND*` 등, 취소 `NOT_AVAILABLE_BANK` → `retry_later`.

### 추가 (비breaking)
- `verifyPaymentWebhook`, `WebhookCheck`, `isWebhookSecretValid` — 웹훅은 재조회 기반. 결과 `authenticated`(secret 일치)와 `refetched`(대조 불가, 진위 미확인 — 인증됨으로 쓰지 말 것)를 구분하고, 결제에 secret 이 있는데 본문에 없으면 `SECRET_MISSING` 거부. 설정 오류(KEY_MODE_*)는 던진다.
- `checkPartialCancel`, `PartialCancelCheck`, `canceledTotal`, `CancelOutcome.uncertain.currentCanceledTotal`(선택).
- `getPaymentSecret`.
- `cancelApprovedMismatch`(+ `createTossClient().cancelApprovedMismatch`), `tossKeyMode`, `assertKeyMode`, `TOSS_TIMEOUT_MAX_MS`.
- `ConfirmInput.expectedTaxFreeAmount`(선택)·`interpretPayment` 의 `expected.taxFreeAmount`(선택): 면세·복합과세 상점의 면세 금액 서버 대조.
- `CancelInput.taxFreeAmount`, `CancelInput.refundReceiveAccount`(가상계좌 환불).
- `TossPayment` 선택 필드: `currency`·`taxFreeAmount`·`suppliedAmount`·`vat`·`secret`·`virtualAccount`.

### 참고
- 위 변경은 `feat/toss-confirm-classify` 브랜치에만 올라가 있고 main 병합·`v0.3.0-rc.2` 태그는 아직 없다(태그는 사장님 직접 승인 후). 소비 앱이 이 태그로 핀을 올릴 때 위 BREAKING·전환 지점(`docs/payments-api-draft.md` §9)을 적용한다.
