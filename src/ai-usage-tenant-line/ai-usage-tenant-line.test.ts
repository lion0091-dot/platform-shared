import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hmacHex } from "../account";
import {
  AI_USAGE_TENANT_ACTION,
  AI_USAGE_TENANT_EXT_TENANT,
  AI_USAGE_TENANT_ITEM_KEYS,
  AI_USAGE_TENANT_MAX_BODY_BYTES,
  AI_USAGE_TENANT_MAX_ITEMS,
  AI_USAGE_TENANT_PATH,
  buildAiUsageTenantCall,
  buildAiUsageTenantLine,
  checkAiUsageTenantBatch,
  classifyAiUsageTenantResponse,
  isValidExtId,
  splitAiUsageTenantBatches,
  type AiUsageTenantItem,
} from "./index";

// 레저코어 계약 §5 시험 벡터(가짜 비밀·고정 시각·고정 jti). 수신 시각 = 2026-11-14T12:00:30Z.
const SECRET = "test-secret-ai-usage-tenant-0123456789abcdef";
const NOW_MS = 1794657630000;
const JTI = "jti-1794657630-ai-usage-tenant";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const VECTOR_BODY =
  '{"system":"wholesale","action":"ai_usage_tenant","ext_tenant":"BATCH","jti":"jti-1794657630-ai-usage-tenant","iat":1794657630,"exp":1794657690,"lines":[{"ext_id":"11111111-1111-4111-8111-111111111111","contract":1,"month":"2026-11-01","input_tokens":3200000,"output_tokens":410000,"cache_tokens":1190000,"calls":1250,"as_of":"2026-11-14T12:00:00.000Z"},{"ext_id":"22222222-2222-4222-8222-222222222222","contract":1,"month":"2026-11-01","input_tokens":0,"output_tokens":0,"cache_tokens":0,"calls":0,"as_of":"2026-11-14T12:00:00.000Z"}]}';
const VECTOR_SIG = "85d8f255485097b6f87444e43e2ead0b32a9c43fe6073078aa6b75e5ca017fcf";
// 계약에 없는 값: 같은 본문에서 system 만 shipping 으로 바꾼 계산 결과를 고정한다(레저코어와 교차 확인용).
const SHIPPING_SIG = "b68a0bd2a086ba0ae32bd81fa0a36d4d45503730868232e7c4a57939db5b3fd7";

const IN1 = { extId: ID1, month: "2026-11-01", inputTokens: 3_200_000, outputTokens: 410_000, cacheTokens: 1_190_000, calls: 1250, asOf: "2026-11-14T12:00:00.000Z" };
const IN2 = { extId: ID2, month: "2026-11-01", inputTokens: 0, outputTokens: 0, cacheTokens: 0, calls: 0, asOf: "2026-11-14T12:00:00.000Z" };

function item(over: Record<string, unknown> = {}, base: Record<string, unknown> = IN1): AiUsageTenantItem {
  const r = buildAiUsageTenantLine({ ...base, ...over }, NOW_MS);

  if (!r.ok) throw new Error(`item failed: ${r.code}`);

  return r.item;
}

describe("레저코어 계약 §5 벡터 정합 (바이트 일치)", () => {
  it("계약 본문 원문은 535바이트이고 계약 비밀로 서명하면 계약의 x-signature 와 같다", () => {
    expect(Buffer.byteLength(VECTOR_BODY, "utf8")).toBe(535);
    expect(hmacHex(VECTOR_BODY, SECRET)).toBe(VECTOR_SIG);
  });

  it("buildAiUsageTenantCall(wholesale) 은 계약 본문·서명과 바이트 단위로 같다", () => {
    const r = buildAiUsageTenantCall(SECRET, "wholesale", [item(), item({}, IN2)], { now: NOW_MS, jti: JTI });

    expect(r).toEqual({ ok: true, body: VECTOR_BODY, signature: VECTOR_SIG });
  });

  it("같은 입력에서 system 만 shipping 이면 고정한 서명이 나온다", () => {
    const r = buildAiUsageTenantCall(SECRET, "shipping", [item(), item({}, IN2)], { now: NOW_MS, jti: JTI });

    expect(r.ok && r.body).toBe(VECTOR_BODY.replace('"system":"wholesale"', '"system":"shipping"'));
    expect(r.ok && r.signature).toBe(SHIPPING_SIG);
  });

  it("호출자가 항목 키를 다른 순서로 넘겨도 본문 순서는 고정", () => {
    const a = item();
    const shuffled = { as_of: a.as_of, calls: a.calls, cache_tokens: a.cache_tokens, output_tokens: a.output_tokens, input_tokens: a.input_tokens, month: a.month, contract: a.contract, ext_id: a.ext_id } as AiUsageTenantItem;
    const r = buildAiUsageTenantCall(SECRET, "wholesale", [shuffled, item({}, IN2)], { now: NOW_MS, jti: JTI });

    expect(r.ok && r.body).toBe(VECTOR_BODY);
  });

  it("상수", () => {
    expect(AI_USAGE_TENANT_ACTION).toBe("ai_usage_tenant");
    expect(AI_USAGE_TENANT_EXT_TENANT).toBe("BATCH");
    expect(AI_USAGE_TENANT_PATH).toBe("/api/provision/ai-usage");
    expect(AI_USAGE_TENANT_MAX_ITEMS).toBe(50);
    expect(AI_USAGE_TENANT_MAX_BODY_BYTES).toBe(16384);
  });

  it("봉투 키는 7개뿐(system·action·ext_tenant·jti·iat·exp·lines)", () => {
    const r = buildAiUsageTenantCall(SECRET, "shipping", [item()], { now: NOW_MS });

    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(JSON.parse(r.body))).toEqual(["system", "action", "ext_tenant", "jti", "iat", "exp", "lines"]);
  });
});

describe("buildAiUsageTenantLine — 보안: 허용 키만, 회사·금액·사용자·모델·기능 혼입 시 실패", () => {
  it("출력 키는 계약 §2 의 8개, 순서 고정, app·금액·합계 없음", () => {
    const it = item();

    expect(Object.keys(it)).toEqual([...AI_USAGE_TENANT_ITEM_KEYS]);
    expect(Object.keys(it)).toEqual(["ext_id", "contract", "month", "input_tokens", "output_tokens", "cache_tokens", "calls", "as_of"]);
    for (const k of ["app", "est_usd", "tokens", "name", "model", "feature"]) expect(k in it).toBe(false);
  });

  const FORBIDDEN = [
    "tenantId", "tenant_id", "wholesalerId", "companyId", "company", "companyName", "tenantName", "name", "userId", "user_id", "email",
    "model", "feature", "estUsd", "est_usd", "cost", "amount", "price", "tokens", "app", "ext_tenant", "extra",
  ];

  for (const key of FORBIDDEN) {
    it(`입력에 «${key}» 키가 섞이면 LINE_EXTRA_KEY`, () => {
      expect(buildAiUsageTenantLine({ ...IN1, [key]: "x" }, NOW_MS)).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    });
  }

  it("심볼 키·비객체·배열·null·던지는 getter", () => {
    expect(buildAiUsageTenantLine({ ...IN1, [Symbol("x")]: 1 }, NOW_MS)).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    for (const bad of [null, [], "x", 5]) expect(buildAiUsageTenantLine(bad, NOW_MS)).toEqual({ ok: false, code: "LINE_INPUT" });

    const r = buildAiUsageTenantLine(
      {
        get extId(): string {
          throw new Error("secret-value");
        },
      },
      NOW_MS,
    );

    expect(r).toEqual({ ok: false, code: "LINE_INPUT" });
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });
});

describe("buildAiUsageTenantLine — 범위·형식", () => {
  const code = (over: Record<string, unknown>) => {
    const r = buildAiUsageTenantLine({ ...IN1, ...over }, NOW_MS);

    return r.ok ? "OK" : r.code;
  };

  it("ext_id: 영문·숫자·밑줄·하이픈 1~100자(계약 §2), 이름·공백·점·한글 거부", () => {
    for (const ok of [ID1, "a", "A_b-9", "x".repeat(100)]) expect(code({ extId: ok }), ok).toBe("OK");
    for (const bad of ["", "x".repeat(101), "회사 이름", "a b", "a.b", "a:b", "a/b", "a\nb", "한글", 5, null, undefined]) {
      expect(code({ extId: bad }), String(bad)).toBe("LINE_EXT_ID");
    }
  });

  it("isValidExtId", () => {
    expect(isValidExtId(ID1)).toBe(true);
    expect(isValidExtId("")).toBe(false);
  });

  it("토큰·calls: 0·10¹⁴ 통과, 10¹⁴ 초과·소수·음수·NaN·문자열·BigInt 거부", () => {
    for (const field of ["inputTokens", "outputTokens", "cacheTokens", "calls"]) {
      expect(code({ [field]: 0 }), field).toBe("OK");
      expect(code({ [field]: 1e14 }), field).toBe("OK");
      for (const bad of [1e14 + 2, 1.5, -1, Number.NaN, Infinity, "5", 10n, null, undefined]) expect(code({ [field]: bad }), `${field}:${String(bad)}`).toBe("LINE_NUMBER");
    }
  });

  it("month: 형식·존재하지 않는 달·1일 아님·미래 달·24개월 초과", () => {
    expect(code({ month: "2026-11-01" })).toBe("OK");
    expect(code({ month: "2024-12-01" })).toBe("OK");
    for (const bad of ["2026-13-01", "2026-00-01", "2026-11-02", "2026-11", "2026-12-01", "2024-11-01", 20261101, null]) expect(code({ month: bad }), String(bad)).toBe("LINE_MONTH");
  });

  it("as_of: 형식·미래 5분 경계·400일 경계·Date 입력·밀리초 정규화", () => {
    expect(code({ asOf: "2026-11-14T12:05:30.000Z" })).toBe("OK");
    expect(code({ asOf: "2026-11-14T12:05:30.001Z" })).toBe("LINE_AS_OF");
    expect(code({ asOf: new Date(NOW_MS - 400 * 24 * 3600_000), month: "2025-10-01" })).toBe("OK");
    expect(code({ asOf: new Date(NOW_MS - 400 * 24 * 3600_000 - 1), month: "2025-10-01" })).toBe("LINE_AS_OF");
    expect(item({ asOf: "2026-11-14T12:00:00Z" }).as_of).toBe("2026-11-14T12:00:00.000Z");
    expect(item({ asOf: new Date("2026-11-14T21:00:00+09:00") }).as_of).toBe("2026-11-14T12:00:00.000Z");
    for (const bad of ["2026-11-14", "2026-11-14T12:00:00", "2026-11-14T12:00:00+09:00", new Date(Number.NaN), 1794657600000, null]) expect(code({ asOf: bad }), String(bad)).toBe("LINE_AS_OF");
  });

  it("now 가 잘못되면 LINE_AS_OF", () => {
    expect(buildAiUsageTenantLine(IN1, Number.NaN)).toEqual({ ok: false, code: "LINE_AS_OF" });
  });

  it("0 사용 항목도 유효(계약 §5 벡터의 둘째 항목)", () => {
    expect(item({}, IN2)).toMatchObject({ input_tokens: 0, output_tokens: 0, cache_tokens: 0, calls: 0 });
  });
});

describe("checkAiUsageTenantBatch — 항목 선검증(허용 키·범위·중복)", () => {
  const good = () => [item(), item({}, IN2)];

  it("정상 1~50건은 통과", () => {
    expect(checkAiUsageTenantBatch(good())).toBeNull();
    expect(checkAiUsageTenantBatch(Array.from({ length: 50 }, (_, i) => item({ extId: `t${i}` })))).toBeNull();
  });

  it("빈 배열·51건·배열 아님은 LINE_BATCH", () => {
    expect(checkAiUsageTenantBatch([])).toBe("LINE_BATCH");
    expect(checkAiUsageTenantBatch(Array.from({ length: 51 }, (_, i) => item({ extId: `t${i}` })))).toBe("LINE_BATCH");
    for (const bad of [null, undefined, "x", {}, 5]) expect(checkAiUsageTenantBatch(bad)).toBe("LINE_BATCH");
  });

  it("같은 (ext_id, month) 중복은 LINE_DUP, ext_id 만 같고 month 가 다르면 통과", () => {
    expect(checkAiUsageTenantBatch([item(), item()])).toBe("LINE_DUP");
    expect(checkAiUsageTenantBatch([item(), item({ month: "2026-10-01" })])).toBeNull();
  });

  it("항목 하나라도 허용 키 밖이면 배치 전체 거부(독이 든 항목)", () => {
    const poison = { ...item({}, IN2), company: "x" } as unknown as AiUsageTenantItem;

    expect(checkAiUsageTenantBatch([item(), poison])).toBe("LINE_EXTRA_KEY");
    for (const key of ["app", "est_usd", "tokens", "name", "model", "feature", "tenant_id", "user_id"]) {
      expect(checkAiUsageTenantBatch([item(), { ...item({}, IN2), [key]: 1 }]), key).toBe("LINE_EXTRA_KEY");
    }
  });

  it("키 누락은 LINE_MALFORMED, 버전·값 오류는 각 코드", () => {
    const { calls: _c, ...missing } = item();

    expect(checkAiUsageTenantBatch([missing])).toBe("LINE_MALFORMED");
    expect(checkAiUsageTenantBatch([{ ...item(), contract: 2 }])).toBe("LINE_VERSION");
    expect(checkAiUsageTenantBatch([{ ...item(), ext_id: "a b" }])).toBe("LINE_EXT_ID");
    expect(checkAiUsageTenantBatch([{ ...item(), month: "2026-13-01" }])).toBe("LINE_MONTH");
    expect(checkAiUsageTenantBatch([{ ...item(), calls: -1 }])).toBe("LINE_NUMBER");
    expect(checkAiUsageTenantBatch([{ ...item(), as_of: "x" }])).toBe("LINE_AS_OF");
    expect(checkAiUsageTenantBatch([null])).toBe("LINE_EXTRA_KEY");
  });
});

describe("splitAiUsageTenantBatches — 50건·16KB 이하로 나누기", () => {
  const many = (n: number, prefix = "t") => Array.from({ length: n }, (_, i) => item({ extId: `${prefix}${i}` }));

  it("빈 목록은 빈 배치(오류 아님)", () => {
    expect(splitAiUsageTenantBatches([])).toEqual({ ok: true, batches: [] });
  });

  it("50건은 한 배치, 51건은 50+1, 120건은 50+50+20, 순서 유지", () => {
    const sizes = (n: number) => {
      const r = splitAiUsageTenantBatches(many(n));

      return r.ok ? r.batches.map((b) => b.length) : r.code;
    };

    expect(sizes(1)).toEqual([1]);
    expect(sizes(50)).toEqual([50]);
    expect(sizes(51)).toEqual([50, 1]);
    expect(sizes(120)).toEqual([50, 50, 20]);

    const r = splitAiUsageTenantBatches(many(120));

    expect(r.ok && r.batches.flat().map((i) => i.ext_id)).toEqual(many(120).map((i) => i.ext_id));
  });

  it("나눈 배치마다 실제 서명 본문이 16KB 이하이고 선검증을 통과한다", () => {
    const r = splitAiUsageTenantBatches(many(400, "tenant-with-a-fairly-long-external-id-"));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const b of r.batches) {
      expect(checkAiUsageTenantBatch(b)).toBeNull();
      const call = buildAiUsageTenantCall(SECRET, "wholesale", b, { now: NOW_MS, jti: "x".repeat(128) });

      expect(call.ok && Buffer.byteLength(call.body, "utf8")).toBeLessThanOrEqual(AI_USAGE_TENANT_MAX_BODY_BYTES);
    }
  });

  it("maxBodyBytes 를 낮추면 더 잘게 나뉜다(큰 항목 포함 경계)", () => {
    const r = splitAiUsageTenantBatches(many(10), { maxBodyBytes: 1500 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batches.length).toBeGreaterThan(1);
    expect(r.batches.flat()).toHaveLength(10);
  });

  it("옵션 범위 밖(0·51건·16385바이트·소수)은 LINE_BATCH, 한 항목도 못 담는 한도도 LINE_BATCH", () => {
    for (const opts of [{ maxItems: 0 }, { maxItems: 51 }, { maxBodyBytes: 16385 }, { maxBodyBytes: 0 }, { maxItems: 1.5 }, { maxBodyBytes: 100 }]) {
      expect(splitAiUsageTenantBatches(many(2), opts), JSON.stringify(opts)).toEqual({ ok: false, code: "LINE_BATCH" });
    }

    expect(splitAiUsageTenantBatches(many(5), { maxItems: 2 })).toMatchObject({ ok: true });
  });

  it("입력에 중복·허용 밖 키·잘못된 값이 있으면 분할 전에 전체 거부(선검증)", () => {
    expect(splitAiUsageTenantBatches([...many(3), item({ extId: "t1" })])).toEqual({ ok: false, code: "LINE_DUP" });
    expect(splitAiUsageTenantBatches([...many(3), { ...item({ extId: "z" }), name: "x" }])).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    expect(splitAiUsageTenantBatches([...many(3), { ...item({ extId: "z" }), calls: -1 }])).toEqual({ ok: false, code: "LINE_NUMBER" });
    expect(splitAiUsageTenantBatches("x")).toEqual({ ok: false, code: "LINE_BATCH" });
    expect(splitAiUsageTenantBatches(null)).toEqual({ ok: false, code: "LINE_BATCH" });
  });
});

describe("buildAiUsageTenantCall — 실패는 던지지 않고 코드만", () => {
  const ok = () => [item()];

  it("선검증 실패는 해당 코드(서명 전에 막음)", () => {
    expect(buildAiUsageTenantCall(SECRET, "shipping", [], { now: NOW_MS })).toEqual({ ok: false, code: "LINE_BATCH" });
    expect(buildAiUsageTenantCall(SECRET, "shipping", [item(), item()], { now: NOW_MS })).toEqual({ ok: false, code: "LINE_DUP" });
    expect(buildAiUsageTenantCall(SECRET, "shipping", [{ ...item(), tenant_id: "t" } as unknown as AiUsageTenantItem], { now: NOW_MS })).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    expect(buildAiUsageTenantCall(SECRET, "shipping", null as unknown as AiUsageTenantItem[], { now: NOW_MS })).toEqual({ ok: false, code: "LINE_BATCH" });
  });

  it("비밀·ttl·now 오류", () => {
    expect(buildAiUsageTenantCall("", "shipping", ok(), { now: NOW_MS })).toEqual({ ok: false, code: "SIGN_SECRET_INVALID" });
    expect(buildAiUsageTenantCall(SECRET, "shipping", ok(), { now: NOW_MS, ttl: 0 })).toEqual({ ok: false, code: "SIGN_TTL_INVALID" });
    expect(buildAiUsageTenantCall(SECRET, "shipping", ok(), { now: Number.NaN })).toEqual({ ok: false, code: "SIGN_NOW_INVALID" });
  });

  it("ttl 은 60 초로 줄고 jti 생략 시 호출마다 다르다", () => {
    const a = buildAiUsageTenantCall(SECRET, "shipping", ok(), { now: NOW_MS, ttl: 600 });
    const b = buildAiUsageTenantCall(SECRET, "shipping", ok(), { now: NOW_MS, ttl: 600 });

    expect(a.ok && JSON.parse(a.body).exp - JSON.parse(a.body).iat).toBe(60);
    expect(a.ok && b.ok && a.body !== b.body).toBe(true);
  });

  it("오류 결과에 비밀·값이 없다", () => {
    const r = buildAiUsageTenantCall("short", "shipping", ok(), { now: NOW_MS, ttl: -1 });

    expect(JSON.stringify(r)).not.toContain("short");
    expect(JSON.stringify(r)).not.toContain("1250");
  });

  it("50건 정상 배치 본문은 16KB 이하", () => {
    const r = buildAiUsageTenantCall(SECRET, "wholesale", Array.from({ length: 50 }, (_, i) => item({ extId: `t${i}` })), { now: NOW_MS, jti: JTI });

    expect(r.ok && Buffer.byteLength(r.body, "utf8")).toBeLessThan(AI_USAGE_TENANT_MAX_BODY_BYTES);
  });
});

describe("classifyAiUsageTenantResponse — 계약 §4", () => {
  const c = (status: number | "network", body: unknown) => classifyAiUsageTenantResponse(status, body);

  it("성공은 received·stored 를 돌려준다(stored ≤ received)", () => {
    expect(c(200, { status: "OK", received: 2, stored: 2 })).toEqual({ action: "sent", code: "OK", received: 2, stored: 2 });
    expect(c(200, { status: "OK", received: 50, stored: 0 })).toEqual({ action: "sent", code: "OK", received: 50, stored: 0 });
  });

  it("알 수 없는 200(상태·건수 이상)은 멈춤", () => {
    for (const body of [null, {}, { status: "UNCHANGED", received: 1, stored: 0 }, { status: "OK" }, { status: "OK", received: 1, stored: 2 }, { status: "OK", received: -1, stored: 0 }, { status: "OK", received: "1", stored: 1 }]) {
      expect(c(200, body), JSON.stringify(body)).toEqual({ action: "stop", code: "UNKNOWN_STATUS" });
    }
  });

  it("오류 코드: 서명·형식·건수·중복·크기는 멈춤, 수명 초과는 재서명, 503·429·500·네트워크는 다음 슬롯", () => {
    expect(c(401, { error: "CALL_EXPIRED" })).toEqual({ action: "retry_resign", code: "CALL_EXPIRED" });
    expect(c(401, { error: "CALL_BAD_SIGNATURE" })).toEqual({ action: "stop", code: "CALL_BAD_SIGNATURE" });
    for (const e of ["CALL_MALFORMED", "CALL_INVALID", "LINE_EXTRA_KEY", "LINE_MALFORMED", "LINE_VERSION", "LINE_MONTH", "LINE_NUMBER", "LINE_AS_OF", "LINE_BATCH", "LINE_DUP"]) {
      expect(c(400, { error: e }), e).toEqual({ action: "stop", code: e });
    }
    expect(c(413, { error: "CALL_TOO_LARGE" })).toEqual({ action: "stop", code: "CALL_TOO_LARGE" });
    expect(c(503, { error: "AI_USAGE_NOT_CONFIGURED" })).toEqual({ action: "next_slot", code: "AI_USAGE_NOT_CONFIGURED" });
    expect(c(429, null)).toEqual({ action: "next_slot", code: "HTTP_429" });
    expect(c(500, null)).toEqual({ action: "next_slot", code: "HTTP_500" });
    expect(c("network", undefined)).toEqual({ action: "next_slot", code: "NETWORK" });
    expect(c(404, null)).toEqual({ action: "stop", code: "HTTP_404" });
  });

  it("본문의 임의 문자열을 코드로 되돌리지 않는다", () => {
    expect(c(400, { error: "내부 오류: secret" })).toEqual({ action: "stop", code: "HTTP_400" });
  });
});

describe("정적 점검 — 순수 함수 모듈", () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ f, text: readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1") }));

  it("소스 파일", () => {
    expect(sources.map((s) => s.f).sort()).toEqual(["batch.ts", "constants.ts", "index.ts", "line.ts", "read.ts", "response.ts"]);
  });

  const BANNED: [string, RegExp][] = [
    ["console 호출", /\bconsole\s*\./],
    ["환경변수 읽기", /process\s*\.\s*env/],
    ["네트워크 호출", /\bfetch\s*\(|XMLHttpRequest|node:https?|node:net/],
    ["현재 시각 읽기", /Date\s*\.\s*now|new\s+Date\s*\(\s*\)/],
    ["난수(jti 기본값 제외)", /Math\s*\.\s*random/],
    ["DB 접근", /supabase|createClient|\bpg\b|node:fs/],
  ];

  for (const [label, re] of BANNED) {
    it(`${label} 없음`, () => {
      for (const s of sources) expect(re.test(s.text), `${s.f}: ${label}`).toBe(false);
    });
  }

  it("줄 코드에 회사 이름·금액·사용자·모델·기능 필드가 없다", () => {
    const text = sources.filter((s) => s.f === "line.ts").map((s) => s.text).join("\n");

    expect(/company|user_?id|email|est_?usd|price|model|feature/i.test(text)).toBe(false);
  });
});
