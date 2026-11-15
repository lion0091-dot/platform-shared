/**
 * 월 AI 사용 합계 «한 줄» 만들기·검사 — 계약 v1 §1. 순수 함수, 던지지 않는다(결과 객체).
 * 회사·사용자 정보가 줄에 섞이지 않게 입력 키를 허용 목록으로 막는다. 오류에는 코드만 있고 값이 없다.
 */
import {
  AI_USAGE_CONTRACT_VERSION,
  AI_USAGE_FUTURE_SKEW_MS,
  AI_USAGE_MAX_COUNT,
  AI_USAGE_MAX_ROWS,
  AI_USAGE_MAX_USD,
} from "./constants";

const KST_OFFSET_MS = 9 * 3600_000;

export type AiUsageLineErrorCode = "LINE_INPUT" | "LINE_EXTRA_KEY" | "LINE_MONTH" | "LINE_NUMBER" | "LINE_AS_OF";

/** 계약 §1 줄. 키 순서가 서명 본문의 순서가 된다. */
export interface AiUsageLine {
  readonly contract: 1;
  readonly month: string;
  readonly calls: number;
  readonly tokens: number;
  readonly est_usd: number;
  readonly as_of: string;
}

export interface AiUsageLineInput {
  /** 서울 기준 월의 1일 `YYYY-MM-01` */
  month: string;
  /** 그 달 호출 수(실제 기록 기준, 예약 제외) */
  calls: number;
  /** 그 달 토큰 합계(입력+출력+캐시) */
  tokens: number;
  /** 그 달 추정 US$ (estimateAiUsageUsd 결과 등) */
  estUsd: number;
  /** 집계 기준 시각 — Date 또는 UTC ISO 문자열(`…Z`) */
  asOf: Date | string;
}

export type AiUsageLineResult = { ok: true; line: AiUsageLine } | { ok: false; code: AiUsageLineErrorCode };

const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set(["month", "calls", "tokens", "estUsd", "asOf"]);
export const MONTH_RE = /^(\d{4})-(\d{2})-01$/;
export const AS_OF_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** 소수 4자리 반올림(한 번만). 이미 4자리인 값에는 영향이 없다. */
export function roundUsd4(value: number): number {
  return Number(value.toFixed(4));
}

export function toMs(now: unknown): number {
  if (now instanceof Date) return now.getTime();
  return typeof now === "number" ? now : Number.NaN;
}

export function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= AI_USAGE_MAX_COUNT;
}

/** 서울 기준 현재 월의 번호(연*12+월-1). */
export function kstMonthIndex(ms: number): number {
  const d = new Date(ms + KST_OFFSET_MS);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/**
 * 줄을 만든다. 입력 키는 `month`·`calls`·`tokens`·`estUsd`·`asOf` 다섯 개만 허용하고 그 밖의 키가 하나라도 있으면 거부한다.
 * `now` 는 발신 시각(Date 또는 ms) — 시계를 이 모듈이 읽지 않으므로 호출하는 쪽이 넘긴다.
 * 월은 서울 기준 이번 달부터 24개월 전까지만 허용한다(미래 달 거부, 수신 쪽 범위와 같음).
 */
export function buildAiUsageLine(input: unknown, now: Date | number): AiUsageLineResult {
  try {
    return buildLine(input, now);
  } catch {
    // getter 가 던지는 객체 등 — 값을 보지 않고 코드만 돌려준다.
    return { ok: false, code: "LINE_INPUT" };
  }
}

function buildLine(input: unknown, now: Date | number): AiUsageLineResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, code: "LINE_INPUT" };

  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !ALLOWED_INPUT_KEYS.has(key)) return { ok: false, code: "LINE_EXTRA_KEY" };
  }

  const nowMs = toMs(now);

  if (!Number.isFinite(nowMs)) return { ok: false, code: "LINE_AS_OF" };

  const v = input as Record<string, unknown>;

  // month
  const mm = typeof v.month === "string" ? MONTH_RE.exec(v.month) : null;

  if (!mm) return { ok: false, code: "LINE_MONTH" };

  const year = Number(mm[1]);
  const mon = Number(mm[2]);

  if (mon < 1 || mon > 12) return { ok: false, code: "LINE_MONTH" };

  const diff = kstMonthIndex(nowMs) - (year * 12 + (mon - 1));

  if (diff < 0 || diff > 23) return { ok: false, code: "LINE_MONTH" };

  // numbers
  if (!isCount(v.calls) || !isCount(v.tokens)) return { ok: false, code: "LINE_NUMBER" };

  const usd = v.estUsd;

  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > AI_USAGE_MAX_USD) return { ok: false, code: "LINE_NUMBER" };

  // as_of
  let asOfMs: number;

  if (v.asOf instanceof Date) asOfMs = v.asOf.getTime();
  else if (typeof v.asOf === "string" && AS_OF_RE.test(v.asOf)) asOfMs = Date.parse(v.asOf);
  else return { ok: false, code: "LINE_AS_OF" };

  if (!Number.isFinite(asOfMs) || asOfMs > nowMs + AI_USAGE_FUTURE_SKEW_MS) return { ok: false, code: "LINE_AS_OF" };

  const asOfDate = new Date(asOfMs);

  if (Number.isNaN(asOfDate.getTime())) return { ok: false, code: "LINE_AS_OF" };

  const line: AiUsageLine = {
    contract: AI_USAGE_CONTRACT_VERSION,
    month: v.month as string,
    calls: v.calls,
    tokens: v.tokens,
    est_usd: roundUsd4(usd),
    as_of: asOfDate.toISOString(),
  };

  return { ok: true, line };
}

/** 모델별 월 토큰. */
export interface AiUsageRow {
  model: string;
  input: number;
  output: number;
  cache?: number;
}

/** 단가표(USD/백만 토큰). 값은 앱 설정이고 이 모듈에는 값이 없다. */
export interface AiUsagePriceTable {
  models: Readonly<Record<string, { input: number; output: number; cache?: number }>>;
}

export type EstimateAiUsageUsdResult =
  | { ok: true; usd: number; estimated: true }
  | { ok: false; code: "MODEL_PRICE_MISSING" | "ROWS_INVALID" };

function isTokens(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * 월 합 추정 US$ — 모델별 값을 **반올림 없이 합산한 뒤 한 번만** 소수 4자리로 반올림한다(계약 §1).
 * 캐시 단가가 없으면 그 모델의 입력 단가를 쓴다. 단가표에 없는 모델이 하나라도 있으면 전체를 거부한다
 * (과소 추정을 조용히 만들지 않는다 — 앱은 그 슬롯 발신을 중단하고 경고한다). 항상 «추정».
 */
export function estimateAiUsageUsd(rows: unknown, prices: unknown): EstimateAiUsageUsdResult {
  try {
    return estimate(rows, prices);
  } catch {
    return { ok: false, code: "ROWS_INVALID" };
  }
}

function estimate(rows: unknown, prices: unknown): EstimateAiUsageUsdResult {
  if (!Array.isArray(rows) || rows.length > AI_USAGE_MAX_ROWS) return { ok: false, code: "ROWS_INVALID" };

  const models = (prices as AiUsagePriceTable | null | undefined)?.models;

  if (typeof models !== "object" || models === null) return { ok: false, code: "ROWS_INVALID" };

  let sum = 0;

  for (const row of rows as unknown[]) {
    if (typeof row !== "object" || row === null) return { ok: false, code: "ROWS_INVALID" };

    const r = row as Record<string, unknown>;

    if (typeof r.model !== "string" || !isTokens(r.input) || !isTokens(r.output) || (r.cache !== undefined && !isTokens(r.cache))) {
      return { ok: false, code: "ROWS_INVALID" };
    }

    if (!Object.prototype.hasOwnProperty.call(models, r.model)) return { ok: false, code: "MODEL_PRICE_MISSING" };

    const p = (models as Record<string, { input?: unknown; output?: unknown; cache?: unknown }>)[r.model];

    if (!isTokens(p?.input) || !isTokens(p?.output) || (p.cache !== undefined && !isTokens(p.cache))) {
      return { ok: false, code: "MODEL_PRICE_MISSING" };
    }

    const cachePrice = p.cache === undefined ? p.input : p.cache;

    sum += (r.input * p.input + r.output * p.output + (r.cache ?? 0) * cachePrice) / 1_000_000;
  }

  if (!Number.isFinite(sum)) return { ok: false, code: "ROWS_INVALID" };

  return { ok: true, usd: roundUsd4(sum), estimated: true };
}
