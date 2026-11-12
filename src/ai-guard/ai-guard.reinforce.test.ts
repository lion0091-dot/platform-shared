import { describe, expect, it } from "vitest";
import { GUARD_RULES_VERSION, guard, type GuardPolicy, type GuardResult } from "./index";
import { normalizeText } from "./normalize";

// 보강 5건 시험. 모든 값은 가짜(번호는 시험 안에서 체크섬을 계산한다).
function biznoComplete(first9: string): string {
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(first9[i]) * w[i]!;
  sum += Math.floor((Number(first9[8]) * 5) / 10);
  return first9 + String((10 - (sum % 10)) % 10);
}

const base: GuardPolicy = {
  policyId: "reinforce.v1",
  level: "STANDARD",
  maxCharsPerField: 2000,
  maxCharsTotal: 4000,
  maxReplacements: 50,
  restoreKinds: [],
};
const p = (over: Partial<GuardPolicy> = {}): GuardPolicy => ({ ...base, ...over });
function okText(r: GuardResult): string {
  if (!r.ok) throw new Error("expected ok, got " + r.reason);
  if (typeof r.payload.value !== "string") throw new Error("string expected");
  return r.payload.value;
}

describe("규칙 버전", () => {
  it("보강으로 규칙이 바뀌어 /2", () => {
    expect(GUARD_RULES_VERSION).toBe("ai-guard-rules/2");
  });
});

describe("보강 ② 유니코드 구분자·비ASCII 숫자 (정규화 층)", () => {
  it.each([
    ["유니코드 하이픈", "010‐1234‐5678"],
    ["비분리 하이픈", "010‑1234‑5678"],
    ["en 대시", "010–1234–5678"],
    ["em 대시", "010—1234—5678"],
    ["수학 빼기", "010−1234−5678"],
    ["가운뎃점", "010·1234·5678"],
    ["가타카나 가운뎃점", "010・1234・5678"],
    ["대시 주변 공백", "010 – 1234 – 5678"],
    ["전각 숫자+전각 하이픈", "０１０－１２３４－５６７８"],
    ["아랍-인도 숫자", "٠١٠-١٢٣٤-٥٦٧٨"],
    ["아랍-인도 숫자+유니코드 대시", "٠١٠–١٢٣٤–٥٦٧٨"],
    ["제로폭 섞임", "010​-1234⁠-5678"],
  ])("전화 변형: %s", (_n, phone) => {
    const out = okText(guard(`연락처 ${phone} 입니다`, p()));
    expect(out).toBe("연락처 [PHONE_1] 입니다");
  });

  it("주민번호·계좌 변형도 잡는다", () => {
    expect(okText(guard("900101−1234567", p()))).toBe("[RRN_1]");
    expect(okText(guard("110–123–456789", p()))).toBe("[ACCT_1]");
  });

  it("문장 속 대시 문체는 바꾸지 않는다(숫자 옆이 아닐 때)", () => {
    expect(normalizeText("가나다 — 라마바 – 사아자")).toBe("가나다 — 라마바 – 사아자");
    expect(normalizeText("A·B")).toBe("A·B");
  });

  it("숫자 옆 대시는 -로 통일, 숫자는 ASCII 로", () => {
    expect(normalizeText("12–34")).toBe("12-34");
    expect(normalizeText("١٢٣")).toBe("123");
    expect(normalizeText("１２３")).toBe("123");
  });

  it("금액·날짜는 여전히 건드리지 않는다", () => {
    expect(okText(guard("총액 1,234,567원 5만원 2024-11-12", p()))).toBe("총액 1,234,567원 5만원 2024-11-12");
  });
});

describe("보강 ③ 이름 단서어 (공유 상수)", () => {
  it.each(["고객명", "신청자", "가입자", "예금주"])("%s 뒤 이름 후보", (cue) => {
    const text = `${cue} 가나다 확인`;
    expect(okText(guard(text, p()))).toBe(`${cue} [PERSON_1] 확인`);
    const strict = guard(text, p({ level: "STRICT" }));
    expect(strict.ok).toBe(false);
  });
  it("업무어가 뒤따르면 이름으로 보지 않는다", () => {
    expect(okText(guard("고객명 변경 요청", p()))).toBe("고객명 변경 요청");
  });
});

describe("보강 ④ 겹친 스팬의 처리 방식 합치기 (가장 엄격한 쪽)", () => {
  const address = (t: string) => {
    const a = t.indexOf("대치동");
    return a < 0 ? [] : [{ kind: "ADDRESS" as const, start: a, end: t.length }];
  };
  const text = "상차 대치동 123-4 전화 010-0000-1234";

  it("기본 정책: 주소가 전화를 감싸면 전체가 PHONE 토큰(기존 동작 유지)", () => {
    expect(okText(guard(text, p({ extraDetectors: [address] })))).toBe("상차 [PHONE_1]");
  });
  it("PHONE=PASS 여도 같은 구간의 주소(MASK)는 누락되지 않는다", () => {
    const out = okText(guard(text, p({ kinds: { PHONE: "PASS" }, extraDetectors: [address] })));
    expect(out).toBe("상차 [ADDR_1]");
    expect(out).not.toContain("010");
    expect(out).not.toContain("대치동");
  });
  it("PHONE=OFF 여도 주소는 누락되지 않는다", () => {
    const out = okText(guard(text, p({ kinds: { PHONE: "OFF" }, extraDetectors: [address] })));
    expect(out).toBe("상차 [ADDR_1]");
  });
  it("전화만 있고 PASS 면 그대로 통과·집계 (변화 없음)", () => {
    const r = guard("전화 010-0000-1234", p({ kinds: { PHONE: "PASS" } }));
    expect(okText(r)).toBe("전화 010-0000-1234");
    if (r.ok) expect(r.report.passed.PHONE).toBe(1);
  });
  it("전화만 있고 OFF 면 탐지 안 함·계좌로도 안 가림 (변화 없음)", () => {
    expect(okText(guard("전화 010-0000-1234", p({ kinds: { PHONE: "OFF" } })))).toBe("전화 010-0000-1234");
  });
  it("BLOCK 구성원이 있으면 PASS 가 삼키지 못한다", () => {
    const r = guard(text, p({ kinds: { PHONE: "PASS", ADDRESS: "BLOCK" }, extraDetectors: [address] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kinds).toContain("ADDRESS");
  });
  it("검증식을 통과한 사업자번호 모양은 BIZNO=PASS 일 때 계좌로 다시 가려지지 않는다", () => {
    const biz = biznoComplete("000123456");
    const f = `${biz.slice(0, 3)}-${biz.slice(3, 5)}-${biz.slice(5)}`;
    const r = guard(`사업자 ${f}`, p({ kinds: { BIZNO: "PASS" } }));
    expect(okText(r)).toBe(`사업자 ${f}`);
    if (r.ok) expect(r.report.passed.BIZNO).toBe(1);
    expect(okText(guard(`사업자 ${f}`, p()))).toBe("사업자 [BIZ_1]"); // 기본은 그대로 가림
  });
});

describe("보강 ⑤ 정책 사후 변경 (컴파일 시점 복사·동결)", () => {
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };

  it("level 을 나중에 바꿔도 이미 컴파일된 규칙은 그대로", () => {
    const pol = p({ level: "STRICT" }) as Mutable<GuardPolicy>;
    const text = "받는분 가나다 연락";
    expect(guard(text, pol).ok).toBe(false); // 첫 호출에서 컴파일
    pol.level = "STANDARD";
    expect(guard(text, pol).ok).toBe(false);
  });
  it("한도를 나중에 키워도 달라지지 않는다", () => {
    const pol = p({ maxCharsPerField: 10, maxCharsTotal: 10 }) as Mutable<GuardPolicy>;
    expect(guard("12345678901", pol).ok).toBe(false);
    pol.maxCharsPerField = 2000;
    pol.maxCharsTotal = 4000;
    expect(guard("12345678901", pol).ok).toBe(false);
  });
  it("extraDetectors 배열에 나중에 감지기를 넣어도 반영되지 않는다", () => {
    const dets: Array<(t: string) => never[]> = [];
    const pol = p({ extraDetectors: dets });
    expect(guard("안녕", pol).ok).toBe(true);
    dets.push(() => {
      throw new Error("later");
    });
    expect(guard("안녕", pol).ok).toBe(true);
  });
  it("fields 의 enum 허용값 배열을 나중에 늘려도 반영되지 않는다", () => {
    const values: string[] = ["A"];
    const pol = p({ fields: { kind: { type: "enum", values } } });
    expect(guard({ kind: "B" }, pol).ok).toBe(false);
    values.push("B");
    expect(guard({ kind: "B" }, pol).ok).toBe(false);
  });
  it("kinds 맵을 나중에 바꿔도 반영되지 않는다", () => {
    const kinds: Record<string, "MASK" | "BLOCK" | "PASS" | "OFF"> = { PHONE: "MASK" };
    const pol = p({ kinds });
    expect(okText(guard("010-0000-1234", pol))).toBe("[PHONE_1]");
    kinds.PHONE = "PASS";
    expect(okText(guard("010-0000-1234", pol))).toBe("[PHONE_1]");
  });
  it("restoreKinds 를 나중에 넓혀도 반영되지 않는다", () => {
    const restoreKinds: Array<"PHONE"> = [];
    const pol = p({ restoreKinds });
    const r = guard("010-0000-1234", pol);
    restoreKinds.push("PHONE");
    if (!r.ok) throw new Error("ok expected");
    expect(r.restore("[PHONE_1]").text).toBe("[PHONE_1]");
  });
});

describe("보강 ① 주소 단서 경고 (가리지 않음)", () => {
  it("주소 단서 뒤에 내용이 이어지면 경고 건수만 기록하고 문장은 그대로", () => {
    const r = guard("배송지는 서울시 강남구 역삼동 입니다. 상세주소: 12동 304호", p());
    expect(okText(r)).toBe("배송지는 서울시 강남구 역삼동 입니다. 상세주소: 12동 304호");
    if (r.ok) expect(r.report.warnings).toEqual({ ADDRESS_CUE: 2 });
  });
  it("단서가 없으면 warnings 키 자체가 없다(기존 리포트 모양 유지)", () => {
    const r = guard("안녕하세요", p());
    if (!r.ok) throw new Error("ok expected");
    expect("warnings" in r.report).toBe(false);
  });
  it("경고에는 값이 없다", () => {
    const r = guard("주소: 비밀가나다로 12", p());
    expect(JSON.stringify(r.ok ? r.report : null)).not.toContain("비밀가나다");
  });
});
