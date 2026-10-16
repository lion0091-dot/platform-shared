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

/**
 * 취소 키: 같은 취소 요청이면 같은 값, 다른 취소 요청이면 다른 값.
 *  - 전액 취소(cancelAmount 생략): `cancel_<paymentKey>_full`
 *  - 부분 취소: cancelAmount 와 alreadyCanceledTotal(요청 직전 토스 기준 취소 누계, 원)을 **둘 다 필수**로 받는다.
 *    누계를 빼면 같은 금액의 두 번째 부분 취소가 첫 번째와 같은 키가 되어 토스가 첫 응답을 돌려주고 실제 환불은 1회뿐이다.
 *    그래서 누계가 없으면 던진다(타입 + 런타임).
 */
export type CancelKeyParts = { paymentKey: string; cancelAmount?: undefined } | { paymentKey: string; cancelAmount: number; alreadyCanceledTotal: number };

export function cancelIdempotencyKey(p: CancelKeyParts): string {
  if (p.cancelAmount === undefined) return assertIdempotencyKey(`cancel_${p.paymentKey}_full`);

  const total = (p as { alreadyCanceledTotal?: unknown }).alreadyCanceledTotal;

  if (!Number.isSafeInteger(p.cancelAmount) || p.cancelAmount <= 0) throw new Error("INVALID_AMOUNT: 취소 금액은 양의 정수(원)여야 한다.");
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new Error("INVALID_CANCELED_TOTAL: 부분 취소 키에는 요청 직전 취소 누계(alreadyCanceledTotal, 0 이상 정수)가 필수다.");

  return assertIdempotencyKey(`cancel_${p.paymentKey}_${total}_${p.cancelAmount}`);
}
