import { canceledTotal, isDoneCancel, isFullyCanceled } from "../payments/status";
import type { TossPayment } from "../payments/types";
import type { NormalizedPayment, NormalizedStatus } from "./types";

/**
 * 토스 원문 상태 → 정규화 상태. 모르는 값은 PENDING_UNCONFIRMED(안전 쪽).
 * 토스는 부분 취소로 잔액을 0 까지 만들어도 PARTIAL_CANCELED 로 남기므로(2026-10-16 실측) 전액 취소로 정규화한다(isFullyCanceled 재사용).
 */
function mapStatus(p: TossPayment): NormalizedStatus {
  switch (p.status) {
    case "DONE":
      return "APPROVED";
    case "CANCELED":
      return "CANCELED";
    case "PARTIAL_CANCELED":
      return isFullyCanceled(p) ? "CANCELED" : "PARTIAL_CANCELED";
    case "ABORTED":
    case "EXPIRED":
      return "FAILED";
    default:
      return "PENDING_UNCONFIRMED";
  }
}

/** 토스 Payment → 정규화 모양(순수, 던지지 않는다). 취소 누계는 완료된 취소(DONE·값 없음)만 합친다. */
export function fromTossPayment(p: TossPayment): NormalizedPayment {
  const cancels = Array.isArray(p.cancels) ? p.cancels : [];
  const done = cancels.filter(isDoneCancel);

  return {
    status: mapStatus(p),
    rawStatus: p.status,
    approvedAmount: p.totalAmount,
    currency: p.currency ?? null,
    canceledTotal: canceledTotal({ status: p.status, totalAmount: p.totalAmount, balanceAmount: p.balanceAmount, cancels }),
    balance: p.balanceAmount,
    providerPaymentRef: p.paymentKey,
    cancels: done.map((c) => ({ providerCancelRef: c.transactionKey, amount: c.cancelAmount, status: c.cancelStatus, canceledAt: c.canceledAt })),
  };
}
