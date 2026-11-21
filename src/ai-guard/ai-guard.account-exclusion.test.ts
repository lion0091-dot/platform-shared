import { describe, expect, it } from "vitest";
import { guard, type GuardPolicy, type GuardResult } from "./index";

// 계좌 제외 규칙 축소(ai-guard-rules/3) 시험. 모든 값은 가짜.
const base: GuardPolicy = {
  policyId: "account-exclusion.v1",
  level: "STANDARD",
  maxCharsPerField: 2000,
  maxCharsTotal: 4000,
  maxReplacements: 50,
  restoreKinds: [],
};
function out(text: string): string {
  const r: GuardResult = guard(text, base);
  if (!r.ok) throw new Error("expected ok, got " + r.reason);
  if (typeof r.payload.value !== "string") throw new Error("string expected");
  return r.payload.value;
}

describe("누락 4종 재현 고정: 계좌로 가려야 한다", () => {
  it.each([
    ["앞 쉼표", "계좌 1,110234567890 입금", "계좌 1,[ACCT_1] 입금"],
    ["앞 점(숫자 아님)", "계좌.110234567890 입금", "계좌.[ACCT_1] 입금"],
    ["뒤 띄어 쓴 원", "계좌 110234567890 원 입금", "계좌 [ACCT_1] 원 입금"],
    ["뒤 만(둥글지 않음)", "110234567890만", "[ACCT_1]만"],
    ["뒤 쉼표+숫자", "계좌 110234567890,123 입금", "계좌 [ACCT_1],123 입금"],
    ["20YYMMDD 12자리", "계좌 202304151234 입금", "계좌 [ACCT_1] 입금"],
    ["20YYMMDD 14자리(시각 아님)", "계좌 20230415996655 입금", "계좌 [ACCT_1] 입금"],
    ["20YYMMDD 14자리(없는 날짜)", "계좌 20230231123456 입금", "계좌 [ACCT_1] 입금"],
  ])("%s", (_n, input, expected) => {
    expect(out(input)).toBe(expected);
  });
});

describe("금액·날짜 오탐 0 (원·만·천·억 포함)", () => {
  it.each([
    "금액 150000000000원 입니다",
    "금액 100000000000원",
    "금액 10000000000만",
    "금액 1,234,567,890,123원",
    "금액 150,000원 5,000만원 3,200천원 12억 5,000만원",
    "합계 1,000,000원 / 2,500,000,000원",
    "수치 1234567890.12 입니다",
    "비율 0.1234567890",
    "접수일 20261109123045 처리",
    "접수일 2026-11-09 처리",
    "수량 12345 개 단가 1,500원",
    "운임 15만원 상차 8시",
  ])("%s", (t) => {
    expect(out(t)).toBe(t);
  });
});
