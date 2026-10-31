/**
 * 토스페이먼츠 **테스트 환경** 실호출 통합 시험. 계약 전에도 개발자센터 테스트 키로 돌릴 수 있다.
 * 평소 `npm test` 에서는 제외된다(vitest.config.ts) — 환경변수를 export 해 둬도 외부 호출이 나가지 않는다.
 * `npm run test:toss`(vitest.toss.config.ts) 로만 실행한다. 키는 저장소에 쓰지 않는다.
 *
 *   TOSS_TEST_SECRET_KEY   필수. test_sk_… (API 개별 연동) 또는 test_gsk_… (결제위젯). live_ 키는 거부한다. 없으면 실패한다.
 *   ── 아래 셋은 결제창에서 테스트 결제를 마친 직후 successUrl 쿼리값(scripts/toss-test-checkout.html). 셋 다 있어야 2단계가 돈다 ──
 *   TOSS_TEST_PAYMENT_KEY  paymentKey
 *   TOSS_TEST_ORDER_ID     orderId
 *   TOSS_TEST_AMOUNT       amount(원, 3000 이상 정수 — 부분 취소 2회 + 전액 취소를 위해)
 *
 * 실행: npm run test:toss  (절차는 docs/payments-api-draft.md §12)
 * 승인은 결제창 인증 후 제한 시간(문서 10분, §7 미확인) 안에 해야 하고, paymentKey 하나는 한 번만 쓸 수 있다(승인→취소까지 진행됨).
 */
import { describe, expect, it } from "vitest";
import { canceledTotal, cancelIdempotencyKey, confirmIdempotencyKey, createTossClient, generateOrderId, interpretPayment, tossKeyMode, type TossPayment } from "./index";

const ENABLED = process.env.TOSS_INTEGRATION === "1";
const SECRET = (process.env.TOSS_TEST_SECRET_KEY ?? "").trim();
const PAYMENT_KEY = (process.env.TOSS_TEST_PAYMENT_KEY ?? "").trim();
const ORDER_ID = (process.env.TOSS_TEST_ORDER_ID ?? "").trim();
const AMOUNT_RAW = (process.env.TOSS_TEST_AMOUNT ?? "").trim();
// 양의 정수만 인정한다(빈 값 → Number("") === 0 이 안전한 정수로 통과하는 것을 막는다).
const AMOUNT = /^[1-9]\d*$/.test(AMOUNT_RAW) ? Number(AMOUNT_RAW) : NaN;

// 실행을 요청했는데 시험이 조용히 건너뛰어지면 안 된다(exit 0 오인) → 필수 입력이 없으면 파일 자체를 실패시킨다.
if (ENABLED && !SECRET) throw new Error("TOSS_TEST_SECRET_KEY 가 없다. test_sk_… 테스트 시크릿키를 export 한 뒤 npm run test:toss 를 실행한다(docs/payments-api-draft.md §12).");
// 실수로 운영 키를 넣으면 실제 승인·환불이 일어난다 → 시험 파일 자체를 실패시킨다(fail-closed).
if (SECRET && tossKeyMode(SECRET) !== "test") throw new Error("TOSS_TEST_SECRET_KEY 는 test_sk_/test_gsk_ 로 시작하는 테스트 시크릿키여야 한다(live 키 금지).");

const PAY_VARS = [PAYMENT_KEY !== "", ORDER_ID !== "", AMOUNT_RAW !== ""];

if (ENABLED && PAY_VARS.some(Boolean) && !(PAY_VARS.every(Boolean) && Number.isSafeInteger(AMOUNT))) {
  throw new Error("TOSS_TEST_PAYMENT_KEY·TOSS_TEST_ORDER_ID·TOSS_TEST_AMOUNT(양의 정수) 셋을 모두 넣거나 모두 비운다.");
}

const HAS_KEY = ENABLED && SECRET !== "";
const HAS_PAYMENT = HAS_KEY && PAY_VARS.every(Boolean);

if (HAS_KEY && !HAS_PAYMENT) console.warn("[toss 통합 시험] 결제 1건 시험(2단계)은 건너뜀 — TOSS_TEST_PAYMENT_KEY·ORDER_ID·AMOUNT 가 없다. 1단계(키만)만 실행한다.");

// 클라이언트 호출 제한(10초) × 재시도(retry_later 최대 3회) × 한 시험 안의 호출 수(최대 2)를 넘는 여유
const T = 120_000;
const RETRY_LATER_MAX = 3;
const RETRY_LATER_WAIT_MS = 2_000;

/** 마지막 토스 오류 응답 코드(시험이 "어떤 코드 때문에 그 분류가 됐는지" 확인하는 용도) */
let lastErrorCode: string | null = null;
const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);

  lastErrorCode = null;

  if (!res.ok) {
    try {
      const b = (await res.clone().json()) as { code?: unknown };
      lastErrorCode = typeof b.code === "string" ? b.code : `HTTP_${res.status}`;
    } catch {
      lastErrorCode = `HTTP_${res.status}`;
    }
  }

  return res;
};

const toss = createTossClient({ secretKey: SECRET, expectedMode: "test", timeoutMs: 10_000, fetch: recordingFetch });

/** FORBIDDEN_CONSECUTIVE_REQUEST·429 는 retry_later 로 분류된다 → 잠시 뒤 같은 입력으로 다시(최대 3회). 취소는 같은 멱등키라 안전하다. */
async function retrying<R extends { kind: string }>(call: () => Promise<R>): Promise<R> {
  let r = await call();

  for (let i = 1; i < RETRY_LATER_MAX && r.kind === "retry_later"; i++) {
    await new Promise((ok) => setTimeout(ok, RETRY_LATER_WAIT_MS));
    r = await call();
  }

  return r;
}

const lookupKey = (k: string) => retrying(() => toss.lookup(k));
const lookupOrder = (id: string) => retrying(() => toss.lookupByOrderId(id));
const cancel = (input: Parameters<typeof toss.cancel>[0]) => retrying(() => toss.cancel(input));
/** 잔액 0 까지 취소됐나: 토스는 부분 취소로 0 이 돼도 PARTIAL_CANCELED 로 남길 수 있다(2026-10-16 실측) → 상태 대신 잔액·누계로 본다. */
const fullyCanceled = (p: TossPayment) => p.status === "CANCELED" || (p.status === "PARTIAL_CANCELED" && (p.balanceAmount === 0 || canceledTotal(p) === p.totalAmount));

describe.skipIf(!HAS_KEY)("토스 테스트 환경 — 키만으로(결제창 없이)", () => {
  it("없는 주문번호 조회 → not_found (Basic 인증 통과 + 404 분류)", { timeout: T }, async () => {
    const r = await lookupOrder(generateOrderId("it-none-"));

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "not_found" });
  });

  it("없는 paymentKey 조회 → not_found", { timeout: T }, async () => {
    const r = await lookupKey(`it_fake_${Date.now()}`);

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "not_found" });
  });

  it("틀린 시크릿키 → fatal (UNAUTHORIZED_KEY 등)", { timeout: T }, async () => {
    const bad = createTossClient({ secretKey: "test_sk_integration_invalid_key", expectedMode: "test", timeoutMs: 10_000 });
    const r = await retrying(() => bad.lookupByOrderId(generateOrderId("it-bad-")));

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "fatal" });
  });

  it("가짜 paymentKey 승인 → session_expired 또는 fatal (결제 안 됨이 분명한 쪽으로 분류)", { timeout: T }, async () => {
    const r = await toss.confirm({ paymentKey: `it_fake_${Date.now()}`, orderId: generateOrderId("it-cf-"), amount: 1000 });

    expect(["session_expired", "fatal"], JSON.stringify(r)).toContain(r.kind);
  });

  it("가짜 paymentKey 취소 → fatal 또는 not_cancelable (canceled 로 오인하지 않음)", { timeout: T }, async () => {
    const paymentKey = `it_fake_${Date.now()}`;
    const r = await cancel({ paymentKey, cancelReason: "통합 시험", idempotencyKey: cancelIdempotencyKey({ paymentKey }) });

    expect(["fatal", "not_cancelable"], JSON.stringify(r)).toContain(r.kind);
  });
});

// 순서대로 실행된다(파일 안 it 은 직렬). 앞 단계가 실패하면 뒤 단계도 의미가 없다.
describe.skipIf(!HAS_PAYMENT)("토스 테스트 환경 — 결제창 결제 1건으로 승인→조회→부분취소→전액취소", () => {
  const P1 = 1000;
  const P2 = 1000;
  // 앞 시험의 응답을 뒤 시험이 "재생인지"를 가려내는 데 쓴다.
  let firstConfirm: TossPayment | null = null;
  let firstCancel: TossPayment | null = null;

  it("TOSS_TEST_AMOUNT 는 3000 이상", () => {
    expect(AMOUNT).toBeGreaterThanOrEqual(P1 + P2 + 1000);
  });

  it("승인 → success, 금액·주문 일치", { timeout: T }, async () => {
    const r = await toss.confirm({ paymentKey: PAYMENT_KEY, orderId: ORDER_ID, amount: AMOUNT });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "success", payment: { status: "DONE", totalAmount: AMOUNT, orderId: ORDER_ID } });
    if (r.kind === "success") firstConfirm = r.payment;
  });

  // 토스는 이미 DONE 인 결제의 재승인에 200 DONE 을 주므로(2026-10-16 실측) 결과 kind 만으로는 "재생"과 "그냥 DONE 조회"를 구분하지 못한다.
  // 그래서 첫 응답과 승인 시각·금액·상태가 그대로인지(새로 승인된 것이 아님)까지만 확인한다.
  it("같은 멱등키로 다시 승인 → success, 첫 응답과 승인 시각·금액이 같다(이중 승인 없음)", { timeout: T }, async () => {
    const r = await toss.confirm({ paymentKey: PAYMENT_KEY, orderId: ORDER_ID, amount: AMOUNT });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "success" });
    expect(firstConfirm, "앞 승인 시험이 먼저 성공해야 한다").not.toBeNull();
    if (r.kind === "success" && firstConfirm) expect({ approvedAt: r.payment.approvedAt, totalAmount: r.payment.totalAmount, status: r.payment.status }).toEqual({ approvedAt: firstConfirm.approvedAt, totalAmount: firstConfirm.totalAmount, status: firstConfirm.status });
  });

  it("다른 멱등키로 다시 승인 → success (토스는 200 DONE 을 그대로 돌려줌, 2026-10-16 실측)", { timeout: T }, async () => {
    const r = await toss.confirm({ paymentKey: PAYMENT_KEY, orderId: ORDER_ID, amount: AMOUNT, idempotencyKey: `${confirmIdempotencyKey(ORDER_ID, PAYMENT_KEY)}_2` });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "success", payment: { status: "DONE" } });
  });

  it("주문번호 조회 → found, interpretPayment = paid", { timeout: T }, async () => {
    const r = await lookupOrder(ORDER_ID);

    expect(r.kind, JSON.stringify(r)).toBe("found");
    if (r.kind === "found") expect(interpretPayment(r.payment, { orderId: ORDER_ID, amount: AMOUNT })).toBe("paid");
  });

  it("부분 취소 1회차(누계 0) → canceled, PARTIAL_CANCELED", { timeout: T }, async () => {
    const input = { paymentKey: PAYMENT_KEY, cancelAmount: P1, alreadyCanceledTotal: 0 };
    const r = await cancel({ ...input, cancelReason: "통합 시험 부분취소 1", idempotencyKey: cancelIdempotencyKey(input) });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "canceled", payment: { status: "PARTIAL_CANCELED" } });
    if (r.kind === "canceled") firstCancel = r.payment;
  });

  it("같은 키로 1회차 재시도 → 첫 응답 재생(취소 이력 1건, 같은 거래), 실제 환불은 1회뿐(조회 누계 = P1)", { timeout: T }, async () => {
    const input = { paymentKey: PAYMENT_KEY, cancelAmount: P1, alreadyCanceledTotal: 0 };
    const r = await cancel({ ...input, cancelReason: "통합 시험 부분취소 1", idempotencyKey: cancelIdempotencyKey(input) });

    expect(r.kind, JSON.stringify(r)).toBe("canceled");
    expect(firstCancel, "앞 부분 취소 시험이 먼저 성공해야 한다").not.toBeNull();

    // 재생이면 응답의 취소 이력이 첫 응답과 같다(새 취소였다면 이력이 늘거나 다른 거래가 붙는다).
    if (r.kind === "canceled" && firstCancel) {
      expect(r.payment.cancels.length).toBe(firstCancel.cancels.length);
      expect(r.payment.cancels.map((c) => c.transactionKey)).toEqual(firstCancel.cancels.map((c) => c.transactionKey));
    }

    const l = await lookupKey(PAYMENT_KEY);

    expect(l.kind, JSON.stringify(l)).toBe("found");
    if (l.kind === "found") {
      expect(l.payment.cancels.length).toBe(1);
      expect(canceledTotal(l.payment)).toBe(P1);
      if (l.payment.balanceAmount !== null) expect(l.payment.balanceAmount).toBe(AMOUNT - P1);
    }
  });

  it("부분 취소 2회차(누계 P1, 같은 금액) → 새 키라 실제 환불, 누계 P1+P2", { timeout: T }, async () => {
    const input = { paymentKey: PAYMENT_KEY, cancelAmount: P2, alreadyCanceledTotal: P1 };
    const r = await cancel({ ...input, cancelReason: "통합 시험 부분취소 2", idempotencyKey: cancelIdempotencyKey(input) });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "canceled", payment: { status: "PARTIAL_CANCELED" } });
    if (r.kind === "canceled") expect(canceledTotal(r.payment)).toBe(P1 + P2);
  });

  it("나머지 전액 취소 → canceled, 잔액 0(CANCELED 또는 잔액 0 인 PARTIAL_CANCELED)", { timeout: T }, async () => {
    const r = await cancel({ paymentKey: PAYMENT_KEY, cancelReason: "통합 시험 전액취소", idempotencyKey: cancelIdempotencyKey({ paymentKey: PAYMENT_KEY }) });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "canceled" });
    if (r.kind === "canceled") expect(fullyCanceled(r.payment), JSON.stringify(r.payment)).toBe(true);
  });

  it("다른 키로 전액 취소 한 번 더 → 토스가 ALREADY_CANCELED_PAYMENT 를 돌려주고, 조회로 확인해 canceled(alreadyCanceled)", { timeout: T }, async () => {
    const r = await cancel({ paymentKey: PAYMENT_KEY, cancelReason: "통합 시험 중복취소", idempotencyKey: `${cancelIdempotencyKey({ paymentKey: PAYMENT_KEY })}_2` });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "canceled", alreadyCanceled: true });
    // alreadyCanceled 는 NOT_CANCELABLE_AMOUNT 경로로도 나온다 → 실제로 받은 토스 코드를 확인한다(다르면 코드가 메시지에 찍힌다).
    expect(["ALREADY_CANCELED_PAYMENT", "ALREADY_REFUND_PAYMENT"], `토스 응답 코드: ${lastErrorCode}`).toContain(lastErrorCode);
  });

  it("최종 조회 → 잔액 0, interpretPayment = canceled", { timeout: T }, async () => {
    const r = await lookupOrder(ORDER_ID);

    expect(r.kind, JSON.stringify(r)).toBe("found");

    if (r.kind === "found") {
      expect(fullyCanceled(r.payment), JSON.stringify(r.payment)).toBe(true);
      expect(interpretPayment(r.payment, { orderId: ORDER_ID, amount: AMOUNT })).toBe("canceled");
    }
  });
});
