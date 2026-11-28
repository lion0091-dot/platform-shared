import { describe, expect, it } from "vitest";
import { guard, type GuardPolicy } from "./index";

// 규칙 보강 /4 시험: 숫자 구분자 확대·이메일 우회 표기·차량번호·주문/송장 단서. 모든 값은 형식만 맞춘 가짜.
const P: GuardPolicy = {
  policyId: "test.rules4",
  level: "STANDARD",
  kinds: { PLATE: "MASK" },
  restoreKinds: [],
  maxCharsPerField: 2000,
  maxCharsTotal: 2000,
  maxReplacements: 100,
};
const out = (s: string): string => {
  const r = guard(s, P);
  if (!r.ok) throw new Error(r.reason);
  return r.payload.value as string;
};

describe("rules/4 숫자 구분자 확대", () => {
  it.each([
    ["연락처 010 - 5123 - 4567 로", "연락처 [PHONE_1] 로"],
    ["Tel. 010-5123 - 4567", "Tel. [PHONE_1]"],
    ["주민 900101.1234567", "주민 [RRN_1]"],
    ["사업자 118.56.31475", "사업자 [BIZ_1]"],
    ["카드 9410.1234.5678.9010", "카드 [CARD_1]"],
    ["계좌 110 123 456789 입금", "계좌 [ACCT_1] 입금"],
    ["계좌 4426 - 470-990487", "계좌 [ACCT_1]"],
  ])("%s", (input, expected) => {
    expect(out(input)).toBe(expected);
  });

  it("소수·점 날짜·3자리 묶음 수량 나열은 그대로", () => {
    for (const s of ["온도 -18.5도, 비율 12.5%", "계약일 2026.11.28", "수량 120 340 560 780", "2026 11 28 입고"]) expect(out(s)).toBe(s);
  });
});

describe("rules/4 이메일 우회 표기", () => {
  it.each([
    ["메일 minsu12 @ example.com 로", "메일 [EMAIL_1] 로"],
    ["minsu12(at)example.co.kr 회신", "[EMAIL_1] 회신"],
    ["minsu12 at example dot com 으로", "[EMAIL_1] 으로"],
    ["minsu12 [at] example [dot] net", "[EMAIL_1]"],
    ["minsu12골뱅이example.com", "[EMAIL_1]"],
  ])("%s", (input, expected) => {
    expect(out(input)).toBe(expected);
  });

  it("영문 문장 속 at·숫자는 이메일로 보지 않는다", () => {
    for (const s of ["arrive at 3.5 pm", "meet at 10.30", "look at it"]) expect(out(s)).toBe(s);
  });
});

describe("rules/4 차량번호", () => {
  it.each([
    ["서울12가3456 도착", "[PLATE_1] 도착"],
    ["경기 81바 1234 배차", "[PLATE_1] 배차"],
    ["15다-2261 입차", "[PLATE_1] 입차"],
    ["47 호  4549 기사님", "[PLATE_1] 기사님"],
  ])("%s", (input, expected) => {
    expect(out(input)).toBe(expected);
  });
});

describe("rules/4 주문·송장 단서 (자유 문장 모듈과 같은 원칙)", () => {
  it("단서 바로 뒤 구분 없는 긴 숫자는 계좌로 보지 않는다", () => {
    for (const s of ["주문번호 2026112800123", "운송장번호: 601234567890", "택배 2874442818 조회", "바코드 8801234567893"]) expect(out(s)).not.toContain("[ACCT_");
  });
  it("단서가 있어도 하이픈 덩어리·카드·전화는 가린다", () => {
    expect(out("송장 110-123-456789")).toBe("송장 [ACCT_1]");
    expect(out("송장 9410123456789010")).toBe("송장 [CARD_1]");
    expect(out("송장 01051234567")).toBe("송장 [PHONE_1]");
  });
  it("단서 없는 긴 숫자는 지금처럼 계좌로 가린다", () => {
    expect(out("입금 1234567890 부탁")).toBe("입금 [ACCT_1] 부탁");
  });
});
