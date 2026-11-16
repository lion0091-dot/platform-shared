import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** 주문 나이(경과 24시간 단위, 내림)가 이 집합일 때만 조회한다 — 상태 저장 없이 날짜 산술만으로 평생 10회(미트 현행과 같음). */
export const OUTSIDE_CANCEL_CHECK_AGES_DAYS: readonly number[] = [1, 2, 3, 4, 7, 8, 14, 15, 30, 31];

const DAY_MS = 86_400_000;

const toMs = (v: string | number | Date): number => (v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(v).getTime());

/** 주문 나이(일). 시각을 못 읽거나 미래이면 null. */
export function orderAgeDays(orderedAt: string | number | Date, now: string | number | Date): number | null {
  const a = toMs(orderedAt);
  const b = toMs(now);

  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;

  return Math.floor((b - a) / DAY_MS);
}

/** 이 주문을 지금 조회할 차례인가. 던지지 않는다(잘못된 입력은 false). */
export function isDueForCheck(orderedAt: string | number | Date, now: string | number | Date, ages: readonly number[] = OUTSIDE_CANCEL_CHECK_AGES_DAYS): boolean {
  const age = orderAgeDays(orderedAt, now);

  return age !== null && ages.includes(age);
}

/** PG 결제 식별자 → SHA-256 hex. 원문은 저장·로그하지 않고 이 값(또는 앞자리)만 쓴다. */
export function paymentRefHash(paymentRef: string): string {
  return createHash("sha256").update(paymentRef, "utf8").digest("hex");
}

/** 취소 건 멱등 키. transactionKey 앞 100자만 쓴다(미트 `cncl:` 형식과 같음). */
export function cancelEventKey(paymentRef: string, cancelRef: string): string {
  return `cncl:${paymentRefHash(paymentRef)}:${cancelRef.slice(0, 100)}`;
}

/** 웹훅 주소 비밀은 이 길이 미만이면 없는 것으로 본다(웹훅 꺼짐). */
export const MIN_WEBHOOK_SECRET_LENGTH = 24;

/** 업체(테넌트)별 웹훅 주소 토큰: HMAC-SHA256(secret, `toss-webhook:<tenantId>`) hex. 비밀이 짧거나 id 가 비면 null. */
export function webhookUrlToken(secret: string, tenantId: string): string | null {
  if (typeof secret !== "string" || secret.length < MIN_WEBHOOK_SECRET_LENGTH || typeof tenantId !== "string" || tenantId.length === 0) return null;

  return createHmac("sha256", secret).update(`toss-webhook:${tenantId}`).digest("hex");
}

/** 주소 토큰 검증(상수 시간 비교). 복호화·DB·토스 호출보다 먼저 한다. 비밀·토큰·id 가 없으면 false. */
export function verifyWebhookUrlToken(secret: string | null | undefined, tenantId: string, token: string | null | undefined): boolean {
  if (!secret || !token) return false;

  const expectedHex = webhookUrlToken(secret, tenantId);

  if (!expectedHex) return false;

  const expected = Buffer.from(expectedHex, "utf8");
  const given = Buffer.from(token, "utf8");

  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 웹훅 본문 상한(바이트). 이보다 크면 읽지 않는다. */
export const WEBHOOK_MAX_BODY_BYTES = 16 * 1024;

export interface WebhookRef {
  paymentKey: string | null;
  orderId: string | null;
}

const REF_PATTERN = /^[A-Za-z0-9_\-=.]{1,200}$/;

const asRef = (v: unknown): string | null => (typeof v === "string" && REF_PATTERN.test(v) ? v : null);

/**
 * 웹훅 본문에서 «조회 키»만 꺼낸다(상태·금액·그 밖 필드는 읽지 않는다 — 본문은 믿지 않고 재조회한 값만 근거).
 * PAYMENT_STATUS_CHANGED·CANCEL_STATUS_CHANGED 는 data.paymentKey/orderId, DEPOSIT_CALLBACK 은 본문 orderId.
 * 형식(영문·숫자·`_-=.` 200자 이하)이 아니면 그 값은 null. 둘 다 null 이면 null 을 돌려준다. 던지지 않는다.
 */
export function extractWebhookRef(body: unknown): WebhookRef | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const b = body as Record<string, unknown>;
  const data = b.data && typeof b.data === "object" && !Array.isArray(b.data) ? (b.data as Record<string, unknown>) : null;
  const paymentKey = data ? asRef(data.paymentKey) : null;
  const orderId = data ? asRef(data.orderId) : asRef(b.orderId);

  if (!paymentKey && !orderId) return null;

  return { paymentKey, orderId };
}

/** 조회 응답의 주문번호가 요청한 값과 같을 때만 쓴다(업체 격리·위조 방어). 요청 값이 없으면(키로만 조회) 통과. */
export function orderRefMatches(requestedOrderId: string | null | undefined, responseOrderId: string | null | undefined): boolean {
  if (!requestedOrderId) return true;

  return typeof responseOrderId === "string" && responseOrderId === requestedOrderId;
}
