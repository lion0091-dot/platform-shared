/**
 * Idempotency-Key 규칙(토스 문서): 최대 300자, 첫 요청부터 15일 유효, (키+API키+URL+메서드)가 같으면 첫 응답을 돌려준다.
 * 에러가 나도 키를 바꿔 재시도하지 말고 원인(조회)을 확인한 뒤 같은 키로 다시 보낸다.
 * 키는 "결제 건당 안정적인 값"이어야 한다: 같은 결제를 다시 시도할 때 항상 같은 값, 다른 결제에는 다른 값.
 */
export const IDEMPOTENCY_KEY_MAX = 300;

const SAFE = /^[\x21-\x7e]+$/; // 보이는 ASCII 만(우리 쪽 안전 제약, 토스 문서에 문자 제한은 미확인)

export function assertIdempotencyKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX || !SAFE.test(key)) {
    throw new Error("INVALID_IDEMPOTENCY_KEY: 1~300자의 보이는 ASCII 여야 한다.");
  }

  return key;
}

/** 승인 키: 결제 시도(paymentKey)마다 다르게 — 같은 주문번호로 결제창을 다시 열어도 이전 시도의 응답이 재사용되지 않는다. */
export function confirmIdempotencyKey(orderId: string, paymentKey: string): string {
  return assertIdempotencyKey(`confirm_${orderId}_${paymentKey}`);
}

/** 취소 키: 같은 취소 요청(결제·기취소 합계·이번 금액)이면 같은 값. 금액 생략(전액)은 "full". */
export function cancelIdempotencyKey(p: { paymentKey: string; cancelAmount?: number; alreadyCanceledTotal?: number }): string {
  return assertIdempotencyKey(`cancel_${p.paymentKey}_${p.alreadyCanceledTotal ?? 0}_${p.cancelAmount ?? "full"}`);
}
