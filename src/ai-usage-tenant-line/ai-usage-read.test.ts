import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_USAGE_READ_ACTION,
  AI_USAGE_READ_MAX_BODY_BYTES,
  AI_USAGE_READ_MAX_IDS,
  AI_USAGE_READ_PATH,
  buildAiUsageReadCall,
  classifyAiUsageReadResponse,
  splitAiUsageReadIds,
} from "./index";

// 가짜 비밀·고정 시각·고정 jti. 레저코어 `buildReadBody`(ai-tenant-read.ts)의 본문 순서와 같은 값을 독립 계산으로 고정한다.
const SECRET = "test-secret-ai-usage-read-0123456789abcdef";
const NOW_MS = 1794657630000;
const JTI = "jti-1794657630-ai-usage-read";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const BODY_MONTH =
  '{"system":"wholesale","action":"ai_usage_read","ext_tenant":"BATCH","jti":"jti-1794657630-ai-usage-read","iat":1794657630,"exp":1794657690,"ext_ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],"month":"2026-11-01"}';
const SIG_MONTH = "570ab1501f708f2820a6124ff3f7f7012e31101a2d80fdd06b1619b37f833db8";
const BODY_NOMONTH =
  '{"system":"wholesale","action":"ai_usage_read","ext_tenant":"BATCH","jti":"jti-1794657630-ai-usage-read","iat":1794657630,"exp":1794657690,"ext_ids":["11111111-1111-4111-8111-111111111111"]}';
const SIG_NOMONTH = "99194cd079422ad3dbf6032f51ec78e82d9d7e5863c05c983c0890a016c5f224";
// 계약에 없는 값: 같은 본문에서 system 만 shipping 으로 바꾼 계산(레저코어와 교차 확인용).
const SIG_SHIPPING = "dcc847815724676c9db692c3f6e0a4c20895cfc365864a612394e02656dc17ca";

const deps = { now: NOW_MS, jti: JTI };

describe("상수", () => {
  it("계약 값", () => {
    expect(AI_USAGE_READ_ACTION).toBe("ai_usage_read");
    expect(AI_USAGE_READ_PATH).toBe("/api/provision/ai-usage-read");
    expect(AI_USAGE_READ_MAX_IDS).toBe(200);
    expect(AI_USAGE_READ_MAX_BODY_BYTES).toBe(8192);
  });
});

describe("buildAiUsageReadCall — 서명 벡터", () => {
  it("month 있음: 본문·서명이 바이트 단위로 같다", () => {
    const r = buildAiUsageReadCall(SECRET, "wholesale", [ID1, ID2], { ...deps, month: "2026-11-01" });

    expect(r).toEqual({ ok: true, body: BODY_MONTH, signature: SIG_MONTH });
  });

  it("month 없음: 키가 빠진다", () => {
    expect(buildAiUsageReadCall(SECRET, "wholesale", [ID1], deps)).toEqual({ ok: true, body: BODY_NOMONTH, signature: SIG_NOMONTH });
  });

  it("system shipping", () => {
    const r = buildAiUsageReadCall(SECRET, "shipping", [ID1, ID2], { ...deps, month: "2026-11-01" });

    expect(r.ok && r.signature).toBe(SIG_SHIPPING);
  });

  it("jti 생략 시 호출마다 다른 jti", () => {
    const a = buildAiUsageReadCall(SECRET, "wholesale", [ID1], { now: NOW_MS });
    const b = buildAiUsageReadCall(SECRET, "wholesale", [ID1], { now: NOW_MS });

    expect(a.ok && b.ok && a.body !== b.body).toBe(true);
  });

  it("ttl 은 exp-iat", () => {
    const r = buildAiUsageReadCall(SECRET, "wholesale", [ID1], { ...deps, ttl: 30 });

    expect(r.ok && JSON.parse(r.body).exp - JSON.parse(r.body).iat).toBe(30);
  });
});

describe("buildAiUsageReadCall — 검사", () => {
  const code = (ids: unknown, d: Record<string, unknown> = deps, secret = SECRET) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (buildAiUsageReadCall(secret, "wholesale", ids as any, d as any) as { code?: string }).code;

  it("개수", () => {
    expect(code([])).toBe("READ_BATCH");
    expect(code("x")).toBe("READ_BATCH");
    expect(code(Array.from({ length: 201 }, (_, i) => `a${i}`))).toBe("READ_BATCH");
  });

  it("id 형식", () => {
    expect(code(["a b"])).toBe("READ_ID");
    expect(code([""])).toBe("READ_ID");
    expect(code([1])).toBe("READ_ID");
    expect(code(["x".repeat(101)])).toBe("READ_ID");
  });

  it("중복", () => {
    expect(code([ID1, ID1])).toBe("READ_DUP");
  });

  it("month 형식", () => {
    expect(code([ID1], { ...deps, month: "2026-11-02" })).toBe("READ_MONTH");
    expect(code([ID1], { ...deps, month: "2026-13-01" })).toBe("READ_MONTH");
    expect(code([ID1], { ...deps, month: "2026-11" })).toBe("READ_MONTH");
  });

  it("jti 길이", () => {
    expect(code([ID1], { now: NOW_MS, jti: "short" })).toBe("READ_OPTIONS");
    expect(code([ID1], { now: NOW_MS, jti: "x".repeat(129) })).toBe("READ_OPTIONS");
  });

  it("비밀·ttl·now 오류는 코드로", () => {
    expect(code([ID1], deps, "")).toBe("SIGN_SECRET_INVALID");
    expect(code([ID1], { ...deps, ttl: 0 })).toBe("SIGN_TTL_INVALID");
    expect(code([ID1], { now: Number.NaN })).toBe("SIGN_NOW_INVALID");
  });

  it("본문 8,192바이트 초과는 CALL_TOO_LARGE (100자 id 200개)", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")}${"a".repeat(97)}`);

    expect(code(ids)).toBe("CALL_TOO_LARGE");
  });

  it("던지지 않는다", () => {
    expect(() => buildAiUsageReadCall(SECRET, "wholesale", null as never, null as never)).not.toThrow();
  });
});

describe("splitAiUsageReadIds", () => {
  const ids = (n: number, len = 36) => Array.from({ length: n }, (_, i) => `${String(i).padStart(4, "0")}${"a".repeat(len - 4)}`);
  const ok = (r: ReturnType<typeof splitAiUsageReadIds>) => {
    if (!r.ok) throw new Error(r.code);

    return r.batches;
  };

  it("빈 목록은 빈 배열", () => {
    expect(ok(splitAiUsageReadIds([]))).toEqual([]);
  });

  it("200개 이하 짧은 id 는 한 묶음", () => {
    expect(ok(splitAiUsageReadIds(ids(200, 20))).map((b) => b.length)).toEqual([200]);
  });

  it("201개는 200 + 1", () => {
    expect(ok(splitAiUsageReadIds(ids(201, 20))).map((b) => b.length)).toEqual([200, 1]);
  });

  it("100자 id 는 바이트 한도가 먼저 닿는다 — 각 묶음이 실제 서명 호출을 통과한다", () => {
    const all = ids(200, 100);
    const batches = ok(splitAiUsageReadIds(all));

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(all);

    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(200);
      expect(buildAiUsageReadCall(SECRET, "wholesale", b, { ...deps, month: "2026-11-01" }).ok).toBe(true);
    }
  });

  it("옵션", () => {
    expect(ok(splitAiUsageReadIds(ids(5, 20), { maxIds: 2 })).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(splitAiUsageReadIds([ID1], { maxIds: 0 })).toEqual({ ok: false, code: "READ_OPTIONS" });
    expect(splitAiUsageReadIds([ID1], { maxBodyBytes: 9000 })).toEqual({ ok: false, code: "READ_OPTIONS" });
    expect(splitAiUsageReadIds([ID1], { maxBodyBytes: 10 })).toEqual({ ok: false, code: "READ_OPTIONS" });
  });

  it("잘못된 입력", () => {
    expect(splitAiUsageReadIds("x")).toEqual({ ok: false, code: "READ_BATCH" });
    expect(splitAiUsageReadIds([ID1, "a b"])).toEqual({ ok: false, code: "READ_ID" });
    expect(splitAiUsageReadIds([ID1, ID1])).toEqual({ ok: false, code: "READ_DUP" });
  });
});

describe("classifyAiUsageReadResponse", () => {
  const c = classifyAiUsageReadResponse;
  const row = (ext_id: string, extra: Record<string, unknown> = {}) => ({ ext_id, linked: true, ledger_calls: 3, ledger_tokens: 1200, ...extra });

  it("200 — 요청한 id 의 알려진 키만 남긴다", () => {
    const r = c(200, { month: "2026-11-01", rows: [row(ID1, { company: "비밀상사", amount: 9 }), row(ID2)] }, [ID1, ID2]);

    expect(r).toEqual({
      action: "ok",
      month: "2026-11-01",
      rows: [
        { ext_id: ID1, linked: true, ledger_calls: 3, ledger_tokens: 1200 },
        { ext_id: ID2, linked: true, ledger_calls: 3, ledger_tokens: 1200 },
      ],
      dropped: 0,
    });
  });

  it("R1: 요청하지 않은 id 의 행은 버린다", () => {
    const r = c(200, { month: "2026-11-01", rows: [row(ID1), row("other-tenant")] }, [ID1]);

    expect(r).toEqual({ action: "ok", month: "2026-11-01", rows: [{ ext_id: ID1, linked: true, ledger_calls: 3, ledger_tokens: 1200 }], dropped: 1 });
  });

  it("중복 행은 첫 번째만", () => {
    const r = c(200, { month: "2026-11-01", rows: [row(ID1), row(ID1, { ledger_tokens: 5 })] }, [ID1]);

    expect(r.action === "ok" && r.rows).toEqual([{ ext_id: ID1, linked: true, ledger_calls: 3, ledger_tokens: 1200 }]);
  });

  it("정수·불리언 검사: 소수·음수·문자열·NaN·큰 수는 행을 버린다", () => {
    const bad = [
      row(ID1, { ledger_tokens: 1.5 }),
      row(ID1, { ledger_tokens: -1 }),
      row(ID1, { ledger_calls: "3" }),
      row(ID1, { ledger_tokens: Number.NaN }),
      row(ID1, { ledger_tokens: Number.MAX_SAFE_INTEGER + 2 }),
      row(ID1, { linked: "true" }),
      null,
      "x",
    ];

    for (const b of bad) {
      expect(c(200, { month: "2026-11-01", rows: [b] }, [ID1])).toEqual({ action: "ok", month: "2026-11-01", rows: [], dropped: 1 });
    }
  });

  it("연결 없음(linked:false, 0)은 그대로 통과", () => {
    const r = c(200, { month: "2026-11-01", rows: [row(ID1, { linked: false, ledger_calls: 0, ledger_tokens: 0 })] }, [ID1]);

    expect(r.action === "ok" && r.rows[0]).toEqual({ ext_id: ID1, linked: false, ledger_calls: 0, ledger_tokens: 0 });
  });

  it("200 인데 모양이 틀리면 stop", () => {
    expect(c(200, null, [ID1])).toEqual({ action: "stop", code: "UNKNOWN_RESPONSE" });
    expect(c(200, { month: "2026-11-01" }, [ID1])).toEqual({ action: "stop", code: "UNKNOWN_RESPONSE" });
    expect(c(200, { rows: [] }, [ID1])).toEqual({ action: "stop", code: "UNKNOWN_RESPONSE" });
    expect(c(200, { month: "2026-11-05", rows: [] }, [ID1])).toEqual({ action: "stop", code: "UNKNOWN_RESPONSE" });
    expect(c(200, { month: "2026-11-01", rows: {} }, [ID1])).toEqual({ action: "stop", code: "UNKNOWN_RESPONSE" });
    expect(c(200, [], [ID1])).toEqual({ action: "stop", code: "UNKNOWN_RESPONSE" });
  });

  it("오류 분류", () => {
    expect(c(401, { error: "CALL_EXPIRED" }, [ID1])).toEqual({ action: "retry_resign", code: "CALL_EXPIRED" });
    expect(c(401, { error: "CALL_BAD_SIGNATURE" }, [ID1])).toEqual({ action: "stop", code: "CALL_BAD_SIGNATURE" });
    expect(c(429, null, [ID1])).toEqual({ action: "retry_later", code: "HTTP_429" });
    expect(c(503, { error: "AI_USAGE_NOT_CONFIGURED" }, [ID1])).toEqual({ action: "retry_later", code: "AI_USAGE_NOT_CONFIGURED" });
    expect(c(500, { error: "AI_USAGE_FAILED" }, [ID1])).toEqual({ action: "retry_later", code: "AI_USAGE_FAILED" });
    expect(c("network", undefined, [ID1])).toEqual({ action: "retry_later", code: "NETWORK" });
    expect(c(400, { error: "READ_REJECTED" }, [ID1])).toEqual({ action: "stop", code: "READ_REJECTED" });
    expect(c(400, { error: "READ_EXTRA_KEY" }, [ID1])).toEqual({ action: "stop", code: "READ_EXTRA_KEY" });
    expect(c(413, { error: "CALL_TOO_LARGE" }, [ID1])).toEqual({ action: "stop", code: "CALL_TOO_LARGE" });
    expect(c(404, null, [ID1])).toEqual({ action: "stop", code: "HTTP_404" });
  });

  it("본문의 임의 문자열을 코드로 되돌리지 않는다", () => {
    expect(c(400, { error: "내부 오류: secret" }, [ID1])).toEqual({ action: "stop", code: "HTTP_400" });
  });

  it("던지지 않는다", () => {
    expect(() => c(200, { month: "2026-11-01", rows: [row(ID1)] }, null as never)).not.toThrow();
  });
});

describe("정적 점검 — read.ts", () => {
  const text = readFileSync(join(__dirname, "read.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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
      expect(re.test(text)).toBe(false);
    });
  }
});
