/**
 * 배치 검사·분할·서명 호출 — 한 호출에 최대 50개 항목·본문 16KB. 순수 함수, 던지지 않는다(결과 객체).
 * 어느 항목이든 허용 키 밖이면 배치 전체를 거부한다(회사 이름·금액·사용자·모델·기능 혼입 방지).
 * «변경분 + 하루 1회 전체» 같은 어떤 테넌트를 보낼지의 선택은 앱 몫이고 이 모듈 밖이다.
 */
import { randomUUID } from "node:crypto";
import { assertSignSecret, signNowSec, signTtl } from "../account/guard";
import { hmacHex, type AccountSystem } from "../account/sign";
import { AS_OF_RE, isCount, MONTH_RE } from "../ai-usage-line/line";
import {
  AI_USAGE_TENANT_ACTION,
  AI_USAGE_TENANT_CONTRACT_VERSION,
  AI_USAGE_TENANT_EXT_TENANT,
  AI_USAGE_TENANT_ITEM_KEYS,
  AI_USAGE_TENANT_MAX_BODY_BYTES,
  AI_USAGE_TENANT_MAX_ITEMS,
} from "./constants";
import { isValidExtId, type AiUsageTenantItem } from "./line";

export type AiUsageTenantBatchErrorCode =
  | "LINE_BATCH"
  | "LINE_EXTRA_KEY"
  | "LINE_MALFORMED"
  | "LINE_VERSION"
  | "LINE_EXT_ID"
  | "LINE_MONTH"
  | "LINE_NUMBER"
  | "LINE_AS_OF"
  | "LINE_DUP";

const KEY_SET: ReadonlySet<string> = new Set(AI_USAGE_TENANT_ITEM_KEYS);

/** 항목 한 개의 구조·값 검사. 오류 코드 또는 null. */
function itemError(item: unknown): AiUsageTenantBatchErrorCode | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return "LINE_EXTRA_KEY";

  const keys = Reflect.ownKeys(item);

  if (!keys.every((k) => typeof k === "string" && KEY_SET.has(k))) return "LINE_EXTRA_KEY";
  if (keys.length !== KEY_SET.size) return "LINE_MALFORMED"; // 모든 키가 필수(누락)

  const v = item as Record<string, unknown>;

  if (!isValidExtId(v.ext_id)) return "LINE_EXT_ID";
  if (v.contract !== AI_USAGE_TENANT_CONTRACT_VERSION) return "LINE_VERSION";

  const mm = typeof v.month === "string" ? MONTH_RE.exec(v.month) : null;

  if (!mm || Number(mm[2]) < 1 || Number(mm[2]) > 12) return "LINE_MONTH";

  if (!isCount(v.input_tokens) || !isCount(v.output_tokens) || !isCount(v.cache_tokens) || !isCount(v.calls)) return "LINE_NUMBER";

  if (typeof v.as_of !== "string" || !AS_OF_RE.test(v.as_of) || Number.isNaN(Date.parse(v.as_of))) return "LINE_AS_OF";

  return null;
}

/** 같은 (ext_id, month) 가 둘 이상이면 true. */
function hasDuplicate(items: readonly AiUsageTenantItem[]): boolean {
  const seen = new Set<string>();

  for (const it of items) {
    const key = `${it.ext_id}\u0000${it.month}`;

    if (seen.has(key)) return true;

    seen.add(key);
  }

  return false;
}

/** 키 순서를 계약 순서로 다시 담는다(호출자가 다른 순서로 넘겨도 본문 순서는 고정). */
function normalize(item: AiUsageTenantItem): AiUsageTenantItem {
  return {
    ext_id: item.ext_id,
    contract: item.contract,
    month: item.month,
    input_tokens: item.input_tokens,
    output_tokens: item.output_tokens,
    cache_tokens: item.cache_tokens,
    calls: item.calls,
    as_of: item.as_of,
  };
}

/** 한 배치 호출에 넣을 항목 목록 검사(1~50건, 구조·값, 중복). 오류 코드 또는 null. */
export function checkAiUsageTenantBatch(items: unknown, maxItems: number = AI_USAGE_TENANT_MAX_ITEMS): AiUsageTenantBatchErrorCode | null {
  if (!Array.isArray(items) || items.length < 1 || items.length > maxItems) return "LINE_BATCH";

  for (const it of items as unknown[]) {
    const code = itemError(it);

    if (code) return code;
  }

  return hasDuplicate(items as AiUsageTenantItem[]) ? "LINE_DUP" : null;
}

export interface AiUsageTenantSplitOptions {
  /** 호출당 최대 항목 수(1~50). 기본 50 */
  maxItems?: number;
  /** 본문 최대 바이트(1~16384). 기본 16384 */
  maxBodyBytes?: number;
}

export type AiUsageTenantSplitResult = { ok: true; batches: AiUsageTenantItem[][] } | { ok: false; code: AiUsageTenantBatchErrorCode };

// 서명 본문의 뼈대 크기를 넉넉히 잡는다(가장 긴 system·jti 128자·큰 iat/exp).
const ENVELOPE_BYTES = Buffer.byteLength(
  JSON.stringify({
    system: "wholesale",
    action: AI_USAGE_TENANT_ACTION,
    ext_tenant: AI_USAGE_TENANT_EXT_TENANT,
    jti: "x".repeat(128),
    iat: 9_999_999_999,
    exp: 9_999_999_999,
    lines: [],
  }),
  "utf8",
);

/**
 * 항목 목록을 한 호출 한도(50건·16KB) 이하의 배치로 나눈다. 순서를 유지하고, 입력에 같은 (ext_id, month) 가 있으면
 * `LINE_DUP`(호출하는 쪽이 하나로 정리해서 넘긴다). 빈 목록은 «보낼 것 없음» 이라 빈 배열을 돌려준다(오류 아님).
 */
export function splitAiUsageTenantBatches(items: unknown, opts: AiUsageTenantSplitOptions = {}): AiUsageTenantSplitResult {
  try {
    const maxItems = opts.maxItems ?? AI_USAGE_TENANT_MAX_ITEMS;
    const maxBytes = opts.maxBodyBytes ?? AI_USAGE_TENANT_MAX_BODY_BYTES;

    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > AI_USAGE_TENANT_MAX_ITEMS) return { ok: false, code: "LINE_BATCH" };
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > AI_USAGE_TENANT_MAX_BODY_BYTES) return { ok: false, code: "LINE_BATCH" };
    if (!Array.isArray(items)) return { ok: false, code: "LINE_BATCH" };

    for (const it of items as unknown[]) {
      const code = itemError(it);

      if (code) return { ok: false, code };
    }

    if (hasDuplicate(items as AiUsageTenantItem[])) return { ok: false, code: "LINE_DUP" };

    const batches: AiUsageTenantItem[][] = [];
    let current: AiUsageTenantItem[] = [];
    let bytes = ENVELOPE_BYTES;

    for (const raw of items as AiUsageTenantItem[]) {
      const item = normalize(raw);
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1; // 쉼표

      if (ENVELOPE_BYTES + size > maxBytes) return { ok: false, code: "LINE_BATCH" };

      if (current.length >= maxItems || bytes + size > maxBytes) {
        batches.push(current);
        current = [];
        bytes = ENVELOPE_BYTES;
      }

      current.push(item);
      bytes += size;
    }

    if (current.length > 0) batches.push(current);

    return { ok: true, batches };
  } catch {
    return { ok: false, code: "LINE_BATCH" };
  }
}

export interface AiUsageTenantCallDeps {
  /** 서명 시각(ms) — 시계를 이 모듈이 읽지 않으므로 필수 */
  now: number;
  /** 생략하면 서명 코드가 무작위 값을 만든다(재시도마다 새 jti) */
  jti?: string;
  /** 본문 수명(초), 최대 60 */
  ttl?: number;
}

export type AiUsageTenantCallErrorCode = AiUsageTenantBatchErrorCode | "CALL_TOO_LARGE" | "SIGN_SECRET_INVALID" | "SIGN_TTL_INVALID" | "SIGN_NOW_INVALID" | "SIGN_FAILED";

export type AiUsageTenantCallResult = { ok: true; body: string; signature: string } | { ok: false; code: AiUsageTenantCallErrorCode };

const SIGN_CODES: ReadonlySet<string> = new Set(["SIGN_SECRET_INVALID", "SIGN_TTL_INVALID", "SIGN_NOW_INVALID"]);

/**
 * 배치 한 호출을 서명한다. 봉투 = system·action `ai_usage_tenant`·ext_tenant `BATCH`·lines(항목 배열)·jti·iat·exp.
 * 반환 `body` 는 서명한 바로 그 문자열이다 — 다시 직렬화하지 말고 그대로 전송한다. 본문이 16KB 를 넘으면 `CALL_TOO_LARGE`.
 */
export function buildAiUsageTenantCall(secret: string, system: AccountSystem, items: readonly AiUsageTenantItem[], deps: AiUsageTenantCallDeps): AiUsageTenantCallResult {
  try {
    const bad = checkAiUsageTenantBatch(items);

    if (bad) return { ok: false, code: bad };

    const lines = items.map(normalize);
    // 계약 §5 의 본문 순서: system → action → ext_tenant → jti → iat → exp → lines. 공용 `buildSignedCall` 은 추가 필드를 jti 앞에 넣어
    // 순서가 달라지므로 같은 검증(비밀·ttl·now)을 쓰는 이 함수에서 직접 직렬화한다.
    assertSignSecret(secret);

    const iat = signNowSec(deps.now);
    const ttl = signTtl(deps.ttl);
    const body = JSON.stringify({
      system,
      action: AI_USAGE_TENANT_ACTION,
      ext_tenant: AI_USAGE_TENANT_EXT_TENANT,
      jti: deps.jti ?? randomUUID(),
      iat,
      exp: iat + ttl,
      lines,
    });
    const signature = hmacHex(body, secret);

    if (Buffer.byteLength(body, "utf8") > AI_USAGE_TENANT_MAX_BODY_BYTES) return { ok: false, code: "CALL_TOO_LARGE" };

    return { ok: true, body, signature };
  } catch (e) {
    const code = e instanceof Error ? /^[A-Z_]+/.exec(e.message)?.[0] : undefined;

    return { ok: false, code: code && SIGN_CODES.has(code) ? (code as AiUsageTenantCallErrorCode) : "SIGN_FAILED" };
  }
}
