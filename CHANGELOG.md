# CHANGELOG

`@platform/shared/payments`·`@platform/shared/secrets` 의 변경 이력. 형식은 단순 목록이며, 소비 앱 전환 안내는 `docs/payments-api-draft.md` §9.

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
