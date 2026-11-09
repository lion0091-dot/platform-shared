import { describe, expect, it } from "vitest";
import pii from "../board/__vectors__/pii.json";
import {
  GUARD_KINDS,
  GUARD_REASONS,
  guard,
  isSafePayload,
  reasonCodes,
  type GuardPolicy,
  type GuardResult,
} from "./index";

// ── 시험 보조: 모든 값은 가짜. 번호는 시험 안에서 만든다(미배정 대역·체크섬 계산). ──
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
  for (let i = 0; i < 9; i++) sum += Number(first9[i]) * w[i];
  sum += Math.floor((Number(first9[8]) * 5) / 10);
  return first9 + String((10 - (sum % 10)) % 10);
}

const base: GuardPolicy = {
  policyId: "test.v1",
  level: "STANDARD",
  maxCharsPerField: 2000,
  maxCharsTotal: 4000,
  maxReplacements: 50,
  restoreKinds: [],
};
const p = (over: Partial<GuardPolicy> = {}): GuardPolicy => ({ ...base, ...over });

function sent(r: GuardResult): string {
  if (!r.ok) throw new Error("expected ok");
  return JSON.stringify(r.payload.value);
}
function okText(r: GuardResult): string {
  if (!r.ok) throw new Error("expected ok, got " + r.reason);
  if (typeof r.payload.value !== "string") throw new Error("expected string payload");
  return r.payload.value;
}

const RRN = "900101-1234567";
const PHONE = "010-0000-1234";
const EMAIL = "canary.user@example.invalid";
const CARD = luhnComplete("999900001111", 16);
const BIZ = biznoComplete("000123456");
const ACCT_PLAIN = "1234567890123";
const ACCT_HYPH = "110-123-456789";

describe("패턴 검사·치환", () => {
  it("종류별로 가리고 원문 조각이 전송본에 없다", () => {
    const text = `주민 ${RRN} 전화 ${PHONE} 메일 ${EMAIL} 카드 ${CARD} 사업자 ${BIZ} 계좌 ${ACCT_HYPH} 끝`;
    const r = guard(text, p());
    const out = okText(r);
    for (const c of [RRN, PHONE, EMAIL, CARD, BIZ, ACCT_HYPH, "1234567", "canary.user"]) expect(out).not.toContain(c);
    expect(out).toMatch(/\[RRN_1\]/);
    expect(out).toMatch(/\[PHONE_1\]/);
    expect(out).toMatch(/\[EMAIL_1\]/);
    expect(out).toMatch(/\[CARD_1\]/);
    expect(out).toMatch(/\[BIZ_1\]/);
    expect(out).toMatch(/\[ACCT_1\]/);
    if (r.ok) {
      expect(r.report.counts).toMatchObject({ RESIDENT_ID: 1, PHONE: 1, EMAIL: 1, CARD: 1, BIZNO: 1, ACCOUNT: 1 });
    }
  });

  it("같은 값은 같은 토큰, 다른 값은 번호가 늘어난다(등장 순서, 결정론)", () => {
    const a = okText(guard(`${PHONE} 그리고 ${PHONE} 그리고 010-0000-5678`, p()));
    expect(a).toBe("[PHONE_1] 그리고 [PHONE_1] 그리고 [PHONE_2]");
    expect(okText(guard(`${PHONE} 그리고 ${PHONE} 그리고 010-0000-5678`, p()))).toBe(a);
  });

  it("구분자·전각·제로폭 변형도 잡는다(변형 퍼징)", () => {
    const variants = [
      "010 0000 1234",
      "010.0000.1234",
      "01000001234",
      "０１０－０００　０－１２３４".replace("　", ""),
      "010​-0000-‌1234",
      "+82 10-0000-1234",
      "82-10-0000-1234",
      "(02)123-4567",
      "02-123-4567",
      "1588-1234",
    ];
    for (const v of variants) {
      const out = okText(guard(`연락 ${v} 부탁`, p()));
      expect(out, v).toMatch(/\[PHONE_1\]/);
      expect(out, v).not.toMatch(/\d{4}/);
    }
    const rrnVars = [RRN, "9001011234567", "900101 1234567", "900101-1234567".replace("-", "~"), "９００１０１－１２３４５６７"];
    for (const v of rrnVars) expect(okText(guard(`번호 ${v}`, p())), v).toMatch(/\[RRN_1\]/);
  });

  it("이음 maskSensitive 이식(종류 단위): 하이픈 없는 10~16자리 계좌", () => {
    for (const n of ["1234567890", "123456789012", ACCT_PLAIN, "1234567890123456"]) {
      const r = guard(`입금 ${n} 확인`, p());
      expect(okText(r), n).not.toContain(n);
      expect(okText(r), n).toMatch(/\[(ACCT|BIZ|CARD)_1\]/);
    }
    expect(okText(guard(`계좌 ${ACCT_HYPH}`, p()))).toMatch(/\[ACCT_1\]/);
    expect(okText(guard("계좌 1002-123-456789", p()))).toMatch(/\[ACCT_1\]/);
  });

  it("이음 maskSensitive 이식: 날짜·금액·수량은 가리지 않는다(오탐 제외)", () => {
    const keep = [
      "접수일 20261109123045 처리",
      "접수일 2026-11-09 처리",
      "금액 150000000000원 입니다",
      "금액 1,234,567,890,123원",
      "금액 150,000원",
      "수치 1234567890.12 입니다",
      "수량 12345 개",
      "버전 1.2.3 에서 오류",
      "운임 15만원 상차 8시",
    ];
    for (const t of keep) expect(okText(guard(t, p())), t).toBe(t);
  });

  it("board pii.json 상위집합: flagged 는 모두 걸리고 clean 은 모두 통과", () => {
    for (const [text] of pii.flagged as [string, string[]][]) {
      const r = guard(text, p());
      const out = okText(r);
      expect(out, text).not.toBe(text);
    }
    for (const text of pii.clean as string[]) {
      expect(okText(guard(text, p())), text).toBe(text);
    }
  });

  it("체크섬이 틀린 사업자번호 모양은 사업자번호로 보지 않지만 계좌 모양이면 가린다", () => {
    const bad = BIZ.slice(0, 9) + String((Number(BIZ[9]) + 1) % 10);
    const out = okText(guard(`번호 ${bad.slice(0, 3)}-${bad.slice(3, 5)}-${bad.slice(5)}`, p()));
    expect(out).not.toContain(bad.slice(5));
  });

  it("[Web발신] 같은 일반 대괄호는 건드리지 않는다", () => {
    expect(okText(guard("[Web발신] 5톤 냉동 내일 8시", p()))).toBe("[Web발신] 5톤 냉동 내일 8시");
  });

  it("종류·이유 상수와 reasonCodes", () => {
    expect(GUARD_KINDS).toContain("PHONE");
    expect(GUARD_REASONS).toContain("RESIDUAL_PII");
    const blocked = guard(`키 sk-ant-${"a1b2c3d4".repeat(5)}`, p());
    expect(blocked.ok).toBe(false);
    expect(reasonCodes(blocked)).toEqual(["SECRET_LIKE:SECRET_LIKE"]);
    expect(reasonCodes(guard("안녕", p()))).toEqual([]);
  });
});

describe("이름·상호 표지와 수준(level)", () => {
  const text = "받는분 가나다 연락. 가나다상사(주) 로 보내 주세요.";

  it("STANDARD 는 의심 스팬을 가린다", () => {
    const out = okText(guard(text, p({ level: "STANDARD" })));
    expect(out).not.toContain("가나다 ");
    expect(out).toMatch(/\[PERSON_1\]/);
    expect(out).toMatch(/\[ORG_1\]/);
  });

  it("STRICT 는 의심이 있으면 호출을 막는다", () => {
    const r = guard(text, p({ level: "STRICT" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("RESIDUAL_PII");
      expect(r.kinds).toEqual(expect.arrayContaining(["PERSON", "ORG"]));
    }
    expect(JSON.stringify(r)).not.toContain("가나다");
  });

  it("호칭 앞 이름과 법인격 표지", () => {
    expect(okText(guard("가나다 사장님께 전달", p()))).toMatch(/\[PERSON_1\]/);
    expect(okText(guard("(주)테스트가나다 입니다", p()))).toMatch(/\[ORG_1\]/);
    expect(okText(guard("테스트가나다㈜ 입니다", p()))).toMatch(/\[ORG_1\]/);
    expect(okText(guard("주식회사 라마바 입니다", p()))).toMatch(/\[ORG_1\]/);
  });

  it("호칭 단독·일반 단어는 이름으로 보지 않는다", () => {
    expect(okText(guard("고객님 안녕하세요", p()))).toBe("고객님 안녕하세요");
  });

  it("extraOrgMarkers·extraPersonCues 로 도메인 표지를 더한다", () => {
    expect(okText(guard("가나다냉동 도착", p()))).toBe("가나다냉동 도착");
    expect(okText(guard("가나다냉동 도착", p({ extraOrgMarkers: ["냉동"] })))).toMatch(/\[ORG_1\]/);
    expect(okText(guard("인수 라마바 도착", p({ extraPersonCues: ["인수"] })))).toMatch(/\[PERSON_1\]/);
  });
});

describe("알려진 용어 사전(knownTerms)", () => {
  const terms = [
    { kind: "ORG" as const, value: "라마바식품", alias: ["라마바 푸드"] },
    { kind: "PERSON" as const, value: "테스트가나다" },
  ];

  it("정확 일치(정규화·대소문자·별칭)로 치환한다", () => {
    const r = guard("라마바식품 과 라마바 푸드 그리고 테스트가나다", p({ knownTerms: terms }));
    expect(okText(r)).toBe("[ORG_1] 과 [ORG_1] 그리고 [PERSON_1]");
  });

  it("너무 짧은 항목은 정책 오류", () => {
    const r = guard("가 나", p({ knownTerms: [{ kind: "ORG", value: "가" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("INVALID_POLICY");
  });
});

describe("kinds: MASK / BLOCK / PASS / OFF", () => {
  it("PASS 는 그대로 보내되 리포트에 집계한다", () => {
    const r = guard(`전화 ${PHONE}`, p({ kinds: { PHONE: "PASS" } }));
    expect(okText(r)).toContain(PHONE);
    if (r.ok) {
      expect(r.report.passed).toMatchObject({ PHONE: 1 });
      expect(r.report.counts.PHONE ?? 0).toBe(0);
    }
  });

  it("OFF 는 탐지하지 않는다(집계도 없다)", () => {
    const r = guard(`전화 ${PHONE}`, p({ kinds: { PHONE: "OFF" } }));
    expect(okText(r)).toContain(PHONE);
    if (r.ok) expect(r.report.passed ?? {}).toEqual({});
  });

  it("BLOCK 은 호출을 막고 종류만 알린다", () => {
    const r = guard(`전화 ${PHONE}`, p({ kinds: { PHONE: "BLOCK" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("RESIDUAL_PII");
      expect(r.kinds).toEqual(["PHONE"]);
    }
    expect(reasonCodes(r)).toEqual(["RESIDUAL_PII:PHONE"]);
    expect(JSON.stringify(r)).not.toContain("0000");
  });

  it("하드 금지 종류는 PASS·OFF 불가", () => {
    for (const k of ["RESIDENT_ID", "CARD", "ACCOUNT", "SECRET_LIKE"] as const) {
      for (const m of ["PASS", "OFF"] as const) {
        const r = guard("안녕", p({ kinds: { [k]: m } }));
        expect(r.ok, `${k}:${m}`).toBe(false);
        if (!r.ok) expect(r.reason).toBe("INVALID_POLICY");
      }
    }
  });

  it("PLATE 는 기본 OFF, 켜면 가린다", () => {
    expect(okText(guard("차량 12가3456 도착", p()))).toBe("차량 12가3456 도착");
    expect(okText(guard("차량 12가3456 도착", p({ kinds: { PLATE: "MASK" } })))).toMatch(/\[PLATE_1\]/);
  });
});

describe("복원(restore)", () => {
  it("restoreKinds 에 있는 종류만 복원하고 나머지는 토큰 그대로 둔다", () => {
    const r = guard(`전화 ${PHONE} 메일 ${EMAIL}`, p({ restoreKinds: ["EMAIL"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = r.restore("연락 [PHONE_1] / [EMAIL_1]");
    expect(back.text).toBe(`연락 [PHONE_1] / ${EMAIL}`);
    expect(back.unrestoredTokens).toEqual(["[PHONE_1]"]);
    expect(back.unknownTokens).toEqual([]);
  });

  it("모델이 만든 모르는 토큰은 복원하지 않고 알린다", () => {
    const r = guard(`전화 ${PHONE}`, p({ restoreKinds: ["PHONE"] }));
    if (!r.ok) throw new Error("ok expected");
    const back = r.restore("[PHONE_1] [PHONE_9] [ORG_3]");
    expect(back.text).toBe(`${PHONE} [PHONE_9] [ORG_3]`);
    expect(back.unknownTokens).toEqual(["[PHONE_9]", "[ORG_3]"]);
  });

  it("하드 금지 종류는 restoreKinds 에 넣을 수 없다", () => {
    for (const k of ["RESIDENT_ID", "CARD", "ACCOUNT", "SECRET_LIKE"] as const) {
      const r = guard("안녕", p({ restoreKinds: [k] }));
      expect(r.ok, k).toBe(false);
      if (!r.ok) expect(r.reason).toBe("INVALID_POLICY");
    }
  });

  it("restoreKinds 는 필수", () => {
    const bad = { ...base } as Record<string, unknown>;
    delete bad.restoreKinds;
    const r = guard("안녕", bad as unknown as GuardPolicy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("INVALID_POLICY");
  });

  it("복원 맵은 직렬화로 새지 않는다", () => {
    const r = guard(`전화 ${PHONE}`, p({ restoreKinds: ["PHONE"] }));
    expect(JSON.stringify(r)).not.toContain("0000");
    expect(JSON.stringify(r)).not.toContain("1234");
  });
});

describe("토큰 모양 충돌", () => {
  it("ESCAPE(기본): 입력의 토큰 모양을 무력화해 위조 복원을 막는다", () => {
    const r = guard(`전화 ${PHONE} 그리고 [PHONE_1] 위조`, p({ restoreKinds: ["PHONE"] }));
    if (!r.ok) throw new Error("ok expected");
    const out = r.payload.value as string;
    expect(out.match(/\[PHONE_1\]/g)?.length).toBe(1);
    const back = r.restore(out);
    expect(back.text).toContain(PHONE);
    expect(back.text.match(new RegExp(PHONE, "g"))?.length).toBe(1);
  });

  it("BLOCK: TOKEN_COLLISION", () => {
    const r = guard("앞 [ORG_1] 뒤", p({ onCollision: "BLOCK" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("TOKEN_COLLISION");
  });
});

describe("앱 감지기(extraDetectors)", () => {
  const addr = "서울 강남구 대치동 123-4 가나다빌딩 3층";
  const detail = (t: string) => {
    const i = t.indexOf("대치동");
    return i < 0 ? [] : [{ kind: "ADDRESS" as const, start: i, end: t.length }];
  };

  it("앱이 알려 준 스팬을 치환하고 복원 종류를 제한한다", () => {
    const r = guard(`상차 ${addr} 하차 부산`, p({ extraDetectors: [(t) => detail(t).map((s) => ({ ...s, end: t.indexOf(" 하차") }))], restoreKinds: ["ADDRESS"] }));
    if (!r.ok) throw new Error("ok expected: " + (r as { reason: string }).reason);
    const out = r.payload.value as string;
    expect(out).toBe("상차 서울 강남구 [ADDR_1] 하차 부산");
    expect(r.restore("상차: [ADDR_1]").text).toBe("상차: 대치동 123-4 가나다빌딩 3층");
  });

  it("감지기 예외·잘못된 스팬은 DETECTOR_FAILED", () => {
    const bads = [
      () => {
        throw new Error("boom");
      },
      () => [{ kind: "ADDRESS" as const, start: -1, end: 3 }],
      () => [{ kind: "ADDRESS" as const, start: 5, end: 5 }],
      () => [{ kind: "ADDRESS" as const, start: 0, end: 9999 }],
      () => [{ kind: "NOPE" as never, start: 0, end: 2 }],
      () => [{ kind: "ADDRESS" as const, start: 0.5, end: 2 }],
      () => "x" as never,
    ];
    for (const d of bads) {
      const r = guard("안녕하세요 반갑습니다", p({ extraDetectors: [d] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("DETECTOR_FAILED");
    }
  });

  it("감지기는 코드 스팬을 약화시킬 수 없다(겹치면 합집합)", () => {
    const text = `주소 대치동 123-4 전화 ${PHONE} 끝`;
    const r = guard(text, p({ extraDetectors: [(t) => (t.includes("대치동") ? [{ kind: "ADDRESS" as const, start: t.indexOf("대치동"), end: t.indexOf(" 끝") }] : [])] }));
    const out = okText(r);
    expect(out).not.toContain("0000");
    expect(out).not.toContain("대치동");
  });
});

describe("구조화 입력(fields)·unknownKeys", () => {
  const policy = p({
    fields: {
      "memo": { type: "text" },
      "bucket": { type: "enum", values: ["LT_10K", "10K_100K"] },
      "amount": { type: "number", min: 0, max: 1000, integer: true },
      "flag": { type: "boolean" },
      "items[].name": { type: "text" },
      "shipper.label": { type: "text" },
    },
    unknownKeys: "DROP",
  });

  it("허용 경로만 보내고 나머지는 버리며 이름은 기록하지 않는다", () => {
    const r = guard(
      {
        memo: `전화 ${PHONE}`,
        bucket: "LT_10K",
        amount: 5,
        flag: true,
        items: [{ name: "가나다 상품", secret: EMAIL }, { name: "라마바" }],
        shipper: { label: "A", id: "x" },
        "홍길동-헤더": "비밀값",
      },
      policy,
    );
    if (!r.ok) throw new Error("ok expected: " + (r as { reason: string }).reason);
    const v = r.payload.value as Record<string, unknown>;
    expect(v).toEqual({
      memo: "전화 [PHONE_1]",
      bucket: "LT_10K",
      amount: 5,
      flag: true,
      items: [{ name: "가나다 상품" }, { name: "라마바" }],
      shipper: { label: "A" },
    });
    expect(r.report.droppedCount).toBe(3);
    expect(JSON.stringify(r.report)).not.toContain("홍길동");
    expect(JSON.stringify(r.report)).not.toContain("secret");
    expect(sent(r)).not.toContain(EMAIL);
  });

  it("unknownKeys 기본값은 BLOCK(UNKNOWN_FIELD)", () => {
    const r = guard({ memo: "a", extra: "b" }, { ...policy, unknownKeys: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("UNKNOWN_FIELD");
    expect(JSON.stringify(r)).not.toContain("extra");
  });

  it("enum·number·boolean 위반은 SCHEMA_VIOLATION", () => {
    const cases: Record<string, unknown>[] = [
      { bucket: "OTHER" },
      { bucket: 3 },
      { amount: 1.5 },
      { amount: 5000 },
      { amount: Number.NaN },
      { amount: "5" },
      { flag: "yes" },
    ];
    for (const c of cases) {
      const r = guard(c, policy);
      expect(r.ok, JSON.stringify(c)).toBe(false);
      if (!r.ok) expect(r.reason).toBe("SCHEMA_VIOLATION");
    }
  });

  it("문자열이 아닌 text 값·바이너리·함수는 NON_TEXT", () => {
    for (const v of [{ memo: 5 }, { memo: new Uint8Array(4) }, { memo: () => 1 }, { memo: Symbol("x") }, { memo: 10n }]) {
      const r = guard(v as Record<string, unknown>, policy);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(["NON_TEXT", "SCHEMA_VIOLATION"]).toContain(r.reason);
    }
    const bin = guard(new Uint8Array(4) as unknown as string, p());
    expect(bin.ok).toBe(false);
    if (!bin.ok) expect(bin.reason).toBe("NON_TEXT");
  });

  it("위험한 키(__proto__ 등)는 복사되지 않고 정책 경로로도 못 쓴다", () => {
    const evil = JSON.parse('{"memo":"a","__proto__":{"polluted":"x"},"constructor":{"prototype":{"p":1}}}');
    const r = guard(evil, policy);
    if (!r.ok) throw new Error("ok expected");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r.payload.value, "constructor")).toBe(false);
    const bad = guard({ memo: "a" }, p({ fields: { "__proto__.x": { type: "text" } } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("INVALID_POLICY");
  });

  it("순환 참조·너무 깊은 구조는 막고 예외를 던지지 않는다", () => {
    const circ: Record<string, unknown> = { memo: "a" };
    circ.self = circ;
    const r = guard(circ, policy);
    expect(r.ok).toBe(false);
    let deep: Record<string, unknown> = { memo: "a" };
    for (let i = 0; i < 50; i++) deep = { shipper: deep };
    const r2 = guard(deep, p({ fields: { "shipper.label": { type: "text" } }, unknownKeys: "DROP" }));
    expect(r2.ok).toBe(false);
  });
});

describe("fail-closed·한도·로그", () => {
  it("guard() 는 어떤 입력에도 던지지 않는다", () => {
    const weird: unknown[] = [null, undefined, 5, true, Symbol("x"), () => 1, [], [1, 2], new Date(), new Map(), { get a() { throw new Error("getter"); } }];
    for (const w of weird) {
      let r: GuardResult | undefined;
      expect(() => {
        r = guard(w as never, p({ fields: { a: { type: "text" } } }));
      }, String(w)).not.toThrow();
      expect(r!.ok).toBe(false);
    }
    expect(() => guard("안녕", null as never)).not.toThrow();
    expect(guard("안녕", null as never).ok).toBe(false);
  });

  it("길이 초과는 자르지 않고 막는다(감지기 실행 전)", () => {
    const long = "가".repeat(2001);
    const r = guard(long, p());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("OVER_LENGTH");
    const total = guard({ a: "가".repeat(1500), b: "나".repeat(1500), c: "다".repeat(1500) }, p({ fields: { a: { type: "text" }, b: { type: "text" }, c: { type: "text" } }, maxCharsTotal: 4000 }));
    expect(total.ok).toBe(false);
    if (!total.ok) expect(total.reason).toBe("OVER_LENGTH");
  });

  it("치환 수 상한 초과는 TOO_MANY_REPLACEMENTS", () => {
    const text = Array.from({ length: 6 }, (_, i) => `010-0000-${String(1000 + i)}`).join(" ");
    const r = guard(text, p({ maxReplacements: 5 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("TOO_MANY_REPLACEMENTS");
  });

  it("카나리: 실패 결과·리포트·성공 리포트에 원문이 없다", () => {
    const text = `받는분 가나다 ${PHONE} ${EMAIL} ${RRN}`;
    const canaries = ["가나다", "0000", "canary", "900101", "1234567"];
    // 실패(STRICT, 의심 이름 포함): 결과 전체에 원문 없음
    const blocked = guard(text, p({ level: "STRICT" }));
    expect(blocked.ok).toBe(false);
    for (const c of canaries) expect(JSON.stringify(blocked), `blocked:${c}`).not.toContain(c);
    // 성공(STANDARD): 전송본(payload)과 리포트 모두 원문 없음
    const okr = guard(text, p({ level: "STANDARD" }));
    if (!okr.ok) throw new Error("ok expected");
    for (const c of canaries) {
      expect(JSON.stringify(okr.payload.value), `payload:${c}`).not.toContain(c);
      expect(JSON.stringify(okr.report), `report:${c}`).not.toContain(c);
    }
  });

  it("성공 시 리포트에는 원문·키 이름이 없다", () => {
    const r = guard(`전화 ${PHONE}`, p());
    if (!r.ok) throw new Error("ok expected");
    const dump = JSON.stringify(r.report);
    expect(dump).not.toContain("0000");
    expect(dump).toContain("test.v1");
    expect(r.report.rulesVersion).toMatch(/^ai-guard-rules\/\d+$/);
  });

  it("SECRET_LIKE 합성 문자열은 항상 차단", () => {
    const fakes = [`sk-ant-${"a1b2c3d4".repeat(5)}`, `eyJ${"abcdefghij".repeat(2)}.${"abcdefghij".repeat(2)}.${"abcdefghij".repeat(2)}`, `AKIA${"ABCDEFGH12345678".slice(0, 16)}`];
    for (const f of fakes) {
      const r = guard(`참고 ${f}`, p());
      expect(r.ok, f).toBe(false);
      if (!r.ok) expect(r.reason).toBe("SECRET_LIKE");
      expect(JSON.stringify(r)).not.toContain(f.slice(0, 12));
    }
  });

  it("post-check: 치환 결과에서 앱 감지기가 새로 찾은 것이 있으면 차단", () => {
    let calls = 0;
    const r = guard("안녕하세요 반갑습니다", p({ extraDetectors: [(t) => {
      calls++;
      // 첫 호출(원문)은 아무것도 못 찾고, 두 번째(치환 결과)에서 토큰 밖 구간을 찾는 최악의 감지기
      return calls === 1 ? [] : [{ kind: "ADDRESS" as const, start: 0, end: 2 }];
    }] }));
    expect(calls).toBe(2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("RESIDUAL_PII");
      expect(r.kinds).toEqual(["ADDRESS"]);
    }
  });

  it("토큰 안쪽을 가리키는 감지기 스팬은 post-check 에서 무시한다", () => {
    const r = guard("상차 대치동 123 끝", p({ extraDetectors: [(t) => {
      const i = t.indexOf("대치동");
      if (i >= 0) return [{ kind: "ADDRESS", start: i, end: i + 7 }];
      const j = t.indexOf("[ADDR_1]");
      return j >= 0 ? [{ kind: "ADDRESS", start: j + 1, end: j + 5 }] : [];
    }] }));
    expect(okText(r)).toBe("상차 [ADDR_1] 끝");
  });
});

describe("payload 표식", () => {
  it("guard 가 만든 페이로드만 SafePayload", () => {
    const r = guard("안녕", p());
    if (!r.ok) throw new Error("ok expected");
    expect(isSafePayload(r.payload)).toBe(true);
    expect(isSafePayload({ kind: "SafePayload", value: "x" })).toBe(false);
    expect(isSafePayload(null)).toBe(false);
    expect(Object.isFrozen(r.payload)).toBe(true);
  });
});

describe("추가 경계", () => {
  it("17자리 이상 연속 숫자는 의심: STRICT 차단 / STANDARD 가림", () => {
    const long = "9".repeat(18);
    expect(guard(`번호 ${long}`, p({ level: "STRICT" })).ok).toBe(false);
    const out = okText(guard(`번호 ${long}`, p({ level: "STANDARD" })));
    expect(out).toBe("번호 [ACCT_1]");
  });

  it("PHONE OFF 여도 전화 모양이 계좌로 이중 해석되지 않는다", () => {
    expect(okText(guard(`전화 ${PHONE}`, p({ kinds: { PHONE: "OFF" } })))).toBe(`전화 ${PHONE}`);
  });

  it("이메일 안의 숫자열은 이메일로만 가린다", () => {
    const out = okText(guard("메일 a1234567890123@example.invalid 끝", p()));
    expect(out).toBe("메일 [EMAIL_1] 끝");
  });

  it("여러 필드에 걸쳐 같은 값은 같은 토큰", () => {
    const r = guard({ a: `전화 ${PHONE}`, b: `또 ${PHONE}` }, p({ fields: { a: { type: "text" }, b: { type: "text" } } }));
    if (!r.ok) throw new Error("ok expected");
    expect(r.payload.value).toEqual({ a: "전화 [PHONE_1]", b: "또 [PHONE_1]" });
  });

  it("정책 ID·리포트는 안전 문자만", () => {
    const r = guard("안녕", p({ policyId: "Bad Id!" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("INVALID_POLICY");
  });

  it("같은 정책 객체를 재사용해도 호출 간 상태가 섞이지 않는다", () => {
    const pol = p();
    const a = okText(guard(`전화 ${PHONE}`, pol));
    const b = okText(guard("전화 010-0000-5678", pol));
    expect(a).toBe("전화 [PHONE_1]");
    expect(b).toBe("전화 [PHONE_1]"); // 호출 단위 번호
  });

  it("전송본은 L1 정규화본이다(제로폭 제거·전각 반각)", () => {
    expect(okText(guard("ＡＢＣ​ 5톤", p()))).toBe("ABC 5톤");
  });
});

describe("성능·ReDoS", () => {
  const pathological = [
    "a".repeat(1999),
    "1".repeat(1999),
    "1-".repeat(999) + "1",
    "1 ".repeat(999) + "1",
    "가".repeat(1999),
    "(".repeat(1999),
    "010".repeat(600),
    "a@".repeat(990),
    "a.".repeat(990) + "@",
    "한국".repeat(990) + "님",
    "받는분 ".repeat(280),
    "[".repeat(1999),
    ("[ORG_1]").repeat(280),
  ];
  it("한도 안의 병리적 입력이 빠르게 끝난다", () => {
    for (const t of pathological) {
      const t0 = performance.now();
      const r = guard(t, p({ maxReplacements: 5000 }));
      const dt = performance.now() - t0;
      expect(dt, t.slice(0, 12)).toBeLessThan(250);
      expect(typeof r.ok).toBe("boolean");
    }
  });

  it("한도 초과 입력은 감지기를 돌리지 않고 즉시 막는다", () => {
    const t0 = performance.now();
    const r = guard("1-".repeat(500000), p());
    expect(r.ok).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("knownTerms 1만 항목도 한 번 호출이 짧다", () => {
    const terms = Array.from({ length: 10000 }, (_, i) => ({ kind: "ORG" as const, value: `시험상호${String(i).padStart(5, "0")}` }));
    const pol = p({ knownTerms: terms });
    guard("워밍업", pol);
    const t0 = performance.now();
    const r = guard("시험상호00042 그리고 시험상호09999 확인", pol);
    expect(okText(r)).toBe("[ORG_1] 그리고 [ORG_2] 확인");
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
