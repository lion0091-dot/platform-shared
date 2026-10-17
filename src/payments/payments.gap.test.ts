import { describe, expect, it, vi } from "vitest";
import {
  assertKeyMode,
  cancelApprovedMismatch,
  cancelIdempotencyKey,
  cancelPayment,
  classifyTossError,
  confirmPayment,
  createTossClient,
  getPayment,
  interpretPayment,
  isWebhookSecretValid,
  tossKeyMode,
} from "./index";

// 가짜 값만 쓴다(실제 키 아님)
const SECRET = "test_sk_fake_secret";
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
const cfgOf = (m: ReturnType<typeof mk>, extra = {}) => ({ secretKey: SECRET, fetch: m.fetch, expectedMode: "test" as const, ...extra });
const sentBody = (m: ReturnType<typeof mk>) => JSON.parse(((m.f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) ?? "{}");

describe("키 종류(test/live) 검사", () => {
  it("접두사로 종류를 읽고 모르면 null", () => {
    expect(tossKeyMode("test_sk_x")).toBe("test");
    expect(tossKeyMode("live_sk_x")).toBe("live");
    expect(tossKeyMode("test_gsk_x")).toBe("test");
    expect(tossKeyMode("live_gsk_x")).toBe("live");
    expect(tossKeyMode("sk_x")).toBeNull();
    expect(tossKeyMode("  test_sk_x\n")).toBe("test"); // 앞뒤 공백·개행은 지우고 판정
    expect(tossKeyMode("TEST_SK_x")).toBeNull(); // 대소문자 구분
    expect(tossKeyMode("")).toBeNull();
  });

  it("expectedMode 가 다르면 네트워크 호출 전에 던지고 메시지에 키가 없다", async () => {
    const m = mk(resp(pay()));
    const run = () => confirmPayment({ secretKey: "test_sk_secretvalue", fetch: m.fetch, expectedMode: "live" }, { paymentKey: PK, orderId: OID, amount: 10000 });

    await expect(run()).rejects.toThrow(/KEY_MODE_MISMATCH/);
    await expect(run()).rejects.not.toThrow(/secretvalue/);
    expect(m.f).not.toHaveBeenCalled();
    expect(() => assertKeyMode("weird", "test")).toThrow(/KEY_MODE_MISMATCH/);
  });

  it("expectedMode 가 맞으면 정상 호출, 생략하면 KEY_MODE_REQUIRED, unchecked 는 접두사 없는 모의 키 허용", async () => {
    const ok = mk(resp(pay()), resp(pay()));

    expect(await getPayment(cfgOf(ok, { expectedMode: "test" }), PK)).toMatchObject({ kind: "found" });
    await expect(getPayment({ secretKey: SECRET, fetch: ok.fetch } as never, PK)).rejects.toThrow(/KEY_MODE_REQUIRED/);
    expect(await getPayment({ secretKey: "fake", fetch: ok.fetch, expectedMode: "unchecked" }, PK)).toMatchObject({ kind: "found" });
    expect(ok.f).toHaveBeenCalledTimes(2);
  });
});

describe("입력 검증 보강", () => {
  it("빈 paymentKey·빈 취소 사유·잘못된 timeoutMs", async () => {
    const m = mk(resp(pay()));

    await expect(getPayment(cfgOf(m), "")).rejects.toThrow(/INVALID_PAYMENT_KEY/);
    await expect(confirmPayment(cfgOf(m), { paymentKey: "", orderId: OID, amount: 1000 })).rejects.toThrow(/INVALID_PAYMENT_KEY/);
    await expect(cancelPayment(cfgOf(m), { paymentKey: PK, cancelReason: "  ", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) })).rejects.toThrow(/INVALID_CANCEL_REASON/);
    expect(m.f).not.toHaveBeenCalled();

    // timeoutMs 0 이어도 즉시 중단되지 않고 기본값을 쓴다
    expect(await getPayment(cfgOf(m, { timeoutMs: 0 }), PK)).toMatchObject({ kind: "found" });
  });
});

describe("확정 거절 코드 추가", () => {
  it.each(["EXCEED_MAX_PAYMENT_AMOUNT", "EXCEED_MAX_DAILY_PAYMENT_COUNT", "EXCEED_MAX_AUTH_COUNT", "NOT_ALLOWED_POINT_USE", "BELOW_MINIMUM_AMOUNT", "INVALID_PASSWORD"])("confirm %s → fatal", (code) => {
    expect(classifyTossError("confirm", 400, code)).toBe("fatal");
  });

  it("FDS_ERROR 는 본인 인증 뒤 결제가 이어질 수 있어 uncertain(조회로 확정)", () => {
    expect(classifyTossError("confirm", 403, "FDS_ERROR")).toBe("uncertain");
  });

  it("모르는 코드·UNAPPROVED_ORDER_ID·CARD_PROCESSING_ERROR 는 여전히 uncertain", () => {
    expect(classifyTossError("confirm", 400, "SOMETHING_NEW")).toBe("uncertain");
    expect(classifyTossError("confirm", 400, "UNAPPROVED_ORDER_ID")).toBe("uncertain");
    expect(classifyTossError("confirm", 400, "CARD_PROCESSING_ERROR")).toBe("uncertain");
    expect(classifyTossError("confirm", 500, "UNKNOWN_PAYMENT_ERROR")).toBe("uncertain");
  });

  it("취소 사람 처리 코드는 not_cancelable, 은행 시간 아님은 retry_later, 5xx 취소 오류는 uncertain", () => {
    for (const c of ["EXCEED_CANCEL_LIMIT", "REFUND_REJECTED", "NOT_ALLOWED_PARTIAL_REFUND", "NOT_ALLOWED_PARTIAL_REFUND_WAITING_DEPOSIT", "FORBIDDEN_BANK_REFUND_REQUEST", "INVALID_REFUND_ACCOUNT_INFO"]) {
      expect(classifyTossError("cancel", 400, c)).toBe("not_cancelable");
    }

    expect(classifyTossError("cancel", 403, "NOT_AVAILABLE_BANK")).toBe("retry_later");
    expect(classifyTossError("confirm", 403, "NOT_AVAILABLE_BANK")).toBe("fatal");
    expect(classifyTossError("cancel", 500, "FAILED_REFUND_PROCESS")).toBe("uncertain");
  });
});

describe("가상계좌·통화·면세 필드", () => {
  const va = { accountNumber: "1234567890", bankCode: "20", customerName: "홍길동", dueDate: "2026-10-20T23:59:59", refundStatus: "NONE", expired: false };

  it("승인 응답이 WAITING_FOR_DEPOSIT(주문·금액 일치)면 waiting_for_deposit + 계좌 정보", async () => {
    const m = mk(resp(pay({ status: "WAITING_FOR_DEPOSIT", virtualAccount: va, secret: "sec_1" })));
    const r = await confirmPayment(cfgOf(m), { paymentKey: PK, orderId: OID, amount: 10000 });

    expect(r).toMatchObject({ kind: "waiting_for_deposit", payment: { virtualAccount: { accountNumber: "1234567890", bankCode: "20" } } });
    if (r.kind === "waiting_for_deposit") expect(r.payment.secret).toBe("sec_1");
  });

  it("WAITING_FOR_DEPOSIT 인데 금액이 다르면 입금 대기로 보지 않고 uncertain", async () => {
    const m = mk(resp(pay({ status: "WAITING_FOR_DEPOSIT", totalAmount: 9000 })));

    expect(await confirmPayment(cfgOf(m), { paymentKey: PK, orderId: OID, amount: 10000 })).toMatchObject({ kind: "uncertain", code: "STATUS_WAITING_FOR_DEPOSIT" });
  });

  it("조회 해석: WAITING_FOR_DEPOSIT→waiting_for_deposit, KRW 외 통화→mismatch, 통화 없음/KRW 는 통과", () => {
    const p = (o = {}) => ({ paymentKey: PK, orderId: OID, status: "DONE", totalAmount: 10000, method: "", approvedAt: null, balanceAmount: null, cancels: [], ...o });
    const exp = { orderId: OID, amount: 10000 };

    expect(interpretPayment(p({ status: "WAITING_FOR_DEPOSIT" }), exp)).toBe("waiting_for_deposit");
    expect(interpretPayment(p({ currency: "USD" }), exp)).toBe("mismatch");
    expect(interpretPayment(p({ currency: "KRW" }), exp)).toBe("paid");
    expect(interpretPayment(p(), exp)).toBe("paid");
  });

  it("면세·공급가액·부가세·통화를 읽는다", async () => {
    const m = mk(resp(pay({ currency: "KRW", taxFreeAmount: 10000, suppliedAmount: 0, vat: 0 })));
    const r = await getPayment(cfgOf(m), PK);

    expect(r).toMatchObject({ kind: "found", payment: { currency: "KRW", taxFreeAmount: 10000, suppliedAmount: 0, vat: 0 } });
  });
});

describe("취소 옵션·전액 응답 판정", () => {
  const key = (n: number, t: number) => cancelIdempotencyKey({ paymentKey: PK, cancelAmount: n, alreadyCanceledTotal: t });

  it("부분 취소에 taxFreeAmount 를 본문에 싣는다, 전액·범위 밖이면 던진다", async () => {
    const m = mk(resp(pay({ status: "PARTIAL_CANCELED", balanceAmount: 7000, cancels: [{ cancelAmount: 3000 }] })));
    const r = await cancelPayment(cfgOf(m), { paymentKey: PK, cancelReason: "부분", cancelAmount: 3000, alreadyCanceledTotal: 0, taxFreeAmount: 3000, idempotencyKey: key(3000, 0) });

    expect(r).toMatchObject({ kind: "canceled" });
    expect(sentBody(m)).toMatchObject({ cancelAmount: 3000, taxFreeAmount: 3000 });
    await expect(cancelPayment(cfgOf(m), { paymentKey: PK, cancelReason: "x", taxFreeAmount: 100, idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) })).rejects.toThrow(/INVALID_TAX_FREE/);
    await expect(cancelPayment(cfgOf(m), { paymentKey: PK, cancelReason: "x", cancelAmount: 1000, alreadyCanceledTotal: 0, taxFreeAmount: 2000, idempotencyKey: key(1000, 0) })).rejects.toThrow(/INVALID_TAX_FREE/);
  });

  it("환불계좌를 본문에 싣고 형식이 틀리면 던진다", async () => {
    const m = mk(resp(pay({ status: "CANCELED" })));
    const acct = { bank: "20", accountNumber: "1234567890", holderName: "홍길동" };

    expect(await cancelPayment(cfgOf(m), { paymentKey: PK, cancelReason: "환불", refundReceiveAccount: acct, idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) })).toMatchObject({ kind: "canceled" });
    expect(sentBody(m).refundReceiveAccount).toEqual(acct);
    await expect(cancelPayment(cfgOf(m), { paymentKey: PK, cancelReason: "x", refundReceiveAccount: { ...acct, accountNumber: "12-34" }, idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) })).rejects.toThrow(/INVALID_REFUND_ACCOUNT/);
  });

  it("전액 요청 응답이 PARTIAL_CANCELED+잔액 0 이면 canceled, 잔액이 남으면 uncertain", async () => {
    const zero = mk(resp(pay({ status: "PARTIAL_CANCELED", balanceAmount: 0, cancels: [{ cancelAmount: 10000 }] })));
    const left = mk(resp(pay({ status: "PARTIAL_CANCELED", balanceAmount: 5000, cancels: [{ cancelAmount: 5000 }] })));
    const input = { paymentKey: PK, cancelReason: "전액", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) };

    expect(await cancelPayment(cfgOf(zero), input)).toMatchObject({ kind: "canceled", alreadyCanceled: false });
    expect(await cancelPayment(cfgOf(left), input)).toMatchObject({ kind: "uncertain" });
  });

  it("긴 취소 사유는 200자(코드포인트)로 자른다", async () => {
    const m = mk(resp(pay({ status: "CANCELED" })));

    await cancelPayment(cfgOf(m), { paymentKey: PK, cancelReason: "😀".repeat(250), idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) });
    expect([...sentBody(m).cancelReason]).toHaveLength(200);
  });
});

describe("approved_mismatch 취소 도우미·웹훅 대조", () => {
  it("표준 전액 취소 키로 취소하고 클라이언트 묶음에도 있다", async () => {
    const m = mk(resp(pay({ orderId: "other-order-1234", status: "DONE" })), resp(pay({ orderId: "other-order-1234", status: "CANCELED" })));
    const cfg = cfgOf(m);
    const c = await confirmPayment(cfg, { paymentKey: PK, orderId: OID, amount: 10000 });

    expect(c.kind).toBe("approved_mismatch");

    if (c.kind !== "approved_mismatch") return;

    expect(await createTossClient(cfg).cancelApprovedMismatch(c)).toMatchObject({ kind: "canceled" });
    const [url, init] = m.f.mock.calls[1] as unknown as [string, RequestInit];

    expect(url).toBe(`https://api.tosspayments.com/v1/payments/${PK}/cancel`);
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(cancelIdempotencyKey({ paymentKey: PK }));
    expect(typeof cancelApprovedMismatch).toBe("function");
  });

  it("웹훅 secret 은 같을 때만 true, 비었거나 길이가 다르면 false", () => {
    expect(isWebhookSecretValid("abc123", "abc123")).toBe(true);
    expect(isWebhookSecretValid("abc123", "abc124")).toBe(false);
    expect(isWebhookSecretValid("abc123", "abc12")).toBe(false);
    expect(isWebhookSecretValid(null, "abc")).toBe(false);
    expect(isWebhookSecretValid("", "")).toBe(false);
    expect(isWebhookSecretValid("abc", undefined)).toBe(false);
  });
});

describe("승인 응답 통화 검사", () => {
  it("KRW 가 아닌 승인 응답은 approved_mismatch(CURRENCY_MISMATCH), KRW·통화 없음은 success", async () => {
    const usd = mk(resp(pay({ currency: "USD" })));
    const krw = mk(resp(pay({ currency: "KRW" })));
    const none = mk(resp(pay()));
    const run = (m: ReturnType<typeof mk>) => confirmPayment(cfgOf(m), { paymentKey: PK, orderId: OID, amount: 10000 });

    expect(await run(usd)).toMatchObject({ kind: "approved_mismatch", reason: "CURRENCY_MISMATCH" });
    expect((await run(krw)).kind).toBe("success");
    expect((await run(none)).kind).toBe("success");
  });
});

describe("키 공백 처리·모의 서버", () => {
  it("개행이 섞인 키는 지운 값으로 검사하고 인증 헤더도 지운 값으로 만든다", async () => {
    const m = mk(resp(pay()));

    await getPayment({ secretKey: "test_sk_abc\n", fetch: m.fetch, expectedMode: "test" }, PK);
    expect((m.f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: `Basic ${Buffer.from("test_sk_abc:").toString("base64")}` });
  });

  it("baseUrl 모의 서버 + unchecked 는 접두사 없는 키로 오탐 없이 동작", async () => {
    const m = mk(resp(pay()));

    expect(await getPayment({ secretKey: "mock", fetch: m.fetch, baseUrl: "http://localhost:9999", expectedMode: "unchecked" }, PK)).toMatchObject({ kind: "found" });
    expect((m.f.mock.calls[0] as unknown as [string])[0]).toBe(`http://localhost:9999/v1/payments/${PK}`);
  });
});

describe("timeoutMs 상한", () => {
  it("2^31 이상·Infinity 여도 즉시 중단되지 않고 상한(120000)으로 대기한다", async () => {
    vi.useFakeTimers();

    try {
      const spy = vi.spyOn(globalThis, "setTimeout");
      const m = mk(resp(pay()));

      for (const t of [2 ** 31 + 10, Infinity, 10_000_000]) {
        await getPayment({ ...cfgOf(m), timeoutMs: t } as never, PK).catch(() => null);
      }

      const delays = spy.mock.calls.map((c) => c[1]).filter((d) => typeof d === "number" && d >= 15_000);

      expect(delays.every((d) => d === 15_000 || d === 120_000)).toBe(true);
      expect(delays).toContain(120_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("secret 비노출", () => {
  it("payment.secret 은 읽히지만 JSON·스프레드·열거에는 나오지 않는다", async () => {
    const m = mk(resp(pay({ secret: "whsec_hidden" })));
    const r = await getPayment(cfgOf(m), PK);

    expect(r.kind).toBe("found");

    if (r.kind !== "found") return;

    expect(r.payment.secret).toBe("whsec_hidden");
    expect(JSON.stringify(r)).not.toContain("whsec_hidden");
    expect(JSON.stringify({ ...r.payment })).not.toContain("whsec_hidden");
    expect(Object.keys(r.payment)).not.toContain("secret");
  });
});
