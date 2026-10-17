import { isFullyCanceled } from "./status";
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
  // 결제 승인 섹션(공식 에러 코드 페이지 2026-10-17 열람): 한도·횟수·시간대·인증·계정 계열 거절
  "EXCEED_MAX_DAILY_PAYMENT_COUNT",
  "EXCEED_MAX_PAYMENT_AMOUNT",
  "EXCEED_MAX_ONE_DAY_WITHDRAW_AMOUNT",
  "EXCEED_MAX_ONE_TIME_WITHDRAW_AMOUNT",
  "EXCEED_MAX_AMOUNT",
  "EXCEED_MAX_MONTHLY_PAYMENT_AMOUNT",
  "EXCEED_MAX_AUTH_COUNT",
  "EXCEED_MAX_ONE_DAY_AMOUNT",
  "NOT_ALLOWED_POINT_USE",
  "BELOW_MINIMUM_AMOUNT",
  "NOT_FOUND_TERMINAL_ID",
  "INVALID_AUTHORIZE_AUTH",
  "RESTRICTED_TRANSFER_ACCOUNT",
  "INVALID_UNREGISTERED_SUBMALL",
  "NOT_REGISTERED_BUSINESS",
  "INVALID_ACCOUNT_INFO_RE_REGISTER",
  "NOT_AVAILABLE_PAYMENT",
  "NOT_AVAILABLE_BANK",
  "INVALID_PASSWORD",
  "INCORRECT_BASIC_AUTH_FORMAT",
  "FDS_ERROR",
]);

/** 취소 섹션: 같은 요청을 되풀이해도 소용없어 사람이 처리해야 하는 코드(NOT_CANCELABLE_* 외) */
const NOT_CANCELABLE_EXTRA = new Set([
  "EXCEED_CANCEL_LIMIT",
  "REFUND_REJECTED",
  "NOT_ALLOWED_PARTIAL_REFUND",
  "NOT_ALLOWED_PARTIAL_REFUND_WAITING_DEPOSIT",
  "EXCEED_CANCEL_AMOUNT_DISCOUNT_AMOUNT",
  "FORBIDDEN_BANK_REFUND_REQUEST",
  "FAILED_CLOSED_ACCOUNT_REFUND",
  "INVALID_REFUND_ACCOUNT_INFO",
  "INVALID_REFUND_ACCOUNT_NUMBER",
  "INVALID_BANK",
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
    if (code.startsWith("NOT_CANCELABLE_") || code === "EXCEED_MAX_REFUND_DUE" || NOT_CANCELABLE_EXTRA.has(code)) return "not_cancelable";
    // 은행 서비스 시간이 아님: 환불은 일어나지 않았고 시간이 지나면 가능 → 같은 키로 나중에 재시도
    if (code === "NOT_AVAILABLE_BANK") return "retry_later";
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
  // 통화가 KRW 가 아니면 금액이 같아 보여도 같은 값이 아니다(응답에 통화가 없으면 KRW 로 본다)
  if (payment.currency && payment.currency !== "KRW") return "mismatch";

  if (isFullyCanceled(payment)) return "canceled";

  switch (payment.status) {
    case "DONE":
      return "paid";
    case "CANCELED":
      return "canceled";
    case "PARTIAL_CANCELED":
      return "partial_canceled";
    case "WAITING_FOR_DEPOSIT":
      return "waiting_for_deposit";
    case "ABORTED":
    case "EXPIRED":
      return "not_paid";
    default:
      return "in_progress";
  }
}
