import { describe, expect, it, vi } from "vitest";
import { cancelIdempotencyKey, cancelPayment, classifyTossError, confirmPayment, getPayment, getPaymentByOrderId } from "./index";

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

describe("401/403 가 HTML 로 올 때 (결정: 401=fatal, 403=uncertain)", () => {
  it("401 HTML → fatal(HTTP_401): 키 오류 알림을 늦추지 않는다", async () => {
    expect(await confirm(mk(html(401)))).toMatchObject({ kind: "fatal", code: "HTTP_401" });
    expect(await getPayment(cfgOf(mk(html(401))), PK)).toMatchObject({ kind: "fatal", code: "HTTP_401" });
    expect(await cancelPayment(cfgOf(mk(html(401))), { paymentKey: PK, cancelReason: "x", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) })).toMatchObject({ kind: "fatal", code: "HTTP_401" });
  });

  it("403 HTML → uncertain(HTTP_403): 차단 원인을 알 수 없어 실패로 굳히지 않는다(앱은 HTTP_ 코드로 알림)", async () => {
    expect(await confirm(mk(html(403)))).toMatchObject({ kind: "uncertain", code: "HTTP_403" });
  });

  it("JSON 본문이 있는 401 UNAUTHORIZED_KEY 는 기존대로 fatal", async () => {
    expect(await confirm(mk(resp({ code: "UNAUTHORIZED_KEY", message: "m" }, 401)))).toMatchObject({ kind: "fatal", code: "UNAUTHORIZED_KEY" });
  });
});
