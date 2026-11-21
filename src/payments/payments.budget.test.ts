import { describe, expect, it, vi } from "vitest";
import { cancelIdempotencyKey, cancelPayment, confirmPayment, getPayment } from "./index";

// 가짜 값만 쓴다(실제 키 아님)
const SECRET = "test_sk_fake_secret";
const PK = "pk_fake_1234567890";
const OID = "order-abc-123456";

const pay = (o: Partial<Record<string, unknown>> = {}) => ({ paymentKey: PK, orderId: OID, status: "DONE", totalAmount: 10000, method: "카드", approvedAt: "2026-10-16T10:00:00+09:00", ...o });
const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (status: number, code: string) => resp({ code, message: `msg ${code}` }, status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 호출마다 (지연 ms, 응답) 을 차례로 돌려주는 가짜 fetch. 신호를 받으면 중단된다. */
function slow(steps: Array<[number, Response]>) {
  const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const step = steps.shift();

    if (!step) throw new Error("no more mock");

    const [ms, r] = step;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);

      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });

    return r;
  });

  return f;
}

const cancel = (f: ReturnType<typeof slow>, cfg: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  cancelPayment({ secretKey: SECRET, fetch: f as unknown as typeof fetch, expectedMode: "test", ...cfg }, { paymentKey: PK, cancelReason: "고객 요청", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }), ...extra });

describe("budgetMs(호출 흐름 전체 예산)", () => {
  it("예산이 없으면 기존 동작 그대로(후속 조회를 한다)", async () => {
    const f = slow([[0, err(400, "ALREADY_CANCELED_PAYMENT")], [0, resp(pay({ status: "CANCELED" }))]]);

    expect(await cancel(f, {})).toMatchObject({ kind: "canceled", alreadyCanceled: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("예산 안에서 끝나면 결과가 같다", async () => {
    const f = slow([[0, err(400, "ALREADY_CANCELED_PAYMENT")], [0, resp(pay({ status: "CANCELED" }))]]);

    expect(await cancel(f, { budgetMs: 5_000 })).toMatchObject({ kind: "canceled", alreadyCanceled: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("ALREADY_CANCELED 응답이 예산을 다 쓰면 후속 조회를 하지 않고 uncertain/BUDGET_EXCEEDED", async () => {
    const f = slow([[60, err(400, "ALREADY_CANCELED_PAYMENT")], [0, resp(pay({ status: "CANCELED" }))]]);
    const r = await cancel(f, { budgetMs: 40, timeoutMs: 1_000 });

    // 첫 호출은 남은 예산(40ms)으로 제한돼 시간 초과 → 네트워크 불명으로 끝난다(후속 조회 없음)
    expect(r).toMatchObject({ kind: "uncertain" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("첫 응답은 받았지만 예산이 바닥나면 후속 조회를 건너뛴다(NOT_CANCELABLE_AMOUNT → not_cancelable 로 넘기지 않는다)", async () => {
    const f = slow([[50, err(400, "NOT_CANCELABLE_AMOUNT")], [0, resp(pay({ status: "CANCELED" }))]]);
    const r = await cancel(f, { budgetMs: 40, timeoutMs: 1_000 });

    expect(r.kind).toBe("uncertain");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("응답은 예산 안에 왔지만 남은 시간이 없을 때(Date.now 경계) 후속 조회는 BUDGET_EXCEEDED", async () => {
    const now = vi.spyOn(Date, "now");

    try {
      let t = 1_000_000;

      now.mockImplementation(() => t);

      const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        t += 1_500; // 첫 호출이 1.5초 걸렸다고 본다(예산 1초)

        return err(400, "ALREADY_CANCELED_PAYMENT");
      });
      const r = await cancelPayment({ secretKey: SECRET, fetch: f as unknown as typeof fetch, expectedMode: "test", budgetMs: 1_000 }, { paymentKey: PK, cancelReason: "고객 요청", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK }) });

      expect(r).toMatchObject({ kind: "uncertain", code: "BUDGET_EXCEEDED" });
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("부분 취소 응답 누계 불일치 뒤 확인 조회도 예산이 없으면 BUDGET_EXCEEDED", async () => {
    const now = vi.spyOn(Date, "now");

    try {
      let t = 2_000_000;

      now.mockImplementation(() => t);

      const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        t += 1_500;

        // 부분 취소 요청인데 응답 누계가 기대(3000)와 다르다
        return resp(pay({ status: "PARTIAL_CANCELED", balanceAmount: 9000, cancels: [{ cancelAmount: 1000 }] }));
      });
      const r = await cancelPayment(
        { secretKey: SECRET, fetch: f as unknown as typeof fetch, expectedMode: "test", budgetMs: 1_000 },
        { paymentKey: PK, cancelReason: "고객 요청", idempotencyKey: cancelIdempotencyKey({ paymentKey: PK, cancelAmount: 3000, alreadyCanceledTotal: 0 }), cancelAmount: 3000, alreadyCanceledTotal: 0 },
      );

      expect(r).toMatchObject({ kind: "uncertain", code: "BUDGET_EXCEEDED" });
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("호출 제한은 min(timeoutMs, budgetMs) 로 줄어든다(단발 함수 포함)", async () => {
    const f = slow([[200, resp(pay())]]);
    const t0 = Date.now();
    const r = await getPayment({ secretKey: SECRET, fetch: f as unknown as typeof fetch, expectedMode: "test", timeoutMs: 10_000, budgetMs: 30 }, PK);

    expect(r).toMatchObject({ kind: "uncertain", code: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it("budgetMs 가 잘못된 값(0·음수·NaN·문자열)이면 무시한다", async () => {
    for (const bad of [0, -1, Number.NaN, "100" as unknown as number]) {
      const f = slow([[0, err(400, "ALREADY_CANCELED_PAYMENT")], [0, resp(pay({ status: "CANCELED" }))]]);

      expect(await cancel(f, { budgetMs: bad })).toMatchObject({ kind: "canceled" });
      expect(f).toHaveBeenCalledTimes(2);
    }
  });

  it("confirmPayment 는 예산이 있어도 결과 분류가 같다", async () => {
    const f = slow([[0, resp(pay())]]);

    expect(await confirmPayment({ secretKey: SECRET, fetch: f as unknown as typeof fetch, expectedMode: "test", budgetMs: 5_000 }, { paymentKey: PK, orderId: OID, amount: 10000 })).toMatchObject({ kind: "success" });
  });

  it("예산 상태는 호출마다 독립이다(한 번 바닥나도 다음 cancelPayment 는 새 예산)", async () => {
    const cfg = { secretKey: SECRET, expectedMode: "test" as const, budgetMs: 40, timeoutMs: 1_000 };
    const f1 = slow([[60, err(400, "ALREADY_CANCELED_PAYMENT")]]);

    expect((await cancel(f1, cfg)).kind).toBe("uncertain");

    await sleep(5);

    const f2 = slow([[0, err(400, "ALREADY_CANCELED_PAYMENT")], [0, resp(pay({ status: "CANCELED" }))]]);

    expect(await cancel(f2, cfg)).toMatchObject({ kind: "canceled" });
  });
});
