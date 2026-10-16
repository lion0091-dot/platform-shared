import { describe, expect, it, vi } from "vitest";
import {
  assertIdempotencyKey,
  basicAuthHeader,
  cancelIdempotencyKey,
  cancelPayment,
  classifyFailCode,
  classifyTossError,
  confirmIdempotencyKey,
  confirmPayment,
  createTossClient,
  generateOrderId,
  getPayment,
  getPaymentByOrderId,
  interpretPayment,
  isValidOrderId,
  type TossPayment,
} from "./index";

// 가짜 값만 쓴다(실제 키 아님)
const SECRET = "test_sk_fake_secret";
const PK = "pk_fake_1234567890";
const OID = "order-abc-123456";

const pay = (o: Partial<Record<string, unknown>> = {}) => ({ paymentKey: PK, orderId: OID, status: "DONE", totalAmount: 10000, method: "카드", approvedAt: "2026-10-16T10:00:00+09:00", ...o });
const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (status: number, code: string) => resp({ code, message: `msg ${code}` }, status);
const mk = (...rs: Array<Response | Error>) => {
  const f = vi.fn(async (..._args: unknown[]) => {
    const r = rs.shift();

    if (!r) throw new Error("no more mock");
    if (r instanceof Error) throw r;

    return r;
  });

  return { fetch: f as unknown as typeof fetch, f };
};
const cfgOf = (m: ReturnType<typeof mk>, extra = {}) => ({ secretKey: SECRET, fetch: m.fetch, ...extra });
const confirm = (m: ReturnType<typeof mk>, amount = 10000) => confirmPayment(cfgOf(m), { paymentKey: PK, orderId: OID, amount });
const callInit = (m: ReturnType<typeof mk>, i = 0) => (m.f.mock.calls[i] as unknown as [string, RequestInit])[1];

describe("인증·요청 형식", () => {
  it("Basic 인증은 base64(시크릿키:)", () => {
    expect(basicAuthHeader("abc")).toBe(`Basic ${Buffer.from("abc:").toString("base64")}`);
  });

  it("confirm 은 POST, 본문·Authorization·Idempotency-Key 를 보낸다", async () => {
    const m = mk(resp(pay()));
    await confirm(m);
    const [url, init] = m.f.mock.calls[0] as unknown as [string, RequestInit];
    const h = init.headers as Record<string, string>;

    expect(url).toBe("https://api.tosspayments.com/v1/payments/confirm");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ paymentKey: PK, orderId: OID, amount: 10000 });
    expect(h.Authorization).toBe(basicAuthHeader(SECRET));
    expect(h["Idempotency-Key"]).toBe(confirmIdempotencyKey(OID, PK));
  });

  it("조회는 GET 이고 Idempotency-Key 를 보내지 않는다", async () => {
    const m = mk(resp(pay()), resp(pay()));
    await getPaymentByOrderId(cfgOf(m), "order/한글 1");
    await getPayment(cfgOf(m), PK);

    expect(m.f.mock.calls[0]![0]).toBe(`https://api.tosspayments.com/v1/payments/orders/${encodeURIComponent("order/한글 1")}`);
    expect(m.f.mock.calls[1]![0]).toBe(`https://api.tosspayments.com/v1/payments/${PK}`);
    expect(callInit(m).method).toBe("GET");
    expect((callInit(m).headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });
});

describe("confirm 분류표", () => {
  it("success: DONE + 금액 일치", async () => {
    const r = await confirm(mk(resp(pay())));
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.payment.totalAmount).toBe(10000);
  });

  it("mismatch: 금액이 다르면 성공이 아니다", async () => {
    expect(await confirm(mk(resp(pay({ totalAmount: 9000 }))))).toMatchObject({ kind: "approved_mismatch", reason: "AMOUNT_MISMATCH" });
  });

  it("mismatch: 주문번호·paymentKey 가 다르면 성공이 아니다", async () => {
    expect(await confirm(mk(resp(pay({ orderId: "other-order-1" }))))).toMatchObject({ kind: "approved_mismatch", reason: "ORDER_MISMATCH" });
    expect(await confirm(mk(resp(pay({ paymentKey: "other_pk" }))))).toMatchObject({ kind: "approved_mismatch", reason: "ORDER_MISMATCH" });
  });

  it("uncertain: 200 이지만 status 가 DONE 이 아님", async () => {
    expect(await confirm(mk(resp(pay({ status: "IN_PROGRESS" }))))).toMatchObject({ kind: "uncertain", code: "STATUS_IN_PROGRESS" });
  });

  it("uncertain: 200 인데 응답 형식이 이상함", async () => {
    expect(await confirm(mk(resp({ foo: 1 })))).toMatchObject({ kind: "uncertain", code: "BAD_RESPONSE" });
  });

  it("already_done: ALREADY_PROCESSED_PAYMENT", async () => {
    expect(await confirm(mk(err(400, "ALREADY_PROCESSED_PAYMENT")))).toEqual({ kind: "already_done", code: "ALREADY_PROCESSED_PAYMENT" });
  });

  it("processing: 409 IDEMPOTENT_REQUEST_PROCESSING(연타)·ALREADY_PROCESSING_REQUEST", async () => {
    expect(await confirm(mk(err(409, "IDEMPOTENT_REQUEST_PROCESSING")))).toMatchObject({ kind: "processing" });
    expect(await confirm(mk(err(400, "ALREADY_PROCESSING_REQUEST")))).toMatchObject({ kind: "processing" });
  });

  it.each([
    [400, "PROVIDER_ERROR"],
    [500, "FAILED_INTERNAL_SYSTEM_PROCESSING"],
    [500, "FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING"],
    [502, "HTTP_502"],
    [429, "TOO_MANY_REQUESTS"],
  ])("uncertain: %i %s", async (s, c) => {
    expect(await confirm(mk(err(s, c)))).toMatchObject({ kind: "uncertain", code: c });
  });

  it("uncertain: 본문이 JSON 이 아닌 5xx 는 HTTP_500", async () => {
    expect(await confirm(mk(new Response("<html>bad gateway</html>", { status: 500 })))).toMatchObject({ kind: "uncertain", code: "HTTP_500" });
  });

  it("uncertain: 네트워크 오류", async () => {
    expect(await confirm(mk(new TypeError("fetch failed")))).toMatchObject({ kind: "uncertain", code: "NETWORK" });
  });

  it("uncertain: 타임아웃(응답이 안 오면 중단)", async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const r = await confirmPayment({ secretKey: SECRET, fetch: hang as unknown as typeof fetch, timeoutMs: 20 }, { paymentKey: PK, orderId: OID, amount: 10000 });

    expect(r).toMatchObject({ kind: "uncertain", code: "TIMEOUT" });
  });

  it.each(["UNAUTHORIZED_KEY", "FORBIDDEN_REQUEST", "REJECT_CARD_COMPANY", "REJECT_CARD_PAYMENT", "REJECT_ACCOUNT_PAYMENT", "INVALID_REJECT_CARD", "NOT_FOUND_PAYMENT"])("fatal(분명한 실패): %s", async (c) => {
    const s = c === "UNAUTHORIZED_KEY" ? 401 : c === "NOT_FOUND_PAYMENT" ? 404 : c === "INVALID_REJECT_CARD" ? 400 : 403;
    expect(await confirm(mk(err(s, c)))).toMatchObject({ kind: "fatal", code: c });
  });

  it("session_expired: NOT_FOUND_PAYMENT_SESSION", async () => {
    expect(await confirm(mk(err(404, "NOT_FOUND_PAYMENT_SESSION")))).toEqual({ kind: "session_expired", code: "NOT_FOUND_PAYMENT_SESSION" });
  });

  it("잘못된 입력은 호출 전에 던진다(금액·키)", async () => {
    const m = mk(resp(pay()));
    await expect(confirm(m, 0)).rejects.toThrow("INVALID_AMOUNT");
    await expect(confirm(m, 100.5)).rejects.toThrow("INVALID_AMOUNT");
    await expect(confirmPayment(cfgOf(m), { paymentKey: PK, orderId: OID, amount: 1, idempotencyKey: "x".repeat(301) })).rejects.toThrow("INVALID_IDEMPOTENCY_KEY");
    expect(m.f).not.toHaveBeenCalled();
  });

  it("호출자가 준 멱등키를 그대로 쓴다(재시도 때 같은 키)", async () => {
    const m = mk(err(500, "PROVIDER_ERROR"), resp(pay()));
    const input = { paymentKey: PK, orderId: OID, amount: 10000, idempotencyKey: "my-key-1" };
    await confirmPayment(cfgOf(m), input);
    await confirmPayment(cfgOf(m), input);

    expect((callInit(m, 0).headers as Record<string, string>)["Idempotency-Key"]).toBe("my-key-1");
    expect((callInit(m, 1).headers as Record<string, string>)["Idempotency-Key"]).toBe("my-key-1");
  });
});

describe("조회", () => {
  it("found / not_found(404) / retry_later(403 연속) / uncertain(5xx·네트워크·형식) / fatal(401)", async () => {
    const m = mk(resp(pay()), err(404, "NOT_FOUND_PAYMENT"), err(403, "FORBIDDEN_CONSECUTIVE_REQUEST"), err(500, "FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING"), new TypeError("x"), resp({}), err(401, "UNAUTHORIZED_KEY"));
    const c = cfgOf(m);
    const kinds = [];

    for (let i = 0; i < 7; i++) kinds.push((await getPaymentByOrderId(c, OID)).kind);

    expect(kinds).toEqual(["found", "not_found", "retry_later", "uncertain", "uncertain", "uncertain", "fatal"]);
  });

  it("interpretPayment: 상태·금액·주문 대조", () => {
    const p = (o: Partial<TossPayment>): TossPayment => ({ ...(pay() as TossPayment), ...o });
    const exp = { orderId: OID, amount: 10000 };

    expect(interpretPayment(p({}), exp)).toBe("paid");
    expect(interpretPayment(p({ status: "CANCELED" }), exp)).toBe("canceled");
    expect(interpretPayment(p({ status: "PARTIAL_CANCELED" }), exp)).toBe("partial_canceled");
    expect(interpretPayment(p({ status: "IN_PROGRESS" }), exp)).toBe("in_progress");
    expect(interpretPayment(p({ status: "READY" }), exp)).toBe("in_progress");
    expect(interpretPayment(p({ status: "ABORTED" }), exp)).toBe("not_paid");
    expect(interpretPayment(p({ status: "EXPIRED" }), exp)).toBe("not_paid");
    expect(interpretPayment(p({ totalAmount: 1 }), exp)).toBe("mismatch");
    expect(interpretPayment(p({ orderId: "zzzzzz" }), exp)).toBe("mismatch");
  });
});

describe("cancel 분류표", () => {
  const cancel = (m: ReturnType<typeof mk>, extra = {}) => cancelPayment(cfgOf(m), { paymentKey: PK, cancelReason: "고객 요청", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }), ...extra });

  it("canceled: 응답 status CANCELED, 본문에 cancelReason 만(전액)·부분은 cancelAmount 포함", async () => {
    const m = mk(resp(pay({ status: "CANCELED" })), resp(pay({ status: "PARTIAL_CANCELED" })));

    expect(await cancel(m)).toMatchObject({ kind: "canceled", alreadyCanceled: false });
    expect(JSON.parse(callInit(m, 0).body as string)).toEqual({ cancelReason: "고객 요청" });
    expect(await cancel(m, { cancelAmount: 3000 })).toMatchObject({ kind: "canceled" });
    expect(JSON.parse(callInit(m, 1).body as string)).toEqual({ cancelReason: "고객 요청", cancelAmount: 3000 });
    expect(m.f.mock.calls[0]![0]).toBe(`https://api.tosspayments.com/v1/payments/${PK}/cancel`);
  });

  it.each(["ALREADY_CANCELED_PAYMENT", "ALREADY_REFUND_PAYMENT"])("%s: 조회로 CANCELED 확인되면 성공 취급", async (c) => {
    const m = mk(err(400, c), resp(pay({ status: "CANCELED" })));

    expect(await cancel(m)).toMatchObject({ kind: "canceled", alreadyCanceled: true });
    expect(m.f.mock.calls[1]![0]).toBe(`https://api.tosspayments.com/v1/payments/${PK}`);
  });

  it("ALREADY_CANCELED 인데 조회가 CANCELED 가 아니거나 실패하면 uncertain", async () => {
    expect(await cancel(mk(err(400, "ALREADY_CANCELED_PAYMENT"), resp(pay({ status: "DONE" }))))).toMatchObject({ kind: "uncertain" });
    expect(await cancel(mk(err(400, "ALREADY_CANCELED_PAYMENT"), err(500, "FAILED_INTERNAL_SYSTEM_PROCESSING")))).toMatchObject({ kind: "uncertain" });
  });

  it("processing: ALREADY_REFUNDING_PAYMENT·409", async () => {
    expect(await cancel(mk(err(400, "ALREADY_REFUNDING_PAYMENT")))).toMatchObject({ kind: "processing" });
    expect(await cancel(mk(err(409, "IDEMPOTENT_REQUEST_PROCESSING")))).toMatchObject({ kind: "processing" });
  });

  it("retry_later: FORBIDDEN_CONSECUTIVE_REQUEST(연타)", async () => {
    expect(await cancel(mk(err(403, "FORBIDDEN_CONSECUTIVE_REQUEST")))).toEqual({ kind: "retry_later", code: "FORBIDDEN_CONSECUTIVE_REQUEST" });
  });

  it.each(["NOT_CANCELABLE_PAYMENT", "NOT_CANCELABLE_AMOUNT", "NOT_CANCELABLE_PAYMENT_FOR_DORMANT_USER", "EXCEED_MAX_REFUND_DUE"])("not_cancelable: %s", async (c) => {
    expect(await cancel(mk(err(403, c)))).toMatchObject({ kind: "not_cancelable", code: c });
  });

  it("uncertain: PROVIDER_ERROR·5xx·네트워크·응답 상태 이상", async () => {
    expect(await cancel(mk(err(400, "PROVIDER_ERROR")))).toMatchObject({ kind: "uncertain" });
    expect(await cancel(mk(err(500, "FAILED_INTERNAL_SYSTEM_PROCESSING")))).toMatchObject({ kind: "uncertain" });
    expect(await cancel(mk(new TypeError("x")))).toMatchObject({ kind: "uncertain", code: "NETWORK" });
    expect(await cancel(mk(resp(pay({ status: "DONE" }))))).toMatchObject({ kind: "uncertain", code: "BAD_RESPONSE" });
  });

  it("fatal: UNAUTHORIZED_KEY·FORBIDDEN_REQUEST", async () => {
    expect(await cancel(mk(err(401, "UNAUTHORIZED_KEY")))).toMatchObject({ kind: "fatal" });
    expect(await cancel(mk(err(403, "FORBIDDEN_REQUEST")))).toMatchObject({ kind: "fatal" });
  });

  it("멱등키 필수·금액 검증, 헤더로 전달", async () => {
    const m = mk(resp(pay({ status: "CANCELED" })));
    await expect(cancel(m, { idempotencyKey: "" })).rejects.toThrow("INVALID_IDEMPOTENCY_KEY");
    await expect(cancel(m, { cancelAmount: -1 })).rejects.toThrow("INVALID_AMOUNT");
    await cancel(m);

    expect((callInit(m).headers as Record<string, string>)["Idempotency-Key"]).toBe(`cancel_${PK}_0_full`);
  });
});

describe("추가 분류(보강)", () => {
  it("모르는 4xx 코드·CARD_PROCESSING_ERROR 는 분명한 실패가 아니라 불확실", async () => {
    expect(await confirm(mk(err(400, "SOMETHING_NEW")))).toMatchObject({ kind: "uncertain" });
    expect(await confirm(mk(err(400, "CARD_PROCESSING_ERROR")))).toMatchObject({ kind: "uncertain" });
  });

  it("createTossClient 는 lookupByOrderId 를 포함한다", async () => {
    const m = mk(resp(pay()));

    expect((await createTossClient(cfgOf(m)).lookupByOrderId(OID)).kind).toBe("found");
  });
});

describe("분류 함수", () => {
  it("classifyTossError 대표 행", () => {
    expect(classifyTossError("confirm", 400, "ALREADY_PROCESSED_PAYMENT")).toBe("already_done");
    expect(classifyTossError("confirm", 409, "IDEMPOTENT_REQUEST_PROCESSING")).toBe("processing");
    expect(classifyTossError("confirm", 500, "ANYTHING")).toBe("uncertain");
    expect(classifyTossError("lookup", 404, "NOT_FOUND_PAYMENT")).toBe("not_found");
    expect(classifyTossError("confirm", 404, "NOT_FOUND_PAYMENT")).toBe("fatal");
    expect(classifyTossError("cancel", 403, "FORBIDDEN_CONSECUTIVE_REQUEST")).toBe("retry_later");
  });

  it("classifyFailCode", () => {
    expect(classifyFailCode("PAY_PROCESS_CANCELED")).toBe("user_canceled");
    expect(classifyFailCode("PAY_PROCESS_ABORTED")).toBe("aborted");
    expect(classifyFailCode("REJECT_CARD_COMPANY")).toBe("card_rejected");
    expect(classifyFailCode("INVALID_CARD_NUMBER")).toBe("other");
    expect(classifyFailCode(undefined)).toBe("other");
  });
});

describe("주문번호·멱등키", () => {
  it("orderId 형식: 영문·숫자·-·_ 6~64자", () => {
    expect(isValidOrderId("abc123")).toBe(true);
    expect(isValidOrderId("a-b_C9")).toBe(true);
    expect(isValidOrderId("a".repeat(64))).toBe(true);
    expect(isValidOrderId("abcde")).toBe(false);
    expect(isValidOrderId("a".repeat(65))).toBe(false);
    expect(isValidOrderId("abc 123")).toBe(false);
    expect(isValidOrderId("주문번호123456")).toBe(false);
    expect(isValidOrderId("abc=123")).toBe(false);
    expect(isValidOrderId(123456)).toBe(false);
  });

  it("generateOrderId: 유효하고 매번 다르다, 잘못된 prefix 는 던진다", () => {
    const a = generateOrderId("ord_");

    expect(isValidOrderId(a)).toBe(true);
    expect(a).not.toBe(generateOrderId("ord_"));
    expect(() => generateOrderId("한글")).toThrow("INVALID_ORDER_ID");
    expect(() => generateOrderId("x".repeat(40))).toThrow("INVALID_ORDER_ID");
  });

  it("멱등키: 같은 입력 → 같은 키, 결제 시도·취소 금액이 다르면 다른 키, 300자 초과 거부", () => {
    expect(confirmIdempotencyKey(OID, PK)).toBe(confirmIdempotencyKey(OID, PK));
    expect(confirmIdempotencyKey(OID, PK)).not.toBe(confirmIdempotencyKey(OID, "pk_other"));
    expect(cancelIdempotencyKey({ paymentKey: PK, cancelAmount: 100, alreadyCanceledTotal: 0 })).not.toBe(cancelIdempotencyKey({ paymentKey: PK, cancelAmount: 100, alreadyCanceledTotal: 100 }));
    expect(() => assertIdempotencyKey("a".repeat(300))).not.toThrow();
    expect(() => assertIdempotencyKey("a".repeat(301))).toThrow();
    expect(() => assertIdempotencyKey("한글")).toThrow();
    expect(() => confirmIdempotencyKey(OID, "p".repeat(300))).toThrow();
  });
});
