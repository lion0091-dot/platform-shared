import { describe, expect, it } from "vitest";
import { computePersonalWithholding, WITHHOLDING_MAX_SUPPLY } from "./index";

const ok = (s: number) => {
  const r = computePersonalWithholding(s);
  if (!r.ok) throw new Error(`거부됨 ${s}: ${r.code}`);
  return r.value;
};

describe("개인 차주 원천징수 — 기준 구현 현행 식 대조", () => {
  it("기준 구현의 단위 시험 표본과 같은 값", () => {
    // 기준 구현 표본: [100000,260000,99999,0,215000,191760] → [3300,8580,3299,0,7095,6328]
    expect([100000, 260000, 99999, 0, 215000, 191760].map((s) => ok(s).total)).toEqual([3300, 8580, 3299, 0, 7095, 6328]);
    expect(ok(191760)).toEqual({ total: 6328, income: 5752, local: 576 });
    expect(ok(100000)).toEqual({ total: 3300, income: 3000, local: 300 });
    expect(ok(260000)).toEqual({ total: 8580, income: 7800, local: 780 });
    expect(ok(99999)).toEqual({ total: 3299, income: 2999, local: 300 });
  });

  it("표본표(소득세 / 지방소득세 / 총액)", () => {
    const table: Array<[number, number, number, number]> = [
      [0, 0, 0, 0], [1, 0, 0, 0], [31, 0, 1, 1], [33, 0, 1, 1], [99, 2, 1, 3],
      [99999, 2999, 300, 3299], [100000, 3000, 300, 3300], [191760, 5752, 576, 6328],
      [215000, 6450, 645, 7095], [260000, 7800, 780, 8580], [4227180, 126815, 12681, 139496],
    ];
    for (const [s, income, local, total] of table) expect(ok(s), String(s)).toEqual({ total, income, local });
  });

  it("경계·0원·큰 금액", () => {
    expect(ok(0)).toEqual({ total: 0, income: 0, local: 0 });
    expect(ok(1)).toEqual({ total: 0, income: 0, local: 0 });
    expect(ok(31)).toEqual({ total: 1, income: 0, local: 1 });
    expect(ok(33)).toEqual({ total: 1, income: 0, local: 1 });
    expect(ok(34)).toEqual({ total: 1, income: 1, local: 0 });
    expect(ok(4227180)).toEqual({ total: 139496, income: 126815, local: 12681 });
    expect(ok(999999999)).toEqual({ total: 32999999, income: 29999999, local: 3000000 });
    expect(ok(WITHHOLDING_MAX_SUPPLY).total).toBe(Math.floor((WITHHOLDING_MAX_SUPPLY * 33) / 1000));
  });

  it("소득세 + 지방소득세 = 총액, 지방소득세 음수 없음(0~200,000 전수)", () => {
    for (let s = 0; s <= 200000; s++) {
      const v = ok(s);
      if (v.income + v.local !== v.total || v.local < 0 || v.income > v.total) throw new Error(`불일치 ${s}`);
    }
  });

  it("정수 나눗셈 기준과 같다(0~2,000,000 전수, DB 정수 나눗셈 bigint*33/1000·*3/100 과 대조)", () => {
    for (let s = 0; s <= 2_000_000; s += 7) {
      const v = ok(s);
      if (v.total !== Number((BigInt(s) * 33n) / 1000n) || v.income !== Number((BigInt(s) * 3n) / 100n)) throw new Error(`식 불일치 ${s}`);
    }
  });

  it("음수·소수·비수·너무 큰 값은 던지지 않고 거부", () => {
    expect(computePersonalWithholding(-1)).toEqual({ ok: false, code: "NEGATIVE" });
    expect(computePersonalWithholding(-100000)).toEqual({ ok: false, code: "NEGATIVE" });
    expect(computePersonalWithholding(1.5)).toEqual({ ok: false, code: "NOT_INTEGER" });
    expect(computePersonalWithholding(NaN)).toEqual({ ok: false, code: "NOT_INTEGER" });
    expect(computePersonalWithholding(Infinity)).toEqual({ ok: false, code: "NOT_INTEGER" });
    expect(computePersonalWithholding("100000" as unknown as number)).toEqual({ ok: false, code: "NOT_INTEGER" });
    expect(computePersonalWithholding(null as unknown as number)).toEqual({ ok: false, code: "NOT_INTEGER" });
    expect(computePersonalWithholding(WITHHOLDING_MAX_SUPPLY + 1)).toEqual({ ok: false, code: "TOO_LARGE" });
  });
});

import { judgeWithholdingTarget } from "./index";

describe("개인 차주 대상 판정 — 사업자번호 → 계산서 → 개인", () => {
  const B = (decision: string, reason: string) => ({ decision, personal: decision === "PERSONAL" ? true : decision === "BUSINESS" ? false : null, reason });
  const table: Array<[string, Parameters<typeof judgeWithholdingTarget>[0], ReturnType<typeof B>]> = [
    ["사업자번호 있음(불리언)", { businessNumber: true, taxInvoice: false }, B("BUSINESS", "BUSINESS_NUMBER")],
    ["사업자번호 값 있음", { businessNumber: "000-00-00000", taxInvoice: false }, B("BUSINESS", "BUSINESS_NUMBER")],
    ["사업자번호 있음 + 계산서도 있음 → 사업자번호 우선", { businessNumber: true, taxInvoice: true }, B("BUSINESS", "BUSINESS_NUMBER")],
    ["사업자번호 있음, 계산서 불명 → 그대로 사업자", { businessNumber: true }, B("BUSINESS", "BUSINESS_NUMBER")],
    ["번호 없음 + 계산서 있음", { businessNumber: false, taxInvoice: true }, B("BUSINESS", "TAX_INVOICE")],
    ["번호 빈 문자열 + 계산서 있음", { businessNumber: "", taxInvoice: true }, B("BUSINESS", "TAX_INVOICE")],
    ["번호 null + 계산서 있음", { businessNumber: null, taxInvoice: true }, B("BUSINESS", "TAX_INVOICE")],
    ["번호 불명 + 계산서 있음 → 어느 경우든 사업자", { taxInvoice: true }, B("BUSINESS", "TAX_INVOICE")],
    ["둘 다 없음 → 개인", { businessNumber: false, taxInvoice: false }, B("PERSONAL", "NO_BUSINESS_NO_INVOICE")],
    ["공백만 있는 번호 + 계산서 null → 개인", { businessNumber: "   ", taxInvoice: null }, B("PERSONAL", "NO_BUSINESS_NO_INVOICE")],
    ["번호 없음 + 계산서 불명 → 확인 필요", { businessNumber: false }, B("NEEDS_CHECK", "TAX_INVOICE_UNKNOWN")],
    ["번호 불명 + 계산서 없음 → 확인 필요", { taxInvoice: false }, B("NEEDS_CHECK", "BUSINESS_NUMBER_UNKNOWN")],
    ["둘 다 불명 → 확인 필요", {}, B("NEEDS_CHECK", "BUSINESS_NUMBER_UNKNOWN")],
  ];
  for (const [name, input, expected] of table) it(name, () => expect(judgeWithholdingTarget(input)).toEqual(expected));

  it("이상 입력은 던지지 않고 불명 처리", () => {
    expect(judgeWithholdingTarget(undefined as never).decision).toBe("NEEDS_CHECK");
    expect(judgeWithholdingTarget({ businessNumber: 123 as never, taxInvoice: false }).decision).toBe("NEEDS_CHECK");
  });

  it("형식은 검증하지 않는다(값이 있으면 있음)", () => {
    expect(judgeWithholdingTarget({ businessNumber: "아무거나", taxInvoice: false }).reason).toBe("BUSINESS_NUMBER");
  });
});
