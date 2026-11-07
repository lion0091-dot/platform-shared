/**
 * 보안 점검(2026-11) 후속 우회 시험. 각 항목은 수정 전에는 실패하고 수정 후에 통과해야 한다.
 * 근거: docs/security-audit-2026-11.md (3-1, 3-2, 2-1, 2-2, 2-3).
 */
import { describe, expect, it } from "vitest";
import { buildSignedCall } from "./account/sign";
import { signSsoToken, ssoTarget } from "./account/sso";
import { canTransition } from "./board/access";
import { detectPii } from "./board/pii";

const SECRET = "TEST-ONLY-hardening-secret-0123456789";
const base = { system: "wholesale" as const, extUser: "u", extTenant: "t", role: "owner", name: "상호" };

describe("3-1 detectPii 선형 시간", () => {
  const adversarial: Array<[string, string]> = [
    ["영문 반복", "a".repeat(100_000)],
    ["숫자-하이픈 반복", "1-".repeat(50_000)],
    ["점 반복", "a.".repeat(50_000)],
    ["숫자 반복", "1".repeat(100_000)],
    ["공백 섞인 숫자", "12 ".repeat(40_000)],
    ["@ 반복", "a@".repeat(50_000)],
  ];

  for (const [name, text] of adversarial) {
    it(`${name} 10만 자가 1초 안에 끝난다`, () => {
      const t = Date.now();

      detectPii(text);

      expect(Date.now() - t).toBeLessThan(1000);
    });
  }

  it("긴 로컬 파트의 이메일도 여전히 잡는다(결과 불변)", () => {
    expect(detectPii(`${"a".repeat(200)}@example.com`)).toEqual(["EMAIL"]);
    expect(detectPii(`앞 글자 ${"b".repeat(5000)}@example.co.kr 뒤`)).toEqual(["EMAIL"]);
  });

  it("이메일 경계 결과가 같다", () => {
    expect(detectPii("a@b.co")).toEqual(["EMAIL"]);
    expect(detectPii("a@b")).toEqual([]);
    expect(detectPii("@b.co")).toEqual([]);
    expect(detectPii("x.y+z%w_v-u@sub.example.com")).toEqual(["EMAIL"]);
  });
});

describe("3-2 canTransition 알 수 없는 actorSide", () => {
  it("TENANT·PLATFORM 이외 값은 모든 전이를 거부한다(실패 시 닫힘)", () => {
    const bad = ["tenant", "platform", "Platform", "ADMIN", "", " PLATFORM", "PLATFORM ", undefined, null, 1] as unknown[];

    for (const side of bad) {
      expect(canTransition("RECEIVED", "DONE", side as never, true), String(side)).toBe(false);
      expect(canTransition("RECEIVED", "IN_PROGRESS", side as never), String(side)).toBe(false);
      expect(canTransition("NONE", "RECEIVED", side as never), String(side)).toBe(false);
      expect(canTransition("DONE", "RECEIVED", side as never, true), String(side)).toBe(false);
    }
  });

  it("정상 값은 그대로 동작한다", () => {
    expect(canTransition("RECEIVED", "DONE", "PLATFORM")).toBe(true);
    expect(canTransition("NONE", "RECEIVED", "TENANT")).toBe(true);
    expect(canTransition("RECEIVED", "DONE", "TENANT")).toBe(false);
  });
});

describe("2-2 buildSignedCall 예약 키 덮어쓰기", () => {
  it("fields 가 system·action·ext_tenant·jti·iat·exp 를 담으면 던진다", () => {
    for (const k of ["system", "action", "ext_tenant", "jti", "iat", "exp"]) {
      expect(() => buildSignedCall(SECRET, { system: "wholesale", action: "suspend", extTenant: "t", fields: { [k]: "x" } }), k).toThrow(/CALL_RESERVED_FIELD/);
    }
  });

  it("예약 키가 없으면 그대로 만든다", () => {
    const b = buildSignedCall(SECRET, { system: "wholesale", action: "suspend", extTenant: "t", fields: { ext_user: "u" } }, { now: 1_000_000, jti: "jti-12345678" });

    expect(JSON.parse(b.body)).toMatchObject({ system: "wholesale", action: "suspend", ext_tenant: "t", ext_user: "u" });
  });
});

describe("2-3 빈 secret·비정상 ttl/now 검증", () => {
  const call = (secret: string, deps: Parameters<typeof buildSignedCall>[2]) => buildSignedCall(secret, { system: "wholesale", action: "suspend", extTenant: "t" }, deps);
  const sso = (secret: string, deps: Parameters<typeof signSsoToken>[2]) => signSsoToken(secret, base, deps);

  it("빈 secret·공백 secret 을 거부한다", () => {
    for (const s of ["", "   ", "\n"]) {
      expect(() => call(s, { now: 1_000_000 })).toThrow(/SIGN_SECRET_INVALID/);
      expect(() => sso(s, { now: 1_000_000 })).toThrow(/SIGN_SECRET_INVALID/);
    }
    expect(() => call(undefined as never, {})).toThrow(/SIGN_SECRET_INVALID/);
    expect(() => sso(null as never, {})).toThrow(/SIGN_SECRET_INVALID/);
  });

  it("NaN·0·음수·Infinity ttl 을 거부한다", () => {
    for (const ttl of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, "60" as never]) {
      expect(() => call(SECRET, { now: 1_000_000, ttl }), String(ttl)).toThrow(/SIGN_TTL_INVALID/);
      expect(() => sso(SECRET, { now: 1_000_000, ttl }), String(ttl)).toThrow(/SIGN_TTL_INVALID/);
    }
  });

  it("NaN now 를 거부한다", () => {
    expect(() => call(SECRET, { now: Number.NaN })).toThrow(/SIGN_NOW_INVALID/);
    expect(() => sso(SECRET, { now: Number.NaN })).toThrow(/SIGN_NOW_INVALID/);
  });

  it("ttl 생략·60 초과는 기존대로(60 상한)", () => {
    expect(JSON.parse(call(SECRET, { now: 1_000_000, jti: "j" }).body)).toMatchObject({ iat: 1000, exp: 1060 });
    expect(JSON.parse(call(SECRET, { now: 1_000_000, jti: "j", ttl: 999 }).body)).toMatchObject({ iat: 1000, exp: 1060 });
    expect(JSON.parse(call(SECRET, { now: 1_000_000, jti: "j", ttl: 30 }).body)).toMatchObject({ iat: 1000, exp: 1030 });
  });
});

describe("2-1 ssoTarget 경로 정규화", () => {
  it("점 구간·인코딩된 점·구분자·제어문자가 있으면 /ledger 로 되돌린다", () => {
    const bad = [
      "/ledger/../admin",
      "/ledger/./x/../../admin",
      "/ledger/%2e%2e/admin",
      "/ledger/%2E%2E/admin",
      "/ledger/.%2e/admin",
      "/ledger/..%2fadmin",
      "/ledger/%2fadmin",
      "/ledger/%5cadmin",
      "/ledger/a%00b",
      "/ledger/a\tb",
      "/ledger/a\u0000b",
      "/ledger/%zz",
      "/ledger/..",
      "/ledger/vat/../../admin?x=1",
      "/ledger/%252e%252e/x",
    ];

    for (const to of bad) expect(ssoTarget(to), JSON.stringify(to)).toBe("/ledger");
  });

  it("정상 경로는 그대로 통과한다(결과 불변)", () => {
    for (const to of ["/ledger", "/ledger/vat", "/ledger/vat/2026-10", "/ledger?tab=1", "/ledger/vat?from=2026-01-01&to=2026-12-31", "/ledger/a.b/c"]) {
      expect(ssoTarget(to), to).toBe(to);
    }
  });

  it("기존 거부 규칙은 유지된다", () => {
    for (const to of ["//evil", "/ledgerx", "/other", "ledger", "/ledger\\x", "/ledger/\r\nx", 5 as never, undefined as never]) {
      expect(ssoTarget(to), String(to)).toBe("/ledger");
    }
  });
});
