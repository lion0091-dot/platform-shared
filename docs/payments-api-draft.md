# 공용 결제 라이브러리 초안 — `@platform/shared/payments`

상태: 초안(버전·태그 없음, 모의 시험만 통과, 실제 토스 호출 없음). 대상: meatpartners·shipping 개발자. 근거: docs.tosspayments.com 의 에러 코드·멱등키 페이지(2026-10-16 열람), 두 앱의 기존 결제 코드. 문서에서 확인 못 한 것은 "미확인".

## 1. 범위
포함: 승인(confirm)·조회(주문번호/paymentKey)·취소(cancel) 호출, Basic 인증, 타임아웃, Idempotency-Key 규칙, 승인 응답 검증, 오류 분류, failUrl code 분류, 주문번호 검증·생성.
제외(앱이 한다): 주문 생성·금액 산정·DB·RLS·장부·정산·알림, 각 앱의 상태머신(meatpartners pending 테이블 / shipping PENDING 상태), 결제창 SDK 래퍼(v1/v2 통일은 2단계), 웹훅 수신, 재시도 스케줄(크론). 라이브러리는 **호출 한 번 + 분류**만 하고 내부에서 재시도하지 않는다. 비밀값은 받기만 하고 저장·기록하지 않는다(공개 저장소).

## 2. 사용법
```ts
import { createTossClient, interpretPayment, confirmIdempotencyKey, cancelIdempotencyKey, classifyFailCode, generateOrderId } from "@platform/shared/payments";
const toss = createTossClient({ secretKey: process.env.TOSS_SECRET_KEY! }); // fetch·baseUrl·timeoutMs(기본 15000) 선택
```
낱개 함수도 같다: `confirmPayment(cfg, input)`, `getPaymentByOrderId(cfg, orderId)`, `getPayment(cfg, paymentKey)`, `cancelPayment(cfg, input)`. 잘못된 입력(금액이 양의 정수 아님, 멱등키 규칙 위반)은 **호출 전에 throw**.

### 2.1 시그니처
| 함수 | 입력 | 출력 |
|---|---|---|
| `confirmPayment` | `{paymentKey, orderId, amount(서버 기대 금액, 원·정수), idempotencyKey?}` | `ConfirmOutcome` |
| `getPaymentByOrderId` / `getPayment` | orderId / paymentKey | `LookupOutcome` |
| `cancelPayment` | `{paymentKey, cancelReason(200자로 자름), cancelAmount?(생략=전액), alreadyCanceledTotal(부분 취소면 필수), idempotencyKey(필수)}` | `CancelOutcome` |
| `interpretPayment(payment, {orderId, amount})` | 조회 결과 + 앱이 DB 에서 가져온 기대값 | `paid`·`canceled`·`partial_canceled`·`in_progress`·`not_paid`·`mismatch` |
| `classifyFailCode(code)` | failUrl 쿼리 code | `user_canceled`·`aborted`·`card_rejected`·`other` |
| `classifyTossError(op, httpStatus, code)` | 순수 분류 | `ErrorClass` |
| `isValidOrderId` / `assertOrderId` / `generateOrderId(prefix?)` | | 영문·숫자·`-`·`_` 6~64자. 생성은 prefix+UUID |
| `confirmIdempotencyKey(orderId, paymentKey)` / `cancelIdempotencyKey({paymentKey, cancelAmount?, alreadyCanceledTotal?})` | | 문자열(300자 이하 보장, 넘으면 throw) |

`TossPayment = {paymentKey, orderId, status(토스 원문), totalAmount, method, approvedAt, balanceAmount(취소 가능 잔액, 없으면 null), cancels[]}`. `cancels` 항목은 `{cancelAmount, cancelReason, canceledAt, transactionKey, cancelStatus(DONE=성공)}`(Payment 객체의 `cancels`, null 이면 빈 배열). `canceled(alreadyCanceled:true)` 일 때 앱은 "토스에서 이미 취소된 금액"을 `cancels` 의 `cancelAmount` 합(또는 `totalAmount - balanceAmount`)으로 알 수 있다 — 앱 DB 와 대조해 정리.

금액(`amount`·`cancelAmount`·`alreadyCanceledTotal`)은 양의 정수(원)여야 하며 아니면 호출 전에 throw 한다. numeric 컬럼(예: pending.total_amount)을 쓰는 앱은 정수로 변환한 값을 넘긴다(변환 전 소수·문자열을 그대로 넘기지 않는다).

입력 검증(호출 전 throw): `confirmPayment`·`getPaymentByOrderId` 는 orderId 가 영문·숫자·`-`·`_` 6~64자가 아니면 `INVALID_ORDER_ID`(uuid 36자는 통과). 외부 호출은 나가지 않는다.

## 3. 오류 분류표

### 3.1 승인(confirm)
앱이 보는 3분류: **분명한 실패**(즉시 실패 확정 가능) / **승인 안 됨 확정**(조회로 확정) / **불확실**(PENDING 유지 후 조회로 확정).

| 토스 응답 | `kind` | 3분류 | 앱이 할 일 |
|---|---|---|---|
| 200, status=DONE, orderId·paymentKey 일치, totalAmount=기대 금액 | `success` | 승인 | 결제 완료 반영 |
| 200, **status=DONE** 인데 orderId/paymentKey 불일치 또는 totalAmount≠기대 금액 (검사 순서: status → 주문·키 → 금액 → 통화. 통화가 KRW 가 아니면 `reason:"CURRENCY_MISMATCH"`) | `approved_mismatch`(`reason`) | **토스에선 승인된 상태** | PG 취소 연계가 필요: 앱이 `cancelPayment` 호출 여부 결정, 주문은 완료로 반영하지 말고 사람이 확인 |
| 200 인데 status≠DONE(IN_PROGRESS 등, 주문·금액이 달라도 불일치로 단정하지 않음) 또는 형식 이상 | `uncertain`(`STATUS_x`/`BAD_RESPONSE`) | 불확실 | PENDING 유지, 조회 |
| 400 `ALREADY_PROCESSED_PAYMENT` | `already_done` | 조회로 확정 | `getPaymentByOrderId` → `interpretPayment`=paid 면 완료 반영(주문·금액 일치 때만) |
| 409 `IDEMPOTENT_REQUEST_PROCESSING`, 400 `ALREADY_PROCESSING_REQUEST` | `processing` | 불확실 | PENDING 유지, 잠시 뒤 조회(또는 같은 키로 재호출). **FAILED 금지** |
| 400 `PROVIDER_ERROR`, 500 `FAILED_INTERNAL_SYSTEM_PROCESSING`·`FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING`, 5xx 전부, 429, 타임아웃(`TIMEOUT`), 네트워크(`NETWORK`), **목록에 없는 모든 코드**, `CARD_PROCESSING_ERROR` | `uncertain` | 불확실 | PENDING 유지, 조회로 확정. **FAILED 확정 금지** |
| 200, status=`WAITING_FOR_DEPOSIT`, orderId·paymentKey·금액 일치 (가상계좌 발급) | `waiting_for_deposit`(`payment.virtualAccount`) | 입금 대기(승인 완료 아님) | 계좌 안내, PENDING 유지, 입금 웹훅 수신 시 §8 순서로 확정 |
| 404 `NOT_FOUND_PAYMENT_SESSION` | `session_expired`(토스 한글 message 동봉) | 분명한 실패(세션 만료) — 단 응답 유실 뒤 다른 키로 재호출한 경우일 수 있음 | **새 결제창 안내 전에 `getPaymentByOrderId` 로 이미 승인된 건이 아닌지 확인**, 없을 때만 새 결제창(새 paymentKey) |
| 401 `UNAUTHORIZED_KEY`, 400 `INVALID_API_KEY`(시크릿키 오류), 403 `FORBIDDEN_REQUEST`, 404 `NOT_FOUND_PAYMENT`, 400 `INVALID_REQUEST`(잘못된 요청) | `fatal` | 분명한 실패 | 즉시 실패. 키 오류는 운영 알림 필요, `INVALID_REQUEST` 는 요청 값(주문번호·금액 등) 점검 |
| 403 `REJECT_CARD_COMPANY`(승인 거절)·`REJECT_CARD_PAYMENT`(한도초과·잔액부족)·`REJECT_ACCOUNT_PAYMENT`·`REJECT_TOSSPAY_INVALID_ACCOUNT`, 400 `INVALID_REJECT_CARD`·`INVALID_CARD_EXPIRATION`·`INVALID_STOPPED_CARD`·`INVALID_CARD_LOST_OR_STOLEN`·`INVALID_CARD_NUMBER`·`INVALID_CARD_INSTALLMENT_PLAN`·`NOT_SUPPORTED_INSTALLMENT_PLAN_CARD_OR_MERCHANT`·`EXCEED_MAX_CARD_INSTALLMENT_PLAN`·`NOT_SUPPORTED_MONTHLY_INSTALLMENT_PLAN`(뒤 2건은 공식 승인 섹션 근거, `EXCEED_MAX_CARD_INSTALLMENT_PLAN` 은 2026-10-16 실측으로도 확인) | `fatal` | 분명한 실패 | 즉시 실패 + 사용자 안내(다른 카드/수단). 코드 목록은 `DEFINITE_FAILURE` |

참고: 2026-10-17 에 공식 에러 코드 페이지 승인 섹션을 다시 열람해 한도·횟수·시간대·인증·계정 계열(`EXCEED_MAX_*`·`NOT_ALLOWED_POINT_USE`·`BELOW_MINIMUM_AMOUNT`·`NOT_AVAILABLE_PAYMENT`·`NOT_AVAILABLE_BANK`·`INVALID_PASSWORD` 등)을 `DEFINITE_FAILURE` 에 추가했다. **`FDS_ERROR`(403)는 `uncertain`**: 위험거래 감지 뒤 "발송된 문자 링크로 본인인증 후 결제가 가능"하다고 안내되므로(출처 https://docs.tosspayments.com/reference/error-codes, 2026-10-17 열람) 이어서 승인될 수 있다 → PENDING 유지 후 조회로 확정(고아 결제 방지). `UNAPPROVED_ORDER_ID`·`CARD_PROCESSING_ERROR`·`UNKNOWN_PAYMENT_ERROR`(500) 는 "결제 안 됨" 보장이 없어 `uncertain` 유지.

참고: shipping 의 가짜 코드 `REJECT_CARD` 는 없다. 실제 코드는 `REJECT_CARD_PAYMENT`·`REJECT_CARD_COMPANY` 다(`REJECT_CARD_PAYMENT` 는 승인 API 섹션에만 있고 "전체 에러 목록"에는 없음 — 문서 내부 차이).

### 3.2 조회 결과 판정(불확실 → 확정)
`getPaymentByOrderId` 결과:
| `LookupOutcome` | 의미 | 앱이 할 일 |
|---|---|---|
| `found` + `interpretPayment`=`paid` (DONE, orderId·금액 일치) | 승인됨 | 완료 반영 |
| `found` + `not_paid` (ABORTED·EXPIRED) 또는 `canceled` (CANCELED) | 승인 안 됨 확정 | 실패 확정(CANCELED 는 승인됐다가 취소된 것 — 이 결제로는 미결제) |
| `found` + `in_progress` (READY·IN_PROGRESS·WAITING_FOR_DEPOSIT 등) | 아직 진행 | PENDING 유지, 나중에 다시 조회 |
| `found` + `mismatch` | 주문번호·금액이 기대와 다름 | 자동 확정 금지, 사람이 확인(승인됐다면 취소 연계) |
| `not_found` (404) | 그 주문번호로 승인된 결제 없음 | 승인 없음. 단 막 호출한 직후라면 지연 가능성이 있어 앱이 유예 시간을 정한다(미확인: 토스 쪽 반영 지연) |
| `retry_later`(`FORBIDDEN_CONSECUTIVE_REQUEST`·429) / `uncertain`(5xx·타임아웃·형식 이상) | 조회 실패 | PENDING 유지, 잠시 뒤 재조회 |
| `fatal` (401·403 등) | 키·권한 | 알림 |
**`not_found` 로 "승인 없음"을 포기·확정하는 유예(권장)**: 승인 호출 시각으로부터 **최소 30분 이상**이면서 **앱의 결제 만료 시각 이후**에만 포기한다(승인 유효시간이 문서에서 10분 vs 30분으로 달라 보수적으로 큰 쪽을 쓴다 — 근거는 shipping 점검표 인용, 이번에 재확인 안 함). 그 전의 `not_found` 는 PENDING 유지 후 재조회.
조회 응답 DONE 의 `totalAmount` 는 최초 결제 금액이며 취소돼도 변하지 않는다(shipping 점검표 기준).

### 3.3 취소(cancel)
| 토스 응답 | `kind` | 앱이 할 일 |
|---|---|---|
| 200, 전액 요청 → status CANCELED | `canceled`(`alreadyCanceled:false`) | DB 취소 반영 |
| 200, 부분 요청(`cancelAmount`+`alreadyCanceledTotal`) → 응답 `cancels` 합 = 누계+이번 금액(그리고 `balanceAmount` 가 있으면 `totalAmount-balanceAmount` 도 같음) | `canceled`(`alreadyCanceled:false`) | DB 취소 반영 |
| 200, 전액 요청 → status `PARTIAL_CANCELED` 이고 `balanceAmount===0` | `canceled`(`alreadyCanceled:false`) | DB 취소 반영 |
| 200 인데 위 검증 불일치·확인할 `cancels`/`balanceAmount` 없음·전액 요청에 잔액이 남은 PARTIAL_CANCELED | `uncertain`(`CANCEL_NOT_APPLIED` 또는 `BAD_RESPONSE`) | 같은 키의 이전 응답(캐시)일 수 있음 → 환불을 두 번 한 것으로 기록하지 말고 `getPayment` 로 확인 |
| (위 행의 후속) 부분 취소 응답 누계 불일치 | 모듈이 `getPayment` 로 현재 누계를 확인해 적용됐으면 `canceled`, 아니면 `uncertain`(`CANCEL_NOT_APPLIED`: 누계 그대로 / `CANCEL_TOTAL_MISMATCH`: 다른 경로가 먼저 취소) + **`currentCanceledTotal`** | 같은 키로 되풀이하지 않는다(첫 응답만 재생). `currentCanceledTotal` 을 `alreadyCanceledTotal` 로 새 키(`cancelIdempotencyKey`)를 만들어 필요한 만큼만 다시 취소. 응답 유실 뒤에는 `checkPartialCancel(cfg,{paymentKey,cancelAmount,alreadyCanceledTotal})` 로 `applied/not_applied/diverged/unknown` 을 확인 |
| 400 `ALREADY_CANCELED_PAYMENT`·`ALREADY_REFUND_PAYMENT` → 라이브러리가 `paymentKey` 조회, CANCELED 확인 | `canceled`(`alreadyCanceled:true`) | 성공 취급, **DB 정리는 앱**(PG 는 취소·DB 는 PAID 인 불일치 해소) |
| 위 두 코드인데 조회로 CANCELED 확인 못 함 | `uncertain` | 사람이 확인 |
| 400 `ALREADY_REFUNDING_PAYMENT`, 409 `IDEMPOTENT_REQUEST_PROCESSING` | `processing` | 잠시 뒤 조회 |
| 403 `FORBIDDEN_CONSECUTIVE_REQUEST`, 429 | `retry_later` | 잠시 뒤 **같은 키로** 재시도 |
| 400 `PROVIDER_ERROR`, 5xx, 타임아웃, 네트워크, 응답 상태 이상, 모르는 코드(`CARD_PROCESSING_ERROR` 포함) | `uncertain` | 같은 키 유지, 조회(`getPayment`)로 확정 후 필요하면 같은 키로 재시도 |
| 403 `NOT_CANCELABLE_PAYMENT`·`NOT_CANCELABLE_AMOUNT`·`NOT_CANCELABLE_PAYMENT_FOR_DORMANT_USER`·`EXCEED_MAX_REFUND_DUE`, `EXCEED_CANCEL_LIMIT`·`REFUND_REJECTED`·`NOT_ALLOWED_PARTIAL_REFUND(_WAITING_DEPOSIT)`·`EXCEED_CANCEL_AMOUNT_DISCOUNT_AMOUNT`·`FORBIDDEN_BANK_REFUND_REQUEST`·`FAILED_CLOSED_ACCOUNT_REFUND`·환불계좌 오류(`INVALID_REFUND_ACCOUNT_INFO`·`_NUMBER`·`INVALID_BANK`) | `not_cancelable` | 재시도 금지, 사람이 처리(API 밖 환불 등) |
| 403 `NOT_AVAILABLE_BANK`(은행 서비스 시간 아님) | `retry_later` | 시간이 지난 뒤 **같은 키로** 재시도 |
| 401 `UNAUTHORIZED_KEY`, 403 `FORBIDDEN_REQUEST` | `fatal` | 알림 |

### 3.4 failUrl(결제창 실패 리다이렉트) `?code=`
`PAY_PROCESS_CANCELED`→`user_canceled`(구매자 취소, **orderId 가 없을 수 있음**), `PAY_PROCESS_ABORTED`→`aborted`, `REJECT_CARD_COMPANY`→`card_rejected`, 그 외→`other`. failUrl 은 승인 호출 전이므로 결제는 일어나지 않았다: 앱 상태는 재시도 가능하게 둘지 실패로 할지 앱이 정한다.

## 4. 멱등키(Idempotency-Key) 규칙
- 헤더 `Idempotency-Key`, 최대 300자, 첫 요청부터 15일 유효. (키+API키+URL+메서드)가 같으면 첫 응답을 돌려줌(문서). GET 에는 무시됨. 409 `IDEMPOTENT_REQUEST_PROCESSING` = 첫 요청 처리 중.
- **에러가 나도 키를 바꿔 재시도하지 않는다.** 원인을 조회로 확인한 뒤 같은 키로 보낸다.
- **confirm 키 = 주문번호 + paymentKey 조합**: `confirmIdempotencyKey(orderId, paymentKey)` = `confirm_<orderId>_<paymentKey>`. 같은 주문번호로 새 결제창을 열어 새 paymentKey 가 생기면 새 키가 되어 이전 시도의 캐시 응답이 재사용되지 않는다. 재시도·새로고침 때는 같은 paymentKey 라 같은 키. (paymentKey 가 길어 300자를 넘으면 throw — 실제 길이는 미확인, 보통 약 40~200자 추정이나 단정 못 함.)
- **cancel 키**: 호출자가 반드시 넘긴다. 전액 취소 = `cancelIdempotencyKey({paymentKey})` = `cancel_<paymentKey>_full`. **부분 취소 = `cancelIdempotencyKey({paymentKey, cancelAmount, alreadyCanceledTotal})` = `cancel_<paymentKey>_<취소누계>_<금액>` 이며 `alreadyCanceledTotal`(요청 직전 토스 기준 취소 누계)이 필수**(타입·런타임 모두, 없으면 throw). 누계를 빼면 같은 금액의 두 번째 부분 취소가 첫 번째와 같은 키가 되어 토스가 첫 응답을 돌려주고 실제 환불은 1회뿐인데 앱은 두 번 환불된 줄 알게 된다.
- **캐시 재생(15일)**: 같은 결제의 전액 취소 키는 재시도마다 동일(`cancel_<paymentKey>_full`)하므로 토스가 15일간 첫 응답을 돌려준다(문서: "중복 요청은 첫 요청과 같은 응답"). 문서는 **에러 응답도 재생되는지, 첫 시도가 `not_cancelable`·`fatal` 로 끝난 뒤 조건이 풀리면 같은 키로 다시 성공할 수 있는지를 밝히지 않는다 → 미확인, 안전 쪽 가정: 에러도 재생된다고 본다.** 따라서 `not_cancelable`·`fatal` 이 나온 취소를 같은 키로 다시 보내지 않고 **"사람이 처리"**(운영자 수동 환불·토스 대시보드 취소)로 보낸다. 사람이 처리한 뒤 DB 정리는 `getPayment` 로 CANCELED 확인 후 앱이 한다. (`uncertain`·`retry_later`·`processing` 은 같은 키로 재시도하는 것이 규칙이다 — 그 경우의 재생은 의도된 동작.)
- **취소 경로가 여럿이어도 키는 하나의 규칙으로**: `approved_mismatch` 후속 취소, 핫딜 매진·재고 부족 등 앱의 자동 환불, 운영자 취소가 **같은 결제를 취소하려 할 수 있다.** 모든 경로는 반드시 `cancelIdempotencyKey` 로 키를 만든다(앱이 임의 키를 만들지 않는다). 같은 결제·같은 금액(·같은 누계)이면 같은 키가 되어 토스가 중복 취소를 한 번만 처리한다. 경로마다 키를 달리 만들면 이중 환불 위험이 있다.
- **앱 규칙(부분 취소)**: 취소 직전에 `getPayment` 로 현재 취소 누계(`cancels` 합 또는 `totalAmount - balanceAmount`)를 조회해 `alreadyCanceledTotal` 로 넘긴다. 같은 취소 건을 재시도할 때는 처음 조회한 누계와 같은 키를 그대로 쓴다(재시도 중 누계가 바뀌었다고 키를 바꾸지 않는다 — 불확실하면 먼저 조회).
- 키 문자는 보이는 ASCII(`!`~`~`)만 허용(우리 쪽 안전 제약; 토스 문서의 문자 제한은 미확인).
- 키는 로그에 남겨도 비밀이 아니지만 시크릿키·Authorization 헤더는 절대 로그에 남기지 않는다.

## 4-1. 키 종류·입력 규칙(2026-10-17 보강)
- **키 종류 고정(필수, 2026-10-17 변경)**: `TossConfig.expectedMode`(`"test"`|`"live"`)는 **필수**다. 모든 호출 전에 시크릿키 접두사(`test_sk_`·`live_sk_`, 위젯 키 `gsk`)를 검사해 다르면 `KEY_MODE_MISMATCH`, 생략하면(JS 포함) `KEY_MODE_REQUIRED` 를 던진다(네트워크 호출 없음, 메시지에 키 없음). **운영 앱은 `"live"`, 스테이징·리허설은 `"test"`.** 접두사 없는 가짜 키로 모의 서버(`baseUrl`)·단위 시험을 돌릴 때만 `"unchecked"`. 선택 이유: 선택 사항이면 지정을 잊은 앱에서 운영에 test 키가 들어가도 아무도 막지 못한다(결제는 DONE 인데 돈이 없음). 앱 영향: 이 모듈은 아직 두 앱이 쓰지 않으므로(둘 다 v0.2.2 고정) 전환 시점부터 적용되며, **rc.1 대비 타입 breaking**(필수 필드 추가)이다.
- 키 접두사 **형식 가정**(문서화): 앞뒤 공백을 지운 뒤 `^(test|live)_g?sk_`(대소문자 구분). 공식 키 형식 문서는 확인하지 못한 관례이며, 인증 헤더도 지운 값으로 만든다(환경변수 개행 방지). `baseUrl` 모의 서버에는 `expectedMode:"unchecked"` 를 써 오탐을 피한다.
- `paymentKey` 는 1~200자 보이는 ASCII, `cancelReason` 은 비어 있으면 안 됨(200자는 코드포인트 기준 절단), `timeoutMs` 는 양의 유한수가 아니면 기본 15초.
- 취소 옵션: 부분 취소의 `taxFreeAmount`(면세·복합과세 상점, 0 이상 취소금액 이하 정수), 가상계좌 결제 취소의 `refundReceiveAccount`(은행 코드·숫자 20자 이하 계좌·예금주 60자 이하). 토스 취소 API 의 `refundableAmount` 는 공식 문서상 **DEPRECATED** 라 지원하지 않는다 — 동시 부분 취소는 앱이 결제 단위로 직렬화하고 `alreadyCanceledTotal` 을 취소 직전 조회로 만든다.
- `TossPayment` 가 읽는 추가 필드: `currency`·`taxFreeAmount`·`suppliedAmount`·`vat`·`secret`·`virtualAccount`. `interpretPayment` 는 통화가 KRW 가 아니면 `mismatch`.
- `cancelApprovedMismatch(cfg, outcome)` / `client.cancelApprovedMismatch`: `approved_mismatch` 결제를 **표준 전액 취소 키**로 취소하는 호출 통일 도우미. 취소할지(자동/사람 확인 후)는 앱이 정한다(§5-6).

## 5. 앱이 DB 에 반영할 때 지킬 규칙
1. **불확실(`uncertain`·`processing`·`already_done`·`approved_mismatch`)은 FAILED 로 확정하지 않는다.** PENDING(또는 pending 테이블 행)을 유지하고 `getPaymentByOrderId` → `interpretPayment` 로 확정한다. FAILED 로 한 번 굳으면 승인이 실제로 됐어도 되살릴 수 없다(shipping 점검표 P1).
2. 완료 반영 조건은 (a) `confirm.success` 또는 (b) 조회 `paid` 이며 **orderId·금액이 앱이 DB 에서 가져온 값과 일치**할 때뿐이다. 클라이언트가 준 amount 는 신뢰하지 않는다.
3. 같은 주문의 두 번째 요청(연타·새로고침)은 `processing`/`already_done` 으로 온다 — 실패로 보지 말고 조회로 수렴시킨다.
3-1. **`success` 는 "이번 호출이 처음 승인했다"는 뜻이 아니다.** 이미 DONE 인 같은 orderId·paymentKey·amount 로 confirm 을 다시 보내면 토스는 `ALREADY_PROCESSED_PAYMENT` 가 아니라 **200 DONE 을 그대로** 돌려준다(같은 멱등키·다른 멱등키 모두, 2026-10-16 실측). 그러므로 앱은 success 를 받아도 DB 의 현재 상태를 조건부 UPDATE(`WHERE status <> 'PAID'` 등, 영향 행 수 확인)로 먼저 본 뒤 **처음 PAID 로 바뀐 요청만** 정산·모집 시작 같은 후속 반영을 한다. `ALREADY_PROCESSED_PAYMENT` 는 Test-Code 헤더로만 재현됐다(실결제 응답은 미확인).
4. 승인 후 DB 반영이 실패하면 PENDING 이 남는다 → 앱의 정합 크론이 PENDING 을 조회로 확정한다(라이브러리는 크론을 제공하지 않음). PENDING 을 FAILED/취소로 만들기 전에 반드시 조회.
5. 취소: 같은 취소 건엔 같은 멱등키. `canceled(alreadyCanceled)` 도 성공으로 DB 를 정리. `retry_later` 는 재시도, `not_cancelable` 은 재시도 금지.
6. `approved_mismatch` 는 "돈은 승인됐다": 자동으로 무시 금지. 취소 호출은 앱이 결정하고 사람이 확인한다.
7. 로그에 시크릿키·카드 정보 금지. 오류 메시지는 토스 `message` 를 300자까지만 담아 돌려준다(사용자 화면에 그대로 노출할지는 앱이 결정).

## 6. 소비 앱 요구사항
### shipping(shipping-prj, 요구 5건 — 대장 전달, 2026-10-16)
1. 게이트웨이 인터페이스에 `lookupByOrderId` 포함 → `createTossClient` 가 `confirm`·`lookupByOrderId`·`lookup`·`cancel` 을 제공. (shipping 의 `PaymentGateway`/`NotConfiguredGateway`(키 없을 때 fail-closed)는 앱에 남기고 어댑터만 이 모듈로 교체하면 된다.)
2. confirm 멱등키 = 주문번호+paymentKey 조합, 300자 이하 → `confirmIdempotencyKey`(§4).
3. 오류 3분류 → §3.1·§3.2. 조회 판정: DONE+orderId·금액 일치=승인, ABORTED·EXPIRED·CANCELED=확정 실패, NOT_FOUND=승인 없음. 실제 코드명 사용(`REJECT_CARD_PAYMENT`).
4. 취소 3종 → §3.3(`ALREADY_*`는 조회 확인 후 성공, `FORBIDDEN_CONSECUTIVE_REQUEST`는 재시도).
5. 200 이지만 금액·주문번호 불일치 → `approved_mismatch`, 취소 호출 여부는 앱이 결정(§3.1).
- 후속 검토 반영(2026-10-16): `INVALID_REQUEST`→fatal(R1), `TossPayment` 에 `balanceAmount`·`cancels`(R2), confirm 검증 순서 status 먼저(R3), confirm·lookup orderId 형식 사전 검증(R5). `approved_mismatch` 후속(취소 연계)은 앱 몫(R4).
- 주의: 이 5건 중 shipping 최신 커밋(`fix/payment-uncertain-states`, a3175be)의 `gateway.ts`·`toss.ts`·`service.ts` 를 이 초안 작성 중에 다시 읽지 못했다(작업 격리 제한). 소비 시 `Failure{code,message}` 형태의 기존 반환과 이 라이브러리의 `kind` 반환 사이의 어댑터는 shipping 담당이 맞춘다.
### meatpartners(wholesale 폴더, 결제 코드 `lib/payments/tosspayments-client.ts`·`pg-reconcile.ts`)
- **pending 테이블 방식을 유지**한다(라이브러리는 DB 모델을 모른다). 이 모듈은 현재 `confirmPayment`/`getPaymentByOrderId`/`cancelPayment` 의 호출·오류 해석만 대체한다.
- 현재 코드는 예외(`TossPaymentsError{code}`)를 던지는 방식, 이 모듈은 값(`kind`)을 반환 → 호출부를 `switch(kind)` 로 바꿔야 한다. 기존 `getPaymentByOrderId` 의 404→`null` 은 `not_found`.
- 기존에 없던 것: 승인·취소 `Idempotency-Key`, 승인 응답 `status===DONE`·금액 검증(현재는 호출부가 함), 조회 후 확정 규칙. 대조 크론은 `uncertain/processing` 을 만났을 때 PENDING 유지.
- **결제창 SDK 는 2단계**(이 모듈에 없음). 현재 SDK 를 그대로 쓴다.
- 취소는 현재 전액(`cancelAmount` 생략)만 쓴다 → 그대로 호환. 부분취소를 쓸 때는 §4 의 누계 규칙(취소 전 조회해 `alreadyCanceledTotal` 전달)을 따른다. shipping 은 부분 환불을 쓰므로 기존 키 `refund-<id>-<기환불합계>-<금액>` 과 같은 발상이지만 이 모듈의 키 함수로 바꾸면 기존 진행 중 취소의 키가 달라지니 전환 시점에 진행 중인 취소가 없는지 확인한다.
### 공통
- 취소 키는 모든 취소 경로(`approved_mismatch` 후속, 핫딜 매진·재고 부족 등 자동 환불, 운영자 취소)에서 **반드시 `cancelIdempotencyKey`** 로 만든다. 앱이 임의 키를 만들지 않는다(§4).
- 크론이 `not_found` 로 포기하기 전 유예는 승인 호출 후 30분 이상 + 앱 만료 시각 이후(§3.2).
- 앱 package.json 에 platform-shared 새 버전을 올릴 때 두 앱을 같이 올린다(README 규칙). 아직 버전·태그 없음.
- 앱 시험에서는 `fetch` 를 주입(`cfg.fetch`)해 모의한다.

## 7. 미확인 항목
- 취소 완료 판정: 부분 취소로 잔액을 0 까지 만들어도 토스 status 는 `PARTIAL_CANCELED` 로 남는다(실측) → `interpretPayment`·`cancelPayment` 의 이미 취소 확인은 `CANCELED` 이거나 `PARTIAL_CANCELED`+`balanceAmount===0` 을 완전 취소로 본다. **미시험**: 한 번에 전액 취소 요청한 응답이 `PARTIAL_CANCELED`+balance 0 인 경우(현행: `uncertain`, 조회로 확정). 이미 전액 취소된 결제의 재취소는 `NOT_CANCELABLE_AMOUNT`("취소 할 수 없는 금액 입니다.", 실측) → `not_cancelable`.
- 공식 문서에 `IDEMPOTENT_REQUEST_PROCESSING` 은 멱등키 페이지에만 있고 에러 코드 페이지에는 없다(대신 `ALREADY_PROCESSING_REQUEST` 400). 둘 다 `processing` 으로 처리.
- 승인 유효 시간: 승인 API 문서 10분 vs Payment 객체 `EXPIRED` 설명 30분(shipping 점검표 인용, 이번에 재확인 안 함).
- `FORBIDDEN_CONSECUTIVE_REQUEST` 가 confirm 에서 오는지: 문서는 조회·취소에만 기재 → confirm 에서는 모르는 코드로 보아 `uncertain`.
- 429 의 실제 발생·재시도 정책, 승인 직후 주문번호 조회의 반영 지연, paymentKey 최대 길이, 멱등키 허용 문자.
- 웹훅 수신 자체(서버 라우트)는 범위 밖. 진위 대조는 §8 의 `isWebhookSecretValid` 로 제공(공식 Payment.secret 설명 근거; 웹훅 가이드 페이지에는 검증 절차가 없어 헤더 서명은 확인 못 함).
- **키가 필요한 실호출 미시험(2026-10-17 갱신)**: Test-Code 헤더 회귀·실결제 `ALREADY_PROCESSED_PAYMENT`·실제 409 / 멱등키 재생이 에러 응답도 재생하는지·15일 이후 / 429·`FORBIDDEN_CONSECUTIVE_REQUEST` 실발생 / 같은 orderId 다른 금액의 실제 거절 코드 / 승인 직후 주문 조회 지연 / paymentKey 최대 길이 / 면세 결제의 부분 취소·`taxFreeAmount` 동작 / 가상계좌 발급·환불·입금 웹훅의 secret 대조 / 5xx 본문 형태. 시험 195건은 모두 가짜 fetch 다.
- 에러 코드 페이지 전체 목록 중 이번에 분류한 것 외의 코드(가상계좌·자동결제 전용 등)는 모두 `uncertain`(승인) 쪽으로 떨어진다 — 더 정확히 하려면 코드 추가 필요.
- `INVALID_REQUEST`(400)는 에러 코드 페이지의 결제 승인 섹션에서 확인(메시지: 잘못된 요청). 다만 "결제가 일어나지 않았다"는 보장은 문서에 명시돼 있지 않다 — 400 계열이라 거절로 보고 fatal 에 넣었다(판단). 페이지가 일부 잘렸을 수 있어(열람 도구 표시) 다른 코드가 빠졌을 수 있음.
- 위험(문서 근거 없음): confirm 의 `INVALID_REQUEST` 는 "결제가 일어나지 않았다"는 보장이 토스 문서에 없다. 승인이 이미 처리된 뒤 같은 요청이 `INVALID_REQUEST` 로 거절되는 경우(예: 이미 사용된 paymentKey 형식 문제)가 있는지 미확인 → 앱은 `fatal` 로 FAILED 확정하기 전에 `getPaymentByOrderId` 로 한 번 확인하는 것이 안전하다(비용 작음). 요청 값은 호출 전 검증(금액·orderId)으로 이미 걸러진다.
- lookup 에서 `fatal`: 분류표의 분명한 실패 코드(`UNAUTHORIZED_KEY`·`FORBIDDEN_REQUEST`·`INVALID_REQUEST`·`INVALID_API_KEY` 등)만 `fatal`, 그 밖의 모르는 코드·5xx 는 `uncertain` 으로 떨어진다. 앱 영향: lookup `fatal` 은 "확인 불가"일 뿐 결제 실패가 아니다 → PENDING 유지 + 운영 알림, FAILED/취소로 바꾸지 않는다. 404·`NOT_FOUND_PAYMENT`·`NOT_FOUND` 는 `not_found`(승인 없음).
- `balanceAmount`·`cancels` 필드명·타입은 토스 reference 페이지(Payment 객체)에서 확인: `balanceAmount` number, `cancels` nullable array(`cancelAmount`·`cancelReason`·`canceledAt`·`transactionKey`·`cancelStatus` 등). 전용 payment-object 주소는 404 였고 reference 메인에서 확인.
- 에러 응답의 멱등키 재생 여부(§4)는 미확인(안전 쪽 가정: 재생됨).
- `TossPayment` 는 현재 method 외의 카드 정보·영수증 URL 등을 포함하지 않는다(필요해지면 추가).
- 모든 동작은 fetch 모의로만 검증, 실제 토스 호출·테스트 키 검증 없음.

## 8. 가상계좌·웹훅 (2026-10-17 추가)
- 가상계좌 승인은 `waiting_for_deposit` 으로 온다(승인 완료 아님). 앱은 `payment.virtualAccount`(계좌·은행·기한)를 안내하고 PENDING 을 유지한다.
- 웹훅은 **신호일 뿐**이다: 수신 → `paymentKey`/`orderId` 로 `getPayment` 조회 → `isWebhookSecretValid(payment.secret, 웹훅본문.secret)` 로 진위 대조 → `interpretPayment` 로 상태 확정. 웹훅 본문의 상태값으로 DB 를 바꾸지 않는다. `secret` 은 로그·저장 금지.
- 가상계좌 취소는 `refundReceiveAccount` 필수(입금 전 취소는 해당 없을 수 있음 — 미확인). 환불 진행은 `payment.virtualAccount.refundStatus`·`cancels[].cancelStatus` 로 확인.
- 이벤트 종류(`PAYMENT_STATUS_CHANGED`·`DEPOSIT_CALLBACK`·`CANCEL_STATUS_CHANGED` 등)는 토스 웹훅 가이드 참고. 이 모듈은 수신 라우트·재시도 응답(10초 내 200)을 다루지 않는다.
