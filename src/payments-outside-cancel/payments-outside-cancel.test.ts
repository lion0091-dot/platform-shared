import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TossPayment } from "../payments/types";
import {
  OUTSIDE_CANCEL_CASES,
  OUTSIDE_CANCEL_CHECK_AGES_DAYS,
  OUTSIDE_CANCEL_SCENARIOS,
  WEBHOOK_MAX_BODY_BYTES,
  cancelEventKey,
  confirmStable,
  extractWebhookRef,
  fromTossPayment,
  isDueForCheck,
  judgeOutsideCancel,
  orderAgeDays,
  orderRefMatches,
  paymentRefHash,
  referenceOutsideCancelAdapter,
  runOutsideCancelConformance,
  summarizeJudgement,
  verifyWebhookUrlToken,
  webhookUrlToken,
  type NormalizedPayment,
  type OutsideCancelAppSide,
} from "./index";

const app = (over: Partial<OutsideCancelAppSide> = {}): OutsideCancelAppSide => ({ total: 50_000, refunded: 0, knownCancelKeys: new Set(), state: "paid", ...over });

const toss = (over: Partial<TossPayment> = {}): TossPayment => ({
  paymentKey: "pay_sample_0001",
  orderId: "ORD-1",
  status: "DONE",
  totalAmount: 50_000,
  method: "카드",
  approvedAt: "2026-11-01T10:00:00+09:00",
  balanceAmount: 50_000,
  cancels: [],
  currency: "KRW",
  ...over,
});

const tc = (key: string | null, amount: number, status: string | null = "DONE") => ({ cancelAmount: amount, cancelReason: "고객 요청", canceledAt: "2026-11-02T10:00:00+09:00", transactionKey: key, cancelStatus: status });

describe("공통 사례표", () => {
  it("14건이고 이름·기대값이 중복되지 않는다", () => {
    expect(OUTSIDE_CANCEL_CASES).toHaveLength(14);
    expect(new Set(OUTSIDE_CANCEL_CASES.map((c) => c.name)).size).toBe(14);
  });

  it("기준 어댑터가 사례표를 모두 통과한다", () => {
    expect(runOutsideCancelConformance(referenceOutsideCancelAdapter)).toEqual([]);
  });

  it("규칙이 어긋난 어댑터는 실패 사례를 돌려준다(던지지 않음)", () => {
    const broken = runOutsideCancelConformance((i) => ({ ...referenceOutsideCancelAdapter(i), verdict: "ok" }));

    expect(broken.length).toBeGreaterThan(0);
    expect(broken.every((f) => typeof f.name === "string")).toBe(true);

    const thrower = runOutsideCancelConformance(() => {
      throw new Error("boom");
    });

    expect(thrower).toHaveLength(14);
    expect(thrower[0].actual).toEqual({ error: "boom" });
  });

  it("앱 쪽 집합이 배열(JSON)이어도 기준 어댑터가 받는다", () => {
    const c = OUTSIDE_CANCEL_CASES[2];

    expect(JSON.parse(JSON.stringify(c))).toEqual(JSON.parse(JSON.stringify({ ...c })));
    expect(referenceOutsideCancelAdapter(JSON.parse(JSON.stringify({ app: c.app, toss: c.toss })))).toEqual(c.expect);
  });
});

describe("토스 원문 → 정규화 → 판정 (사례표와 같은 결론)", () => {
  const run = (t: TossPayment | null, a: Partial<OutsideCancelAppSide> = {}) => summarizeJudgement(judgeOutsideCancel(t ? fromTossPayment(t) : null, app(a)));

  it("DONE → ok", () => expect(run(toss()).verdict).toBe("ok"));

  it("CANCELED·앱 환불 0 → external_full 총액", () => {
    expect(run(toss({ status: "CANCELED", balanceAmount: 0, cancels: [tc("t1", 50_000)] }))).toEqual({ verdict: "external_full", amount: 50_000, newCancelRefs: ["t1"] });
  });

  it("PARTIAL_CANCELED 잔액 0(실측) → 전액 취소로 정규화되고 external_full", () => {
    const t = toss({ status: "PARTIAL_CANCELED", balanceAmount: 0, cancels: [tc("t1", 30_000), tc("t2", 20_000)] });

    expect(fromTossPayment(t).status).toBe("CANCELED");
    expect(run(t)).toEqual({ verdict: "external_full", amount: 50_000, newCancelRefs: ["t1", "t2"] });
  });

  it("정규화 없이 PARTIAL_CANCELED 잔액 0 이 와도 judge 는 전액으로 본다", () => {
    const n: NormalizedPayment = { ...fromTossPayment(toss({ status: "PARTIAL_CANCELED", balanceAmount: 0, cancels: [tc("t1", 50_000)] })), status: "PARTIAL_CANCELED" };

    expect(judgeOutsideCancel(n, app()).verdict).toBe("external_full");
  });

  it("PARTIAL_CANCELED 잔액 30000 → external_partial, 잔액·취소 누계 값", () => {
    const j = judgeOutsideCancel(fromTossPayment(toss({ status: "PARTIAL_CANCELED", balanceAmount: 30_000, cancels: [tc("t1", 20_000)] })), app());

    expect(j).toMatchObject({ verdict: "external_partial", unreflected: 20_000, canceledTotal: 20_000, balance: 30_000 });
  });

  it("balance 없음 + cancels 만 → 합계로 판정, 진행 중 취소 제외", () => {
    const t = toss({ status: "PARTIAL_CANCELED", balanceAmount: null, cancels: [tc("t1", 10_000), tc("t2", 7_000, "IN_PROGRESS")] });

    expect(run(t)).toEqual({ verdict: "external_partial", amount: 10_000, newCancelRefs: ["t1"] });
  });

  it("balance·cancels 둘 다 없는 PARTIAL_CANCELED → unreadable", () => {
    expect(run(toss({ status: "PARTIAL_CANCELED", balanceAmount: null, cancels: [] })).verdict).toBe("unreadable");
  });

  it("READY·IN_PROGRESS·WAITING_FOR_DEPOSIT·모르는 값 → status_anomaly, ABORTED·EXPIRED 도", () => {
    for (const s of ["READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT", "ABORTED", "EXPIRED", "SOMETHING_NEW"]) {
      const j = judgeOutsideCancel(fromTossPayment(toss({ status: s })), app());

      expect(j.verdict, s).toBe("status_anomaly");
      expect(j).toMatchObject({ rawStatus: s });
    }
  });

  it("통화 USD·총액 불일치 → amount_mismatch", () => {
    expect(run(toss({ currency: "USD" })).verdict).toBe("amount_mismatch");
    expect(run(toss(), { total: 49_000 }).verdict).toBe("amount_mismatch");
  });

  it("앱이 전액 환불로만 기록(누계 null) + 토스 전액 취소 → ok, 앱 누계 null + paid 면 총액이 미반영", () => {
    const t = toss({ status: "CANCELED", balanceAmount: 0, cancels: [tc("t1", 50_000)] });

    expect(judgeOutsideCancel(fromTossPayment(t), app({ refunded: null, state: "refunded", knownCancelKeys: new Set(["t1"]) })).verdict).toBe("ok");
    expect(judgeOutsideCancel(fromTossPayment(t), app({ refunded: null })).verdict).toBe("external_full");
  });

  it("미트 balance<=0 / 이음 설계안과 같은 결과(회귀): balance 0 → full, balance>=total → ok, 그 사이 → partial", () => {
    for (const [bal, want] of [[0, "external_full"], [1, "external_partial"], [49_999, "external_partial"], [50_000, "ok"]] as const) {
      const status = bal === 50_000 ? "DONE" : bal === 0 ? "CANCELED" : "PARTIAL_CANCELED";

      expect(run(toss({ status, balanceAmount: bal, cancels: [] })).verdict, `balance ${bal}`).toBe(want);
    }
  });
});

describe("멱등·새 취소 건", () => {
  const t = toss({ status: "PARTIAL_CANCELED", balanceAmount: 30_000, cancels: [tc("t1", 10_000), tc("t2", 10_000), tc(null, 0)] });

  it("건별 키가 없는 건은 unkeyedCancels 로 세고 멱등 키를 만들지 않는다", () => {
    const j = judgeOutsideCancel(fromTossPayment(t), app());

    expect(j.unkeyedCancels).toBe(1);
    expect(j.newCancels.map((c) => c.providerCancelRef)).toEqual(["t1", "t2"]);
    expect(j.eventKeys).toEqual([cancelEventKey("pay_sample_0001", "t1"), cancelEventKey("pay_sample_0001", "t2")]);
    expect(j.eventKeys[0]).toBe(`cncl:${paymentRefHash("pay_sample_0001")}:t1`);
  });

  it("같은 관측을 N 번 반복해도 결과가 같고, 앱이 건을 기록한 뒤에는 새 건이 비어 있다(웹훅 재전송·웹훅+크론 겹침)", () => {
    const first = judgeOutsideCancel(fromTossPayment(t), app());

    for (let i = 0; i < 20; i++) expect(judgeOutsideCancel(fromTossPayment(t), app())).toEqual(first);

    const known = new Set(first.newCancels.map((c) => c.providerCancelRef!));
    const after = judgeOutsideCancel(fromTossPayment(t), app({ refunded: 20_000, knownCancelKeys: known }));

    expect(after.verdict).toBe("ok");
    expect(after.newCancels).toEqual([]);
    expect(after.eventKeys).toEqual([]);
  });

  it("같은 transactionKey 가 한 응답에 두 번 와도 새 건은 한 번", () => {
    const j = judgeOutsideCancel(fromTossPayment(toss({ status: "PARTIAL_CANCELED", balanceAmount: 40_000, cancels: [tc("t1", 10_000), tc("t1", 10_000)] })), app());

    expect(j.newCancels).toHaveLength(1);
  });

  it("긴 transactionKey 는 앞 100자만 멱등 키에 쓴다", () => {
    expect(cancelEventKey("p", "k".repeat(150))).toBe(`cncl:${paymentRefHash("p")}:${"k".repeat(100)}`);
  });
});

describe("confirmStable (재조회 확정)", () => {
  const full = (a: Partial<OutsideCancelAppSide> = {}) => judgeOutsideCancel(fromTossPayment(toss({ status: "CANCELED", balanceAmount: 0, cancels: [tc("t1", 50_000)] })), app(a));

  it("같은 결론이면 확정", () => expect(confirmStable(full(), full())).toBe(true));

  it("결론·금액·새 건이 다르면 보류", () => {
    const partial = judgeOutsideCancel(fromTossPayment(toss({ status: "PARTIAL_CANCELED", balanceAmount: 30_000, cancels: [tc("t1", 20_000)] })), app());

    expect(confirmStable(full(), partial)).toBe(false);
    expect(confirmStable(full(), full({ refunded: 10_000 }))).toBe(false);
    expect(confirmStable(full(), full({ knownCancelKeys: new Set(["t1"]) }))).toBe(false);
  });

  it("ok·not_found·status_anomaly·unreadable 은 확정 대상이 아니다", () => {
    const ok = judgeOutsideCancel(fromTossPayment(toss()), app());

    expect(confirmStable(ok, ok)).toBe(false);
    expect(confirmStable(judgeOutsideCancel(null, app()), judgeOutsideCancel(null, app()))).toBe(false);
  });
});

describe("던지지 않음 (이상한 입력)", () => {
  it("숫자·구조가 깨진 입력도 verdict 로 돌려준다", () => {
    const weird: unknown[] = [
      { status: "APPROVED", approvedAmount: NaN, canceledTotal: 0, balance: null, providerPaymentRef: "p", cancels: [] },
      { status: "APPROVED", approvedAmount: 50_000, canceledTotal: -5, balance: null, providerPaymentRef: "p", cancels: [] },
      { status: "APPROVED", approvedAmount: 50_000, canceledTotal: 0.5, balance: null, providerPaymentRef: "p", cancels: null },
      { status: "CANCELED", approvedAmount: 50_000, canceledTotal: null, balance: null, providerPaymentRef: "p", cancels: [null, { amount: "x" }] },
      {},
      [],
    ];

    for (const w of weird) {
      for (const a of [app(), app({ total: NaN }), app({ refunded: -1 }), { ...app(), knownCancelKeys: undefined as unknown as Set<string> }]) {
        expect(() => judgeOutsideCancel(w as NormalizedPayment, a)).not.toThrow();
      }
    }
  });

  it("undefined·null 입력", () => {
    expect(() => judgeOutsideCancel(undefined as unknown as null, app())).not.toThrow();
    expect(judgeOutsideCancel(null, app()).verdict).toBe("not_found");
    expect(() => judgeOutsideCancel(fromTossPayment(toss()), null as unknown as OutsideCancelAppSide)).not.toThrow();
  });

  it("무작위 입력 3,000건에서 던지지 않고 항상 알려진 verdict", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const nums = [0, 1, 100, 49_999, 50_000, 50_001, -1, 1.5, NaN, null];
    const known = new Set(["unreadable", "ok", "external_full", "external_partial", "app_ahead", "amount_mismatch", "status_anomaly", "not_found"]);

    for (let i = 0; i < 3_000; i++) {
      const n = {
        status: pick(["APPROVED", "CANCELED", "PARTIAL_CANCELED", "PENDING_UNCONFIRMED", "FAILED"]),
        approvedAmount: pick(nums),
        currency: pick(["KRW", "USD", null, undefined]),
        canceledTotal: pick(nums),
        balance: pick(nums),
        providerPaymentRef: "p",
        cancels: pick([[], [{ providerCancelRef: "a", amount: pick(nums), status: pick(["DONE", null, "X"]), canceledAt: null }]]),
      } as unknown as NormalizedPayment;

      expect(known.has(judgeOutsideCancel(n, app({ total: pick(nums) as number, refunded: pick(nums), state: pick(["paid", "refunded", "other"] as const) })).verdict)).toBe(true);
    }
  });
});

describe("주문 나이·조회 차례", () => {
  const day = 86_400_000;
  const t0 = Date.parse("2026-11-01T00:00:00Z");

  it("기본 집합은 미트 현행과 같다", () => expect([...OUTSIDE_CANCEL_CHECK_AGES_DAYS]).toEqual([1, 2, 3, 4, 7, 8, 14, 15, 30, 31]));

  it("나이가 집합에 있을 때만 true (문자열·Date·숫자 입력)", () => {
    const hits: number[] = [];

    for (let d = 0; d <= 45; d++) if (isDueForCheck(new Date(t0).toISOString(), new Date(t0 + d * day + 3_600_000))) hits.push(d);

    expect(hits).toEqual([1, 2, 3, 4, 7, 8, 14, 15, 30, 31]);
    expect(isDueForCheck(t0, t0 + 7 * day)).toBe(true);
    expect(isDueForCheck(new Date(t0), new Date(t0 + 7 * day - 1))).toBe(false);
  });

  it("사용자 지정 집합·잘못된 입력", () => {
    expect(isDueForCheck(t0, t0 + 45 * day, [45])).toBe(true);
    expect(isDueForCheck("not-a-date", t0)).toBe(false);
    expect(isDueForCheck(t0, "x")).toBe(false);
    expect(orderAgeDays(t0 + day, t0)).toBeNull();
  });
});

describe("웹훅 보조", () => {
  const SECRET = "test-secret-outside-cancel-0123456789";

  it("주소 토큰: 같은 업체는 같은 값, 업체·비밀이 다르면 다른 값", () => {
    const a = webhookUrlToken(SECRET, "tenant-a");

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(webhookUrlToken(SECRET, "tenant-a")).toBe(a);
    expect(webhookUrlToken(SECRET, "tenant-b")).not.toBe(a);
    expect(webhookUrlToken(SECRET + "x", "tenant-a")).not.toBe(a);
  });

  it("미트 현행 토큰 규칙(HMAC-SHA256, `toss-webhook:<id>`, hex)과 같은 값", () => {
    const expected = createHmac("sha256", SECRET).update("toss-webhook:tenant-a").digest("hex");

    expect(webhookUrlToken(SECRET, "tenant-a")).toBe(expected);
  });

  it("검증: 맞는 토큰만 통과, 없음·짧은 비밀·길이 다름·다른 업체는 거부", () => {
    const tok = webhookUrlToken(SECRET, "tenant-a")!;

    expect(verifyWebhookUrlToken(SECRET, "tenant-a", tok)).toBe(true);
    expect(verifyWebhookUrlToken(SECRET, "tenant-b", tok)).toBe(false);
    expect(verifyWebhookUrlToken(SECRET, "tenant-a", tok.slice(1))).toBe(false);
    expect(verifyWebhookUrlToken(SECRET, "tenant-a", tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0"))).toBe(false);
    expect(verifyWebhookUrlToken(null, "tenant-a", tok)).toBe(false);
    expect(verifyWebhookUrlToken(SECRET, "tenant-a", null)).toBe(false);
    expect(verifyWebhookUrlToken("short", "tenant-a", tok)).toBe(false);
    expect(webhookUrlToken("short", "tenant-a")).toBeNull();
    expect(webhookUrlToken(SECRET, "")).toBeNull();
  });

  it("본문에서 조회 키만 꺼낸다 — 본문의 상태·금액은 결과에 영향이 없다", () => {
    const base = { eventType: "PAYMENT_STATUS_CHANGED", createdAt: "2026-11-02T00:00:00Z", data: { paymentKey: "pay_sample_0001", orderId: "ORD-1", status: "DONE", totalAmount: 50_000 } };
    const forged = { ...base, data: { ...base.data, status: "CANCELED", totalAmount: 1, balanceAmount: 0, cancels: [{ cancelAmount: 50_000 }] } };

    expect(extractWebhookRef(base)).toEqual({ paymentKey: "pay_sample_0001", orderId: "ORD-1" });
    expect(extractWebhookRef(forged)).toEqual(extractWebhookRef(base));
    expect(Object.keys(extractWebhookRef(forged)!).sort()).toEqual(["orderId", "paymentKey"]);
  });

  it("DEPOSIT_CALLBACK 은 본문 orderId, 형식이 이상한 값은 null, 둘 다 없으면 null", () => {
    expect(extractWebhookRef({ orderId: "ORD-2", secret: "s", status: "DONE", transactionKey: "t" })).toEqual({ paymentKey: null, orderId: "ORD-2" });
    expect(extractWebhookRef({ data: { paymentKey: "a b", orderId: "ORD-3" } })).toEqual({ paymentKey: null, orderId: "ORD-3" });
    expect(extractWebhookRef({ data: { paymentKey: "../x" , orderId: "x y" } })).toBeNull();
    expect(extractWebhookRef({ data: { paymentKey: "k".repeat(201) } })).toBeNull();

    for (const bad of [null, undefined, 1, "x", [], {}, { data: [] }, { data: null }]) expect(extractWebhookRef(bad)).toBeNull();
  });

  it("조회 응답의 주문번호가 요청과 다르면 무시(orderRefMatches)", () => {
    expect(orderRefMatches("ORD-1", "ORD-1")).toBe(true);
    expect(orderRefMatches("ORD-1", "ORD-2")).toBe(false);
    expect(orderRefMatches("ORD-1", undefined)).toBe(false);
    expect(orderRefMatches(null, "ORD-2")).toBe(true);
  });

  it("본문 상한 상수", () => expect(WEBHOOK_MAX_BODY_BYTES).toBe(16_384));
});

describe("시나리오 표", () => {
  it("6종·id 중복 없음·단언 비어 있지 않음", () => {
    expect(OUTSIDE_CANCEL_SCENARIOS.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    for (const s of OUTSIDE_CANCEL_SCENARIOS) expect(s.assert.length).toBeGreaterThan(0);
  });
});

describe("성능", () => {
  it("판정 10만 건이 1초 안에(순수 계산, 취소 건 5개)", () => {
    const n = fromTossPayment(toss({ status: "PARTIAL_CANCELED", balanceAmount: 25_000, cancels: [tc("a", 5_000), tc("b", 5_000), tc("c", 5_000), tc("d", 5_000), tc("e", 5_000)] }));
    const a = app({ refunded: 10_000, knownCancelKeys: new Set(["a", "b"]) });
    const start = performance.now();

    for (let i = 0; i < 100_000; i++) judgeOutsideCancel(n, a);

    const ms = performance.now() - start;

    expect(ms).toBeLessThan(1_000);
  });

  it("조회 차례 계산 100만 건이 1초 안에", () => {
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    const start = performance.now();

    for (let i = 0; i < 1_000_000; i++) isDueForCheck(t0, t0 + (i % 40) * 86_400_000);

    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe("정적 점검 — 순수 함수 모듈", () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ f, text: readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1") }));

  it("소스 파일 목록", () => {
    expect(sources.map((s) => s.f).sort()).toEqual(["cases.ts", "fromTossPayment.ts", "helpers.ts", "index.ts", "judge.ts", "scenarios.ts", "types.ts"]);
  });

  const BANNED: [string, RegExp][] = [
    ["console 호출", /\bconsole\s*\./],
    ["환경변수 읽기", /process\s*\.\s*env/],
    ["네트워크 호출", /\bfetch\s*\(|XMLHttpRequest|node:https?|node:net/],
    ["현재 시각 읽기", /Date\s*\.\s*now|new\s+Date\s*\(\s*\)/],
    ["난수", /Math\s*\.\s*random|randomUUID|randomBytes/],
    ["DB·파일 접근", /supabase|createClient|\bpg\b|node:fs/],
  ];

  for (const [label, re] of BANNED) {
    it(`${label} 없음`, () => {
      for (const s of sources) expect(re.test(s.text), `${s.f}: ${label}`).toBe(false);
    });
  }

  it("판정 코드는 PG 코드(../payments)를 가져오지 않고 업체·키 필드가 없다(정규화 모양만 받음)", () => {
    const text = sources.filter((s) => s.f === "judge.ts" || s.f === "types.ts").map((s) => s.text).join("\n");

    expect(/from\s+"\.\.\//.test(text)).toBe(false);
    expect(/secretKey|wholesaler|tenantId\s*:/i.test(text)).toBe(false);
  });
});
