import { getPayment, getPaymentByOrderId } from "./client";
import { getPaymentSecret } from "./secret";
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

/**
 * authenticated  본문의 secret 이 토스 조회 결과의 secret 과 일치 → 토스가 보낸 요청임이 확인됨.
 * refetched      secret 대조가 불가능(조회 결과에 secret 이 없음)해 **요청의 진위는 확인하지 못했다**. 재조회한 payment(토스가 직접 알려준 상태)만 믿을 수 있다.
 *                앱은 이 값을 "인증됨"으로 쓰지 말고 payment 의 상태만 근거로 처리한다(요청이 위조여도 payment 는 사실이라 안전).
 * rejected       본문 이상(BAD_PAYLOAD)·결제 없음(NOT_FOUND)·secret 불일치(SECRET_MISMATCH)·조회에는 secret 이 있는데 본문에 없음(SECRET_MISSING, 위조 의심)·입금 웹훅인데 조회에 secret 없음(SECRET_UNAVAILABLE)
 * lookup_failed  토스 조회 실패(재시도 대상)
 */
export type WebhookCheck =
  | { kind: "authenticated"; eventType: string; payment: TossPayment }
  | { kind: "refetched"; eventType: string; payment: TossPayment }
  | { kind: "rejected"; reason: "BAD_PAYLOAD" | "NOT_FOUND" | "SECRET_MISMATCH" | "SECRET_MISSING" | "SECRET_UNAVAILABLE" }
  | { kind: "lookup_failed"; outcome: Exclude<LookupOutcome, { kind: "found" }> };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * 결제 웹훅 진위·최신 상태 확인. **웹훅 본문의 상태값은 믿지 않는다** — 본문에서 paymentKey/orderId 만 꺼내 토스를 다시 조회하고, 그 결과(payment)만 근거로 쓴다.
 *  - DEPOSIT_CALLBACK(본문: orderId·secret·status·transactionKey): 주문번호로 조회 + secret 대조 필수. 조회 결과에 secret 이 없으면 SECRET_UNAVAILABLE 로 거부.
 *  - PAYMENT_STATUS_CHANGED·CANCEL_STATUS_CHANGED(본문: eventType·createdAt·data): data 의 paymentKey(없으면 orderId)로 조회. 서명 헤더는 없다(`tosspayments-webhook-signature` 는 지급대행·셀러 웹훅 전용).
 *    조회 결과에 secret 이 있으면 data.secret 이 같아야 `authenticated`(없거나 다르면 거부). 조회 결과에 secret 이 없으면 대조할 수 없어 `refetched`(진위 미확인, 재조회한 payment 만 신뢰).
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

  // 웹훅 본문의 값이 형식 규칙을 어긴 경우(INVALID_ORDER_ID·INVALID_PAYMENT_KEY)만 거부로 바꾼다.
  // 그 밖의 던짐(KEY_MODE_REQUIRED·KEY_MODE_MISMATCH 같은 설정 오류 등)은 삼키지 않고 그대로 던져, 운영 설정 오류가 "모든 웹훅 거부"로 숨지 않게 한다.
  let l: LookupOutcome;

  try {
    l = paymentKey ? await getPayment(cfg, paymentKey) : await getPaymentByOrderId(cfg, orderId!);
  } catch (e) {
    if (e instanceof Error && /^(INVALID_ORDER_ID|INVALID_PAYMENT_KEY)\b/.test(e.message)) return { kind: "rejected", reason: "BAD_PAYLOAD" };

    throw e;
  }

  if (l.kind === "not_found") return { kind: "rejected", reason: "NOT_FOUND" };
  if (l.kind !== "found") return { kind: "lookup_failed", outcome: l };

  const received = isDeposit ? str(b.secret) : data ? str(data.secret) : null;
  const known = getPaymentSecret(l.payment);

  if (isDeposit) {
    if (!known) return { kind: "rejected", reason: "SECRET_UNAVAILABLE" };

    return isWebhookSecretValid(known, received) ? { kind: "authenticated", eventType, payment: l.payment } : { kind: "rejected", reason: "SECRET_MISMATCH" };
  }

  if (known) {
    // 결제에 secret 이 있으면 정상 웹훅(data=Payment 객체)에도 있어야 한다. 없으면 위조 의심으로 거부한다.
    if (!received) return { kind: "rejected", reason: "SECRET_MISSING" };

    return isWebhookSecretValid(known, received) ? { kind: "authenticated", eventType, payment: l.payment } : { kind: "rejected", reason: "SECRET_MISMATCH" };
  }

  return { kind: "refetched", eventType, payment: l.payment };
}
