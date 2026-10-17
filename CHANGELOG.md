# CHANGELOG

`@platform/shared/payments` 의 변경 이력. 형식은 단순 목록이며, 소비 앱 전환 안내는 `docs/payments-api-draft.md` §9.

## Unreleased (v0.3.0-rc.2 예정, 아직 태그·병합 없음)

기준: v0.3.0-rc.1(`0db3db3`) 대비. 두 앱(shipping-prj·wholesale)은 아직 `#v0.2.2`(payments 없음)에 고정이라 **지금 깨지는 곳은 없고, 핀을 올릴 때부터 적용**된다.

### BREAKING (타입·분기 영향)
- `TossConfig.expectedMode` **필수**(`"test" | "live" | "unchecked"`). 생략하면 `KEY_MODE_REQUIRED` 를 던진다. 접두사(`test_sk_`·`live_sk_`, 위젯 `gsk`)와 다르면 `KEY_MODE_MISMATCH`.
- `ConfirmOutcome` 에 `{ kind: "waiting_for_deposit"; payment }` 추가 — `switch` 를 exhaustive 하게 쓰는 소비자는 분기 추가 필요.
- `PaymentInterpretation` 에 `"waiting_for_deposit"` 추가(이전엔 `in_progress`).
- `ConfirmMismatchReason` 에 `"CURRENCY_MISMATCH"` 추가(승인 응답 통화가 KRW 가 아님).
- `getPayment` 가 `async` 함수가 됨: 입력 오류가 동기 throw 가 아니라 rejected Promise 로 나온다(`await`/`.catch` 를 쓰면 동일).
- `TossPayment.secret` 은 열거되지 않는 속성: `JSON.stringify`·스프레드·`Object.keys` 에 나오지 않는다(`payment.secret` 직접 읽기는 동일).

### 동작 변경 (타입은 그대로, 결과가 달라질 수 있음)
- `FDS_ERROR`(confirm) `fatal` → `uncertain`(본인 인증 뒤 결제가 이어질 수 있음).
- 본문 없는 `HTTP_401`: 조회·취소 → `fatal`(전엔 `uncertain`), **승인은 `uncertain` 유지**(일시 앞단 장애로 승인된 결제가 FAILED 가 되는 것 방지; 앱은 `HTTP_401` 코드를 알림 대상으로). 본문 없는 `HTTP_403` 은 `uncertain` 유지.
- 조회 `not_found` 는 코드가 `NOT_FOUND_PAYMENT` 일 때만. 코드 없는/다른 코드의 404 는 `uncertain`.
- 취소: `NOT_CANCELABLE_AMOUNT` 인데 조회로 이미 반영된 취소로 확인되면 `not_cancelable` 대신 `canceled`(`alreadyCanceled:true`).
- 취소: 부분 취소 요청의 `ALREADY_CANCELED_PAYMENT` 는 현재 누계 = 요청 전 누계+금액일 때만 `canceled`(`alreadyCanceled:true`), 결제가 다른 이유로 전액 취소돼 있으면 `not_cancelable`.
- 취소: 부분 취소 응답 누계 불일치 시 모듈이 조회 1회 추가 — 적용 확인되면 `canceled`, 아니면 `uncertain`(`CANCEL_NOT_APPLIED`/`CANCEL_TOTAL_MISMATCH`)에 `currentCanceledTotal`.
- 취소 응답: `balanceAmount` 없는 `PARTIAL_CANCELED` 도 `cancels` 합 = `totalAmount` 이면 완전 취소 판정.
- 취소 사유가 비어 있으면 throw(`INVALID_CANCEL_REASON`), `paymentKey` 형식 검사(`INVALID_PAYMENT_KEY`), `timeoutMs` 상한 120000ms·비정상 값은 15000ms.
- 키 앞뒤 공백·개행은 지우고 판정·전송.
- 확정 거절(`fatal`) 코드 추가: `EXCEED_MAX_*`, `NOT_ALLOWED_POINT_USE`, `BELOW_MINIMUM_AMOUNT`, `NOT_AVAILABLE_PAYMENT`, `NOT_AVAILABLE_BANK`, `INVALID_PASSWORD` 등(공식 에러 코드 페이지 2026-10-17). 취소 `not_cancelable` 추가: `EXCEED_CANCEL_LIMIT`, `REFUND_REJECTED`, `NOT_ALLOWED_PARTIAL_REFUND*` 등, 취소 `NOT_AVAILABLE_BANK` → `retry_later`.

### 추가 (비breaking)
- `verifyPaymentWebhook`, `WebhookCheck`, `isWebhookSecretValid` — 웹훅은 재조회 기반. 결과 `authenticated`(secret 일치)와 `refetched`(대조 불가, 진위 미확인 — 인증됨으로 쓰지 말 것)를 구분하고, 결제에 secret 이 있는데 본문에 없으면 `SECRET_MISSING` 거부. 설정 오류(KEY_MODE_*)는 던진다.
- `checkPartialCancel`, `PartialCancelCheck`, `canceledTotal`, `CancelOutcome.uncertain.currentCanceledTotal`(선택).
- `cancelApprovedMismatch`(+ `createTossClient().cancelApprovedMismatch`), `tossKeyMode`, `assertKeyMode`, `TOSS_TIMEOUT_MAX_MS`.
- `CancelInput.taxFreeAmount`, `CancelInput.refundReceiveAccount`(가상계좌 환불).
- `TossPayment` 선택 필드: `currency`·`taxFreeAmount`·`suppliedAmount`·`vat`·`secret`·`virtualAccount`.

### 참고
- 위 변경은 모두 로컬 커밋이며 공개 저장소에 push 되지 않았다. 공개 시점은 앱 전환 직전(스테이징 반영 → 테스트 키 실호출 시험 → push·rc.2 태그).
