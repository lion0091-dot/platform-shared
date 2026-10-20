import { describe, expect, it, vi } from "vitest";
import { canceledTotal, cancelIdempotencyKey, cancelPayment, classifyTossError, confirmPayment, getPayment, getPaymentByOrderId, interpretPayment } from "./index";

// 가짜 값만 쓴다(실제 키 아님)
const PK = "pk_fake_1234567890";
const OID = "order-abc-123456";

const pay = (o: Partial<Record<string, unknown>> = {}) => ({ paymentKey: PK, orderId: OID, status: "DONE", totalAmount: 10000, method: "카드", approvedAt: "2026-10-16T10:00:00+09:00", ...o });
const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (status: number) => new Response("<html><body>blocked</body></html>", { status, headers: { "Content-Type": "text/html" } });
const mk = (...rs: Array<Response | Error | object>) => {
  const f = vi.fn(async (..._args: unknown[]) => {
    const r = rs.shift();

    if (!r) throw new Error("no more mock");
    if (r instanceof Error) throw r;

    return r;
  });

  return { fetch: f as unknown as typeof fetch, f };
};
const cfgOf = (m: ReturnType<typeof mk>, extra = {}) => ({ secretKey: "test_sk_fake_secret", fetch: m.fetch, expectedMode: "test" as const, ...extra });
const confirm = (m: ReturnType<typeof mk>) => confirmPayment(cfgOf(m), { paymentKey: PK, orderId: OID, amount: 10000 });
const abortErr = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
/** 상태·헤더는 왔지만 본문을 읽다가 중단되는 응답 */
const brokenBody = (status: number) => ({ ok: status >= 200 && status < 300, status, text: async () => { throw abortErr(); } });

describe("응답 본문 읽기 중 중단", () => {
  it("200 인데 본문을 읽다 끊기면 uncertain(BAD_RESPONSE) — 승인됐을 수 있으니 실패로 굳히지 않는다", async () => {
    expect(await confirm(mk(brokenBody(200)))).toMatchObject({ kind: "uncertain", code: "BAD_RESPONSE" });
    expect(await getPayment(cfgOf(mk(brokenBody(200))), PK)).toMatchObject({ kind: "uncertain", code: "BAD_RESPONSE" });
    expect(await cancelPayment(cfgOf(mk(brokenBody(200))), { paymentKey: PK, cancelReason: "x", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) })).toMatchObject({ kind: "uncertain", code: "BAD_RESPONSE" });
  });

  it("오류 상태 + 본문 끊김은 HTTP_상태 코드로 분류(500 uncertain, 404 조회는 not_found 가 아님)", async () => {
    expect(await confirm(mk(brokenBody(500)))).toMatchObject({ kind: "uncertain", code: "HTTP_500" });
    expect(await getPaymentByOrderId(cfgOf(mk(brokenBody(404))), OID)).toMatchObject({ kind: "uncertain", code: "HTTP_404" });
  });

  it("fetch 자체가 AbortError 로 끊기면 TIMEOUT", async () => {
    expect(await confirm(mk(abortErr()))).toMatchObject({ kind: "uncertain", code: "TIMEOUT" });
  });
});

describe("잘못된/모순된 code + 상태 조합", () => {
  it("5xx 가 확정 거절 코드를 달고 와도 uncertain(5xx 우선)", async () => {
    expect(await confirm(mk(resp({ code: "REJECT_CARD_COMPANY", message: "m" }, 500)))).toMatchObject({ kind: "uncertain", code: "REJECT_CARD_COMPANY" });
    expect(classifyTossError("confirm", 502, "INVALID_CARD_NUMBER")).toBe("uncertain");
  });

  it("code 가 문자열이 아니거나 없으면 HTTP_상태 로 취급", async () => {
    expect(await confirm(mk(resp({ code: 123, message: "m" }, 400)))).toMatchObject({ kind: "uncertain", code: "HTTP_400" });
    expect(await confirm(mk(resp({ message: "m" }, 400)))).toMatchObject({ kind: "uncertain", code: "HTTP_400" });
    expect(await confirm(mk(resp(null, 400)))).toMatchObject({ kind: "uncertain", code: "HTTP_400" });
  });

  it("2xx 인데 오류 객체(code 포함) 본문이면 승인으로 보지 않는다", async () => {
    expect(await confirm(mk(resp({ code: "ALREADY_PROCESSED_PAYMENT", message: "m" }, 200)))).toMatchObject({ kind: "uncertain", code: "BAD_RESPONSE" });
  });

  it("다른 연산의 코드는 섞이지 않는다(confirm 에 취소 코드, 취소에 승인 코드)", () => {
    expect(classifyTossError("confirm", 400, "ALREADY_CANCELED_PAYMENT")).toBe("uncertain");
    expect(classifyTossError("cancel", 400, "ALREADY_PROCESSED_PAYMENT")).toBe("uncertain");
    expect(classifyTossError("cancel", 404, "NOT_FOUND_PAYMENT_SESSION")).toBe("uncertain");
  });
});

describe("401/403 가 HTML 로 올 때 (결정: 승인 401=uncertain, 조회·취소 401=fatal, 403=uncertain)", () => {
  it("승인 경로의 본문 없는 401(앞단 일시 인증 장애) → uncertain(HTTP_401): 승인된 결제를 FAILED 로 굳히지 않는다", async () => {
    expect(await confirm(mk(html(401)))).toMatchObject({ kind: "uncertain", code: "HTTP_401" });
  });

  it("일시 401 시나리오: 승인 401 → 조회로 DONE 확인(paid)", async () => {
    const m = mk(html(401), resp(pay()));
    const c = await confirm(m);

    expect(c.kind).toBe("uncertain");

    const l = await getPaymentByOrderId(cfgOf(m), OID);

    expect(l.kind).toBe("found");
  });

  it("조회·취소 경로의 본문 없는 401 → fatal(HTTP_401): 키 오류 알림을 늦추지 않는다", async () => {
    expect(await getPayment(cfgOf(mk(html(401))), PK)).toMatchObject({ kind: "fatal", code: "HTTP_401" });
    expect(await cancelPayment(cfgOf(mk(html(401))), { paymentKey: PK, cancelReason: "x", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) })).toMatchObject({ kind: "fatal", code: "HTTP_401" });
  });

  it("403 HTML → uncertain(HTTP_403): 차단 원인을 알 수 없어 실패로 굳히지 않는다(앱은 HTTP_ 코드로 알림)", async () => {
    expect(await confirm(mk(html(403)))).toMatchObject({ kind: "uncertain", code: "HTTP_403" });
  });

  it("JSON 본문이 있는 401 UNAUTHORIZED_KEY 는 승인에서도 fatal", async () => {
    expect(await confirm(mk(resp({ code: "UNAUTHORIZED_KEY", message: "m" }, 401)))).toMatchObject({ kind: "fatal", code: "UNAUTHORIZED_KEY" });
  });
});

describe("취소 항목의 cancelStatus(DONE 만 합계에 포함)", () => {
  const entry = (cancelAmount: number, cancelStatus: string | undefined) => ({ cancelAmount, cancelReason: "x", ...(cancelStatus ? { cancelStatus } : {}) });
  const input = { paymentKey: PK, cancelReason: "x", cancelAmount: 3000, alreadyCanceledTotal: 0, idempotencyKey: cancelIdempotencyKey({ paymentKey: PK, cancelAmount: 3000, alreadyCanceledTotal: 0 }) };

  it("취소 응답의 항목이 DONE 이 아니면(진행 중) 적용된 것으로 세지 않고 uncertain", async () => {
    const pending = pay({ status: "PARTIAL_CANCELED", balanceAmount: null, cancels: [entry(3000, "IN_PROGRESS")] });

    expect(await cancelPayment(cfgOf(mk(resp(pending), resp(pending))), input)).toMatchObject({ kind: "uncertain" });
  });

  it("DONE·값 없음은 포함, 진행 중·실패는 제외(canceledTotal·완전 취소 판정)", () => {
    const base = { status: "PARTIAL_CANCELED", totalAmount: 10000, balanceAmount: null };
    const c = (a: number, st: string | null) => ({ cancelAmount: a, cancelReason: "", canceledAt: null, transactionKey: null, cancelStatus: st });

    expect(canceledTotal({ ...base, cancels: [c(1000, "DONE"), c(2000, null), c(4000, "IN_PROGRESS"), c(3000, "FAILED")] })).toBe(3000);

    const pending = { paymentKey: PK, orderId: OID, method: "", approvedAt: null, ...base, cancels: [c(5000, "DONE"), c(5000, "IN_PROGRESS")] };

    expect(interpretPayment(pending, { orderId: OID, amount: 10000 })).toBe("partial_canceled");
    expect(interpretPayment({ ...pending, cancels: [c(5000, "DONE"), c(5000, "DONE")] }, { orderId: OID, amount: 10000 })).toBe("canceled");
  });
});

describe("면세 금액 대조(expectedTaxFreeAmount)", () => {
  const run = (m: ReturnType<typeof mk>, tax?: number) => confirmPayment(cfgOf(m), { paymentKey: PK, orderId: OID, amount: 10000, ...(tax === undefined ? {} : { expectedTaxFreeAmount: tax }) });

  it("일치하면 success, 다르면 approved_mismatch(TAX_FREE_MISMATCH), 응답에 값이 없으면 uncertain(TAX_FREE_UNVERIFIED), 지정 안 하면 대조 안 함", async () => {
    expect(await run(mk(resp(pay({ taxFreeAmount: 10000 }))), 10000)).toMatchObject({ kind: "success" });
    expect(await run(mk(resp(pay({ taxFreeAmount: 0 }))), 10000)).toMatchObject({ kind: "approved_mismatch", reason: "TAX_FREE_MISMATCH" });
    expect(await run(mk(resp(pay())), 10000)).toMatchObject({ kind: "uncertain", code: "TAX_FREE_UNVERIFIED" });
    expect(await run(mk(resp(pay({ taxFreeAmount: 5 })))).then((r) => r.kind)).toBe("success");
  });

  it("범위를 벗어난 기대 면세 금액은 호출 전에 던진다", async () => {
    const m = mk(resp(pay()));

    for (const bad of [-1, 1.5, 10001, Number.NaN]) await expect(run(m, bad)).rejects.toThrow(/INVALID_TAX_FREE/);

    expect(m.f).not.toHaveBeenCalled();
  });

  it("interpretPayment: expected.taxFreeAmount 를 넘기면 토스 기록과 다를 때 mismatch", () => {
    const p = { paymentKey: PK, orderId: OID, status: "DONE", totalAmount: 10000, method: "", approvedAt: null, balanceAmount: null, cancels: [], taxFreeAmount: 10000 };

    expect(interpretPayment(p, { orderId: OID, amount: 10000, taxFreeAmount: 10000 })).toBe("paid");
    expect(interpretPayment(p, { orderId: OID, amount: 10000, taxFreeAmount: 0 })).toBe("mismatch");
    expect(interpretPayment(p, { orderId: OID, amount: 10000 })).toBe("paid");
    expect(interpretPayment({ ...p, taxFreeAmount: undefined }, { orderId: OID, amount: 10000, taxFreeAmount: 0 })).toBe("paid");
  });
});
