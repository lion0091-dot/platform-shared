/**
 * 서명 호출 만들기 — 기존 `buildSignedCall` 을 `action:"ai_usage"`·`ext_tenant:"APP"` 으로 부르는 얇은 래퍼.
 * 줄 필드는 계약 §1 순서(contract→month→calls→tokens→est_usd→as_of)로 본문에 들어가 계약 §3 시험 벡터와 원문이 같아진다.
 * 비밀은 호출하는 앱이 넘긴다(이 모듈은 환경변수를 읽지 않는다). 던지지 않는다 — 실패는 코드로 돌려준다.
 */
import { buildSignedCall, type AccountSystem } from "../account/sign";
import { AI_USAGE_ACTION, AI_USAGE_EXT_TENANT, AI_USAGE_LINE_KEYS, AI_USAGE_MAX_BODY_BYTES } from "./constants";
import type { AiUsageLine } from "./line";

export interface AiUsageCallDeps {
  /** 서명 시각(ms) — 시계를 이 모듈이 읽지 않으므로 필수 */
  now: number;
  /** 생략하면 서명 코드가 무작위 값을 만든다(재시도마다 새 jti) */
  jti?: string;
  /** 본문 수명(초), 최대 60 */
  ttl?: number;
}

export type AiUsageCallErrorCode = "LINE_EXTRA_KEY" | "CALL_TOO_LARGE" | "SIGN_SECRET_INVALID" | "SIGN_TTL_INVALID" | "SIGN_NOW_INVALID" | "SIGN_FAILED";

export type AiUsageCallResult = { ok: true; body: string; signature: string } | { ok: false; code: AiUsageCallErrorCode };

const SIGN_CODES: ReadonlySet<string> = new Set(["SIGN_SECRET_INVALID", "SIGN_TTL_INVALID", "SIGN_NOW_INVALID"]);

/** 반환 `body` 는 서명한 바로 그 문자열이다 — 다시 직렬화하지 말고 그대로 전송한다. */
export function buildAiUsageCall(secret: string, system: AccountSystem, line: AiUsageLine, deps: AiUsageCallDeps): AiUsageCallResult {
  try {
    const keys = typeof line === "object" && line !== null ? Reflect.ownKeys(line) : [];
    const allowed: readonly (string | symbol)[] = AI_USAGE_LINE_KEYS;

    if (keys.length !== AI_USAGE_LINE_KEYS.length || !keys.every((k) => allowed.includes(k))) return { ok: false, code: "LINE_EXTRA_KEY" };

    // 계약 순서로 다시 담는다(호출자가 키를 다른 순서로 넘겨도 본문 순서는 고정).
    const fields: Record<string, string | number> = {};

    for (const k of AI_USAGE_LINE_KEYS) fields[k] = line[k];

    const { body, signature } = buildSignedCall(
      secret,
      { system, action: AI_USAGE_ACTION, extTenant: AI_USAGE_EXT_TENANT, fields },
      { now: deps.now, jti: deps.jti, ttl: deps.ttl },
    );

    if (Buffer.byteLength(body, "utf8") > AI_USAGE_MAX_BODY_BYTES) return { ok: false, code: "CALL_TOO_LARGE" };

    return { ok: true, body, signature };
  } catch (e) {
    const code = e instanceof Error ? /^[A-Z_]+/.exec(e.message)?.[0] : undefined;

    return { ok: false, code: code && SIGN_CODES.has(code) ? (code as AiUsageCallErrorCode) : "SIGN_FAILED" };
  }
}
