import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Keyring, SecretError, jsonSecret, loadKeyring, openSecret, readFailed, resolveSecret, sealSecret, type SecretContext, type SecretErrorCode } from "./index";

/** 시험 벡터(TEST-ONLY 가짜 키·값). 모듈과 독립인 구현으로 만든 고정 암호문. */
const vectors = JSON.parse(readFileSync(new URL("./__vectors__/secret-vectors.json", import.meta.url), "utf8")) as {
  keys_TEST_ONLY: Record<"A" | "B", { hex: string; base64: string; kid: string }>;
  cases: Array<{ name: string; format: string; token: string; tenantId: string; provider: string; key: "A" | "B"; plain: string }>;
};

const KA = vectors.keys_TEST_ONLY.A;
const KB = vectors.keys_TEST_ONLY.B;
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const ctx: SecretContext = { tenantId: TENANT, provider: "toss" };

const ringA = () => loadKeyring({ TENANT_SECRET_KEY: KA.hex });
const ringB = () => loadKeyring({ TENANT_SECRET_KEY: KB.hex });

function code(fn: () => unknown): SecretErrorCode {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SecretError);
    // 메시지는 코드 그대로 — 값·키 조각을 담지 않는다
    expect((e as SecretError).message).toBe((e as SecretError).code);

    return (e as SecretError).code;
  }

  throw new Error("did not throw");
}

describe("키 로더", () => {
  it("hex 64자와 base64(패딩 유무)·base64url 을 모두 받고 같은 키로 본다", () => {
    const b64 = loadKeyring({ TENANT_SECRET_KEY: KA.base64 });
    const b64NoPad = loadKeyring({ TENANT_SECRET_KEY: KA.base64.replace(/=+$/, "") });
    const b64url = loadKeyring({ TENANT_SECRET_KEY: KA.base64.replace(/\+/g, "-").replace(/\//g, "_") });
    const hexUpper = loadKeyring({ TENANT_SECRET_KEY: KA.hex.toUpperCase() });

    for (const r of [ringA(), b64, b64NoPad, b64url, hexUpper]) expect(r.currentKid).toBe(KA.kid);
  });

  it("앞뒤 공백·개행은 지운다", () => {
    expect(loadKeyring({ TENANT_SECRET_KEY: `  ${KA.hex}\n` }).currentKid).toBe(KA.kid);
  });

  it("없거나 비었으면 SECRET_KEY_MISSING", () => {
    expect(code(() => loadKeyring({}))).toBe("SECRET_KEY_MISSING");
    expect(code(() => loadKeyring({ TENANT_SECRET_KEY: "   " }))).toBe("SECRET_KEY_MISSING");
  });

  it("형식이 틀리면 SECRET_KEY_INVALID (길이·문자·이전 키 포함)", () => {
    const bad = ["abc", KA.hex.slice(0, 63), KA.hex + "0", "g".repeat(64), KA.base64.slice(0, 40), Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), "!".repeat(44)];

    for (const v of bad) expect(code(() => loadKeyring({ TENANT_SECRET_KEY: v }))).toBe("SECRET_KEY_INVALID");

    expect(code(() => loadKeyring({ TENANT_SECRET_KEY: KA.hex, TENANT_SECRET_KEY_PREVIOUS: "nope" }))).toBe("SECRET_KEY_INVALID");
  });

  it("현재 키와 이전 키가 같은 값이면 SECRET_KEY_DUPLICATE", () => {
    expect(code(() => loadKeyring({ TENANT_SECRET_KEY: KA.hex, TENANT_SECRET_KEY_PREVIOUS: KA.base64 }))).toBe("SECRET_KEY_DUPLICATE");
  });

  it("환경변수 이름을 바꿀 수 있고 이전 키 기본 이름은 <현재>_PREVIOUS, 여러 개는 쉼표", () => {
    const r = loadKeyring({ CREDENTIAL_ENCRYPTION_KEY: KA.hex, CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: ` ${KB.hex} , ` }, { current: "CREDENTIAL_ENCRYPTION_KEY" });

    expect(r.currentKid).toBe(KA.kid);
    expect(r.previousKids).toEqual([KB.kid]);

    const custom = loadKeyring({ K: KA.hex, OLD: KB.hex }, { current: "K", previous: "OLD" });

    expect(custom.previousKids).toEqual([KB.kid]);
  });

  it("키링은 키 바이트를 드러내지 않는다(JSON·콘솔)", () => {
    const r = loadKeyring({ TENANT_SECRET_KEY: KA.hex, TENANT_SECRET_KEY_PREVIOUS: KB.hex });
    const shown = JSON.stringify(r) + inspect(r) + String(r);

    expect(shown).not.toContain(KA.hex);
    expect(shown).not.toContain(KB.hex);
    expect(shown).not.toContain(KA.base64);
    expect(JSON.parse(JSON.stringify(r))).toEqual({ currentKid: KA.kid, previousKids: [KB.kid] });
  });

  it("빈 키링은 만들 수 없다", () => {
    expect(code(() => new Keyring([]))).toBe("SECRET_KEY_MISSING");
  });
});

describe("v2 봉투", () => {
  it("봉인 → 열기 왕복, 형식은 ENC:v2:<kid>:<base64url>", () => {
    const token = sealSecret('{"secretKey":"test_sk_x"}', ctx, ringA());

    expect(token).toMatch(new RegExp(`^ENC:v2:${KA.kid}:[A-Za-z0-9_-]+$`));
    expect(openSecret(token, ctx, ringA())).toEqual({ plain: '{"secretKey":"test_sk_x"}', needsRewrite: false, format: "v2" });
  });

  it("같은 평문도 매번 다른 암호문(iv 무작위)", () => {
    expect(sealSecret("x", ctx, ringA())).not.toBe(sealSecret("x", ctx, ringA()));
  });

  it("빈 문자열·유니코드·긴 평문", () => {
    for (const plain of ["", "한글 비밀번호 🔑", "x".repeat(3000)]) expect(openSecret(sealSecret(plain, ctx, ringA()), ctx, ringA()).plain).toBe(plain);
  });

  it("다른 테넌트로는 열리지 않는다", () => {
    const token = sealSecret("s", ctx, ringA());

    expect(code(() => openSecret(token, { ...ctx, tenantId: OTHER_TENANT }, ringA()))).toBe("SECRET_DECRYPT_FAILED");
  });

  it("같은 테넌트의 다른 provider 칸으로는 열리지 않는다", () => {
    const token = sealSecret("s", ctx, ringA());

    expect(code(() => openSecret(token, { ...ctx, provider: "bizppurio" }, ringA()))).toBe("SECRET_DECRYPT_FAILED");
  });

  it("테넌트 id 대소문자는 정규화(소문자)해서 묶는다", () => {
    const token = sealSecret("s", { tenantId: TENANT.toUpperCase(), provider: "toss" }, ringA());

    expect(openSecret(token, ctx, ringA()).plain).toBe("s");
  });

  it("변조(본문·태그·kid)는 거절", () => {
    const token = sealSecret("secret", ctx, ringA());
    const [head, payload] = [token.slice(0, token.lastIndexOf(":") + 1), token.slice(token.lastIndexOf(":") + 1)];
    const raw = Buffer.from(payload, "base64url");

    for (const idx of [0, 12, raw.length - 1]) {
      const copy = Buffer.from(raw);

      copy[idx] ^= 0x01;

      expect(code(() => openSecret(head + copy.toString("base64url"), ctx, ringA()))).toBe("SECRET_DECRYPT_FAILED");
    }

    // kid 만 바꾸면 그 kid 키가 없음
    expect(code(() => openSecret(token.replace(KA.kid, "deadbeef"), ctx, ringA()))).toBe("SECRET_KEY_UNKNOWN");
  });

  it("잘못된 모양은 SECRET_FORMAT", () => {
    const bad = ["", "garbage", "ENC:v2:", "ENC:v2:zz:abc", `ENC:v2:${KA.kid}:`, `ENC:v2:${KA.kid}:abc`, `ENC:v2:${KA.kid}:a:b`, "ENC:v3:xxxx", "ENC:v1:", "ENC:v1:AAAA", "a.b.c", "a.b", "..", "ENC:x"];

    for (const t of bad) expect(code(() => openSecret(t, ctx, ringA()))).toBe("SECRET_FORMAT");

    expect(code(() => openSecret(undefined as unknown as string, ctx, ringA()))).toBe("SECRET_FORMAT");
    expect(code(() => sealSecret(5 as unknown as string, ctx, ringA()))).toBe("SECRET_FORMAT");
  });

  it("컨텍스트 형식 검증(구분자 오염 방지)", () => {
    const bad: SecretContext[] = [
      { tenantId: "", provider: "toss" },
      { tenantId: "a|b", provider: "toss" },
      { tenantId: "a:b", provider: "toss" },
      { tenantId: "x".repeat(65), provider: "toss" },
      { tenantId: TENANT, provider: "" },
      { tenantId: TENANT, provider: "Toss" },
      { tenantId: TENANT, provider: "to|ss" },
      { tenantId: TENANT, provider: "a".repeat(33) },
      { tenantId: 1 as unknown as string, provider: "toss" },
    ];

    for (const c of bad) {
      expect(code(() => sealSecret("s", c, ringA()))).toBe("SECRET_CONTEXT_INVALID");
      expect(code(() => openSecret("ENC:v2:00000000:x", c, ringA()))).toBe("SECRET_CONTEXT_INVALID");
    }
  });

  it("오류 메시지·키링에 평문·키가 없다", () => {
    const token = sealSecret("very-secret-value", ctx, ringA());

    try {
      openSecret(token, { ...ctx, tenantId: OTHER_TENANT }, ringA());
    } catch (e) {
      const text = String(e) + JSON.stringify(e) + ((e as Error).stack ?? "");

      expect(text).not.toContain("very-secret-value");
      expect(text).not.toContain(KA.hex);
    }
  });
});

describe("키 로테이션", () => {
  it("이전 키로 봉인된 것은 needsRewrite=true 로 열리고, 다시 봉인하면 현재 키로 바뀐다", () => {
    const oldToken = sealSecret("rotating", ctx, ringA());
    const rotated = loadKeyring({ TENANT_SECRET_KEY: KB.hex, TENANT_SECRET_KEY_PREVIOUS: KA.hex });
    const opened = openSecret(oldToken, ctx, rotated);

    expect(opened).toEqual({ plain: "rotating", needsRewrite: true, format: "v2" });

    const resealed = sealSecret(opened.plain, ctx, rotated);

    expect(resealed).toContain(`ENC:v2:${KB.kid}:`);
    expect(openSecret(resealed, ctx, rotated).needsRewrite).toBe(false);
    // 이전 키를 제거한 뒤에도 새 봉투는 열린다
    expect(openSecret(resealed, ctx, ringB()).plain).toBe("rotating");
  });

  it("이전 키를 제거한 뒤 옛 봉투는 SECRET_KEY_UNKNOWN (분실·환경 혼동과 변조를 구분)", () => {
    const oldToken = sealSecret("x", ctx, ringA());

    expect(code(() => openSecret(oldToken, ctx, ringB()))).toBe("SECRET_KEY_UNKNOWN");
  });

  it("쓰기는 항상 현재 키", () => {
    const ring = loadKeyring({ TENANT_SECRET_KEY: KB.hex, TENANT_SECRET_KEY_PREVIOUS: KA.hex });

    expect(sealSecret("x", ctx, ring)).toContain(`ENC:v2:${KB.kid}:`);
  });
});

describe("시험 벡터(독립 구현으로 만든 고정 암호문)", () => {
  const ringFor = (k: "A" | "B", format: string) =>
    // 벡터의 키는 A=hex, B=base64 로 번갈아 넘겨 두 표기를 모두 검증한다
    loadKeyring({ TENANT_SECRET_KEY: format === "v1" ? vectors.keys_TEST_ONLY[k].base64 : vectors.keys_TEST_ONLY[k].hex });

  for (const c of vectors.cases) {
    it(`${c.name} 를 연다`, () => {
      const opened = openSecret(c.token, { tenantId: c.tenantId, provider: c.provider }, ringFor(c.key, c.format));

      expect(opened.plain).toBe(c.plain);
      expect(opened.format).toBe(c.format);
      expect(opened.needsRewrite).toBe(c.format !== "v2");
    });

    it(`${c.name}: 다른 키로는 열리지 않는다`, () => {
      const other = c.key === "A" ? "B" : "A";
      const expected: SecretErrorCode = c.format === "v2" ? "SECRET_KEY_UNKNOWN" : "SECRET_DECRYPT_FAILED";

      expect(code(() => openSecret(c.token, { tenantId: c.tenantId, provider: c.provider }, ringFor(other, c.format)))).toBe(expected);
    });
  }

  it("v1 은 테넌트 id 를 AAD 로 묶는다(다른 테넌트 거절), provider 는 묶지 않는다(레거시 동작)", () => {
    const v1 = vectors.cases.find((c) => c.format === "v1" && c.key === "A")!;
    const ring = ringFor("A", "v1");

    expect(code(() => openSecret(v1.token, { tenantId: OTHER_TENANT, provider: v1.provider }, ring))).toBe("SECRET_DECRYPT_FAILED");
    expect(openSecret(v1.token, { tenantId: v1.tenantId, provider: "bizppurio" }, ring).plain).toBe(v1.plain);
  });

  it("v1 AAD 는 호출 쪽이 넘긴 id 문자열 그대로(대소문자 보존)", () => {
    const v1 = vectors.cases.find((c) => c.format === "v1" && c.key === "A")!;

    expect(code(() => openSecret(v1.token, { tenantId: v1.tenantId.replace(/a1$/, "A1"), provider: v1.provider }, ringFor("A", "v1")))).toBe("SECRET_DECRYPT_FAILED");
  });

  it("legacy-dotted 는 AAD 가 없어 테넌트와 무관하게 열린다(그래서 needsRewrite 로 v2 이전이 필요)", () => {
    const d = vectors.cases.find((c) => c.format === "legacy-dotted" && c.key === "A")!;

    expect(openSecret(d.token, { tenantId: OTHER_TENANT, provider: "bizppurio" }, ringFor("A", "legacy-dotted")).plain).toBe(d.plain);
  });

  it("레거시를 열어 v2 로 다시 봉인한 뒤에는 AAD 가 걸린다", () => {
    const d = vectors.cases.find((c) => c.format === "legacy-dotted" && c.key === "A")!;
    const c2 = { tenantId: d.tenantId, provider: d.provider };
    const ring = ringFor("A", "legacy-dotted");
    const resealed = sealSecret(openSecret(d.token, c2, ring).plain, c2, ring);

    expect(openSecret(resealed, c2, ring)).toMatchObject({ plain: d.plain, format: "v2", needsRewrite: false });
    expect(code(() => openSecret(resealed, { ...c2, tenantId: OTHER_TENANT }, ring))).toBe("SECRET_DECRYPT_FAILED");
  });

  it("레거시는 이전 키 목록에서도 찾는다", () => {
    const d = vectors.cases.find((c) => c.format === "legacy-dotted" && c.key === "B")!;
    const ring = loadKeyring({ TENANT_SECRET_KEY: KA.hex, TENANT_SECRET_KEY_PREVIOUS: KB.hex });

    expect(openSecret(d.token, { tenantId: d.tenantId, provider: d.provider }, ring).plain).toBe(d.plain);
  });
});

describe("기존 앱 알고리즘과의 호환(참조 구현을 시험 안에 복제)", () => {
  /** 앱 A 방식: ENC:v1:+base64(iv‖태그‖암호문), AAD=테넌트 id. */
  function legacyV1(plain: string, tenantId: string, key: Buffer): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);

    c.setAAD(Buffer.from(tenantId, "utf8"));

    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);

    return "ENC:v1:" + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }

  /** 앱 B 방식: iv.태그.암호문(base64url), AAD 없음. */
  function legacyDotted(plain: string, key: Buffer): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);

    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
  }

  it("두 레거시 형식을 환경변수 값 그대로(base64 / hex) 열 수 있다", () => {
    const key = Buffer.from(KA.hex, "hex");

    expect(openSecret(legacyV1('{"a":1}', TENANT, key), ctx, loadKeyring({ TENANT_SECRET_KEY: key.toString("base64") })).plain).toBe('{"a":1}');
    expect(openSecret(legacyDotted("pw", key), ctx, loadKeyring({ CREDENTIAL_ENCRYPTION_KEY: key.toString("hex") }, { current: "CREDENTIAL_ENCRYPTION_KEY" })).plain).toBe("pw");
  });
});

describe("3상태 보조 resolveSecret", () => {
  const parse = jsonSecret((v) => {
    const o = v as { secretKey?: unknown } | null;

    return o && typeof o.secretKey === "string" ? { secretKey: o.secretKey } : null;
  });

  it("값이 없으면 absent (null·undefined·빈 문자열)", () => {
    for (const v of [null, undefined, ""]) expect(resolveSecret(v, ctx, ringA(), parse)).toEqual({ state: "absent" });
  });

  it("정상이면 ok + 값 + needsRewrite", () => {
    const token = sealSecret('{"secretKey":"test_sk_1"}', ctx, ringA());

    expect(resolveSecret(token, ctx, ringA(), parse)).toEqual({ state: "ok", value: { secretKey: "test_sk_1" }, needsRewrite: false, format: "v2" });

    const rotated = loadKeyring({ TENANT_SECRET_KEY: KB.hex, TENANT_SECRET_KEY_PREVIOUS: KA.hex });

    expect(resolveSecret(token, ctx, rotated, parse)).toMatchObject({ state: "ok", needsRewrite: true });
  });

  it("값은 있는데 못 읽으면 unavailable + 코드(문자열이 아닌 값, 깨진 형식, 다른 테넌트, 키 없음)", () => {
    const token = sealSecret('{"secretKey":"x"}', ctx, ringA());

    expect(resolveSecret(123, ctx, ringA(), parse)).toEqual({ state: "unavailable", reason: "SECRET_FORMAT" });
    expect(resolveSecret("garbage", ctx, ringA(), parse)).toEqual({ state: "unavailable", reason: "SECRET_FORMAT" });
    expect(resolveSecret(token, { ...ctx, tenantId: OTHER_TENANT }, ringA(), parse)).toEqual({ state: "unavailable", reason: "SECRET_DECRYPT_FAILED" });
    expect(resolveSecret(token, ctx, ringB(), parse)).toEqual({ state: "unavailable", reason: "SECRET_KEY_UNKNOWN" });
  });

  it("키링 팩토리가 던지면(키 환경변수 누락·형식 오류) unavailable 로 매핑", () => {
    const token = sealSecret('{"secretKey":"x"}', ctx, ringA());

    expect(resolveSecret(token, ctx, () => loadKeyring({}), parse)).toEqual({ state: "unavailable", reason: "SECRET_KEY_MISSING" });
    expect(resolveSecret(token, ctx, () => loadKeyring({ TENANT_SECRET_KEY: "bad" }), parse)).toEqual({ state: "unavailable", reason: "SECRET_KEY_INVALID" });
    expect(resolveSecret(token, ctx, () => ringA(), parse)).toMatchObject({ state: "ok" });
  });

  it("내용 검증 실패·JSON 오류는 INVALID_PAYLOAD (값이 결과에 없다)", () => {
    const notJson = sealSecret("not json at all", ctx, ringA());
    const wrongShape = sealSecret('{"other":1}', ctx, ringA());

    expect(resolveSecret(notJson, ctx, ringA(), parse)).toEqual({ state: "unavailable", reason: "INVALID_PAYLOAD" });
    expect(resolveSecret(wrongShape, ctx, ringA(), parse)).toEqual({ state: "unavailable", reason: "INVALID_PAYLOAD" });
  });

  it("DB 읽기 실패용 readFailed()", () => {
    expect(readFailed()).toEqual({ state: "unavailable", reason: "READ_FAILED" });
  });

  it("컨텍스트가 틀리면(호출 오류) 던지지 않고 unavailable", () => {
    const token = sealSecret("{}", ctx, ringA());

    expect(resolveSecret(token, { tenantId: "a|b", provider: "toss" }, ringA(), (p) => p)).toEqual({ state: "unavailable", reason: "SECRET_CONTEXT_INVALID" });
  });
});
