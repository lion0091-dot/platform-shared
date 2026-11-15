/**
 * 게시판 한글 라벨 표 — 코드값이 화면에 그대로 나오지 않게 하는 기본 문구.
 * 앱은 이 표를 그대로 쓰거나, getter 의 overrides 로 일부만 덮어쓸 수 있다(표 자체는 바꾸지 않는다).
 * 순수 상수만 있다. 값·개인정보는 담지 않는다.
 */
import type { BoardErrorCode, BoardReplyVisibility, BoardStatus, BoardTier1Category, BoardTier2Category, BoardAuthorKind, BoardViewerKind } from "./codes";
import type { PiiKind } from "./pii";

/** 모르는 코드일 때의 일반 문구(내부 코드를 보이지 않는다). */
export const BOARD_LABEL_FALLBACK = "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";

/** 오류 코드 → 사용자에게 보일 문구. */
export const BOARD_ERROR_LABELS: Readonly<Record<BoardErrorCode, string>> = {
  ALREADY_PROCESSED: "이미 처리된 건입니다. 화면을 새로 고쳐 확인해 주세요.",
  PII_DETECTED: "개인정보로 보이는 내용이 있어 저장하지 않았습니다. 지우고 다시 시도해 주세요.",
  INVALID_TRANSITION: "지금 상태에서는 이 작업을 할 수 없습니다.",
  NOT_ESCALATED: "플랫폼으로 전달되지 않은 글입니다.",
  RATE_LIMITED: "너무 자주 올리고 있습니다. 잠시 후 다시 시도해 주세요.",
  AUTH_REQUIRED: "로그인이 필요합니다.",
  NOT_VISIBLE: "대상을 찾을 수 없습니다. 이미 지워졌을 수 있습니다.",
  NOT_AUTHORIZED: "이 작업을 할 권한이 없습니다.",
  PRIVACY_NOT_CONFIRMED: "개인정보가 없음을 확인하는 칸을 체크해 주세요.",
  REASON_REQUIRED: "사유를 입력해 주세요.",
  INVALID_CATEGORY: "분류를 확인해 주세요.",
  EMPTY_CONTENT: "내용을 입력해 주세요.",
  SETTING_OUT_OF_RANGE: "설정 값이 허용 범위를 벗어났습니다.",
  SETTING_UNKNOWN: "알 수 없는 설정입니다.",
  NOTICE_LOCKED: "이 안내 문구는 바꿀 수 없습니다.",
  NOTICE_INVALID: "안내 문구를 확인해 주세요.",
  APPROVER_SAME_AS_REQUESTER: "요청한 사람은 직접 승인할 수 없습니다. 다른 담당자가 승인해야 합니다.",
  APPROVAL_EXPIRED: "승인 기한이 지났습니다. 다시 요청해 주세요.",
  ATTACH_TOO_MANY: "첨부는 한 곳에 5개까지만 올릴 수 있습니다.",
  ATTACH_TOO_LARGE: "파일이 너무 큽니다. 4MB 이하로 줄여 주세요.",
  ATTACH_TYPE_NOT_ALLOWED: "올릴 수 없는 형식입니다. 사진(jpg·png·webp), pdf, txt·log 파일만 올릴 수 있습니다.",
  ATTACH_CONTENT_MISMATCH: "파일 내용이 확장자와 맞지 않습니다. 파일을 확인해 주세요.",
  ATTACH_NAME_INVALID: "파일 이름을 확인해 주세요.",
  ATTACH_NOT_FOUND: "첨부를 찾을 수 없습니다.",
  ATTACH_PRIVACY_NOT_CONFIRMED: "첨부에 개인정보가 보이지 않음을 확인하는 칸을 체크해 주세요.",
};

/** 1층 분류. */
export const BOARD_TIER1_CATEGORY_LABELS: Readonly<Record<BoardTier1Category, string>> = {
  NOTICE: "공지",
  QUESTION: "문의",
  HANDOVER: "인수인계",
  SUGGESTION: "제안",
};

/** 2층 분류. */
export const BOARD_TIER2_CATEGORY_LABELS: Readonly<Record<BoardTier2Category, string>> = {
  BUG: "오류",
  FEATURE: "기능 요청",
  ACCOUNT: "계정·권한",
  ETC: "기타",
};

/** 상태(1층 글은 NONE). */
export const BOARD_STATUS_LABELS: Readonly<Record<BoardStatus, string>> = {
  NONE: "해당 없음",
  RECEIVED: "접수",
  IN_PROGRESS: "처리 중",
  NEED_INFO: "추가 정보 요청",
  DONE: "완료",
  DECLINED: "처리 불가",
};

/** 작성자 유형. */
export const BOARD_AUTHOR_KIND_LABELS: Readonly<Record<BoardAuthorKind, string>> = {
  STAFF: "직원",
  USER: "사용자",
};

/** 보는 사람 유형. */
export const BOARD_VIEWER_KIND_LABELS: Readonly<Record<BoardViewerKind, string>> = {
  STAFF: "직원",
  USER: "사용자",
  PLATFORM: "플랫폼 운영자",
};

/** 답글 공개 범위. */
export const BOARD_REPLY_VISIBILITY_LABELS: Readonly<Record<BoardReplyVisibility, string>> = {
  AUTHOR: "작성자에게만",
  TENANT_ONLY: "우리 회사 직원만",
  PLATFORM: "플랫폼 운영자에게",
};

/** 개인정보 감지 종류(값은 보이지 않고 종류만). */
export const BOARD_PII_KIND_LABELS: Readonly<Record<PiiKind, string>> = {
  RESIDENT_ID: "주민등록번호 형태",
  PHONE: "전화번호 형태",
  ACCOUNT: "계좌번호 형태",
  EMAIL: "이메일 주소",
};

type Overrides = Readonly<Record<string, string>>;

function pick(table: Readonly<Record<string, string>>, code: unknown, overrides: Overrides | undefined, fallback: string): string {
  if (typeof code !== "string") return fallback;
  const o = overrides && Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code] : undefined;
  if (typeof o === "string" && o !== "") return o;
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : fallback;
}

/** 오류 코드의 한글 문구. 모르는 코드는 일반 문구. overrides 로 앱이 일부를 덮어쓴다. */
export function boardErrorLabel(code: unknown, overrides?: Overrides): string {
  return pick(BOARD_ERROR_LABELS, code, overrides, BOARD_LABEL_FALLBACK);
}

/** 상태의 한글 이름. 모르는 값은 «알 수 없음». */
export function boardStatusLabel(code: unknown, overrides?: Overrides): string {
  return pick(BOARD_STATUS_LABELS, code, overrides, "알 수 없음");
}

/** 분류(1층·2층)의 한글 이름. 모르는 값은 «알 수 없음». */
export function boardCategoryLabel(code: unknown, overrides?: Overrides): string {
  return pick({ ...BOARD_TIER1_CATEGORY_LABELS, ...BOARD_TIER2_CATEGORY_LABELS }, code, overrides, "알 수 없음");
}

/** 개인정보 감지 종류의 한글 이름. */
export function boardPiiKindLabel(code: unknown, overrides?: Overrides): string {
  return pick(BOARD_PII_KIND_LABELS, code, overrides, "개인정보 형태");
}

/** 답글 공개 범위의 한글 이름. */
export function boardVisibilityLabel(code: unknown, overrides?: Overrides): string {
  return pick(BOARD_REPLY_VISIBILITY_LABELS, code, overrides, "알 수 없음");
}
