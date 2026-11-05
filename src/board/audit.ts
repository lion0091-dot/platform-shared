/**
 * 스태프 변경의 감사 이벤트 코드값·위험 단계·2인 승인 요청 표 스키마 계약 상수
 * (docs/ops-staff-screen-common-rules-2026-11.md, 게시판 설계서 §12). 표·RPC·화면은 앱 몫.
 * 2인 승인 장치는 2단계(오픈 전 필수) — 1단계에서는 approval_mode 가 항상 "single".
 */
import { BOARD_ERRORS } from "./codes";

/** 감사 action(`대상.동작`, 소문자·점·밑줄 — 앱 감사 표의 형식 CHECK 와 맞춘다). */
export const BOARD_AUDIT_ACTIONS = {
  POST_REDACTED: "board.post_redacted",
  ATTACHMENT_DELETED: "board.attachment_deleted",
  SWITCH_ON: "board.switch_on",
  SWITCH_OFF: "board.switch_off",
  SETTING_CHANGED: "board.setting_changed",
  RETENTION_RUN: "board.retention_run",
} as const;
export type BoardAuditAction = (typeof BOARD_AUDIT_ACTIONS)[keyof typeof BOARD_AUDIT_ACTIONS];

export const BOARD_AUDIT_RESULTS = ["ok", "rejected", "failed"] as const;
export type BoardAuditResult = (typeof BOARD_AUDIT_RESULTS)[number];

/** 1단계는 single, 2인 승인 장치가 구현되면 two_person. */
export const BOARD_APPROVAL_MODES = ["single", "two_person"] as const;
export type BoardApprovalMode = (typeof BOARD_APPROVAL_MODES)[number];

/** 감사 기록 필수 필드 이름(앱 감사 표의 열 이름은 달라도 같은 정보가 있어야 한다). 이메일·비밀값·본문은 넣지 않는다. */
export const BOARD_AUDIT_FIELDS = [
  "actor_id",
  "actor_role",
  "at",
  "action",
  "target_kind",
  "target_id",
  "before",
  "after",
  "reason_code",
  "reason_memo",
  "result",
  "approval_mode",
  "requested_by",
  "approved_by",
  "reverts_audit_id",
] as const;

/** 확인 단계: L1 확인+이유, L2 대상 이름 재입력, L3 2인 승인(2단계). */
export type BoardRiskLevel = "L1" | "L2" | "L3";

/**
 * 게시판 작업의 위험 단계(1단계 기준). 게시판 켜기는 개인정보 스위치이므로 2인 승인 대상이나
 * 장치가 2단계라 1단계는 L2 이다(twoPersonStage: 2 — 오픈 전 필수).
 */
export const BOARD_ACTION_RISK: Record<BoardAuditAction, { level: BoardRiskLevel; twoPersonStage?: 2 }> = {
  "board.post_redacted": { level: "L2" },
  "board.attachment_deleted": { level: "L2" },
  "board.switch_on": { level: "L2", twoPersonStage: 2 },
  "board.switch_off": { level: "L1" },
  "board.setting_changed": { level: "L1" },
  "board.retention_run": { level: "L2" },
};

/** 사유 코드(선택지). OTHER 이면 메모 필수. */
export const BOARD_REASON_CODES = ["USER_REQUEST", "INCIDENT", "TEST_DATA", "LEGAL_REQUEST", "PRIVACY", "OTHER"] as const;
export type BoardReasonCode = (typeof BOARD_REASON_CODES)[number];

export const BOARD_REASON_MAX = 500;

/** 사유 1~500자(앞뒤 공백 제거 후). 빈칸·공백만이면 REASON_REQUIRED. */
export function validateReason(reason: string | null | undefined): { ok: true; reason: string } | { ok: false; code: typeof BOARD_ERRORS.REASON_REQUIRED } {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < 1 || trimmed.length > BOARD_REASON_MAX) {
    return { ok: false, code: BOARD_ERRORS.REASON_REQUIRED };
  }
  return { ok: true, reason: trimmed };
}

/** 2인 승인 요청 표 스키마 계약(앱이 표로 구현, 2단계). 요청 내용은 고정 저장되어 승인 후 바뀌지 않는다. */
export const BOARD_APPROVAL_REQUEST_COLUMNS = [
  "id",
  "action",
  "target_kind",
  "target_id",
  "before",
  "after",
  "reason_code",
  "reason_memo",
  "requested_by",
  "requested_at",
  "expires_at",
  "status",
  "decided_by",
  "decided_at",
  "decision_reason",
  "executed_at",
  "result",
] as const;

export const BOARD_APPROVAL_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "EXPIRED", "EXECUTED"] as const;
export type BoardApprovalStatus = (typeof BOARD_APPROVAL_STATUSES)[number];

/** 승인 만료 시간(시간). 기본 24, 앱 설정 가능 범위 1~72(결정 S-5). */
export const BOARD_APPROVAL_TTL_HOURS = { default: 24, min: 1, max: 72 } as const;

export function approvalExpiresAt(requestedAt: Date, ttlHours: number = BOARD_APPROVAL_TTL_HOURS.default): Date {
  const hours = Number.isInteger(ttlHours) && ttlHours >= BOARD_APPROVAL_TTL_HOURS.min && ttlHours <= BOARD_APPROVAL_TTL_HOURS.max
    ? ttlHours
    : BOARD_APPROVAL_TTL_HOURS.default;
  return new Date(requestedAt.getTime() + hours * 3600_000);
}

/** 승인·거절 가능 여부: 요청자와 다른 사람이어야 하고, 만료 전이어야 하며, 거절은 사유 필수. */
export function validateApprovalDecision(input: {
  requestedBy: string;
  decidedBy: string;
  expiresAt: Date;
  now: Date;
  decision: "APPROVE" | "REJECT";
  decisionReason?: string;
}):
  | { ok: true }
  | { ok: false; code: typeof BOARD_ERRORS.APPROVER_SAME_AS_REQUESTER | typeof BOARD_ERRORS.APPROVAL_EXPIRED | typeof BOARD_ERRORS.REASON_REQUIRED } {
  if (input.requestedBy === input.decidedBy) {
    return { ok: false, code: BOARD_ERRORS.APPROVER_SAME_AS_REQUESTER };
  }
  if (input.now.getTime() >= input.expiresAt.getTime()) {
    return { ok: false, code: BOARD_ERRORS.APPROVAL_EXPIRED };
  }
  if (input.decision === "REJECT" && !validateReason(input.decisionReason).ok) {
    return { ok: false, code: BOARD_ERRORS.REASON_REQUIRED };
  }
  return { ok: true };
}
