/**
 * 공용 AI 키(방식 B) 서버 모듈 — 서버 전용(node:crypto). 클라이언트 번들에 넣지 않는다(타입·순수 함수는 `/types`).
 * 설계: docs/design-ai-shared-key-module-2026-11.md
 *
 * 원칙: ① 키 평문은 `sealPlatformAiKey` 입력, 공급사 확인 호출, `withPlatformAiKey` 콜백 인자 밖으로 나가지 않는다(로그·반환값·오류 문구에 넣지 않음).
 *       ② 복호화는 «호출 직전» `withPlatformAiKey` 한 곳에서만, 사용량 예약이 통과한 뒤에만 한다.
 *       ③ 마스터 키는 환경변수 «이름»만 받는다(값은 읽어도 출력하지 않음). 이 모듈에는 기본 이름이 없다.
 */
import { Keyring, SecretError, loadKeyring, openSecret, sealSecret } from "../secrets/index";
import {
  AI_DEFAULT_SCOPE,
  AI_PROVIDER,
  AiSharedKeyError,
  isUuid,
  resolveRpcNames,
  AI_RESERVE_CODES,
  type AiCompanyList,
  type AiCompanyOverview,
  type AiKeyMarkStatus,
  type AiKeyStatus,
  type AiKeyUse,
  type AiRecordArgs,
  type AiRecordMeta,
  type AiRecordResult,
  type AiReserveCode,
  type AiReserveResult,
  type AiRpc,
  type AiRpcNames,
} from "./types";

export * from "./types";

/** 훅(상세 기록)을 기다리는 최대 시간. 넘으면 포기하고 결과에 hookError 만 표시한다. */
export const AI_HOOK_TIMEOUT_MS = 2000;

export interface AiOpts {
  provider?: string;
  scope?: string;
  rpcNames?: Partial<AiRpcNames>;
}
type Ring = Keyring | (() => Keyring);
const ringOf = (r: Ring): Keyring => (typeof r === "function" ? r() : r);
const ctxOf = (o?: AiOpts) => ({ tenantId: o?.scope ?? AI_DEFAULT_SCOPE, provider: o?.provider ?? AI_PROVIDER });

// ───────── 키 모양·힌트 ─────────
/** 입력한 키의 «모양»만 검사한다(공급사 형식은 가정하지 않음): 20~400자, 공백·제어문자·한글 없음. 통과해도 유효한 키라는 뜻은 아니다. */
export function validateAiKeyShape(plain: unknown): { ok: true; key: string } | { ok: false; code: "AI_KEY_EMPTY" | "AI_KEY_SHAPE" } {
  if (typeof plain !== "string") return { ok: false, code: "AI_KEY_EMPTY" };
  const key = plain.trim();
  if (key === "") return { ok: false, code: "AI_KEY_EMPTY" };
  if (key.length < 20 || key.length > 400 || !/^[\x21-\x7e]+$/.test(key)) return { ok: false, code: "AI_KEY_SHAPE" };
  return { ok: true, key };
}

/** 화면 표시용 힌트: 끝 4글자(영숫자만). 영숫자가 아닌 글자는 건너뛴다. */
export function keyHint(plain: string): string {
  return plain.replace(/[^A-Za-z0-9]/g, "").slice(-4);
}

// ───────── 봉인·복호화 ─────────
export function sealPlatformAiKey(plain: string, ring: Ring, opts?: AiOpts): { ciphertext: string; hint: string } {
  const shape = validateAiKeyShape(plain);
  if (!shape.ok) throw new SecretError("SECRET_FORMAT");
  return { ciphertext: sealSecret(shape.key, ctxOf(opts), ringOf(ring)), hint: keyHint(shape.key) };
}

/**
 * 호출 직전 한 곳: 현재 공용 키(ACTIVE 일 때만)의 암호문을 읽어 복호화해 콜백에만 넘긴다. 이 함수는 예약이 통과한 뒤에만 부른다.
 * 오류는 코드만 돌려주고 키·암호문은 어떤 문자열에도 넣지 않는다.
 */
export async function withPlatformAiKey<T>(sb: AiRpc, fn: (key: string) => Promise<T>, ring: Ring, opts?: AiOpts): Promise<AiKeyUse<T>> {
  const names = resolveRpcNames(opts?.rpcNames);
  const ctx = ctxOf(opts);
  let cipher: unknown;
  try {
    const r = await sb.rpc(names.cipher, { p_provider: ctx.provider });
    if (r.error) return { state: "unavailable", reason: "READ_FAILED" };
    cipher = r.data;
  } catch {
    return { state: "unavailable", reason: "READ_FAILED" };
  }
  if (cipher === null || cipher === undefined) return { state: "off" };
  let key: string;
  try {
    key = openSecret(String(cipher), ctx, ringOf(ring)).plain;
  } catch (e) {
    return { state: "unavailable", reason: e instanceof SecretError ? e.code : "DECRYPT_FAILED" };
  }
  try {
    return { state: "ok", value: await fn(key) };
  } catch {
    return { state: "unavailable", reason: "AI_CALL_FAILED" };
  }
}

// ───────── 예약·기록·무효 표시 ─────────
const RESERVE_SET: ReadonlySet<string> = new Set(AI_RESERVE_CODES);
/** 사용량 예약(원자, 서버). 알 수 없는 응답은 READ_FAILED(호출하지 않음). */
export async function reservePlatformAiUsage(sb: AiRpc, tenantId: string, calls: number, tokens: number, opts?: AiOpts): Promise<AiReserveResult> {
  const names = resolveRpcNames(opts?.rpcNames);
  let r;
  try {
    r = await sb.rpc(names.reserve, { p_tenant: tenantId, p_provider: ctxOf(opts).provider, p_calls: calls, p_tokens: tokens });
  } catch {
    return { ok: false, code: "READ_FAILED" };
  }
  if (r.error || !r.data || typeof r.data !== "object") return { ok: false, code: "READ_FAILED" };
  const d = r.data as { ok?: boolean; code?: string; calls?: number; tokens?: number };
  if (d.ok === true) return { ok: true, calls: Number(d.calls), tokens: Number(d.tokens) };
  return { ok: false, code: RESERVE_SET.has(String(d.code)) ? (d.code as AiReserveCode) : "READ_FAILED" };
}

/** 공급사 401·403 이면 공용 키를 INVALID 로 표시한다. 429 는 표시하지 않는다. 실패해도 호출 흐름은 막지 않는다. */
export async function markPlatformKeyInvalid(sb: AiRpc, code: "HTTP_401" | "HTTP_403", opts?: AiOpts): Promise<void> {
  const names = resolveRpcNames(opts?.rpcNames);
  try {
    await sb.rpc(names.keyMark, { p_provider: ctxOf(opts).provider, p_status: "INVALID" satisfies AiKeyMarkStatus, p_code: code });
  } catch {
    /* 표시 실패는 무시: 다음 호출이 다시 시도한다 */
  }
}

export type AiRecordHook = (args: AiRecordArgs, meta?: AiRecordMeta) => void | Promise<void>;

const nonNeg = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * 실제 사용량 기록. 절대 던지지 않는다. 훅은 RPC 가 «성공한 뒤에만» 불리고, 훅의 예외·실패·지연(2초 초과)은
 * 결과와 AI 호출 결과에 영향을 주지 않는다(결과에 hookError 만 표시).
 */
export async function recordPlatformAiUsage(sb: AiRpc, args: AiRecordArgs, meta?: AiRecordMeta, hook?: AiRecordHook, opts?: AiOpts): Promise<AiRecordResult> {
  if (!isUuid(args.tenantId) || ![args.reserved, args.input, args.output, args.cache].every(nonNeg)) return { ok: false, code: "INVALID_ARGS" };
  const names = resolveRpcNames(opts?.rpcNames);
  try {
    const r = await sb.rpc(names.record, {
      p_tenant: args.tenantId,
      p_provider: ctxOf(opts).provider,
      p_reserved: args.reserved,
      p_input: args.input,
      p_output: args.output,
      p_cache: args.cache,
      p_failed: args.failed === true,
    });
    if (r.error) return { ok: false, code: "READ_FAILED" };
  } catch {
    return { ok: false, code: "READ_FAILED" };
  }
  if (!hook) return { ok: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("hook timeout")), AI_HOOK_TIMEOUT_MS);
    });
    await Promise.race([Promise.resolve().then(() => hook(args, meta)), timeout]);
    return { ok: true };
  } catch {
    return { ok: true, hookError: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ───────── 공급사 키 확인 ─────────
/** 모델 조회 1회(토큰·과금 없음). 응답 본문·헤더는 읽지 않는다. 모델 ID 가 없거나 형식이 틀리면 false. */
export function anthropicVerifier(model: string, fetchImpl: typeof fetch = fetch): (key: string) => Promise<boolean> {
  return async (key) => {
    if (!/^[a-z0-9._-]{3,80}$/i.test(model)) return false;
    try {
      const r = await fetchImpl(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
        headers: { "anthropic-version": "2023-06-01", "x-api-key": key },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      return r.ok;
    } catch {
      return false;
    }
  };
}

// ───────── 관리 액션(스태프 전용 — 호출 전에 앱의 서버 가드를 통과해야 한다) ─────────
const reasonOf = (raw: unknown): string => {
  const r = String(raw ?? "").trim();
  if (r === "" || [...r].length > 500) throw new AiSharedKeyError("REASON_REQUIRED", "a reason of 1-500 characters is required");
  return r;
};
const confirmOf = (raw: unknown): string | null => {
  const c = String(raw ?? "").trim();
  return c === "" ? null : c;
};
/** 빈 문자열은 «미설정(NULL)», 아니면 0 이상 정수(상한 포함). */
function limitOf(raw: unknown, max: number): number | null {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new AiSharedKeyError("AI_LIMIT_INVALID", "limit must be a non-negative integer");
  return n;
}
const needUuid = (v: unknown): string => {
  if (!isUuid(v)) throw new AiSharedKeyError("PLATFORM_INVALID", "company id must be a uuid");
  return v.toLowerCase();
};
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const CALL_MAX = 100_000_000;
const TOKEN_MAX = 1_000_000_000_000;

export interface AiSharedKeyConfig extends AiOpts {
  rpc: AiRpc;
  /** 마스터 키 환경변수 «이름»(필수, 기본값 없음). 이전 키는 `<이름>_PREVIOUS`. */
  masterKeyEnv: string;
  env?: Record<string, string | undefined>;
  /** 키링을 직접 주입(시험·특수 경로). 없으면 env 의 masterKeyEnv 로 읽는다. */
  ring?: Ring;
  /** 관리 액션에서 키 등록 시 공급사 확인(예: anthropicVerifier(model)). 없으면 «확인 안 됨»으로 저장된다. */
  verifyKey?: (key: string) => Promise<boolean>;
  /** record 성공 뒤 상세 기록용 훅(§4A). */
  onRecorded?: AiRecordHook;
}

/** 오류 문구 앞의 `CODE:` 를 코드로 쓴다(DB 함수가 `CODE: 설명` 형식으로 던진다). */
function wrapRpcError(message: string): AiSharedKeyError {
  const m = /^([A-Z][A-Z0-9_]{2,39}):/.exec(message);
  return new AiSharedKeyError(m ? m[1] : "RPC_FAILED", message.slice(0, 300));
}

export function createAiSharedKey(cfg: AiSharedKeyConfig) {
  if (typeof cfg.masterKeyEnv !== "string" || cfg.masterKeyEnv.trim() === "") throw new AiSharedKeyError("PLATFORM_INVALID", "masterKeyEnv is required");
  const names = resolveRpcNames(cfg.rpcNames);
  const opts: AiOpts = { provider: cfg.provider, scope: cfg.scope, rpcNames: cfg.rpcNames };
  const ring: Ring = cfg.ring ?? (() => loadKeyring(cfg.env ?? process.env, { current: cfg.masterKeyEnv }));

  async function call(fn: string, args: Record<string, unknown>): Promise<any> {
    let r;
    try {
      r = await cfg.rpc.rpc(fn, args);
    } catch {
      throw new AiSharedKeyError("RPC_FAILED", "rpc call failed");
    }
    if (r.error) throw wrapRpcError(r.error.message);
    return r.data;
  }

  return {
    names,
    seal: (plain: string) => sealPlatformAiKey(plain, ring, opts),
    withKey: <T>(fn: (key: string) => Promise<T>) => withPlatformAiKey(cfg.rpc, fn, ring, opts),
    reserve: (tenantId: string, calls: number, tokens: number) => reservePlatformAiUsage(cfg.rpc, tenantId, calls, tokens, opts),
    record: (args: AiRecordArgs, meta?: AiRecordMeta) => recordPlatformAiUsage(cfg.rpc, args, meta, cfg.onRecorded, opts),
    markInvalid: (code: "HTTP_401" | "HTTP_403") => markPlatformKeyInvalid(cfg.rpc, code, opts),

    async keyStatus(actor: string): Promise<AiKeyStatus> {
      const p = await call(names.keyStatus, { p_actor: actor });
      if (!p || typeof p !== "object") throw new AiSharedKeyError("NOT_FOUND", "ai key status");
      return {
        registered: p.registered === true, version: p.version ?? null, status: p.status ?? null, key_hint: p.key_hint ?? null,
        verified_at: p.verified_at ?? null, last_error_code: p.last_error_code ?? null, month: String(p.month ?? ""),
        monthly_call_cap: p.monthly_call_cap ?? null, monthly_token_cap: p.monthly_token_cap ?? null, calls: Number(p.calls ?? 0), tokens: Number(p.tokens ?? 0),
      };
    },

    /** 새 공용 키 등록·교체: 모양 검사 → 공급사 확인 1회 → 봉인 → 저장. 반환값에는 키가 없다. */
    async registerKey(actor: string, input: { key: string; reason: string; confirm: string }): Promise<{ version: number; status: string; verified: boolean }> {
      const reason = reasonOf(input.reason);
      const shape = validateAiKeyShape(input.key);
      if (!shape.ok) throw new AiSharedKeyError("AI_CREDENTIAL_INVALID", shape.code);
      let verified = false;
      try {
        verified = cfg.verifyKey ? (await cfg.verifyKey(shape.key)) === true : false;
      } catch {
        verified = false;
      }
      const sealed = sealPlatformAiKey(shape.key, ring, opts);
      const r = await call(names.keySave, { p_actor: actor, p_ciphertext: sealed.ciphertext, p_hint: sealed.hint, p_verified: verified, p_reason: reason, p_confirm: confirmOf(input.confirm) });
      return { version: Number(r?.version), status: String(r?.status), verified };
    },

    async revokeKey(actor: string, input: { reason: string; confirm: string }): Promise<boolean> {
      return (await call(names.keyRevoke, { p_actor: actor, p_reason: reasonOf(input.reason), p_confirm: confirmOf(input.confirm) })) === true;
    },

    async setKeyEnabled(actor: string, input: { enabled: boolean; reason: string }): Promise<string> {
      return String(await call(names.keySetEnabled, { p_actor: actor, p_enabled: input.enabled, p_reason: reasonOf(input.reason) }));
    },

    async setCap(actor: string, input: { calls: string; tokens: string; reason: string }): Promise<void> {
      await call(names.setCap, { p_actor: actor, p_calls: limitOf(input.calls, CALL_MAX), p_tokens: limitOf(input.tokens, TOKEN_MAX), p_reason: reasonOf(input.reason) });
    },

    async companyOverview(actor: string, tenantId: string): Promise<AiCompanyOverview> {
      const p = await call(names.companyOverview, { p_actor: actor, p_tenant: needUuid(tenantId) });
      if (!p || typeof p !== "object") throw new AiSharedKeyError("NOT_FOUND", "tenant");
      return {
        platform_enabled: p.platform_enabled === true, owner_off: p.owner_off === true, owner_off_at: p.owner_off_at ?? null, owner_off_role: p.owner_off_role ?? null,
        configured: p.configured === true, usable: p.usable === true, month: String(p.month ?? ""), calls: Number(p.calls ?? 0), failures: Number(p.failures ?? 0),
        monthly_call_limit: p.monthly_call_limit ?? null,
      };
    },

    async setCompany(actor: string, input: { tenantId: string; enabled: boolean; calls: string; tokens: string; reason: string; confirm: string }): Promise<void> {
      await call(names.companySet, {
        p_actor: actor, p_tenant: needUuid(input.tenantId), p_enabled: input.enabled, p_calls: limitOf(input.calls, CALL_MAX), p_tokens: limitOf(input.tokens, TOKEN_MAX),
        p_reason: reasonOf(input.reason), p_confirm: confirmOf(input.confirm),
      });
    },

    async companyList(actor: string): Promise<AiCompanyList> {
      const p = await call(names.companyList, { p_actor: actor });
      if (!p || typeof p !== "object" || !Array.isArray(p.rows)) throw new AiSharedKeyError("NOT_FOUND", "ai company list");
      return {
        month: String(p.month ?? ""), key_active: p.key_active === true, truncated: p.truncated === true,
        rows: p.rows.map((r: any) => ({
          tenant_id: String(r.tenant_id), name: String(r.name), platform_enabled: r.platform_enabled === true, owner_off: r.owner_off === true, owner_off_at: r.owner_off_at ?? null,
          owner_off_role: r.owner_off_role ?? null, configured: r.configured === true, usable: r.usable === true,
          calls: Number(r.calls ?? 0), tokens: Number(r.tokens ?? 0), failures: Number(r.failures ?? 0),
          call_limit: num(r.call_limit), token_limit: num(r.token_limit), call_pct: num(r.call_pct), token_pct: num(r.token_pct),
        })),
      };
    },

    /** 회사의 개별 정지(enabled=false)·재개(enabled=true, 확인 문구 필요). 회사가 스스로 정지한 상태는 건드리지 않는다. */
    async switchCompany(actor: string, input: { tenantId: string; enabled: boolean; reason: string; confirm: string }): Promise<boolean> {
      return (await call(names.companySwitch, { p_actor: actor, p_tenant: needUuid(input.tenantId), p_enabled: input.enabled, p_reason: reasonOf(input.reason), p_confirm: confirmOf(input.confirm) })) === true;
    },
  };
}
export type AiSharedKey = ReturnType<typeof createAiSharedKey>;
