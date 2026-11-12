import { describe, expect, it } from "vitest";
import pii from "../board/__vectors__/pii.json";
import { normalizeText, normalizeWithMap } from "../ai-guard/normalize";
import { createFreeTextMasker, FREE_TEXT_MAX_CHARS, FREE_TEXT_RULES_VERSION, maskFreeText, type FreeTextResult } from "./index";

// 시험 값은 전부 합성이다. 카드·사업자번호는 시험 안에서 체크섬을 계산한다.
function luhnComplete(prefix: string, len: number): string {
  const body = prefix.padEnd(len - 1, "0").slice(0, len - 1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}
function biznoComplete(first9: string): string {
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(first9[i]) * w[i]!;
  sum += Math.floor((Number(first9[8]) * 5) / 10);
  return first9 + String((10 - (sum % 10)) % 10);
}

const CARD16 = luhnComplete("999900001111", 16);
const CARD16_G = `${CARD16.slice(0, 4)}-${CARD16.slice(4, 8)}-${CARD16.slice(8, 12)}-${CARD16.slice(12)}`;
const AMEX15 = luhnComplete("3999000011", 15);
const AMEX15_G = `${AMEX15.slice(0, 4)}-${AMEX15.slice(4, 10)}-${AMEX15.slice(10)}`;
const BIZ = biznoComplete("000123456");
const BIZ_F = `${BIZ.slice(0, 3)}-${BIZ.slice(3, 5)}-${BIZ.slice(5)}`;
const RRN = "900101-1234567";

function ok(r: FreeTextResult): Extract<FreeTextResult, { ok: true }> {
  if (!r.ok) throw new Error("expected ok, got " + r.reason);
  return r;
}
const t = (s: string): string => ok(maskFreeText(s)).text;

describe("금액·날짜·번호 표기는 불변 (개발자 규칙: 금액은 가리지 않음)", () => {
  const keep = [
    "총액 1,234,567원 입니다",
    "운임 15만원, 5만, 3.5억, 1억2천만",
    "금액 ₩1,200,000 / KRW 12,000",
    "금액 12000000000원",
    "금액 150000000000원 입니다",
    "금액 1,234,567,890,123원",
    "수치 1234567890.12 입니다",
    "pi 3.141592653589 근사",
    "접수일 2024-11-12, 20241112, 2024.11.12 09:30, 20241112093000",
    "우편번호 06236, 수량 10,000개, 12345 개, 시각 12:30",
    "서버 192.168.0.1 버전 1.2.3",
    "주문 ORD-2024-0001 / A1234567890 / ABC_1234567890",
    "[Web발신] 5톤 냉동 내일 8시",
    "주문 2건이 아직 배차되지 않았습니다",
    "",
  ];
  it.each(keep)("%s", (s) => {
    const r = ok(maskFreeText(s));
    expect(r.text).toBe(s);
    expect(r.maskedKinds).toEqual([]);
  });
  it("금액 문장 안에 전화가 섞여도 금액은 그대로", () => {
    expect(t("운임 1,500,000원 / 010-0000-1234 로 연락")).toBe("운임 1,500,000원 / [전화] 로 연락");
  });
  it("board 계약의 clean 벡터는 모두 불변", () => {
    for (const s of pii.clean as string[]) expect(t(s), s).toBe(s);
  });
});

describe("전화·주민·카드·계좌 가림", () => {
  it.each([
    ["010-0000-1234"],
    ["01000001234"],
    ["010 0000 1234"],
    ["010.0000.1234"],
    ["+82 10-0000-1234"],
    ["82-10-0000-1234"],
    ["02-123-4567"],
    ["(02)123-4567"],
    ["031-123-4567"],
    ["070-1234-5678"],
  ])("전화 %s", (v) => {
    const r = ok(maskFreeText(`연락처 ${v} 입니다`));
    expect(r.text).toBe("연락처 [전화] 입니다");
    expect(r.maskedKinds).toEqual(["PHONE"]);
    expect(r.counts).toEqual({ PHONE: 1 });
  });
  it("대표번호는 구분자나 단서가 있을 때만", () => {
    expect(t("대표 1588-1234 입니다")).toBe("대표 [전화] 입니다");
    expect(t("전화 15881234")).toBe("전화 [전화]");
    expect(t("A15001234")).toBe("A15001234");
    expect(t("15881234원")).toBe("15881234원");
  });
  it.each([[RRN], ["9001011234567"], ["900101 1234567"], ["900101~1234567"], ["900101-5234567"]])("주민번호 %s", (v) => {
    const r = ok(maskFreeText(`번호 ${v} 끝`));
    expect(r.text).toBe("번호 [주민번호] 끝");
    expect(r.maskedKinds).toEqual(["RESIDENT_ID"]);
  });
  it("카드: 묶음·Amex·구분 없는 Luhn 통과분", () => {
    expect(t(`카드 ${CARD16_G} 결제`)).toBe("카드 [카드] 결제");
    expect(t(`카드 ${AMEX15_G} 결제`)).toBe("카드 [카드] 결제");
    expect(t(`카드 ${CARD16} 결제`)).toBe("카드 [카드] 결제");
  });
  it("Luhn 불통과 16자리는 카드가 아니라 계좌로 가린다", () => {
    const bad = CARD16.slice(0, 15) + String((Number(CARD16[15]) + 1) % 10);
    const r = ok(maskFreeText(`번호 ${bad}`));
    expect(r.text).toBe("번호 [계좌]");
    expect(r.maskedKinds).toEqual(["ACCOUNT"]);
  });
  it.each([["110-123-456789"], ["1002-123-456789"], ["1234567890"], ["123456789012"], ["1234567890123"], ["12345678901234567"]])("계좌 %s", (v) => {
    expect(t(`입금 ${v} 확인`)).toBe("입금 [계좌] 확인");
  });
  it("여러 종류가 섞이면 종류 목록은 고정 순서·건수는 종류별", () => {
    const r = ok(maskFreeText(`계좌 110-123-456789, 전화 010-0000-1234, 010-0000-5678, 주민 ${RRN}`));
    expect(r.text).toBe("계좌 [계좌], 전화 [전화], [전화], 주민 [주민번호]");
    expect(r.maskedKinds).toEqual(["RESIDENT_ID", "PHONE", "ACCOUNT"]);
    expect(r.counts).toEqual({ RESIDENT_ID: 1, PHONE: 2, ACCOUNT: 1 });
  });
  it("board 계약의 flagged 벡터는 이메일을 켜면 모두 변한다", () => {
    for (const [s] of pii.flagged as [string, string[]][]) {
      const r = ok(maskFreeText(s, { extraKinds: ["EMAIL"] }));
      expect(r.text, s).not.toBe(s);
    }
  });
});

describe("변형 우회 (유니코드 구분자·전각·비ASCII 숫자·제로폭·공백)", () => {
  const variants: Array<[string, string]> = [
    ["전각", "０１０－０００　０－１２３４".replace("　", "")],
    ["유니코드 하이픈", "010‐0000‐1234"],
    ["en 대시", "010–0000–1234"],
    ["em 대시", "010—0000—1234"],
    ["수학 빼기", "010−0000−1234"],
    ["가운뎃점", "010·0000·1234"],
    ["대시 주변 공백", "010 – 0000 – 1234"],
    ["아랍-인도 숫자", "٠١٠-٠٠٠٠-١٢٣٤"],
    ["제로폭·단어결합자", "010​-0000⁠-1234"],
    ["소프트 하이픈", "010­0000­1234"],
    ["줄바꿈 섞임", "010 0000\n1234"],
  ];
  it.each(variants)("전화 변형: %s", (_n, v) => {
    expect(t(`연락 ${v} 끝`)).toBe("연락 [전화] 끝");
  });
  it("주민·계좌 변형", () => {
    expect(t("９００１０１－１２３４５６７")).toBe("[주민번호]");
    expect(t("900101−1234567")).toBe("[주민번호]");
    expect(t("110–123–456789")).toBe("[계좌]");
  });
  it("변형 글자가 잔여물로 남지 않는다(가린 구간은 변형 글자 전체)", () => {
    const out = t("앞 010​–0000⁠–1234 뒤");
    expect(out).toBe("앞 [전화] 뒤");
    expect(out).not.toMatch(/[​⁠–]/);
  });
  it("가려지지 않는 문장 속 글자는 입력 그대로(정규화본이 아님)", () => {
    const s = "ＡＢＣ ㈜테스트 — ① 항목 ٣ 번";
    expect(t(s)).toBe(s);
    expect(t(`ＡＢＣ ㈜테스트 010-0000-1234`)).toBe("ＡＢＣ ㈜테스트 [전화]");
    expect(t("㈜테스트 ① 010-0000-1234 끝 ＺＺ")).toBe("㈜테스트 ① [전화] 끝 ＺＺ");
  });
  it("대응표 정규화는 숫자·구분자에 대해 normalizeText 와 같다", () => {
    for (const s of ["010–0000–1234", "٠١٠-١٢٣٤", "１２３ ４５６", "12 − 34", "no digits here", "9·9·9"]) {
      expect(normalizeWithMap(s).text, s).toBe(normalizeText(s));
    }
  });
});

describe("숫자 단서 면제 (주문번호·운송장 등)", () => {
  it("구분 없는 긴 숫자만 면제하고 경고(LONG_DIGITS)로 건수를 남긴다", () => {
    for (const s of ["송장 123456789012", "운송장번호: 123456789012", "주문번호 1234567890123", "접수번호#123456789012"]) {
      const r = ok(maskFreeText(s));
      expect(r.text, s).toBe(s);
      expect(r.warnings, s).toEqual([{ code: "LONG_DIGITS", count: 1 }]);
    }
  });
  it("영문 접두 코드도 면제", () => {
    const r = ok(maskFreeText("코드 A1234567890 확인"));
    expect(r.text).toBe("코드 A1234567890 확인");
    expect(r.warnings).toEqual([{ code: "LONG_DIGITS", count: 1 }]);
  });
  it("단서가 있어도 Luhn 카드·하이픈 계좌·주민번호·전화는 가린다", () => {
    expect(t(`주문번호 ${CARD16}`)).toBe("주문번호 [카드]");
    expect(t("송장 110-123-456789")).toBe("송장 [계좌]");
    expect(t(`접수번호 ${RRN}`)).toBe("접수번호 [주민번호]");
    expect(t("운송장 010-0000-1234")).toBe("운송장 [전화]");
  });
  it("단서 없는 긴 숫자는 가린다(과가림 허용)", () => {
    expect(t("재고 123456789012 개")).toBe("재고 [계좌] 개");
  });
  it("앱이 단서어를 더할 수 있다", () => {
    expect(ok(maskFreeText("관리코드 123456789012", { numberCueExemptions: ["관리코드"] })).text).toBe("관리코드 123456789012");
  });
});

describe("사업자번호·이메일·비밀 모양 (옵션)", () => {
  it("기본: 검증식 통과 사업자번호는 계좌로 오가림하지 않고 그대로", () => {
    expect(t(`사업자 ${BIZ_F}`)).toBe(`사업자 ${BIZ_F}`);
  });
  it("켜면 가린다", () => {
    expect(ok(maskFreeText(`사업자 ${BIZ_F}`, { extraKinds: ["BIZNO"] })).text).toBe("사업자 [사업자번호]");
  });
  it("검증식 불통과 3-2-5 는 계좌 후보로 가린다", () => {
    const bad = BIZ.slice(0, 9) + String((Number(BIZ[9]) + 1) % 10);
    expect(t(`번호 ${bad.slice(0, 3)}-${bad.slice(3, 5)}-${bad.slice(5)}`)).toBe("번호 [계좌]");
  });
  it("이메일은 기본 꺼짐, 켜면 가림", () => {
    expect(t("메일 test.user@example.invalid 입니다")).toBe("메일 test.user@example.invalid 입니다");
    expect(ok(maskFreeText("메일 test.user@example.invalid 입니다", { extraKinds: ["EMAIL"] })).text).toBe("메일 [이메일] 입니다");
  });
  it("이메일 안의 숫자열은 계좌로 따로 가리지 않는다", () => {
    const r = ok(maskFreeText("메일 user1234567890123@example.invalid", { extraKinds: ["EMAIL"] }));
    expect(r.text).toBe("메일 [이메일]");
    expect(r.counts).toEqual({ EMAIL: 1 });
  });
  it("비밀 모양(합성)은 켜면 가림", () => {
    const fake = "sk-" + "A1b2C3d4".repeat(5);
    const r = ok(maskFreeText(`키 ${fake} 입니다`, { extraKinds: ["SECRET_LIKE"] }));
    expect(r.text).not.toContain(fake.slice(5));
  });
});

describe("이름·주소·한글 숫자는 경고만 (가리지 않음)", () => {
  it("이름 단서어 뒤 후보: 텍스트 불변 + NAME_CUE", () => {
    for (const s of ["성함 홍길동 입니다", "고객명: 김철수", "신청자 이영희", "받는분 박민수 님께"]) {
      const r = ok(maskFreeText(s));
      expect(r.text, s).toBe(s);
      expect(r.warnings, s).toEqual([{ code: "NAME_CUE", count: 1 }]);
    }
  });
  it("업무어가 뒤따르거나 호칭만 있으면 경고 없음", () => {
    for (const s of ["이름 변경 요청", "고객명 확인 부탁", "홍길동님 안녕하세요", "고객님 안녕하세요"]) {
      expect(ok(maskFreeText(s)).warnings, s).toEqual([]);
    }
  });
  it("호칭 앞 이름 경고는 옵션", () => {
    expect(ok(maskFreeText("홍길동님 안녕하세요", { nameTitleWarnings: true })).warnings).toEqual([{ code: "NAME_CUE", count: 1 }]);
  });
  it("앱 단서어 추가", () => {
    expect(ok(maskFreeText("인수 라마바 도착", { extraNameCues: ["인수"] })).warnings).toEqual([{ code: "NAME_CUE", count: 1 }]);
  });
  it("주소 단서: 텍스트 불변 + ADDRESS_CUE", () => {
    const s = "배송지는 서울시 강남구 역삼동 입니다. 상세주소: 12동 304호";
    const r = ok(maskFreeText(s));
    expect(r.text).toBe(s);
    expect(r.warnings).toEqual([{ code: "ADDRESS_CUE", count: 2 }]);
    expect(ok(maskFreeText("납품처 확인", { extraAddressCues: ["납품처"] })).warnings).toEqual([{ code: "ADDRESS_CUE", count: 1 }]);
  });
  it("한글로 풀어 쓴 숫자는 가리지 않고 경고", () => {
    const s = "공일공 일이삼사 오육칠팔 입니다";
    const r = ok(maskFreeText(s));
    expect(r.text).toBe(s);
    expect(r.warnings).toEqual([{ code: "SPELLED_DIGITS", count: 1 }]);
  });
  it("가림과 경고가 함께 나온다", () => {
    const r = ok(maskFreeText("성함 홍길동 010-0000-1234"));
    expect(r.text).toBe("성함 홍길동 [전화]");
    expect(r.warnings).toEqual([{ code: "NAME_CUE", count: 1 }]);
  });
});

describe("길이·유니코드·멱등·성능", () => {
  it("상한 이하는 통과, 초과는 저장 거부(원문 미반환)", () => {
    expect(maskFreeText("가".repeat(FREE_TEXT_MAX_CHARS)).ok).toBe(true);
    const long = "비밀가나다".repeat(5000) + "!";
    const r = maskFreeText(long);
    expect(r).toEqual({ ok: false, reason: "TOO_LONG", rulesVersion: FREE_TEXT_RULES_VERSION });
    expect(JSON.stringify(r)).not.toContain("비밀가나다");
  });
  it("앱은 상한을 줄일 수만 있다", () => {
    expect(maskFreeText("12345678901", { maxChars: 10 })).toMatchObject({ ok: false, reason: "TOO_LONG" });
    expect(maskFreeText("가".repeat(FREE_TEXT_MAX_CHARS + 1), { maxChars: 999999 })).toMatchObject({ ok: false, reason: "TOO_LONG" });
  });
  it("긴 문장 속 번호도 가린다", () => {
    const filler = "가나다라 마바사 ".repeat(1000);
    const out = t(`${filler}010-0000-1234${filler}`);
    expect(out).toBe(`${filler}[전화]${filler}`);
  });
  it("이모지(서로게이트 쌍)·결합 문자 사이에서도 주변 글자가 손상되지 않는다", () => {
    expect(t("한글😀010-0000-1234😀끝")).toBe("한글😀[전화]😀끝");
    expect(t("é 010-0000-1234 é")).toBe("é [전화] é");
    expect(t("👨‍👩‍👧 110-123-456789")).toBe("👨‍👩‍👧 [계좌]");
  });
  it("멱등: 이미 가린 결과를 다시 가려도 변하지 않는다", () => {
    for (const s of [`전화 010-0000-1234 계좌 110-123-456789 ${RRN}`, "금액 1,234,567원", "성함 홍길동", "한글😀010-0000-1234"]) {
      const first = ok(maskFreeText(s));
      const second = ok(maskFreeText(first.text));
      expect(second.text, s).toBe(first.text);
      expect(second.maskedKinds, s).toEqual([]);
    }
  });
  it("겹침: 인접한 서로 다른 번호는 각각 가려진다", () => {
    expect(t("010-0000-1234 110-123-456789")).toBe("[전화] [계좌]");
  });
  it("병리적 입력이 빠르게 끝난다", () => {
    const inputs = ["-".repeat(19000), "0".repeat(19000), "1 ".repeat(9000), "010-".repeat(4500), "–".repeat(19000), "9·".repeat(9000), ("가".repeat(50) + " ").repeat(380)];
    const t0 = Date.now();
    for (const s of inputs) expect(maskFreeText(s).ok === true || maskFreeText(s).ok === false).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("감사 메타와 실패 시 안전", () => {
  it("결과 메타에 값·위치·길이가 없다", () => {
    const r = ok(maskFreeText("성함 홍길동 010-0000-1234 / 110-123-456789"));
    const meta = JSON.stringify({ k: r.maskedKinds, c: r.counts, w: r.warnings, v: r.rulesVersion });
    for (const leak of ["홍길동", "0000", "123-456789", "1234"]) expect(meta).not.toContain(leak);
  });
  it("null/undefined 는 빈 문자열, 문자열이 아니면 NOT_TEXT", () => {
    expect(ok(maskFreeText(null)).text).toBe("");
    expect(ok(maskFreeText(undefined)).text).toBe("");
    for (const bad of [5, {}, [], true, Symbol("x"), () => 1]) {
      expect(maskFreeText(bad as unknown as string)).toMatchObject({ ok: false, reason: "NOT_TEXT" });
    }
  });
  it("실패 결과에 입력이 들어 있지 않다", () => {
    const r = maskFreeText({ secret: "CANARY-0001" } as unknown as string);
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  it("결과는 얼려 있다", () => {
    const r = ok(maskFreeText("010-0000-1234"));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.maskedKinds)).toBe(true);
  });
  it("규칙 버전 상수", () => {
    expect(ok(maskFreeText("a")).rulesVersion).toBe("free-text-rules/1");
  });
});

describe("정책 검증과 사후 변경", () => {
  it("잘못된 정책은 INVALID_POLICY", () => {
    const bads: unknown[] = [
      { extraKinds: ["PHONE"] },
      { extraKinds: "EMAIL" },
      { policyId: "Bad Id" },
      { maxChars: 0 },
      { maxChars: 1.5 },
      { extraNameCues: Array.from({ length: 51 }, (_, i) => `단서${i}`) },
      { extraNameCues: ["가".repeat(21)] },
      { extraAddressCues: [5] },
      { nameTitleWarnings: "yes" },
      [],
      "x",
    ];
    for (const b of bads) {
      expect(createFreeTextMasker(b as never), JSON.stringify(b)).toEqual({ ok: false, reason: "INVALID_POLICY" });
      expect(maskFreeText("a", b as never), JSON.stringify(b)).toMatchObject({ ok: false, reason: "INVALID_POLICY" });
    }
  });
  it("정규식 메타문자가 든 단서어도 안전하게 쓰인다", () => {
    const r = maskFreeText("(주소) 확인 .*", { extraAddressCues: ["(주소)", ".*"], extraNameCues: ["a+b"] });
    expect(r.ok).toBe(true);
  });
  it("마스커를 만든 뒤 정책 객체를 바꿔도 달라지지 않는다", () => {
    const policy = { extraKinds: ["EMAIL"] as Array<"EMAIL" | "BIZNO">, extraNameCues: ["인수"] } as { extraKinds: Array<"EMAIL" | "BIZNO">; extraNameCues: string[] };
    const m = createFreeTextMasker(policy);
    if (!m.ok) throw new Error("setup");
    const before = ok(m.mask("메일 a@b.example 성함 홍길동 인수 라마바"));
    policy.extraKinds.length = 0;
    policy.extraKinds.push("BIZNO");
    policy.extraNameCues.length = 0;
    const after = ok(m.mask("메일 a@b.example 성함 홍길동 인수 라마바"));
    expect(after).toEqual(before);
    expect(after.maskedKinds).toEqual(["EMAIL"]);
  });
  it("기본 4종은 끌 수 없다(옵션에 끄는 항목이 없다)", () => {
    expect(ok(maskFreeText("010-0000-1234", {})).text).toBe("[전화]");
  });
});

describe("퍼징: 변형 조합", () => {
  const seps = ["-", " ", ".", "‐", "–", "—", "−", "·", "", "－"];
  const pads = ["", "​", "⁠", "­"];
  it("전화번호 변형 조합은 항상 가려지고 금액 문장은 그대로", () => {
    let n = 0;
    for (const a of seps) {
      for (const b of seps) {
        for (const pad of pads) {
          const phone = `010${pad}${a}0000${pad}${b}1234`;
          const out = t(`금액 1,234,567원 연락 ${phone} 끝`);
          expect(out, JSON.stringify(phone)).toBe("금액 1,234,567원 연락 [전화] 끝");
          n++;
        }
      }
    }
    expect(n).toBe(seps.length * seps.length * pads.length);
  });
});
