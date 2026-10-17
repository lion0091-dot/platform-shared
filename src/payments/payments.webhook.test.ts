import { describe, expect, it, vi } from "vitest";
import { verifyPaymentWebhook } from "./index";

// 가짜 값만 쓴다(실제 키 아님)
const PK = "pk_fake_1234567890";
const OID = "order-abc-123456";

const pay = (o: Partial<Record<string, unknown>> = {}) => ({ paymentKey: PK, orderId: OID, status: "DONE", totalAmount: 10000, method: "카드", approvedAt: "2026-10-16T10:00:00+09:00", ...o });
const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const mk = (...rs: Array<Response | Error>) => {
  const f = vi.fn(async (..._args: unknown[]) => {
    const r = rs.shift();

    if (!r) throw new Error("no more mock");
    if (r instanceof Error) throw r;

    return r;
  });

  return { fetch: f as unknown as typeof fetch, f };
};
const cfgOf = (m: ReturnType<typeof mk>) => ({ secretKey: "test_sk_fake_secret", fetch: m.fetch, expectedMode: "test" as const });

describe("웹훅 검증(verifyPaymentWebhook): 본문 상태는 믿지 않고 재조회", () => {
  const dep = (secret: unknown) => ({ createdAt: "2026-10-17T00:00:00", secret, status: "DONE", transactionKey: "t1", orderId: OID });
  const evt = (data: Record<string, unknown>, eventType = "PAYMENT_STATUS_CHANGED") => ({ eventType, createdAt: "2026-10-17T00:00:00", data });

  it("DEPOSIT_CALLBACK: secret 일치만 verified, 불일치·조회에 secret 없음은 거부", async () => {
    expect(await verifyPaymentWebhook(cfgOf(mk(resp(pay({ secret: "s1" })))), dep("s1"))).toMatchObject({ kind: "authenticated", eventType: "DEPOSIT_CALLBACK" });
    expect(await verifyPaymentWebhook(cfgOf(mk(resp(pay({ secret: "s1" })))), dep("zz"))).toMatchObject({ kind: "rejected", reason: "SECRET_MISMATCH" });
    expect(await verifyPaymentWebhook(cfgOf(mk(resp(pay()))), dep("s1"))).toMatchObject({ kind: "rejected", reason: "SECRET_UNAVAILABLE" });
  });

  it("PAYMENT_STATUS_CHANGED: 본문 status 는 무시하고 조회 결과를 쓴다. 조회에 secret 이 없으면 refetched(진위 미확인), 있으면 일치할 때만 authenticated", async () => {
    const noSecret = evt({ paymentKey: PK, orderId: OID, status: "DONE", secret: null });
    const r = await verifyPaymentWebhook(cfgOf(mk(resp(pay({ status: "ABORTED" })))), noSecret);

    expect(r).toMatchObject({ kind: "refetched", payment: { status: "ABORTED" } });
    expect(await verifyPaymentWebhook(cfgOf(mk(resp(pay({ secret: "s1" })))), evt({ paymentKey: PK, secret: "s1" }))).toMatchObject({ kind: "authenticated" });
    expect(await verifyPaymentWebhook(cfgOf(mk(resp(pay({ secret: "s1" })))), evt({ paymentKey: PK, secret: "bad" }))).toMatchObject({ kind: "rejected", reason: "SECRET_MISMATCH" });
    expect(await verifyPaymentWebhook(cfgOf(mk(resp(pay({ status: "CANCELED" })))), evt({ orderId: OID }, "CANCEL_STATUS_CHANGED"))).toMatchObject({ kind: "refetched", eventType: "CANCEL_STATUS_CHANGED" });
  });

  it("위조: data 만 넣고 secret 을 생략/빈 값으로 보내면 결제에 secret 이 있을 때 SECRET_MISSING 으로 거부(authenticated 가 되지 않음)", async () => {
    for (const forged of [evt({ paymentKey: PK }), evt({ paymentKey: PK, secret: null }), evt({ paymentKey: PK, secret: "" })]) {
      expect(await verifyPaymentWebhook(cfgOf(mk(resp(pay({ secret: "s1" })))), forged)).toMatchObject({ kind: "rejected", reason: "SECRET_MISSING" });
    }

    // 입금 웹훅은 secret 이 반드시 있어야 하고, 본문 secret 이 없으면 형식 이상으로 거부
    expect(await verifyPaymentWebhook(cfgOf(mk(resp(pay({ secret: "s1" })))), { orderId: OID, status: "DONE" })).toMatchObject({ kind: "rejected", reason: "BAD_PAYLOAD" });
  });

  it("존재하지 않는 결제·형식 오류·본문 이상·조회 실패", async () => {
    expect(await verifyPaymentWebhook(cfgOf(mk(resp({ code: "NOT_FOUND_PAYMENT", message: "x" }, 404))), evt({ paymentKey: PK }))).toMatchObject({ kind: "rejected", reason: "NOT_FOUND" });
    expect(await verifyPaymentWebhook(cfgOf(mk()), evt({ paymentKey: "" }))).toMatchObject({ kind: "rejected", reason: "BAD_PAYLOAD" });
    expect(await verifyPaymentWebhook(cfgOf(mk()), evt({ orderId: "bad id!" }))).toMatchObject({ kind: "rejected", reason: "BAD_PAYLOAD" });
    expect(await verifyPaymentWebhook(cfgOf(mk()), null)).toMatchObject({ kind: "rejected", reason: "BAD_PAYLOAD" });
    expect(await verifyPaymentWebhook(cfgOf(mk()), { foo: 1 })).toMatchObject({ kind: "rejected", reason: "BAD_PAYLOAD" });
    expect(await verifyPaymentWebhook(cfgOf(mk(new Error("down"))), evt({ paymentKey: PK }))).toMatchObject({ kind: "lookup_failed" });
  });

  it("설정 오류(KEY_MODE_REQUIRED·KEY_MODE_MISMATCH)는 BAD_PAYLOAD 로 삼키지 않고 던진다", async () => {
    const body = evt({ paymentKey: PK });
    const m = mk(resp(pay()));

    await expect(verifyPaymentWebhook({ secretKey: "test_sk_fake_secret", fetch: m.fetch } as never, body)).rejects.toThrow(/KEY_MODE_REQUIRED/);
    await expect(verifyPaymentWebhook({ secretKey: "test_sk_fake_secret", fetch: m.fetch, expectedMode: "live" }, body)).rejects.toThrow(/KEY_MODE_MISMATCH/);
    await expect(verifyPaymentWebhook({ secretKey: "test_sk_fake_secret", fetch: m.fetch, expectedMode: "live" }, dep("s1"))).rejects.toThrow(/KEY_MODE_MISMATCH/);
    expect(m.f).not.toHaveBeenCalled();
  });
});
