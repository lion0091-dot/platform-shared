import type { TossPayment } from "./types";

/**
 * 결제의 웹훅 대조용 secret 을 **명시적으로** 읽는다(없거나 비어 있으면 null).
 *
 * `TossPayment.secret` 은 로그·JSON 노출을 막으려고 열거되지 않는 속성이다. 그래서 `structuredClone`·`{...payment}`·`JSON.stringify`·큐/캐시 직렬화를
 * 거친 객체에는 secret 이 **없다**(그 객체로는 isWebhookSecretValid 가 false). 대조가 필요한 곳은 직렬화 전에 이 함수로 값을 꺼내 쓰거나,
 * 값을 들고 다니지 말고 `verifyPaymentWebhook` 으로 웹훅 때 다시 조회하는 편이 안전하다. secret 은 로그·저장 금지.
 */
export function getPaymentSecret(payment: Pick<TossPayment, "secret">): string | null {
  const v = payment.secret;

  return typeof v === "string" && v.length > 0 ? v : null;
}
