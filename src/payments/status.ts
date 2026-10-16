import type { TossPayment } from "./types";

/**
 * 완전히 취소된 결제인가. 토스는 부분 취소로 잔액을 0 까지 만들어도 status 를 CANCELED 가 아닌 PARTIAL_CANCELED 로 남긴다(2026-10-16 실측).
 * 그래서 CANCELED 이거나, PARTIAL_CANCELED 이면서 balanceAmount 가 정확히 0 일 때만 true. balanceAmount 가 없으면(null) 판단하지 않는다.
 * 내부용(index 에서 내보내지 않는다).
 */
export function isFullyCanceled(p: Pick<TossPayment, "status" | "balanceAmount">): boolean {
  return p.status === "CANCELED" || (p.status === "PARTIAL_CANCELED" && p.balanceAmount === 0);
}
