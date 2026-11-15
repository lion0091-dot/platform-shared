/**
 * pii-display 한글 라벨 표 — 해제 오류 코드가 화면에 그대로 나오지 않게 하는 기본 문구.
 * 앱은 표를 그대로 쓰거나 getter 의 overrides 로 일부만 덮어쓴다. 순수 상수.
 */
import type { UnmaskErrorCode } from "./reveal";

export const UNMASK_ERROR_LABELS: Readonly<Record<UnmaskErrorCode, string>> = {
  INVALID_REQUEST: "요청 내용이 올바르지 않습니다.",
  BATCH_NOT_ALLOWED: "여러 항목을 한꺼번에 볼 수 없습니다. 한 번에 한 항목만 확인해 주세요.",
  REASON_REQUIRED: "확인하는 사유를 선택해 주세요.",
  REASON_UNKNOWN: "선택한 사유를 쓸 수 없습니다. 목록에서 다시 선택해 주세요.",
  RECENT_LOGIN_REQUIRED: "보안을 위해 다시 로그인한 뒤 확인해 주세요.",
  NOT_ALLOWED: "이 정보를 볼 권한이 없습니다.",
  FAILED: "확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
};

/** 해제 오류 코드의 한글 문구. 모르는 코드는 일반 문구. overrides 로 앱이 일부를 덮어쓴다. */
export function unmaskErrorLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  const fallback = "확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  if (typeof code !== "string") return fallback;
  const o = overrides && Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code] : undefined;
  if (typeof o === "string" && o !== "") return o;
  return Object.prototype.hasOwnProperty.call(UNMASK_ERROR_LABELS, code) ? (UNMASK_ERROR_LABELS as Record<string, string>)[code] : fallback;
}
