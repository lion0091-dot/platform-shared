import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Keyring, SecretError, loadKeyring, openSecret } from "../secrets/index";
import {
  AI_DEFAULT_SCOPE,
  AI_HOOK_TIMEOUT_MS,
  AI_PROVIDER,
  AI_RESERVE_CODES,
  AI_RPC_DEFAULTS,
  AiSharedKeyError,
  NEAR_LIMIT_PCT,
  aiReserveReason,
  assertNoForbiddenKeys,
  createAiSharedKey,
  estimateCostUsd,
  filterAiRows,
  keyHint,
  markPlatformKeyInvalid,
  recordPlatformAiUsage,
  reservePlatformAiUsage,
  resolveRpcNames,
  sealPlatformAiKey,
  validateAiKeyShape,
  withPlatformAiKey,
  anthropicVerifier,
  type AiCompanyRow,
  type AiRpc,
} from "./index";

// 시험용 가짜 값만 쓴다(실제 키·마스터 키 아님).
const hex = () => randomBytes(32).toString("hex");
const ENV_NAME = "TEST_AI_MASTER_KEY";
const ringA = () => loadKeyring({ [ENV_NAME]: KA }, { current: ENV_NAME });
const KA = hex();
const KB = hex();
const FAKE_KEY = "test-fake-key-" + "A1b2C3d4E5f6G7h8I9j0";
const T1 = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";

function fakeRpc(handler: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: string } | Promise<{ data?: unknown; error?: string }>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const sb: AiRpc = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const r = await handler(fn, args);
      return { data: r.data ?? null, error: r.error ? { message: r.error } : null };
    },
  };
  return { sb, calls };
}

describe("키 모양·힌트", () => {
  it("경계: 19자 거부, 20자 허용, 400자 허용, 401자 거부", () => {
    expect(validateAiKeyShape("a".repeat(19))).toEqual({ ok: false, code: "AI_KEY_SHAPE" });
    expect(validateAiKeyShape("a".repeat(20)).ok).toBe(true);
    expect(validateAiKeyShape("a".repeat(400)).ok).toBe(true);
    expect(validateAiKeyShape("a".repeat(401))).toEqual({ ok: false, code: "AI_KEY_SHAPE" });
  });
  it("비문자열·빈 문자열은 EMPTY, 공백·한글·제어문자는 SHAPE, 앞뒤 공백은 잘라 허용", () => {
    expect(validateAiKeyShape(undefined)).toEqual({ ok: false, code: "AI_KEY_EMPTY" });
    expect(validateAiKeyShape("   ")).toEqual({ ok: false, code: "AI_KEY_EMPTY" });
    expect(validateAiKeyShape("abcdefghij klmnopqrstuv")).toEqual({ ok: false, code: "AI_KEY_SHAPE" });
    expect(validateAiKeyShape("한글".repeat(12))).toEqual({ ok: false, code: "AI_KEY_SHAPE" });
    expect(validateAiKeyShape("abcdefghij\u0007klmnopqrstuv")).toEqual({ ok: false, code: "AI_KEY_SHAPE" });
    expect(validateAiKeyShape(`  ${FAKE_KEY}  `)).toEqual({ ok: true, key: FAKE_KEY });
  });
  it("힌트는 영숫자 끝 4자", () => {
    expect(keyHint("abc-def_ghij-1234")).toBe("1234");
    expect(keyHint("ab-c")).toBe("abc");
  });
});

describe("봉인·복호화", () => {
  it("봉인→복호화 왕복, 기본 AAD 는 platform-ai|ai-claude", () => {
    const sealed = sealPlatformAiKey(FAKE_KEY, ringA());
    expect(sealed.ciphertext).toMatch(/^ENC:v2:[0-9a-f]{8}:[A-Za-z0-9_-]{16,}$/);
    expect(sealed.ciphertext).not.toContain(FAKE_KEY);
    expect(openSecret(sealed.ciphertext, { tenantId: AI_DEFAULT_SCOPE, provider: AI_PROVIDER }, ringA()).plain).toBe(FAKE_KEY);
  });
  it("모양이 틀린 키는 봉인하지 않는다", () => {
    expect(() => sealPlatformAiKey("short", ringA())).toThrow(SecretError);
  });
  it("scope 가 다르면 다른 범위에서 열리지 않는다", () => {
    const sealed = sealPlatformAiKey(FAKE_KEY, ringA(), { scope: "other-scope" });
    expect(() => openSecret(sealed.ciphertext, { tenantId: AI_DEFAULT_SCOPE, provider: AI_PROVIDER }, ringA())).toThrow(SecretError);
  });
});

describe("withPlatformAiKey 3분기", () => {
  const sealed = sealPlatformAiKey(FAKE_KEY, ringA()).ciphertext;
  it("ok: 콜백에만 키가 전달되고 반환값에는 없다", async () => {
    const { sb } = fakeRpc(() => ({ data: sealed }));
    let seen = "";
    const r = await withPlatformAiKey(sb, async (k) => ((seen = k), "done"), ringA());
    expect(r).toEqual({ state: "ok", value: "done" });
    expect(seen).toBe(FAKE_KEY);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });
  it("off: 암호문이 NULL", async () => {
    const { sb } = fakeRpc(() => ({ data: null }));
    expect(await withPlatformAiKey(sb, async () => 1, ringA())).toEqual({ state: "off" });
  });
  it("unavailable: RPC 오류·예외 → READ_FAILED, 키 불일치 → 코드만, 콜백 예외 → AI_CALL_FAILED(키 비노출)", async () => {
    expect(await withPlatformAiKey(fakeRpc(() => ({ error: "boom" })).sb, async () => 1, ringA())).toEqual({ state: "unavailable", reason: "READ_FAILED" });
    const thrower: AiRpc = { rpc: () => Promise.reject(new Error("net")) };
    expect(await withPlatformAiKey(thrower, async () => 1, ringA())).toEqual({ state: "unavailable", reason: "READ_FAILED" });
    const wrongRing = () => loadKeyring({ [ENV_NAME]: KB }, { current: ENV_NAME });
    const r1 = await withPlatformAiKey(fakeRpc(() => ({ data: sealed })).sb, async () => 1, wrongRing);
    expect(r1.state).toBe("unavailable");
    const r2 = await withPlatformAiKey(fakeRpc(() => ({ data: sealed })).sb, async (k) => { throw new Error(`leak ${k}`); }, ringA());
    expect(r2).toEqual({ state: "unavailable", reason: "AI_CALL_FAILED" });
    expect(JSON.stringify([r1, r2])).not.toContain(FAKE_KEY);
  });
  it("cipher RPC 이름·인자: 기본값과 덮어쓰기", async () => {
    const a = fakeRpc(() => ({ data: null }));
    await withPlatformAiKey(a.sb, async () => 1, ringA());
    expect(a.calls[0]).toEqual({ fn: "platform_ai_cipher", args: { p_provider: "ai-claude" } });
    const b = fakeRpc(() => ({ data: null }));
    await withPlatformAiKey(b.sb, async () => 1, ringA(), { rpcNames: { cipher: "ai_cipher" } });
    expect(b.calls[0].fn).toBe("ai_cipher");
  });
});

describe("예약", () => {
  it("성공 응답", async () => {
    const { sb, calls } = fakeRpc(() => ({ data: { ok: true, calls: 3, tokens: 900 } }));
    expect(await reservePlatformAiUsage(sb, T1, 1, 300)).toEqual({ ok: true, calls: 3, tokens: 900 });
    expect(calls[0]).toEqual({ fn: "platform_ai_reserve", args: { p_tenant: T1, p_provider: "ai-claude", p_calls: 1, p_tokens: 300 } });
  });
  it("코드 6종은 그대로, 알 수 없는 코드·형식·오류·예외는 READ_FAILED", async () => {
    for (const code of AI_RESERVE_CODES) {
      expect(await reservePlatformAiUsage(fakeRpc(() => ({ data: { ok: false, code } })).sb, T1, 1, 1)).toEqual({ ok: false, code });
    }
    for (const data of [{ ok: false, code: "NEW_CODE" }, { ok: false }, "str", null, [], { ok: "true" }]) {
      expect(await reservePlatformAiUsage(fakeRpc(() => ({ data })).sb, T1, 1, 1)).toEqual({ ok: false, code: "READ_FAILED" });
    }
    expect(await reservePlatformAiUsage(fakeRpc(() => ({ error: "x" })).sb, T1, 1, 1)).toEqual({ ok: false, code: "READ_FAILED" });
    expect(await reservePlatformAiUsage({ rpc: () => { throw new Error("sync"); } } as AiRpc, T1, 1, 1)).toEqual({ ok: false, code: "READ_FAILED" });
  });
  it("aiReserveReason: 모르는 코드는 UNKNOWN(앱 폴백)", () => {
    expect(aiReserveReason("LIMIT_EXCEEDED")).toBe("LIMIT_EXCEEDED");
    expect(aiReserveReason("READ_FAILED")).toBe("READ_FAILED");
    expect(aiReserveReason("SOMETHING_NEW")).toBe("UNKNOWN");
  });
});

describe("무효 표시", () => {
  it("INVALID 로 표시하고, 실패해도 던지지 않는다", async () => {
    const { sb, calls } = fakeRpc(() => ({ data: "INVALID" }));
    await markPlatformKeyInvalid(sb, "HTTP_401");
    expect(calls[0]).toEqual({ fn: "platform_ai_key_mark", args: { p_provider: "ai-claude", p_status: "INVALID", p_code: "HTTP_401" } });
    await expect(markPlatformKeyInvalid({ rpc: () => Promise.reject(new Error("x")) } as AiRpc, "HTTP_403")).resolves.toBeUndefined();
  });
});

describe("record + onRecorded 훅", () => {
  const args = { tenantId: T1, reserved: 500, input: 100, output: 50, cache: 10, failed: false };
  it("RPC 인자 매핑, 훅은 성공 뒤에 meta 와 함께 호출", async () => {
    const { sb, calls } = fakeRpc(() => ({ data: null }));
    const hook = vi.fn();
    const r = await recordPlatformAiUsage(sb, args, { feature: "f1", model: "m1" }, hook);
    expect(r).toEqual({ ok: true });
    expect(calls[0]).toEqual({ fn: "platform_ai_record", args: { p_tenant: T1, p_provider: "ai-claude", p_reserved: 500, p_input: 100, p_output: 50, p_cache: 10, p_failed: false } });
    expect(hook).toHaveBeenCalledWith(args, { feature: "f1", model: "m1" });
  });
  it("RPC 가 실패하면 훅을 부르지 않는다(오류·예외 모두), 던지지 않는다", async () => {
    const hook = vi.fn();
    expect(await recordPlatformAiUsage(fakeRpc(() => ({ error: "NOT_FOUND: ai usage row" })).sb, args, undefined, hook)).toEqual({ ok: false, code: "READ_FAILED" });
    expect(await recordPlatformAiUsage({ rpc: () => Promise.reject(new Error("x")) } as AiRpc, args, undefined, hook)).toEqual({ ok: false, code: "READ_FAILED" });
    expect(hook).not.toHaveBeenCalled();
  });
  it("0 사용(가림 차단 정산)도 RPC 성공이면 훅 호출, failed 전달", async () => {
    const { sb, calls } = fakeRpc(() => ({ data: null }));
    const hook = vi.fn();
    await recordPlatformAiUsage(sb, { tenantId: T1, reserved: 500, input: 0, output: 0, cache: 0, failed: true }, { feature: "f" }, hook);
    expect(calls[0].args.p_failed).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });
  it("훅의 예외는 결과에 영향이 없고 hookError 만 표시", async () => {
    const r = await recordPlatformAiUsage(fakeRpc(() => ({ data: null })).sb, args, undefined, () => { throw new Error("detail failed"); });
    expect(r).toEqual({ ok: true, hookError: true });
    const r2 = await recordPlatformAiUsage(fakeRpc(() => ({ data: null })).sb, args, undefined, async () => { throw new Error("async fail"); });
    expect(r2).toEqual({ ok: true, hookError: true });
  });
  it("훅이 2초를 넘으면 포기하고 hookError", async () => {
    vi.useFakeTimers();
    try {
      const p = recordPlatformAiUsage(fakeRpc(() => ({ data: null })).sb, args, undefined, () => new Promise<void>(() => {}));
      await vi.advanceTimersByTimeAsync(AI_HOOK_TIMEOUT_MS + 10);
      expect(await p).toEqual({ ok: true, hookError: true });
    } finally {
      vi.useRealTimers();
    }
  });
  it("잘못된 인자는 RPC 를 부르지 않는다", async () => {
    const { sb, calls } = fakeRpc(() => ({ data: null }));
    for (const bad of [{ ...args, tenantId: "nope" }, { ...args, input: -1 }, { ...args, output: Number.NaN }]) {
      expect(await recordPlatformAiUsage(sb, bad, undefined, undefined)).toEqual({ ok: false, code: "INVALID_ARGS" });
    }
    expect(calls.length).toBe(0);
  });
});

describe("createAiSharedKey / 관리 액션", () => {
  const mk = (handler: Parameters<typeof fakeRpc>[0], extra: Partial<Parameters<typeof createAiSharedKey>[0]> = {}) => {
    const f = fakeRpc(handler);
    const ai = createAiSharedKey({ rpc: f.sb, masterKeyEnv: ENV_NAME, env: { [ENV_NAME]: KA }, ...extra });
    return { ai, ...f };
  };
  it("masterKeyEnv 는 필수(기본 이름 없음)", () => {
    expect(() => createAiSharedKey({ rpc: fakeRpc(() => ({})).sb, masterKeyEnv: "" })).toThrow(AiSharedKeyError);
  });
  it("registerKey: 사유 필수, 모양 검사, 확인 호출, 봉인 후 저장, 반환에 키 없음", async () => {
    const verifyKey = vi.fn(async () => true);
    const { ai, calls } = mk(() => ({ data: { version: 2, status: "ACTIVE" } }), { verifyKey });
    await expect(ai.registerKey(ACTOR, { key: FAKE_KEY, reason: "", confirm: "ai-claude" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(ai.registerKey(ACTOR, { key: "short", reason: "r", confirm: "ai-claude" })).rejects.toMatchObject({ code: "AI_CREDENTIAL_INVALID" });
    expect(calls.length).toBe(0);
    const r = await ai.registerKey(ACTOR, { key: FAKE_KEY, reason: "초기 등록", confirm: "ai-claude" });
    expect(r).toEqual({ version: 2, status: "ACTIVE", verified: true });
    expect(verifyKey).toHaveBeenCalledWith(FAKE_KEY);
    const saved = calls[0];
    expect(saved.fn).toBe("platform_ai_key_save");
    expect(Object.keys(saved.args)).toEqual(["p_actor", "p_ciphertext", "p_hint", "p_verified", "p_reason", "p_confirm"]);
    expect(String(saved.args.p_ciphertext)).toMatch(/^ENC:v2:/);
    expect(JSON.stringify([r, saved.args])).not.toContain(FAKE_KEY);
    expect(saved.args.p_hint).toBe(keyHint(FAKE_KEY));
  });
  it("verifyKey 가 없거나 던지면 verified=false 로 저장", async () => {
    const a = mk(() => ({ data: { version: 1, status: "SUSPENDED" } }));
    expect((await a.ai.registerKey(ACTOR, { key: FAKE_KEY, reason: "r", confirm: "ai-claude" })).verified).toBe(false);
    const b = mk(() => ({ data: { version: 1, status: "SUSPENDED" } }), { verifyKey: async () => { throw new Error("x"); } });
    expect((await b.ai.registerKey(ACTOR, { key: FAKE_KEY, reason: "r", confirm: "ai-claude" })).verified).toBe(false);
  });
  it("한도·uuid·사유 입력 검증", async () => {
    const { ai, calls } = mk(() => ({ data: null }));
    await expect(ai.setCap(ACTOR, { calls: "-1", tokens: "", reason: "r" })).rejects.toMatchObject({ code: "AI_LIMIT_INVALID" });
    await expect(ai.setCap(ACTOR, { calls: "1.5", tokens: "", reason: "r" })).rejects.toMatchObject({ code: "AI_LIMIT_INVALID" });
    await expect(ai.setCap(ACTOR, { calls: "100000001", tokens: "", reason: "r" })).rejects.toMatchObject({ code: "AI_LIMIT_INVALID" });
    await expect(ai.setCap(ACTOR, { calls: "", tokens: "", reason: "x".repeat(501) })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(ai.companyOverview(ACTOR, "not-a-uuid")).rejects.toMatchObject({ code: "PLATFORM_INVALID" });
    await expect(ai.switchCompany(ACTOR, { tenantId: "x", enabled: false, reason: "r", confirm: "" })).rejects.toMatchObject({ code: "PLATFORM_INVALID" });
    expect(calls.length).toBe(0);
    await ai.setCap(ACTOR, { calls: "", tokens: "5000", reason: "r" });
    expect(calls[0]).toEqual({ fn: "platform_ai_set_cap", args: { p_actor: ACTOR, p_calls: null, p_tokens: 5000, p_reason: "r" } });
  });
  it("DB 오류 문구의 CODE: 접두를 코드로, 없으면 RPC_FAILED", async () => {
    const a = mk(() => ({ error: "PLATFORM_CONFIRM_REQUIRED: type the provider name" }));
    await expect(a.ai.revokeKey(ACTOR, { reason: "r", confirm: "" })).rejects.toMatchObject({ code: "PLATFORM_CONFIRM_REQUIRED" });
    const b = mk(() => ({ error: "connection reset" }));
    await expect(b.ai.keyStatus(ACTOR)).rejects.toMatchObject({ code: "RPC_FAILED" });
  });
  it("keyStatus·companyList·companyOverview 응답 정규화, 모르는 키는 무시", async () => {
    const list = {
      month: "2026-11-01", key_active: true, truncated: false, extra: 1,
      rows: [{ tenant_id: T1, name: "회사A", platform_enabled: true, owner_off: false, configured: true, usable: true, calls: "3", tokens: 10, failures: 0, call_limit: 100, token_limit: null, call_pct: 3, token_pct: null, unknown_col: "x" }],
    };
    const { ai } = mk((fn) => ({ data: fn === "platform_ai_company_list" ? list : fn === "platform_ai_key_status" ? { registered: true, version: 1, status: "ACTIVE", key_hint: "abcd", month: "2026-11-01", calls: 1, tokens: 2 } : { platform_enabled: true, month: "2026-11-01" } }));
    const l = await ai.companyList(ACTOR);
    expect(l.rows[0]).toMatchObject({ tenant_id: T1, calls: 3, token_limit: null, owner_off_at: null });
    expect(l.rows[0]).not.toHaveProperty("unknown_col");
    expect((await ai.keyStatus(ACTOR)).key_hint).toBe("abcd");
    expect((await ai.companyOverview(ACTOR, T1.toUpperCase())).platform_enabled).toBe(true);
  });
  it("companyList 형식이 틀리면 NOT_FOUND", async () => {
    const { ai } = mk(() => ({ data: { rows: "x" } }));
    await expect(ai.companyList(ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rpcNames 덮어쓰기가 모든 경로에 적용, 모르는 키·잘못된 이름은 거부", async () => {
    const { ai, calls } = mk(() => ({ data: { ok: false, code: "NO_ACTIVE_KEY" } }), { rpcNames: { reserve: "ai_reserve" } });
    await ai.reserve(T1, 1, 1);
    expect(calls[0].fn).toBe("ai_reserve");
    expect(() => resolveRpcNames({ nope: "x" } as never)).toThrow(AiSharedKeyError);
    expect(() => resolveRpcNames({ reserve: "bad name; drop" })).toThrow(AiSharedKeyError);
  });
  it("record 는 config.onRecorded 훅을 쓴다", async () => {
    const onRecorded = vi.fn();
    const { ai } = mk(() => ({ data: null }), { onRecorded });
    await ai.record({ tenantId: T1, reserved: 1, input: 1, output: 1, cache: 0 }, { feature: "x" });
    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T1 }), { feature: "x" });
  });
  it("키링은 env 에서 읽고, 마스터 키 값이 없으면 withKey 는 unavailable(코드만)", async () => {
    const cipher = sealPlatformAiKey(FAKE_KEY, ringA()).ciphertext;
    const { ai } = mk(() => ({ data: cipher }));
    expect((await ai.withKey(async (k) => k.length)).state).toBe("ok");
    const f = fakeRpc(() => ({ data: cipher }));
    const noKey = createAiSharedKey({ rpc: f.sb, masterKeyEnv: ENV_NAME, env: {} });
    const r = await noKey.withKey(async () => 1);
    expect(r).toEqual({ state: "unavailable", reason: "SECRET_KEY_MISSING" });
  });
});

describe("공급사 확인", () => {
  it("모델 ID 형식이 틀리면 호출 없이 false, 성공은 true, 실패·예외는 false, 키는 헤더로만", async () => {
    const f = vi.fn(async () => ({ ok: true }) as Response);
    expect(await anthropicVerifier("bad model!", f as never)(FAKE_KEY)).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(await anthropicVerifier("model-x", f as never)(FAKE_KEY)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(FAKE_KEY);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(FAKE_KEY);
    expect(await anthropicVerifier("model-x", (async () => ({ ok: false }) as Response) as never)(FAKE_KEY)).toBe(false);
    expect(await anthropicVerifier("model-x", (async () => { throw new Error("x"); }) as never)(FAKE_KEY)).toBe(false);
  });
});

describe("타입 서브패스의 순수 함수", () => {
  const row = (o: Partial<AiCompanyRow>): AiCompanyRow => ({ tenant_id: T1, name: "n", platform_enabled: true, owner_off: false, owner_off_at: null, owner_off_role: null, configured: true, usable: true, calls: 0, tokens: 0, failures: 0, call_limit: null, token_limit: null, call_pct: null, token_pct: null, ...o });
  it("filterAiRows 5종, 근접 기준 80%", () => {
    const rows = [row({ tenant_id: "a" }), row({ tenant_id: "b", usable: false, platform_enabled: false }), row({ tenant_id: "c", owner_off: true, usable: false }), row({ tenant_id: "d", call_pct: NEAR_LIMIT_PCT }), row({ tenant_id: "e", token_pct: NEAR_LIMIT_PCT - 1 })];
    const ids = (f: Parameters<typeof filterAiRows>[1]) => filterAiRows(rows, f).map((r) => r.tenant_id);
    expect(ids("all")).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids("usable")).toEqual(["a", "d", "e"]);
    expect(ids("platform_closed")).toEqual(["b"]);
    expect(ids("tenant_paused")).toEqual(["c"]);
    expect(ids("near_limit")).toEqual(["d"]);
  });
  it("assertNoForbiddenKeys: 중첩·배열까지 검사, 힌트·상태 키는 통과", () => {
    expect(() => assertNoForbiddenKeys({ key_hint: "abcd", status: "ACTIVE", rows: [{ name: "x" }] })).not.toThrow();
    expect(() => assertNoForbiddenKeys({ rows: [{ a: { ciphertext: "x" } }] })).toThrow(AiSharedKeyError);
    expect(() => assertNoForbiddenKeys({ api_key: "x" })).toThrow(AiSharedKeyError);
    expect(() => assertNoForbiddenKeys({ Secret: 1 })).toThrow(AiSharedKeyError);
  });
  it("estimateCostUsd: 추정 표시 강제, 모르는 모델·잘못된 수는 null, prototype 키 거부", () => {
    const prices = { date: "2026-11-14", models: { m1: { input: 1, output: 5, cache: 0.1 }, m2: { input: 2, output: 4 } } };
    expect(estimateCostUsd({ model: "m1", input: 1_000_000, output: 200_000, cache: 1_000_000 }, prices)).toEqual({ usd: 2.1, estimated: true, priceDate: "2026-11-14" });
    expect(estimateCostUsd({ model: "m2", input: 500_000, output: 0, cache: 1_000_000 }, prices).usd).toBe(3); // cache 단가 없으면 input 단가
    expect(estimateCostUsd({ model: "zz", input: 1, output: 1 }, prices).usd).toBeNull();
    expect(estimateCostUsd({ model: "toString", input: 1, output: 1 }, prices).usd).toBeNull();
    expect(estimateCostUsd({ model: "m1", input: -1, output: 1 }, prices).usd).toBeNull();
  });
  it("RPC 기본 이름은 계약 v1(16개)", () => {
    expect(Object.keys(AI_RPC_DEFAULTS).length).toBe(16);
    expect(AI_RPC_DEFAULTS.reserve).toBe("platform_ai_reserve");
  });
  it("Keyring 객체는 직렬화에 키 바이트를 노출하지 않는다(secrets 와 같은 보장 확인)", () => {
    expect(JSON.stringify(ringA())).not.toContain(KA);
    expect(ringA()).toBeInstanceOf(Keyring);
  });
});
