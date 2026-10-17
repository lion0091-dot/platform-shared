/**
 * 웹훅 진위 대조: 웹훅 본문의 secret 이 결제 조회(Payment.secret)의 값과 같으면 토스가 보낸 것이다(공식 문서).
 * 앱 순서: 웹훅 수신 → paymentKey/orderId 로 getPayment 조회 → 이 함수로 secret 대조 → interpretPayment 로 상태 확정. 웹훅 본문의 상태는 믿지 않는다.
 * 길이와 무관하게 끝까지 비교한다(타이밍 누출 완화). 둘 중 하나라도 비었으면 false.
 */
export function isWebhookSecretValid(paymentSecret: string | null | undefined, received: unknown): boolean {
  if (typeof paymentSecret !== "string" || typeof received !== "string" || paymentSecret.length === 0 || received.length === 0) return false;

  let diff = paymentSecret.length ^ received.length;
  const n = Math.max(paymentSecret.length, received.length);

  for (let i = 0; i < n; i++) diff |= (paymentSecret.charCodeAt(i) || 0) ^ (received.charCodeAt(i) || 0);

  return diff === 0;
}
