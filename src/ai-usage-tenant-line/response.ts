/**
 * 수신(레저코어) 응답 → 발신 쪽 처리 — 배치 호출. 앱 합계 한 줄의 분류(`classifyAiUsageResponse`)를 그대로 따르되
 * 200 응답은 `{"status":"OK","received":n,"stored":m}` 만 성공으로 본다.
 * 항목별 결과·연결 없는 외부 id 구분은 응답에 없다(존재 여부 비노출). `stored < received` 여도 어느 항목인지 알 수 없고 알려고 하지 않는다.
 *  sent          저장 처리됨 — received·stored 건수 포함
 *  retry_resign  수명 초과(CALL_EXPIRED) — 새 iat/exp·jti 로 다시 서명해 재시도
 *  next_slot     설정 전(503)·속도 제한(429)·일시 오류(500·네트워크·시간 초과) — 다음 슬롯에 다시 보냄
 *  stop          같은 본문 재시도 금지, 알림(서명·형식·건수·크기·알 수 없는 응답)
 */
import { classifyAiUsageResponse, type AiUsageResponseAction } from "../ai-usage-line/response";

export interface AiUsageTenantResponseOutcome {
  action: AiUsageResponseAction;
  code: string;
  /** action 이 sent 일 때만: 받은 건수·저장 건수 */
  received?: number;
  stored?: number;
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

export function classifyAiUsageTenantResponse(status: number | "network", body: unknown): AiUsageTenantResponseOutcome {
  if (status !== 200) return classifyAiUsageResponse(status, body);

  const obj = typeof body === "object" && body !== null ? (body as { status?: unknown; received?: unknown; stored?: unknown }) : null;

  if (obj?.status !== "OK" || !isCount(obj.received) || !isCount(obj.stored) || obj.stored > obj.received) {
    return { action: "stop", code: "UNKNOWN_STATUS" };
  }

  return { action: "sent", code: "OK", received: obj.received, stored: obj.stored };
}
