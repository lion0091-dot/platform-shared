/**
 * 원문 해제(규칙 A 1단계) 계약: 서버 액션이 구현할 흐름의 타입, 순수 검증 함수, 순서를 강제하는 실행기.
 *
 *   최근 로그인 5분 이내 → 사유 코드 필수 → 권한 확인 → 열람 기록(시도) → 원문 읽기 → 열람 기록(결과) → 반환
 *   - 열람 기록이 실패하면 원문을 반환하지 않는다(fail-closed).
 *   - 해제는 «대상 1건 · 필드군 1개» 단위다. 일괄 해제(배열·목록)는 거부한다.
 *   - 해제 토큰은 5분, 같은 사용자·회사·표·대상 1건·필드군에서만 유효하다.
 * 이 모듈은 DB·시계·난수·네트워크를 직접 쓰지 않는다. 시각·토큰 id·저장은 앱이 훅으로 준다. 키·비밀값은 다루지 않는다.
 * 열람 기록·오류에는 원문(값)을 넣지 않는다.
 */

/** 최근 로그인 허용 시간(초). 개발자 확정: 5분. */
export const RECENT_LOGIN_MAX_SEC = 300;
/** 해제 토큰 유효 시간(ms). 개발자 확정: 5분. 앱은 줄일 수는 있어도 늘릴 수 없다. */
export const UNMASK_TOKEN_TTL_MS = 300_000;
export const REASON_NOTE_MAX = 500;

export type UnmaskErrorCode =
  | "INVALID_REQUEST"
  | "BATCH_NOT_ALLOWED"
  | "REASON_REQUIRED"
  | "REASON_UNKNOWN"
  | "RECENT_LOGIN_REQUIRED"
  | "NOT_ALLOWED"
  | "FAILED";

export interface UnmaskTarget {
  table: string;
  recordId: string;
}

export interface UnmaskRequest {
  company: string;
  actor: { id: string; role: string };
  target: UnmaskTarget;
  /** 필드군 1개(예: "contact", "account"). 여러 개 한꺼번에 해제할 수 없다. */
  fieldGroup: string;
  /** 앱이 정한 닫힌 목록의 사유 코드. */
  reasonCode: string;
  /** 선택 보충 메모. 자유 문장이므로 앱이 규칙 B(자유 문장 가림)를 적용한 뒤 넘긴다. 이 모듈은 길이만 본다. */
  reasonNote?: string;
  /** 서버가 세션(IdP 인증 시각)에서 계산한 값. 클라이언트 값을 그대로 쓰면 안 된다. */
  recentLoginAgeSec: number;
}

export interface UnmaskConfig {
  /** 허용 사유 코드 목록(앱이 정의). 비어 있으면 모든 요청이 거부된다. */
  reasonCodes: readonly string[];
  /** 허용 필드군 목록(앱이 정의). */
  fieldGroups: readonly string[];
  /** 토큰 유효 시간을 줄일 때만(ms, 1 이상). */
  tokenTtlMs?: number;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const GROUP_RE = /^[a-z][a-z0-9_]{0,39}$/;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/;

export type Validation<T> = { ok: true; value: T } | { ok: false; code: UnmaskErrorCode };

function fail<T>(code: UnmaskErrorCode): Validation<T> {
  return { ok: false, code };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 요청 검증(순수). 통과한 값은 복사본이라 호출자가 나중에 원본을 바꿔도 영향이 없다. */
export function validateUnmaskRequest(req: unknown, cfg: UnmaskConfig): Validation<UnmaskRequest> {
  try {
    if (!isRecord(req)) return fail("INVALID_REQUEST");
    const { company, actor, target, fieldGroup, reasonCode, reasonNote, recentLoginAgeSec } = req as Record<string, unknown>;

    // 일괄 해제 금지: 대상·필드군·회사·행위자가 배열/목록이면 거부.
    if (Array.isArray(target) || Array.isArray(fieldGroup) || Array.isArray(company) || Array.isArray(actor)) return fail("BATCH_NOT_ALLOWED");
    if (!isRecord(target) || Array.isArray((target as Record<string, unknown>).recordId)) return fail(Array.isArray((target as Record<string, unknown> | undefined)?.recordId) ? "BATCH_NOT_ALLOWED" : "INVALID_REQUEST");
    if (typeof company !== "string" || !ID_RE.test(company)) return fail("INVALID_REQUEST");
    if (!isRecord(actor) || typeof actor.id !== "string" || !ID_RE.test(actor.id) || typeof actor.role !== "string" || !ROLE_RE.test(actor.role)) {
      return fail("INVALID_REQUEST");
    }
    const t = target as Record<string, unknown>;
    if (typeof t.table !== "string" || !NAME_RE.test(t.table) || typeof t.recordId !== "string") return fail("INVALID_REQUEST");
    // 쉼표·공백·와일드카드가 들어간 id 는 «여러 건» 시도로 보고 거부한다.
    if (/[\s,;*%]/.test(t.recordId)) return fail("BATCH_NOT_ALLOWED");
    if (!ID_RE.test(t.recordId)) return fail("INVALID_REQUEST");
    if (typeof fieldGroup !== "string" || !GROUP_RE.test(fieldGroup)) return fail("INVALID_REQUEST");
    if (!cfg.fieldGroups.includes(fieldGroup)) return fail("INVALID_REQUEST");

    if (typeof reasonCode !== "string" || reasonCode === "") return fail("REASON_REQUIRED");
    if (!CODE_RE.test(reasonCode) || !cfg.reasonCodes.includes(reasonCode)) return fail("REASON_UNKNOWN");
    if (reasonNote !== undefined && (typeof reasonNote !== "string" || reasonNote.length > REASON_NOTE_MAX)) return fail("INVALID_REQUEST");

    if (typeof recentLoginAgeSec !== "number" || !Number.isFinite(recentLoginAgeSec) || recentLoginAgeSec < 0 || recentLoginAgeSec > RECENT_LOGIN_MAX_SEC) {
      return fail("RECENT_LOGIN_REQUIRED");
    }

    const value: UnmaskRequest = {
      company,
      actor: { id: actor.id, role: actor.role },
      target: { table: t.table, recordId: t.recordId },
      fieldGroup,
      reasonCode,
      recentLoginAgeSec,
      ...(reasonNote !== undefined ? { reasonNote } : {}),
    };
    return { ok: true, value };
  } catch {
    return fail("INVALID_REQUEST");
  }
}

// ── 열람 기록 ─────────────────────────────────────────────────
export type AccessKind = "UNMASK" | "EXCEPTION_PLAIN";
export type AccessOutcome = "attempt" | "ok" | "denied" | "failed";

/** 열람 기록 한 건. 값(원문)·암호문·키 조각을 담는 자리가 없다. */
export interface AccessLogEntry {
  kind: AccessKind;
  at: string; // ISO UTC
  company: string;
  actorId: string;
  actorRole: string;
  table: string;
  recordId: string;
  fieldGroup: string;
  reasonCode: string;
  reasonNote?: string;
  outcome: AccessOutcome;
  /** 로그인 근거(예: recent_login_5m). */
  authBasis: string;
  tokenId?: string;
  errorCode?: UnmaskErrorCode;
}

/** 예외 평문(진행 중 주문 상세·본인·문서) 최소 기록. 사유 없음. */
export interface ExceptionPlainEntry {
  kind: "EXCEPTION_PLAIN";
  at: string;
  company: string;
  actorId: string;
  actorRole: string;
  table: string;
  recordId: string;
  surface: string;
  basisKind: "ACTIVE_ORDER" | "SELF" | "DOCUMENT";
}

// ── 해제 토큰 ─────────────────────────────────────────────────
export interface UnmaskTokenRecord {
  tokenId: string;
  actorId: string;
  company: string;
  table: string;
  recordId: string;
  fieldGroup: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type TokenCheck = { ok: true } | { ok: false; code: "TOKEN_INVALID" | "TOKEN_EXPIRED" | "TOKEN_MISMATCH" };

export function issueTokenRecord(req: UnmaskRequest, tokenId: string, nowMs: number, ttlMs: number = UNMASK_TOKEN_TTL_MS): UnmaskTokenRecord | null {
  if (typeof tokenId !== "string" || !ID_RE.test(tokenId)) return null;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return null;
  const ttl = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs >= 1 ? Math.min(ttlMs, UNMASK_TOKEN_TTL_MS) : UNMASK_TOKEN_TTL_MS;
  return {
    tokenId,
    actorId: req.actor.id,
    company: req.company,
    table: req.target.table,
    recordId: req.target.recordId,
    fieldGroup: req.fieldGroup,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttl,
  };
}

/** 토큰 사용 검사(순수). 다른 사용자·회사·표·대상·필드군이면 불일치. 만료 시각 이후(>=)는 만료. */
export function checkTokenUse(
  token: unknown,
  use: { actorId: string; company: string; table: string; recordId: string; fieldGroup: string },
  nowMs: number,
): TokenCheck {
  try {
    if (!isRecord(token)) return { ok: false, code: "TOKEN_INVALID" };
    const t = token as Partial<UnmaskTokenRecord>;
    if (typeof t.expiresAtMs !== "number" || typeof t.issuedAtMs !== "number" || !Number.isFinite(t.expiresAtMs) || !Number.isFinite(t.issuedAtMs)) {
      return { ok: false, code: "TOKEN_INVALID" };
    }
    if (t.expiresAtMs - t.issuedAtMs > UNMASK_TOKEN_TTL_MS || t.expiresAtMs <= t.issuedAtMs) return { ok: false, code: "TOKEN_INVALID" };
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return { ok: false, code: "TOKEN_INVALID" };
    if (
      t.actorId !== use.actorId ||
      t.company !== use.company ||
      t.table !== use.table ||
      t.recordId !== use.recordId ||
      t.fieldGroup !== use.fieldGroup
    ) {
      return { ok: false, code: "TOKEN_MISMATCH" };
    }
    if (nowMs < t.issuedAtMs) return { ok: false, code: "TOKEN_INVALID" };
    if (nowMs >= t.expiresAtMs) return { ok: false, code: "TOKEN_EXPIRED" };
    return { ok: true };
  } catch {
    return { ok: false, code: "TOKEN_INVALID" };
  }
}

// ── 실행기 ───────────────────────────────────────────────────
export interface UnmaskHooks {
  /** 서버 권한 확인(역할·회사 소속·대상 접근권). false 이거나 throw 면 거부. */
  authorize(req: UnmaskRequest): Promise<boolean> | boolean;
  /** 열람 기록 저장(앱 몫). throw 하면 원문을 반환하지 않는다. */
  record(entry: AccessLogEntry): Promise<void> | void;
  /** 원문 읽기(앱 몫: 암호화 값이면 revealField 등). 반환 문자열은 이 함수 밖에 남기지 않는다. */
  load(req: UnmaskRequest): Promise<string> | string;
  /** 서버 시각(ms). */
  nowMs(): number;
  /** 토큰 id 생성(난수는 앱 몫). */
  newTokenId(): string;
}

export type UnmaskResult =
  | { ok: true; value: string; token: UnmaskTokenRecord }
  | { ok: false; code: UnmaskErrorCode };

export async function runUnmask(req: unknown, cfg: UnmaskConfig, hooks: UnmaskHooks): Promise<UnmaskResult> {
  const v = validateUnmaskRequest(req, cfg);
  if (!v.ok) return { ok: false, code: v.code };
  const r = v.value;

  const entry = (outcome: AccessOutcome, extra: Partial<AccessLogEntry> = {}): AccessLogEntry => ({
    kind: "UNMASK",
    at: new Date(hooks.nowMs()).toISOString(),
    company: r.company,
    actorId: r.actor.id,
    actorRole: r.actor.role,
    table: r.target.table,
    recordId: r.target.recordId,
    fieldGroup: r.fieldGroup,
    reasonCode: r.reasonCode,
    ...(r.reasonNote !== undefined ? { reasonNote: r.reasonNote } : {}),
    outcome,
    authBasis: "recent_login_5m",
    ...extra,
  });

  try {
    let allowed = false;
    try {
      allowed = (await hooks.authorize(r)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      try {
        await hooks.record(entry("denied", { errorCode: "NOT_ALLOWED" }));
      } catch {
        /* 거부 기록 실패는 결과를 바꾸지 않는다(원문은 어차피 반환하지 않음) */
      }
      return { ok: false, code: "NOT_ALLOWED" };
    }

    await hooks.record(entry("attempt")); // 실패하면 아래 catch → 원문 미반환

    let value: string;
    try {
      value = await hooks.load(r);
      if (typeof value !== "string") throw new Error("load");
    } catch {
      try {
        await hooks.record(entry("failed", { errorCode: "FAILED" }));
      } catch {
        /* ignore */
      }
      return { ok: false, code: "FAILED" };
    }

    const token = issueTokenRecord(r, hooks.newTokenId(), hooks.nowMs(), cfg.tokenTtlMs);
    if (!token) return { ok: false, code: "FAILED" };
    await hooks.record(entry("ok", { tokenId: token.tokenId })); // 결과 기록이 실패하면 원문을 버린다
    return { ok: true, value, token };
  } catch {
    return { ok: false, code: "FAILED" };
  }
}

/**
 * 예외 평문 최소 기록의 행을 만든다(순수). 사유 없음. 값·위치 정보 없음.
 * 기록 저장과 실패 처리(평문 반환 + 경고 + 회로 차단)는 앱 몫이다(설계서 A-1b-4).
 */
export function buildExceptionPlainEntry(args: {
  nowMs: number;
  company: string;
  actor: { id: string; role: string };
  target: UnmaskTarget;
  surface: string;
  basisKind: "ACTIVE_ORDER" | "SELF" | "DOCUMENT";
}): ExceptionPlainEntry {
  return {
    kind: "EXCEPTION_PLAIN",
    at: new Date(args.nowMs).toISOString(),
    company: args.company,
    actorId: args.actor.id,
    actorRole: args.actor.role,
    table: args.target.table,
    recordId: args.target.recordId,
    surface: args.surface,
    basisKind: args.basisKind,
  };
}
