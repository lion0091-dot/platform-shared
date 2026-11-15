/**
 * 수신(레저코어) 응답 → 발신 쪽 처리 — 계약 v1 §4. 정지·접근 신호용 `classifyAccountResponse` 와 의미가 달라 따로 둔다.
 *  sent          저장함·같은 값·더 최근 줄이 이미 있음(OK·UNCHANGED·STALE) — 성공, 재시도 불필요
 *  retry_resign  수명 초과(CALL_EXPIRED) — 새 iat/exp·jti 로 다시 서명해 재시도
 *  next_slot     레저코어 설정 전(503)·일시 오류(500·네트워크·시간 초과) — 다음 슬롯에 최신 스냅샷을 다시 보냄
 *  stop          같은 본문 재시도 금지, 알림(서명·형식·크기·알 수 없는 응답)
 * 오류는 코드만 돌려주고 본문의 다른 내용은 되돌리지 않는다.
 */

export type AiUsageResponseAction = "sent" | "retry_resign" | "next_slot" | "stop";

export interface AiUsageResponseOutcome {
  action: AiUsageResponseAction;
  /** 응답의 성공 status 또는 오류 코드(대문자·밑줄만). 없으면 `HTTP_<상태>`·`NETWORK` */
  code: string;
}

const OK_STATUS: ReadonlySet<string> = new Set(["OK", "UNCHANGED", "STALE"]);
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function pickCode(value: unknown): string {
  return typeof value === "string" && CODE_RE.test(value) ? value : "";
}

/** status: HTTP 상태. 네트워크 오류·시간 초과는 `"network"`. */
export function classifyAiUsageResponse(status: number | "network", body: unknown): AiUsageResponseOutcome {
  if (status === "network") return { action: "next_slot", code: "NETWORK" };

  if (typeof status !== "number" || !Number.isInteger(status)) return { action: "stop", code: "HTTP_UNKNOWN" };

  const obj = typeof body === "object" && body !== null ? (body as { error?: unknown; status?: unknown }) : null;
  const error = pickCode(obj?.error);
  const okStatus = pickCode(obj?.status);
  const httpCode = `HTTP_${status}`;

  if (status === 200) {
    return OK_STATUS.has(okStatus) ? { action: "sent", code: okStatus } : { action: "stop", code: "UNKNOWN_STATUS" };
  }

  if (status === 401) {
    return error === "CALL_EXPIRED" ? { action: "retry_resign", code: error } : { action: "stop", code: error || httpCode };
  }

  if (status === 503) return { action: "next_slot", code: error || httpCode };
  if (status >= 500) return { action: "next_slot", code: error || httpCode };

  // 400 CALL_MALFORMED·CALL_INVALID·LINE_*, 413 CALL_TOO_LARGE 와 계약에 없는 나머지 상태는 모두 멈춤(발신 코드·설정 점검).
  return { action: "stop", code: error || httpCode };
}
