import type { FailUrlKind, PaymentInterpretation, TossPayment } from "./types";

export type Op = "confirm" | "lookup" | "cancel";

export type ErrorClass =
  | "already_done"
  | "uncertain"
  | "processing"
  | "fatal"
  | "session_expired"
  | "retry_later"
  | "not_cancelable"
  | "already_canceled"
  | "not_found";

const PROCESSING = new Set(["IDEMPOTENT_REQUEST_PROCESSING", "ALREADY_PROCESSING_REQUEST", "ALREADY_REFUNDING_PAYMENT"]);
const UNCERTAIN = new Set(["PROVIDER_ERROR", "FAILED_INTERNAL_SYSTEM_PROCESSING", "FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING", "FAILED_CARD_COMPANY_RESPONSE"]);

/**
 * 분명한 실패(fatal): 요청이 거절돼 결제가 일어나지 않았음이 분명한 코드(공식 에러 코드 페이지 2026-10-16 열람 기준).
 * 카드사 거절·한도·카드 정보 오류, 키·권한 오류, 존재하지 않는 결제. CARD_PROCESSING_ERROR(카드사 오류)는 일부러 뺐다 → 불확실.
 */
export const DEFINITE_FAILURE: ReadonlySet<string> = new Set([
  "UNAUTHORIZED_KEY",
  "FORBIDDEN_REQUEST",
  "INVALID_API_KEY",
  "INVALID_REQUEST",
  "NOT_FOUND_PAYMENT",
  "REJECT_CARD_COMPANY",
  "REJECT_CARD_PAYMENT",
  "REJECT_ACCOUNT_PAYMENT",
  "REJECT_TOSSPAY_INVALID_ACCOUNT",
  "INVALID_REJECT_CARD",
  "INVALID_CARD_EXPIRATION",
  "INVALID_STOPPED_CARD",
  "INVALID_CARD_LOST_OR_STOLEN",
  "INVALID_CARD_NUMBER",
  "INVALID_CARD_INSTALLMENT_PLAN",
  "NOT_SUPPORTED_INSTALLMENT_PLAN_CARD_OR_MERCHANT",
  // 결제 승인 섹션(공식 에러 코드 페이지 2026-10-16 열람, 400): 할부 개월 초과·할부 미지원 카드
  "EXCEED_MAX_CARD_INSTALLMENT_PLAN",
  "NOT_SUPPORTED_MONTHLY_INSTALLMENT_PLAN",
]);

/** 토스 오류(HTTP 상태 + code) → 분류. 순수 함수. 분류표는 docs/payments-api-draft.md. */
export function classifyTossError(op: Op, httpStatus: number, code: string): ErrorClass {
  if (PROCESSING.has(code) || (httpStatus === 409 && /PROCESSING/.test(code))) return "processing";

  if (op === "confirm") {
    if (code === "ALREADY_PROCESSED_PAYMENT") return "already_done";
    if (code === "NOT_FOUND_PAYMENT_SESSION") return "session_expired";
  }

  if (op === "cancel") {
    if (code === "ALREADY_CANCELED_PAYMENT" || code === "ALREADY_REFUND_PAYMENT") return "already_canceled";
    if (code.startsWith("NOT_CANCELABLE_") || code === "EXCEED_MAX_REFUND_DUE") return "not_cancelable";
  }

  if (op !== "confirm" && code === "FORBIDDEN_CONSECUTIVE_REQUEST") return "retry_later";
  if (httpStatus === 429) return op === "confirm" ? "uncertain" : "retry_later";
  if (UNCERTAIN.has(code) || httpStatus >= 500) return "uncertain";
  if (op === "lookup" && (httpStatus === 404 || code === "NOT_FOUND_PAYMENT" || code === "NOT_FOUND")) return "not_found";

  // 분명한 실패: 문서에 올라 있고 "결제가 일어나지 않았음"이 분명한 코드만. 그 밖의 모르는 코드는 불확실(조회로 확정).
  if (DEFINITE_FAILURE.has(code)) return "fatal";

  return "uncertain";
}

/** failUrl 쿼리의 code 분류. */
export function classifyFailCode(code: string | null | undefined): FailUrlKind {
  if (code === "PAY_PROCESS_CANCELED") return "user_canceled";
  if (code === "PAY_PROCESS_ABORTED") return "aborted";
  if (code === "REJECT_CARD_COMPANY") return "card_rejected";

  return "other";
}

/** 조회 결과(Payment)를 앱이 기대한 주문·금액과 대조해 해석한다. expected 는 앱이 DB 에서 가져온 값이어야 한다. */
export function interpretPayment(payment: TossPayment, expected: { orderId: string; amount: number }): PaymentInterpretation {
  if (payment.orderId !== expected.orderId || payment.totalAmount !== expected.amount) return "mismatch";

  switch (payment.status) {
    case "DONE":
      return "paid";
    case "CANCELED":
      return "canceled";
    case "PARTIAL_CANCELED":
      return "partial_canceled";
    case "ABORTED":
    case "EXPIRED":
      return "not_paid";
    default:
      return "in_progress";
  }
}
