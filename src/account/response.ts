/**
 * account 서버 호출 응답 → 호출 쪽 처리 — 약속: account 저장소 docs/contract/integration-contract.md §6.
 * 오류 이름은 경로마다 접두사가 다르다(SUSPEND_* 와 CALL_*) — 같은 의미로 해석한다. 오류는 코드만 온다(상세 없음).
 *  sent         성공(변경 있음)
 *  sent_noop    성공(할 일 없음: NO_LINK·NO_USER·NOT_MEMBER)
 *  treat_as_sent 이미 처리된 요청(409 REPLAY) — 성공으로 본다
 *  retry        새 jti·새 iat/exp 로 다시 서명해 재시도(만료·500·네트워크)
 *  retry_later  account 쪽 설정 전(503) — 큐에 보관하고 나중에
 *  owner_forbidden 403 SUSPEND_OWNER_FORBIDDEN·RESUME_OWNER_FORBIDDEN(대표는 정지·해제 대상이 아님) — 계약상 stop 이지만 "할 일 없음"일 수도 있어 따로 알린다. 성공으로 끝낼지·재시도 후 경고할지는 각 앱의 큐 정책이 정한다.
 *  stop         같은 본문 재시도 금지(형식·서명·소유자 정지 거부·연결 없음 등), 사람이 본다
 */
export type AccountCallResult = "sent" | "sent_noop" | "treat_as_sent" | "retry" | "retry_later" | "owner_forbidden" | "stop";

export interface AccountCallOutcome {
  action: AccountCallResult;
  /** 응답의 오류 코드 또는 성공 status(없으면 빈 문자열) */
  code: string;
}

const NOOP_STATUS = new Set(["NO_LINK", "NO_USER", "NOT_MEMBER"]);

/** status: HTTP 상태. network 오류·시간 초과는 status 에 "network" 를 넘긴다. */
export function classifyAccountResponse(status: number | "network", body: unknown): AccountCallOutcome {
  if (status === "network") return { action: "retry", code: "NETWORK" };

  const obj = (body ?? null) as { error?: unknown; status?: unknown } | null;
  const error = typeof obj?.error === "string" ? obj.error : "";
  const okStatus = typeof obj?.status === "string" ? obj.status : "";

  if (status === 200) return { action: NOOP_STATUS.has(okStatus) ? "sent_noop" : "sent", code: okStatus };

  const code = error || `HTTP_${status}`;
  const name = error.replace(/^(CALL|SUSPEND)_/, "");

  if (status === 409 && name === "REPLAY") return { action: "treat_as_sent", code };
  if (status === 401 && name === "EXPIRED") return { action: "retry", code };
  if (status === 403 && /OWNER_FORBIDDEN$/.test(error)) return { action: "owner_forbidden", code };
  if (status === 503) return { action: "retry_later", code };
  if (status >= 500) return { action: "retry", code };

  // 400·401(서명)·403·404·409(OLD_NOT_OWNER·LAST_OWNER·SEQ_CONFLICT)·413 — 같은 본문을 다시 보내도 결과가 같다.
  return { action: "stop", code };
}
