/**
 * 게시판 공용 계약 v1 — 코드값·상수. 설계: docs/design-two-tier-board-shared-2026-11.md, 계약: docs/board-contract.md
 * 순수 상수만 있다(DB·화면·알림·표는 앱 몫).
 */

export const BOARD_CONTRACT_VERSION = 1 as const;

/** 앱 식별값(분석 뷰의 app_key). 결정 #6. */
export const BOARD_APP_KEYS = ["shipping", "wholesale", "ledgercore"] as const;
export type BoardAppKey = (typeof BOARD_APP_KEYS)[number];

/** 2층 읽기 전용 분석 뷰 이름(결정 #6). 1층 글은 이 뷰에 행도 열도 없다. */
export const BOARD_ANALYSIS_VIEW = "board_escalations_v" as const;

/** 분석 뷰 열(설계서 §5). 열 추가는 하위 호환, 이름·값 변경은 계약 버전을 올린다. */
export const BOARD_ANALYSIS_VIEW_COLUMNS = [
  "app_key",
  "post_id",
  "tenant_id",
  "category",
  "escalation_status",
  "created_at",
  "escalated_at",
  "first_response_at",
  "closed_at",
  "updated_at",
  "title",
  "body",
  "reply_count",
] as const;

/** 층. 1층 = 테넌트 안, 2층 = 플랫폼으로 승격된 글. */
export type BoardTier = 1 | 2;

/** 1층 분류. NOTICE 는 직원만, HANDOVER 는 직원 내부용. 앱이 더 추가할 수 있으나 분석 대상은 아니다(결정 #7). */
export const BOARD_TIER1_CATEGORIES = ["NOTICE", "QUESTION", "HANDOVER", "SUGGESTION"] as const;
export type BoardTier1Category = (typeof BOARD_TIER1_CATEGORIES)[number];

/** 일반 사용자가 쓸 수 있는 1층 분류(결정 #21). */
export const BOARD_USER_WRITABLE_CATEGORIES = ["QUESTION", "SUGGESTION"] as const;

/** 2층 분류(승격 때 선택). 청구·계약 문의는 두지 않는다(결정 #8). */
export const BOARD_TIER2_CATEGORIES = ["BUG", "FEATURE", "ACCOUNT", "ETC"] as const;
export type BoardTier2Category = (typeof BOARD_TIER2_CATEGORIES)[number];

/** 2층 상태. 1층 글의 상태는 NONE. */
export const BOARD_TIER2_STATUSES = ["RECEIVED", "IN_PROGRESS", "NEED_INFO", "DONE", "DECLINED"] as const;
export type BoardTier2Status = (typeof BOARD_TIER2_STATUSES)[number];
export type BoardStatus = "NONE" | BoardTier2Status;

/** 작성자 유형(글·답글 모두 보유). 앱이 USER 를 안 쓰면 STAFF 만(결정 #23). */
export const BOARD_AUTHOR_KINDS = ["STAFF", "USER"] as const;
export type BoardAuthorKind = (typeof BOARD_AUTHOR_KINDS)[number];

/** 보는 사람 유형. PLATFORM 은 승격된 2층만 본다. */
export const BOARD_VIEWER_KINDS = ["STAFF", "USER", "PLATFORM"] as const;
export type BoardViewerKind = (typeof BOARD_VIEWER_KINDS)[number];

/** 답글·전이를 하는 쪽. */
export type BoardActorSide = "TENANT" | "PLATFORM";

/** 답글 가시성 3종(결정 #16). */
export const BOARD_REPLY_VISIBILITIES = ["AUTHOR", "TENANT_ONLY", "PLATFORM"] as const;
export type BoardReplyVisibility = (typeof BOARD_REPLY_VISIBILITIES)[number];

/** 오류 코드(문자열만 쓰고, 값·개인정보를 담지 않는다). */
export const BOARD_ERRORS = {
  ALREADY_PROCESSED: "ALREADY_PROCESSED",
  PII_DETECTED: "PII_DETECTED",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  NOT_ESCALATED: "NOT_ESCALATED",
  RATE_LIMITED: "RATE_LIMITED",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  NOT_VISIBLE: "NOT_VISIBLE",
  NOT_AUTHORIZED: "NOT_AUTHORIZED",
  PRIVACY_NOT_CONFIRMED: "PRIVACY_NOT_CONFIRMED",
  REASON_REQUIRED: "REASON_REQUIRED",
  INVALID_CATEGORY: "INVALID_CATEGORY",
  EMPTY_CONTENT: "EMPTY_CONTENT",
  SETTING_OUT_OF_RANGE: "SETTING_OUT_OF_RANGE",
  SETTING_UNKNOWN: "SETTING_UNKNOWN",
  NOTICE_LOCKED: "NOTICE_LOCKED",
  NOTICE_INVALID: "NOTICE_INVALID",
  APPROVER_SAME_AS_REQUESTER: "APPROVER_SAME_AS_REQUESTER",
  APPROVAL_EXPIRED: "APPROVAL_EXPIRED",
  ATTACH_TOO_MANY: "ATTACH_TOO_MANY",
  ATTACH_TOO_LARGE: "ATTACH_TOO_LARGE",
  ATTACH_TYPE_NOT_ALLOWED: "ATTACH_TYPE_NOT_ALLOWED",
  ATTACH_CONTENT_MISMATCH: "ATTACH_CONTENT_MISMATCH",
  ATTACH_NAME_INVALID: "ATTACH_NAME_INVALID",
  ATTACH_NOT_FOUND: "ATTACH_NOT_FOUND",
  ATTACH_PRIVACY_NOT_CONFIRMED: "ATTACH_PRIVACY_NOT_CONFIRMED",
} as const;
export type BoardErrorCode = (typeof BOARD_ERRORS)[keyof typeof BOARD_ERRORS];
