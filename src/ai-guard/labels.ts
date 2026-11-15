/**
 * ai-guard 한글 라벨 표 — 거절 사유·감지 종류·경고 코드가 화면에 그대로 나오지 않게 하는 기본 문구.
 * 앱은 표를 그대로 쓰거나 getter 의 overrides 로 일부만 덮어쓴다. 순수 상수, 원문·개인정보는 담지 않는다.
 */
import type { GuardKind, GuardReason, GuardWarning } from "./types";

/** 거절 사유 → 사용자에게 보일 문구(원문은 보이지 않는다). */
export const GUARD_REASON_LABELS: Readonly<Record<GuardReason, string>> = {
  OVER_LENGTH: "내용이 너무 길어 AI 에 보내지 않았습니다.",
  UNKNOWN_FIELD: "허용되지 않은 항목이 있어 AI 에 보내지 않았습니다.",
  NON_TEXT: "글자가 아닌 내용이 있어 AI 에 보내지 않았습니다.",
  SCHEMA_VIOLATION: "입력 형식이 맞지 않아 AI 에 보내지 않았습니다.",
  RESIDUAL_PII: "개인정보로 보이는 내용이 남아 있어 AI 에 보내지 않았습니다.",
  TOO_MANY_REPLACEMENTS: "가려야 할 내용이 너무 많아 AI 에 보내지 않았습니다.",
  SECRET_LIKE: "비밀번호·키처럼 보이는 내용이 있어 AI 에 보내지 않았습니다.",
  TOKEN_COLLISION: "내용 중 가림 표시와 겹치는 부분이 있어 AI 에 보내지 않았습니다.",
  DETECTOR_FAILED: "개인정보 검사에 실패해 AI 에 보내지 않았습니다.",
  INVALID_POLICY: "개인정보 검사 설정이 올바르지 않아 AI 에 보내지 않았습니다.",
  CHECK_ERROR: "개인정보 검사 중 오류가 나 AI 에 보내지 않았습니다.",
};

/** 감지 종류 → 이름. */
export const GUARD_KIND_LABELS: Readonly<Record<GuardKind, string>> = {
  RESIDENT_ID: "주민등록번호",
  BIZNO: "사업자등록번호",
  PHONE: "전화번호",
  ACCOUNT: "계좌번호",
  EMAIL: "이메일 주소",
  CARD: "카드번호",
  ORG: "상호·기관명",
  PERSON: "사람 이름",
  ADDRESS: "주소",
  PLATE: "차량번호",
  SECRET_LIKE: "비밀번호·키 형태",
  KNOWN: "등록된 비공개 용어",
};

/** 경고 코드 → 문구. */
export const GUARD_WARNING_LABELS: Readonly<Record<GuardWarning, string>> = {
  ADDRESS_CUE: "주소로 보이는 표현이 있습니다. 확인해 주세요.",
};

function pick(table: Readonly<Record<string, string>>, code: unknown, overrides: Readonly<Record<string, string>> | undefined, fallback: string): string {
  if (typeof code !== "string") return fallback;
  const o = overrides && Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code] : undefined;
  if (typeof o === "string" && o !== "") return o;
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : fallback;
}

/** 거절 사유의 한글 문구. 모르는 코드는 일반 문구. */
export function guardReasonLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  return pick(GUARD_REASON_LABELS, code, overrides, "AI 에 보내지 못했습니다. 내용을 확인해 주세요.");
}

/** 감지 종류의 한글 이름. */
export function guardKindLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  return pick(GUARD_KIND_LABELS, code, overrides, "개인정보 형태");
}

/** 경고 코드의 한글 문구. */
export function guardWarningLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  return pick(GUARD_WARNING_LABELS, code, overrides, "확인이 필요한 내용이 있습니다.");
}
