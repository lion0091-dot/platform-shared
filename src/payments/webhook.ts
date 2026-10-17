import { getPayment, getPaymentByOrderId } from "./client";
import type { LookupOutcome, TossConfig, TossPayment } from "./types";

/**
 * 웹훅 secret 대조(공식 문서 https://docs.tosspayments.com/reference/using-api/webhook-events, 2026-10-17 열람):
 * 가상계좌 입금 웹훅(DEPOSIT_CALLBACK)의 `secret` 이 결제의 `secret`(승인 응답·조회 Payment.secret)과 같으면 정상 요청이다.
 * 길이와 무관하게 끝까지 비교한다(타이밍 누출 완화). 둘 중 하나라도 비었으면 false.
 */
export function isWebhookSecretValid(paymentSecret: string | null | undefined, received: unknown): boolean {
  if (typeof paymentSecret !== "string" || typeof received !== "string" || paymentSecret.length === 0 || received.length === 0) return false;

  let diff = paymentSecret.length ^ received.length;
  const n = Math.max(paymentSecret.length, received.length);

  for (let i = 0; i < n; i++) diff |= (paymentSecret.charCodeAt(i) || 0) ^ (received.charCodeAt(i) || 0);

  return diff === 0;
}

export type WebhookCheck =
  | { kind: "verified"; eventType: string; payment: TossPayment; secretChecked: boolean }
  | { kind: "rejected"; reason: "BAD_PAYLOAD" | "NOT_FOUND" | "SECRET_MISMATCH" | "SECRET_UNAVAILABLE" }
  | { kind: "lookup_failed"; outcome: Exclude<LookupOutcome, { kind: "found" }> };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * 결제 웹훅 진위·최신 상태 확인. **웹훅 본문의 상태값은 믿지 않는다** — 본문에서 paymentKey/orderId 만 꺼내 토스를 다시 조회하고, 그 결과(payment)만 근거로 쓴다.
 *  - DEPOSIT_CALLBACK(본문: orderId·secret·status·transactionKey): 주문번호로 조회 + secret 대조 필수. 조회 결과에 secret 이 없으면 SECRET_UNAVAILABLE 로 거부.
 *  - PAYMENT_STATUS_CHANGED·CANCEL_STATUS_CHANGED(본문: eventType·createdAt·data): data 의 paymentKey(없으면 orderId)로 조회. 서명 헤더는 없다(`tosspayments-webhook-signature` 는 지급대행·셀러 웹훅 전용).
 *    조회 결과와 data 양쪽에 secret 이 있으면 대조하고 다르면 거부, 어느 한쪽이 null 이면 대조 없이 재조회 결과만으로 확인(secretChecked:false).
 * 추가 방어(권장): 웹훅 엔드포인트의 출발 IP 허용 목록(보안 가이드 안내 IP)과 HTTPS. 10초 안에 200 응답.
 */
export async function verifyPaymentWebhook(cfg: TossConfig, body: unknown): Promise<WebhookCheck> {
  if (!body || typeof body !== "object") return { kind: "rejected", reason: "BAD_PAYLOAD" };

  const b = body as Record<string, unknown>;
  const data = b.data && typeof b.data === "object" ? (b.data as Record<string, unknown>) : null;
  const isDeposit = !data && str(b.secret) !== null && str(b.orderId) !== null && b.eventType === undefined;
  const eventType = str(b.eventType) ?? (isDeposit ? "DEPOSIT_CALLBACK" : null);

  if (!eventType) return { kind: "rejected", reason: "BAD_PAYLOAD" };

  const paymentKey = data ? str(data.paymentKey) : null;
  const orderId = data ? str(data.orderId) : str(b.orderId);

  if (!paymentKey && !orderId) return { kind: "rejected", reason: "BAD_PAYLOAD" };

  // 형식이 이상한 값(주문번호 규칙 위반 등)은 조회 함수가 던지므로 거부로 바꾼다
  let l: LookupOutcome;

  try {
    l = paymentKey ? await getPayment(cfg, paymentKey) : await getPaymentByOrderId(cfg, orderId!);
  } catch {
    return { kind: "rejected", reason: "BAD_PAYLOAD" };
  }

  if (l.kind === "not_found") return { kind: "rejected", reason: "NOT_FOUND" };
  if (l.kind !== "found") return { kind: "lookup_failed", outcome: l };

  const received = isDeposit ? str(b.secret) : data ? str(data.secret) : null;
  const known = l.payment.secret ?? null;

  if (isDeposit) {
    if (!known) return { kind: "rejected", reason: "SECRET_UNAVAILABLE" };

    return isWebhookSecretValid(known, received) ? { kind: "verified", eventType, payment: l.payment, secretChecked: true } : { kind: "rejected", reason: "SECRET_MISMATCH" };
  }

  if (known && received) {
    return isWebhookSecretValid(known, received) ? { kind: "verified", eventType, payment: l.payment, secretChecked: true } : { kind: "rejected", reason: "SECRET_MISMATCH" };
  }

  return { kind: "verified", eventType, payment: l.payment, secretChecked: false };
}
