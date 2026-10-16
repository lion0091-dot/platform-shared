/**
 * 토스페이먼츠 **테스트 환경** 실호출 통합 시험. 계약 전에도 개발자센터 테스트 키로 돌릴 수 있다.
 * 환경변수가 없으면 전부 건너뛴다(평소 `npm test` 는 외부 호출 없음). 키는 저장소에 쓰지 않는다.
 *
 *   TOSS_TEST_SECRET_KEY   test_sk_… (API 개별 연동) 또는 test_gsk_… (결제위젯). live_ 키는 거부한다.
 *   ── 아래 셋은 결제창에서 테스트 결제를 마친 직후 successUrl 쿼리값(scripts/toss-test-checkout.html) ──
 *   TOSS_TEST_PAYMENT_KEY  paymentKey
 *   TOSS_TEST_ORDER_ID     orderId
 *   TOSS_TEST_AMOUNT       amount(원, 3000 이상 — 부분 취소 2회 + 전액 취소를 위해)
 *
 * 실행: npm run test:toss  (절차는 docs/payments-api-draft.md §8)
 * 승인은 결제창 인증 후 제한 시간(문서 10분, §7 미확인) 안에 해야 하고, paymentKey 하나는 한 번만 쓸 수 있다(승인→취소까지 진행됨).
 */
import { describe, expect, it } from "vitest";
import { cancelIdempotencyKey, confirmIdempotencyKey, createTossClient, generateOrderId, interpretPayment, type TossPayment } from "./index";

const SECRET = process.env.TOSS_TEST_SECRET_KEY ?? "";
const PAYMENT_KEY = process.env.TOSS_TEST_PAYMENT_KEY ?? "";
const ORDER_ID = process.env.TOSS_TEST_ORDER_ID ?? "";
const AMOUNT = Number(process.env.TOSS_TEST_AMOUNT ?? "");

// 실수로 운영 키를 넣으면 실제 승인·환불이 일어난다 → 시험 파일 자체를 실패시킨다(fail-closed).
if (SECRET && !/^test_g?sk_/.test(SECRET)) throw new Error("TOSS_TEST_SECRET_KEY 는 test_sk_/test_gsk_ 로 시작하는 테스트 시크릿키여야 한다(live 키 금지).");

const HAS_KEY = SECRET !== "";
const HAS_PAYMENT = HAS_KEY && PAYMENT_KEY !== "" && ORDER_ID !== "" && Number.isSafeInteger(AMOUNT);
const T = 30_000;

const toss = createTossClient({ secretKey: SECRET });
const canceledSum = (p: TossPayment) => p.cancels.reduce((s, c) => s + c.cancelAmount, 0);

describe.skipIf(!HAS_KEY)("토스 테스트 환경 — 키만으로(결제창 없이)", () => {
  it("없는 주문번호 조회 → not_found (Basic 인증 통과 + 404 분류)", { timeout: T }, async () => {
    const r = await toss.lookupByOrderId(generateOrderId("it-none-"));

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "not_found" });
  });

  it("없는 paymentKey 조회 → not_found", { timeout: T }, async () => {
    const r = await toss.lookup(`it_fake_${Date.now()}`);

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "not_found" });
  });

  it("틀린 시크릿키 → fatal (UNAUTHORIZED_KEY 등)", { timeout: T }, async () => {
    const bad = createTossClient({ secretKey: "test_sk_integration_invalid_key" });
    const r = await bad.lookupByOrderId(generateOrderId("it-bad-"));

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "fatal" });
  });

  it("가짜 paymentKey 승인 → session_expired 또는 fatal (결제 안 됨이 분명한 쪽으로 분류)", { timeout: T }, async () => {
    const r = await toss.confirm({ paymentKey: `it_fake_${Date.now()}`, orderId: generateOrderId("it-cf-"), amount: 1000 });

    expect(["session_expired", "fatal"], JSON.stringify(r)).toContain(r.kind);
  });

  it("가짜 paymentKey 취소 → fatal 또는 not_cancelable (canceled 로 오인하지 않음)", { timeout: T }, async () => {
    const paymentKey = `it_fake_${Date.now()}`;
    const r = await toss.cancel({ paymentKey, cancelReason: "통합 시험", idempotencyKey: cancelIdempotencyKey({ paymentKey }) });

    expect(["fatal", "not_cancelable"], JSON.stringify(r)).toContain(r.kind);
  });
});

// 순서대로 실행된다(파일 안 it 은 직렬). 앞 단계가 실패하면 뒤 단계도 의미가 없다.
describe.skipIf(!HAS_PAYMENT)("토스 테스트 환경 — 결제창 결제 1건으로 승인→조회→부분취소→전액취소", () => {
  const P1 = 1000;
  const P2 = 1000;

  it("TOSS_TEST_AMOUNT 는 3000 이상", () => {
    expect(AMOUNT).toBeGreaterThanOrEqual(P1 + P2 + 1000);
  });

  it("승인 → success, 금액·주문 일치", { timeout: T }, async () => {
    const r = await toss.confirm({ paymentKey: PAYMENT_KEY, orderId: ORDER_ID, amount: AMOUNT });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "success", payment: { status: "DONE", totalAmount: AMOUNT, orderId: ORDER_ID } });
  });

  it("같은 멱등키로 다시 승인 → 첫 응답 재생(success), 이중 승인 없음", { timeout: T }, async () => {
    const r = await toss.confirm({ paymentKey: PAYMENT_KEY, orderId: ORDER_ID, amount: AMOUNT });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "success" });
  });

  it("다른 멱등키로 다시 승인 → already_done (ALREADY_PROCESSED_PAYMENT)", { timeout: T }, async () => {
    const r = await toss.confirm({ paymentKey: PAYMENT_KEY, orderId: ORDER_ID, amount: AMOUNT, idempotencyKey: `${confirmIdempotencyKey(ORDER_ID, PAYMENT_KEY)}_2` });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "already_done" });
  });

  it("주문번호 조회 → found, interpretPayment = paid", { timeout: T }, async () => {
    const r = await toss.lookupByOrderId(ORDER_ID);

    expect(r.kind, JSON.stringify(r)).toBe("found");
    if (r.kind === "found") expect(interpretPayment(r.payment, { orderId: ORDER_ID, amount: AMOUNT })).toBe("paid");
  });

  it("부분 취소 1회차(누계 0) → canceled, PARTIAL_CANCELED", { timeout: T }, async () => {
    const input = { paymentKey: PAYMENT_KEY, cancelAmount: P1, alreadyCanceledTotal: 0 };
    const r = await toss.cancel({ ...input, cancelReason: "통합 시험 부분취소 1", idempotencyKey: cancelIdempotencyKey(input) });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "canceled", payment: { status: "PARTIAL_CANCELED" } });
  });

  it("같은 키로 1회차 재시도 → 재생(canceled), 실제 환불은 1회뿐(조회 누계 = P1)", { timeout: T }, async () => {
    const input = { paymentKey: PAYMENT_KEY, cancelAmount: P1, alreadyCanceledTotal: 0 };
    const r = await toss.cancel({ ...input, cancelReason: "통합 시험 부분취소 1", idempotencyKey: cancelIdempotencyKey(input) });

    expect(r.kind, JSON.stringify(r)).toBe("canceled");

    const l = await toss.lookup(PAYMENT_KEY);

    expect(l.kind, JSON.stringify(l)).toBe("found");
    if (l.kind === "found") {
      expect(canceledSum(l.payment)).toBe(P1);
      if (l.payment.balanceAmount !== null) expect(l.payment.balanceAmount).toBe(AMOUNT - P1);
    }
  });

  it("부분 취소 2회차(누계 P1, 같은 금액) → 새 키라 실제 환불, 누계 P1+P2", { timeout: T }, async () => {
    const input = { paymentKey: PAYMENT_KEY, cancelAmount: P2, alreadyCanceledTotal: P1 };
    const r = await toss.cancel({ ...input, cancelReason: "통합 시험 부분취소 2", idempotencyKey: cancelIdempotencyKey(input) });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "canceled", payment: { status: "PARTIAL_CANCELED" } });
    if (r.kind === "canceled") expect(canceledSum(r.payment)).toBe(P1 + P2);
  });

  it("나머지 전액 취소 → canceled, CANCELED", { timeout: T }, async () => {
    const r = await toss.cancel({ paymentKey: PAYMENT_KEY, cancelReason: "통합 시험 전액취소", idempotencyKey: cancelIdempotencyKey({ paymentKey: PAYMENT_KEY }) });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "canceled", payment: { status: "CANCELED" } });
  });

  it("다른 키로 전액 취소 한 번 더 → ALREADY_CANCELED 를 조회로 확인해 canceled(alreadyCanceled)", { timeout: T }, async () => {
    const r = await toss.cancel({ paymentKey: PAYMENT_KEY, cancelReason: "통합 시험 중복취소", idempotencyKey: `${cancelIdempotencyKey({ paymentKey: PAYMENT_KEY })}_2` });

    expect(r, JSON.stringify(r)).toMatchObject({ kind: "canceled", alreadyCanceled: true });
  });

  it("최종 조회 → CANCELED, interpretPayment = canceled", { timeout: T }, async () => {
    const r = await toss.lookupByOrderId(ORDER_ID);

    expect(r.kind, JSON.stringify(r)).toBe("found");
    if (r.kind === "found") expect(interpretPayment(r.payment, { orderId: ORDER_ID, amount: AMOUNT })).toBe("canceled");
  });
});
