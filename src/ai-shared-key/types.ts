/**
 * 공용 AI 키(방식 B) — 클라이언트에서도 import 할 수 있는 부분(타입·상수·순수 함수). node:crypto 를 끌어오지 않는다.
 * 서버 전용 로직은 `@platform/shared/ai-shared-key`, RPC 계약 정적 검사는 `@platform/shared/ai-shared-key/contract`.
 * 설계: docs/design-ai-shared-key-module-2026-11.md (§3·§4A·§4B).
 * 이 파일에는 키·암호문·마스터 키 값, 회사 정보를 넣지 않는다(공개 저장소).
 */

export const AI_PROVIDER = "ai-claude";
/** 봉인 AAD 의 tenantId 자리 기본값. 레저코어 기존 암호문과 호환(바꾸면 복호화 실패). */
export const AI_DEFAULT_SCOPE = "platform-ai";

/** 예약 코드 6종(계약 v1, 고정). */
export const AI_RESERVE_CODES = [
  "NO_ACTIVE_KEY",
  "COMPANY_DISABLED",
  "LIMIT_NOT_SET",
  "PLATFORM_CAP_NOT_SET",
  "LIMIT_EXCEEDED",
  "PLATFORM_CAP_EXCEEDED",
] as const;
export type AiReserveDenyCode = (typeof AI_RESERVE_CODES)[number];
export type AiReserveCode = AiReserveDenyCode | "READ_FAILED";
export type AiReserveResult = { ok: true; calls: number; tokens: number } | { ok: false; code: AiReserveCode };

/** 모르는 코드는 'UNKNOWN' 으로 돌려 앱이 «일반 안내» 폴백을 쓰게 한다(문구는 앱 몫). */
export function aiReserveReason(code: string): AiReserveCode | "UNKNOWN" {
  if (code === "READ_FAILED") return code;
  return (AI_RESERVE_CODES as readonly string[]).includes(code) ? (code as AiReserveDenyCode) : "UNKNOWN";
}

export type AiKeyUse<T> = { state: "ok"; value: T } | { state: "off" } | { state: "unavailable"; reason: string };

/** `keyMark` 가 받는 상태. 401·403 → INVALID, 429 는 표시하지 않는다. */
export type AiKeyMarkStatus = "ACTIVE" | "LIMITED" | "INVALID" | "SUSPENDED";

/** RPC 클라이언트(Supabase 서비스 롤 클라이언트와 같은 모양). */
export interface AiRpc {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

// ───────── RPC 이름(계약 v1 기본값 = 레저코어 8440) ─────────
export const AI_RPC_DEFAULTS = {
  keySave: "platform_ai_key_save",
  keyRevoke: "platform_ai_key_revoke",
  keySetEnabled: "platform_ai_key_set_enabled",
  setCap: "platform_ai_set_cap",
  keyStatus: "platform_ai_key_status",
  companySet: "platform_ai_company_set",
  companyOverview: "platform_ai_company_overview",
  companySwitch: "platform_ai_company_switch",
  companyList: "platform_ai_company_list",
  cipher: "platform_ai_cipher",
  keyMark: "platform_ai_key_mark",
  reserve: "platform_ai_reserve",
  record: "platform_ai_record",
  // 회사 owner 용(authenticated). 모듈은 호출하지 않고 계약 검사에만 쓴다.
  companyStatus: "ai_company_status",
  companySetOwnerOff: "ai_company_set_owner_off",
  companySetLimits: "ai_company_set_limits",
} as const;
export type AiRpcKey = keyof typeof AI_RPC_DEFAULTS;
export type AiRpcNames = { readonly [K in AiRpcKey]: string };

const RPC_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
export function resolveRpcNames(overrides?: Partial<AiRpcNames>): AiRpcNames {
  const out: Record<string, string> = { ...AI_RPC_DEFAULTS };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (!(k in AI_RPC_DEFAULTS)) throw new AiSharedKeyError("PLATFORM_INVALID", `unknown rpc name key: ${k}`);
    if (typeof v !== "string" || !RPC_NAME_RE.test(v)) throw new AiSharedKeyError("PLATFORM_INVALID", `invalid rpc name for ${k}`);
    out[k] = v;
  }
  return out as unknown as AiRpcNames;
}

// ───────── 오류 ─────────
export type AiSharedKeyErrorCode =
  | "PLATFORM_INVALID"
  | "REASON_REQUIRED"
  | "AI_LIMIT_INVALID"
  | "AI_CREDENTIAL_INVALID"
  | "NOT_FOUND"
  | "RPC_FAILED"
  | "FORBIDDEN_KEY"
  | (string & {});

/** 메시지에는 키·암호문 값을 절대 넣지 않는다(호출자가 넘긴 문구는 코드·고정 설명뿐). */
export class AiSharedKeyError extends Error {
  readonly code: AiSharedKeyErrorCode;
  constructor(code: AiSharedKeyErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AiSharedKeyError";
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// ───────── 응답 타입(화면용) ─────────
export interface AiKeyStatus {
  registered: boolean;
  version: number | null;
  status: string | null;
  key_hint: string | null;
  verified_at: string | null;
  last_error_code: string | null;
  month: string;
  monthly_call_cap: number | null;
  monthly_token_cap: number | null;
  calls: number;
  tokens: number;
}

export interface AiCompanyOverview {
  platform_enabled: boolean;
  owner_off: boolean;
  owner_off_at: string | null;
  owner_off_role: string | null;
  configured: boolean;
  usable: boolean;
  month: string;
  calls: number;
  failures: number;
  monthly_call_limit: number | null;
}

export interface AiCompanyRow {
  tenant_id: string;
  name: string;
  platform_enabled: boolean;
  owner_off: boolean;
  owner_off_at: string | null;
  owner_off_role: string | null;
  configured: boolean;
  usable: boolean;
  calls: number;
  tokens: number;
  failures: number;
  call_limit: number | null;
  token_limit: number | null;
  call_pct: number | null;
  token_pct: number | null;
}
export interface AiCompanyList {
  month: string;
  key_active: boolean;
  truncated: boolean;
  rows: AiCompanyRow[];
}

/** 목록 필터. «한도 근접» = 호출 또는 토큰 사용률이 80% 이상. */
export type AiListFilter = "all" | "usable" | "platform_closed" | "tenant_paused" | "near_limit";
export const NEAR_LIMIT_PCT = 80;
export function filterAiRows(rows: readonly AiCompanyRow[], f: AiListFilter): AiCompanyRow[] {
  switch (f) {
    case "usable":
      return rows.filter((r) => r.usable);
    case "platform_closed":
      return rows.filter((r) => !r.platform_enabled);
    case "tenant_paused":
      return rows.filter((r) => r.owner_off);
    case "near_limit":
      return rows.filter((r) => (r.call_pct ?? 0) >= NEAR_LIMIT_PCT || (r.token_pct ?? 0) >= NEAR_LIMIT_PCT);
    default:
      return [...rows];
  }
}

// ───────── 기록(record) ─────────
export interface AiRecordArgs {
  tenantId: string;
  /** 예약 때 올린 토큰 수(실제와의 차액을 기록 함수가 정산). */
  reserved: number;
  input: number;
  output: number;
  cache: number;
  failed?: boolean;
}
/** 앱이 정하는 호출자 메타(기능 코드·모델 등). 모듈은 해석하지 않고 훅에 그대로 전달한다. */
export type AiRecordMeta = Readonly<Record<string, unknown>>;
export type AiRecordResult = { ok: true; hookError?: true } | { ok: false; code: "READ_FAILED" | "INVALID_ARGS" };

// ───────── 응답 화이트리스트 검사 ─────────
const FORBIDDEN_KEY_RE = /cipher|secret|plaintext|key_plain|api_?key|password|master/i;
/** 응답 객체 어디에든 금지 키 이름(암호문·비밀 등)이 있으면 예외. 시험·방어용(깊이 20까지). */
export function assertNoForbiddenKeys(value: unknown, depth = 0): void {
  if (depth > 20 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) assertNoForbiddenKeys(v, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_RE.test(k)) throw new AiSharedKeyError("FORBIDDEN_KEY", `forbidden key name in response: ${k}`);
    assertNoForbiddenKeys(v, depth + 1);
  }
}

// ───────── 추정 금액(순수 함수, 단가 값은 앱 설정) ─────────
/** USD/백만 토큰. 값은 앱이 정한다(모듈은 값을 갖지 않는다). */
export interface AiModelPrice {
  input: number;
  output: number;
  cache?: number;
}
export interface AiPriceTable {
  /** 단가 적용일(표시용, 예: '2026-11-14'). */
  date: string;
  models: Readonly<Record<string, AiModelPrice>>;
}
export interface AiUsageForCost {
  model: string;
  input: number;
  output: number;
  cache?: number;
}
/** 항상 `estimated: true` — 화면은 «추정» 으로 표시해야 한다. 단가가 없는 모델이면 usd 는 null. */
export function estimateCostUsd(usage: AiUsageForCost, prices: AiPriceTable): { usd: number | null; estimated: true; priceDate: string } {
  const p = Object.prototype.hasOwnProperty.call(prices.models, usage.model) ? prices.models[usage.model] : undefined;
  const base = { estimated: true as const, priceDate: prices.date };
  const nums = [usage.input, usage.output, usage.cache ?? 0];
  if (!p || nums.some((n) => !Number.isFinite(n) || n < 0)) return { usd: null, ...base };
  const usd = (usage.input * p.input + usage.output * p.output + (usage.cache ?? 0) * (p.cache ?? p.input)) / 1_000_000;
  return { usd: Math.round(usd * 1e6) / 1e6, ...base };
}
