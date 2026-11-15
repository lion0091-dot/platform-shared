/**
 * 테넌트별 월 AI 토큰 «한 줄» 만들기 — 입력 키 허용 목록·범위·서울 월·as_of 검사. 순수 함수, 던지지 않는다.
 * 줄에는 회사 이름·금액·사용자·모델·기능이 없다(토큰·호출 수만). 오류에는 코드만 있고 값이 없다.
 */
import { AI_USAGE_FUTURE_SKEW_MS } from "../ai-usage-line/constants";
import { AS_OF_RE, isCount, kstMonthIndex, MONTH_RE, toMs } from "../ai-usage-line/line";
import { AI_USAGE_TENANT_CONTRACT_VERSION, AI_USAGE_TENANT_EXT_ID_MAX_LENGTH, AI_USAGE_TENANT_MAX_AGE_MS } from "./constants";

export type AiUsageTenantLineErrorCode = "LINE_INPUT" | "LINE_EXTRA_KEY" | "LINE_EXT_ID" | "LINE_MONTH" | "LINE_NUMBER" | "LINE_AS_OF";

/** 배치 항목 한 개. 키 순서가 본문의 순서가 된다. */
export interface AiUsageTenantItem {
  readonly ext_id: string;
  readonly contract: 1;
  readonly month: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_tokens: number;
  readonly calls: number;
  readonly as_of: string;
}

export interface AiUsageTenantLineInput {
  /** 앱의 외부 id(이음=운영사 id, 미트=업체 id) — 레저코어가 연결 표로 회사를 찾는다 */
  extId: string;
  /** 서울 기준 월의 1일 `YYYY-MM-01` */
  month: string;
  /** 그 달 입력 토큰(실제 기록 기준, 예약 제외) */
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  /** 그 달 호출 수 */
  calls: number;
  /** 집계 기준 시각 — Date 또는 UTC ISO 문자열(`…Z`) */
  asOf: Date | string;
}

export type AiUsageTenantLineResult = { ok: true; item: AiUsageTenantItem } | { ok: false; code: AiUsageTenantLineErrorCode };

const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set(["extId", "month", "inputTokens", "outputTokens", "cacheTokens", "calls", "asOf"]);

/** 화면에 보이는 이름이 아니라 시스템 id 모양만 허용한다(공백·제어문자·한글 이름 거부). */
const EXT_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidExtId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= AI_USAGE_TENANT_EXT_ID_MAX_LENGTH && EXT_ID_RE.test(value);
}

/**
 * 항목을 만든다. 입력 키는 `extId`·`month`·`inputTokens`·`outputTokens`·`cacheTokens`·`calls`·`asOf` 일곱 개만 허용하고
 * 그 밖의 키(이름·금액·사용자·모델·기능 등)가 하나라도 있으면 거부한다. `now` 는 발신 시각이며 이 모듈은 시계를 읽지 않는다.
 * 월은 서울 기준 이번 달부터 24개월 전까지만 허용한다(미래 달 거부). `as_of` 는 미래 5분 초과·400일보다 오래됨을 거부한다.
 */
export function buildAiUsageTenantLine(input: unknown, now: Date | number): AiUsageTenantLineResult {
  try {
    return build(input, now);
  } catch {
    return { ok: false, code: "LINE_INPUT" };
  }
}

function build(input: unknown, now: Date | number): AiUsageTenantLineResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, code: "LINE_INPUT" };

  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !ALLOWED_INPUT_KEYS.has(key)) return { ok: false, code: "LINE_EXTRA_KEY" };
  }

  const nowMs = toMs(now);

  if (!Number.isFinite(nowMs)) return { ok: false, code: "LINE_AS_OF" };

  const v = input as Record<string, unknown>;

  if (!isValidExtId(v.extId)) return { ok: false, code: "LINE_EXT_ID" };

  const mm = typeof v.month === "string" ? MONTH_RE.exec(v.month) : null;

  if (!mm) return { ok: false, code: "LINE_MONTH" };

  const year = Number(mm[1]);
  const mon = Number(mm[2]);

  if (mon < 1 || mon > 12) return { ok: false, code: "LINE_MONTH" };

  const diff = kstMonthIndex(nowMs) - (year * 12 + (mon - 1));

  if (diff < 0 || diff > 23) return { ok: false, code: "LINE_MONTH" };

  if (!isCount(v.inputTokens) || !isCount(v.outputTokens) || !isCount(v.cacheTokens) || !isCount(v.calls)) return { ok: false, code: "LINE_NUMBER" };

  let asOfMs: number;

  if (v.asOf instanceof Date) asOfMs = v.asOf.getTime();
  else if (typeof v.asOf === "string" && AS_OF_RE.test(v.asOf)) asOfMs = Date.parse(v.asOf);
  else return { ok: false, code: "LINE_AS_OF" };

  if (!Number.isFinite(asOfMs) || asOfMs > nowMs + AI_USAGE_FUTURE_SKEW_MS || asOfMs < nowMs - AI_USAGE_TENANT_MAX_AGE_MS) return { ok: false, code: "LINE_AS_OF" };

  const asOfDate = new Date(asOfMs);

  if (Number.isNaN(asOfDate.getTime())) return { ok: false, code: "LINE_AS_OF" };

  const item: AiUsageTenantItem = {
    ext_id: v.extId,
    contract: AI_USAGE_TENANT_CONTRACT_VERSION,
    month: v.month as string,
    input_tokens: v.inputTokens,
    output_tokens: v.outputTokens,
    cache_tokens: v.cacheTokens,
    calls: v.calls,
    as_of: asOfDate.toISOString(),
  };

  return { ok: true, item };
}
