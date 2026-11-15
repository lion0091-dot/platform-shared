/**
 * 읽기 호출(앱이 자기 테넌트들의 레저코어 AI 사용량을 읽어 감) — 본문 검사·분할·서명·응답 정제. 순수 함수, 던지지 않는다.
 * R1: 응답에서 «요청한 외부 id» 와 «알려진 4개 키» 만 남긴다(다른 테넌트·회사 이름·금액 등은 버린다).
 * 어떤 id 를 묻는지(로그인한 테넌트 본인의 id 만)·캐시(권고 5분)·호출은 앱 몫이다.
 */
import { randomUUID } from "node:crypto";
import { assertSignSecret, signNowSec, signTtl } from "../account/guard";
import { hmacHex, type AccountSystem } from "../account/sign";
import { classifyAiUsageResponse } from "../ai-usage-line/response";
import { AI_USAGE_READ_ACTION, AI_USAGE_READ_MAX_BODY_BYTES, AI_USAGE_READ_MAX_IDS, AI_USAGE_TENANT_EXT_ID_MAX_LENGTH, AI_USAGE_TENANT_EXT_TENANT } from "./constants";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const READ_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;

export type AiUsageReadErrorCode =
  | "READ_BATCH"
  | "READ_ID"
  | "READ_DUP"
  | "READ_MONTH"
  | "READ_OPTIONS"
  | "CALL_TOO_LARGE"
  | "SIGN_SECRET_INVALID"
  | "SIGN_TTL_INVALID"
  | "SIGN_NOW_INVALID"
  | "SIGN_FAILED";

function isReadId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= AI_USAGE_TENANT_EXT_ID_MAX_LENGTH && ID_RE.test(v);
}

function isReadMonth(v: unknown): v is string {
  return typeof v === "string" && READ_MONTH_RE.test(v);
}

/** id 목록 검사(1~200개, 각 형식, 중복 없음). 오류 코드 또는 null. */
function checkIds(ids: unknown): "READ_BATCH" | "READ_ID" | "READ_DUP" | null {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > AI_USAGE_READ_MAX_IDS) return "READ_BATCH";
  if (!ids.every(isReadId)) return "READ_ID";

  return new Set(ids).size !== ids.length ? "READ_DUP" : null;
}

// 본문 뼈대 크기(가장 긴 jti 128자·큰 iat/exp·month 포함, ext_ids 는 빈 배열)를 넉넉히 잡는다.
const ENVELOPE_BYTES = Buffer.byteLength(
  JSON.stringify({
    system: "wholesale",
    action: AI_USAGE_READ_ACTION,
    ext_tenant: AI_USAGE_TENANT_EXT_TENANT,
    jti: "x".repeat(128),
    iat: 9_999_999_999,
    exp: 9_999_999_999,
    ext_ids: [],
    month: "2026-11-01",
  }),
  "utf8",
);

export interface AiUsageReadSplitOptions {
  /** 호출당 최대 id 수(1~200). 기본 200 */
  maxIds?: number;
  /** 본문 최대 바이트(1~8192). 기본 8192 */
  maxBodyBytes?: number;
}

export type AiUsageReadSplitResult = { ok: true; batches: string[][] } | { ok: false; code: AiUsageReadErrorCode };

/** id 목록을 «200개·8,192바이트 중 먼저 닿는 쪽» 이하의 묶음으로 나눈다(순서 유지). 빈 목록은 빈 배열(오류 아님). */
export function splitAiUsageReadIds(extIds: unknown, opts: AiUsageReadSplitOptions = {}): AiUsageReadSplitResult {
  try {
    const maxIds = opts.maxIds ?? AI_USAGE_READ_MAX_IDS;
    const maxBytes = opts.maxBodyBytes ?? AI_USAGE_READ_MAX_BODY_BYTES;

    if (!Number.isInteger(maxIds) || maxIds < 1 || maxIds > AI_USAGE_READ_MAX_IDS) return { ok: false, code: "READ_OPTIONS" };
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > AI_USAGE_READ_MAX_BODY_BYTES) return { ok: false, code: "READ_OPTIONS" };
    if (!Array.isArray(extIds)) return { ok: false, code: "READ_BATCH" };
    if (extIds.length === 0) return { ok: true, batches: [] };
    if (!extIds.every(isReadId)) return { ok: false, code: "READ_ID" };
    if (new Set(extIds).size !== extIds.length) return { ok: false, code: "READ_DUP" };

    const batches: string[][] = [];
    let current: string[] = [];
    let bytes = ENVELOPE_BYTES;

    for (const id of extIds as string[]) {
      const size = Buffer.byteLength(JSON.stringify(id), "utf8") + 1; // 쉼표

      if (ENVELOPE_BYTES + size > maxBytes) return { ok: false, code: "READ_OPTIONS" };

      if (current.length >= maxIds || bytes + size > maxBytes) {
        batches.push(current);
        current = [];
        bytes = ENVELOPE_BYTES;
      }

      current.push(id);
      bytes += size;
    }

    if (current.length > 0) batches.push(current);

    return { ok: true, batches };
  } catch {
    return { ok: false, code: "READ_BATCH" };
  }
}

export interface AiUsageReadCallDeps {
  /** 서명 시각(ms) — 시계를 이 모듈이 읽지 않으므로 필수 */
  now: number;
  /** 8~128자. 생략하면 무작위 값(재시도마다 새 jti) */
  jti?: string;
  /** 본문 수명(초), 최대 60 */
  ttl?: number;
  /** `YYYY-MM-01`. 생략하면 수신이 서울 기준 이번 달 */
  month?: string;
}

export type AiUsageReadCallResult = { ok: true; body: string; signature: string } | { ok: false; code: AiUsageReadErrorCode };

const SIGN_CODES: ReadonlySet<string> = new Set(["SIGN_SECRET_INVALID", "SIGN_TTL_INVALID", "SIGN_NOW_INVALID"]);

/**
 * 읽기 호출 한 건을 서명한다. 본문 순서 system → action → ext_tenant → jti → iat → exp → ext_ids → month(선택).
 * 반환 `body` 는 서명한 바로 그 문자열이다 — 다시 직렬화하지 말고 그대로 전송한다. 8,192바이트 초과는 `CALL_TOO_LARGE`
 * (많은 id 는 `splitAiUsageReadIds` 로 먼저 나눈다).
 */
export function buildAiUsageReadCall(secret: string, system: AccountSystem, extIds: readonly string[], deps: AiUsageReadCallDeps): AiUsageReadCallResult {
  try {
    const bad = checkIds(extIds);

    if (bad) return { ok: false, code: bad };
    if (deps.month !== undefined && !isReadMonth(deps.month)) return { ok: false, code: "READ_MONTH" };
    if (deps.jti !== undefined && (typeof deps.jti !== "string" || deps.jti.length < 8 || deps.jti.length > 128)) return { ok: false, code: "READ_OPTIONS" };

    assertSignSecret(secret);

    const iat = signNowSec(deps.now);
    const ttl = signTtl(deps.ttl);
    const o: Record<string, unknown> = {
      system,
      action: AI_USAGE_READ_ACTION,
      ext_tenant: AI_USAGE_TENANT_EXT_TENANT,
      jti: deps.jti ?? randomUUID(),
      iat,
      exp: iat + ttl,
      ext_ids: [...extIds],
    };

    if (deps.month !== undefined) o.month = deps.month;

    const body = JSON.stringify(o);
    const signature = hmacHex(body, secret);

    if (Buffer.byteLength(body, "utf8") > AI_USAGE_READ_MAX_BODY_BYTES) return { ok: false, code: "CALL_TOO_LARGE" };

    return { ok: true, body, signature };
  } catch (e) {
    const code = e instanceof Error ? /^[A-Z_]+/.exec(e.message)?.[0] : undefined;

    return { ok: false, code: code && SIGN_CODES.has(code) ? (code as AiUsageReadErrorCode) : "SIGN_FAILED" };
  }
}

export interface AiUsageReadRow {
  ext_id: string;
  linked: boolean;
  ledger_calls: number;
  ledger_tokens: number;
}

export type AiUsageReadOutcome =
  | { action: "ok"; month: string; rows: AiUsageReadRow[]; dropped: number }
  | { action: "retry_resign" | "retry_later" | "stop"; code: string };

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * 읽기 응답 분류·정제. status: HTTP 상태, 네트워크 오류·시간 초과는 `"network"`. requestedIds: 이 호출에서 물은 id.
 *  ok            200 — 요청한 id 의 행만, 알려진 4개 키만, 정수·불리언 검사 통과분만 돌려준다(`dropped` = 버린 행 수)
 *  retry_resign  401 CALL_EXPIRED — 새 iat/exp·jti 로 다시 서명해 재시도
 *  retry_later   429·503·500·네트워크 — 잠시 뒤 다시(앱은 «잠시 불러오지 못했습니다» 표시, 캐시된 값 유지)
 *  stop          그 밖의 400·401·413 과 알 수 없는 응답 — 같은 본문 재시도 금지, 코드·설정 점검
 * 오류는 코드만 돌려주고 본문의 다른 내용은 되돌리지 않는다.
 */
export function classifyAiUsageReadResponse(status: number | "network", body: unknown, requestedIds: readonly string[]): AiUsageReadOutcome {
  try {
    if (status !== 200) {
      const o = classifyAiUsageResponse(status, body);

      if (o.action === "retry_resign") return { action: "retry_resign", code: o.code };

      return { action: o.action === "next_slot" ? "retry_later" : "stop", code: o.code };
    }

    const obj = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { month?: unknown; rows?: unknown }) : null;

    if (!obj || !isReadMonth(obj.month) || !Array.isArray(obj.rows)) return { action: "stop", code: "UNKNOWN_RESPONSE" };

    const wanted = new Set(requestedIds);
    const seen = new Set<string>();
    const rows: AiUsageReadRow[] = [];
    let dropped = 0;

    for (const r of obj.rows as unknown[]) {
      const x = typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : null;

      if (!x || typeof x.ext_id !== "string" || !wanted.has(x.ext_id) || seen.has(x.ext_id)) {
        dropped += 1;
        continue;
      }

      if (typeof x.linked !== "boolean" || !isCount(x.ledger_calls) || !isCount(x.ledger_tokens)) {
        dropped += 1;
        continue;
      }

      seen.add(x.ext_id);
      rows.push({ ext_id: x.ext_id, linked: x.linked, ledger_calls: x.ledger_calls, ledger_tokens: x.ledger_tokens });
    }

    return { action: "ok", month: obj.month, rows, dropped };
  } catch {
    return { action: "stop", code: "UNKNOWN_RESPONSE" };
  }
}
