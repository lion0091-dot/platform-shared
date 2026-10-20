import type { TossCancel, TossPayment } from "./types";

/** 취소 항목이 완료됐는가: cancelStatus 가 DONE 이거나 값이 없을 때(문서: DONE 이면 취소 성공). 진행 중·실패 등 다른 문자열이면 합계에서 제외한다. */
export const isDoneCancel = (c: Pick<TossCancel, "cancelStatus">): boolean => c.cancelStatus == null || c.cancelStatus === "DONE";

const sumDone = (cancels: TossCancel[]): number => cancels.filter(isDoneCancel).reduce((s, c) => s + c.cancelAmount, 0);

/**
 * 토스 기준 현재까지 취소된 누계(원). balanceAmount 가 있으면 totalAmount - balanceAmount, 없으면 cancels 의 cancelAmount 합,
 * 둘 다 없고 status 가 CANCELED 면 totalAmount, 그 밖에는 null(판단 불가). 부분 취소 전 alreadyCanceledTotal 을 만들 때도 쓴다.
 */
export function canceledTotal(p: Pick<TossPayment, "status" | "totalAmount" | "balanceAmount" | "cancels">): number | null {
  if (typeof p.balanceAmount === "number") return p.totalAmount - p.balanceAmount;
  if (p.cancels.length > 0) return sumDone(p.cancels);

  return p.status === "CANCELED" ? p.totalAmount : null;
}

/**
 * 완전히 취소된 결제인가. 토스는 부분 취소로 잔액을 0 까지 만들어도 status 를 CANCELED 가 아닌 PARTIAL_CANCELED 로 남긴다(2026-10-16 실측).
 * 그래서 CANCELED 이거나, PARTIAL_CANCELED 이면서 balanceAmount 가 정확히 0 일 때 true.
 * balanceAmount 가 없으면(null) cancels 의 cancelAmount 합이 totalAmount 와 같을 때(합이 0 보다 큼)만 true — 둘 다 없으면 판단하지 않는다.
 * 내부용(index 에서 내보내지 않는다).
 */
export function isFullyCanceled(p: Pick<TossPayment, "status" | "balanceAmount"> & Partial<Pick<TossPayment, "cancels" | "totalAmount">>): boolean {
  if (p.status === "CANCELED") return true;
  if (p.status !== "PARTIAL_CANCELED") return false;
  if (p.balanceAmount === 0) return true;
  if (p.balanceAmount !== null || !p.cancels || p.cancels.length === 0 || typeof p.totalAmount !== "number") return false;

  const sum = sumDone(p.cancels);

  return sum > 0 && sum === p.totalAmount;
}
