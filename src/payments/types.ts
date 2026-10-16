/** 토스페이먼츠 결제 승인·조회·취소의 도메인 중립 타입. 앱의 DB·상태머신은 여기 없다. */

export interface TossConfig {
  /** 시크릿키(서버 전용). 코드·저장소에 쓰지 않는다. */
  secretKey: string;
  /** 시험용으로 fetch 를 바꿔 끼운다(기본: 전역 fetch). */
  fetch?: typeof fetch;
  /** 기본 https://api.tosspayments.com */
  baseUrl?: string;
  /** 호출 제한 시간(ms). 기본 15000 */
  timeoutMs?: number;
}

/** 토스 Payment 객체 중 쓰는 필드만. status 는 토스 원문(DONE·CANCELED·PARTIAL_CANCELED·READY·IN_PROGRESS·WAITING_FOR_DEPOSIT·ABORTED·EXPIRED …). */
export interface TossPayment {
  paymentKey: string;
  orderId: string;
  status: string;
  totalAmount: number;
  method: string;
  approvedAt: string | null;
  /** 취소 후 남은 취소 가능 금액(Payment.balanceAmount). 응답에 없으면 null */
  balanceAmount: number | null;
  /** 취소 이력(Payment.cancels, null 이면 빈 배열). 이미 취소된 금액 = totalAmount - balanceAmount 또는 cancels 의 cancelAmount 합 */
  cancels: TossCancel[];
}

/** Payment.cancels 항목 중 쓰는 최소 필드 */
export interface TossCancel {
  cancelAmount: number;
  cancelReason: string;
  canceledAt: string | null;
  transactionKey: string | null;
  /** 문서: DONE 이면 취소 성공 */
  cancelStatus: string | null;
}

export interface ConfirmInput {
  paymentKey: string;
  orderId: string;
  /** 클라이언트가 준 값이 아니라 서버가 DB 에서 계산한 기대 금액(원, 정수) */
  amount: number;
  /** 생략하면 confirmIdempotencyKey(orderId, paymentKey). 재시도 때는 반드시 같은 값을 넘긴다. */
  idempotencyKey?: string;
}

export type ConfirmMismatchReason = "ORDER_MISMATCH" | "AMOUNT_MISMATCH";

/**
 * success         승인 완료(status DONE · orderId·paymentKey 일치 · totalAmount === 기대 금액)
 * already_done    토스가 "이미 처리된 결제"(ALREADY_PROCESSED_PAYMENT) → 조회로 확정
 * uncertain       결과 불명(PROVIDER_ERROR·5xx·타임아웃·네트워크·응답 형식 이상·200 이지만 status≠DONE) → FAILED 확정 금지, 조회 후 확정
 * processing      같은 요청이 처리 중(409 IDEMPOTENT_REQUEST_PROCESSING 등) → 조금 뒤 조회/같은 키로 재호출
 * fatal           재시도해도 같음(키 오류·권한·카드사 거절 등) → 실패 확정 가능
 * session_expired 결제 세션 만료(NOT_FOUND_PAYMENT_SESSION) → 새 결제창으로 다시 시작
 * approved_mismatch 승인 응답(200)은 왔으나 주문·금액이 기대와 다름 = 토스에서는 결제가 승인된 상태 → 앱이 PG 취소(cancelPayment)를 연계하고 사람이 확인
 */
export type ConfirmOutcome =
  | { kind: "success"; payment: TossPayment }
  | { kind: "already_done"; code: string }
  | { kind: "uncertain"; code: string; message: string }
  | { kind: "processing"; code: string }
  | { kind: "fatal"; code: string; message: string }
  | { kind: "session_expired"; code: string; message?: string }
  | { kind: "approved_mismatch"; reason: ConfirmMismatchReason; payment: TossPayment };

/**
 * found        결제가 있다(payment.status 를 interpretPayment 로 해석)
 * not_found    그 주문번호로 결제 기록이 없다(결제창을 안 열었거나 승인 전) — 에러가 아님
 * retry_later  연속 호출 제한(FORBIDDEN_CONSECUTIVE_REQUEST)·429 → 잠시 뒤 다시
 * uncertain    5xx·타임아웃·네트워크·응답 형식 이상 → 나중에 다시 조회
 * fatal        키 오류·권한 등
 */
export type LookupOutcome =
  | { kind: "found"; payment: TossPayment }
  | { kind: "not_found"; code: string }
  | { kind: "retry_later"; code: string }
  | { kind: "uncertain"; code: string; message: string }
  | { kind: "fatal"; code: string; message: string };

export interface CancelInput {
  paymentKey: string;
  cancelReason: string;
  /** 생략하면 전액 취소 */
  cancelAmount?: number;
  /** 부분 취소(cancelAmount 지정)일 때 필수: 요청 직전 토스 기준 취소 누계(원). 응답 검증(이번 금액만큼 늘었는지)에 쓴다. 전액 취소는 생략. */
  alreadyCanceledTotal?: number;
  /** 필수. 같은 취소 건에는 항상 같은 값(cancelIdempotencyKey 로 만든다). */
  idempotencyKey: string;
}

/**
 * canceled        취소 확인됨(응답 status CANCELED/PARTIAL_CANCELED, 또는 이미 취소돼 조회로 CANCELED 확인 — alreadyCanceled=true)
 * processing      취소 진행 중(ALREADY_REFUNDING_PAYMENT·409 IDEMPOTENT_REQUEST_PROCESSING) → 조금 뒤 조회
 * retry_later     FORBIDDEN_CONSECUTIVE_REQUEST·429 → 잠시 뒤 같은 키로 재시도
 * uncertain       결과 불명(PROVIDER_ERROR·5xx·타임아웃·ALREADY_* 인데 조회로 확인 못 함) → 조회 후 확정, 같은 키 유지
 * not_cancelable  NOT_CANCELABLE_*·EXCEED_MAX_REFUND_DUE → 재시도 금지, 사람이 처리
 * fatal           키 오류·권한 등
 */
export type CancelOutcome =
  | { kind: "canceled"; payment: TossPayment; alreadyCanceled: boolean }
  | { kind: "processing"; code: string }
  | { kind: "retry_later"; code: string }
  | { kind: "uncertain"; code: string; message: string }
  | { kind: "not_cancelable"; code: string; message: string }
  | { kind: "fatal"; code: string; message: string };

/** interpretPayment 결과 */
export type PaymentInterpretation =
  | "paid" // DONE + 주문·금액 일치
  | "canceled" // CANCELED
  | "partial_canceled" // PARTIAL_CANCELED
  | "in_progress" // READY·IN_PROGRESS·WAITING_FOR_DEPOSIT·그 밖의 진행 상태 → PENDING 유지
  | "not_paid" // ABORTED·EXPIRED → 승인 안 됨, 실패 확정 가능
  | "mismatch"; // 주문번호/금액이 기대와 다름 → 자동 확정 금지

export type FailUrlKind = "user_canceled" | "aborted" | "card_rejected" | "other";
