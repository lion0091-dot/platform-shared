/** 토스 주문번호(orderId): 영문 대소문자·숫자·-·_ , 6~64자. */
const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function isValidOrderId(orderId: unknown): orderId is string {
  return typeof orderId === "string" && ORDER_ID_RE.test(orderId);
}

export function assertOrderId(orderId: string): string {
  if (!isValidOrderId(orderId)) throw new Error("INVALID_ORDER_ID: 주문번호는 영문·숫자·-·_ 6~64자여야 한다.");

  return orderId;
}

/** 추측하기 어려운 새 주문번호: prefix + UUID(36자). prefix 는 영문·숫자·-·_ 만, 결과가 64자 이하여야 한다. */
export function generateOrderId(prefix = ""): string {
  return assertOrderId(`${prefix}${globalThis.crypto.randomUUID()}`);
}
