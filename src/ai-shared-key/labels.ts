/**
 * ai-shared-key 한글 라벨 표 — 예약 거절 코드·오류 코드가 화면에 그대로 나오지 않게 하는 기본 문구.
 * 앱은 표를 그대로 쓰거나 getter 의 overrides 로 일부만 덮어쓴다. 순수 상수, 키·암호문 값은 담지 않는다.
 */
import type { AiReserveCode } from "./types";

/** 예약 거절 코드(READ_FAILED 포함) → 사용자에게 보일 문구. */
export const AI_RESERVE_CODE_LABELS: Readonly<Record<AiReserveCode, string>> = {
  NO_ACTIVE_KEY: "사용할 수 있는 AI 키가 없습니다.",
  COMPANY_DISABLED: "이 회사는 AI 기능이 꺼져 있습니다.",
  LIMIT_NOT_SET: "이 회사의 AI 사용 한도가 정해지지 않았습니다.",
  PLATFORM_CAP_NOT_SET: "플랫폼 전체 AI 사용 한도가 정해지지 않았습니다.",
  LIMIT_EXCEEDED: "이 회사의 AI 사용 한도를 넘었습니다.",
  PLATFORM_CAP_EXCEEDED: "플랫폼 전체 AI 사용 한도를 넘었습니다.",
  READ_FAILED: "AI 사용 한도를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
};

/** 오류 코드 → 관리 화면에 보일 문구. */
export const AI_ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  PLATFORM_INVALID: "회사 식별값이나 설정이 올바르지 않습니다.",
  REASON_REQUIRED: "사유는 1자 이상 500자 이하로 입력해 주세요.",
  AI_LIMIT_INVALID: "한도는 0 이상의 정수로 입력해 주세요.",
  AI_CREDENTIAL_INVALID: "AI 키 형식이 올바르지 않습니다.",
  NOT_FOUND: "대상을 찾을 수 없습니다.",
  RPC_FAILED: "서버 호출에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  FORBIDDEN_KEY: "허용되지 않는 값이 포함되어 있습니다.",
};

function pick(table: Readonly<Record<string, string>>, code: unknown, overrides: Readonly<Record<string, string>> | undefined, fallback: string): string {
  if (typeof code !== "string") return fallback;
  const o = overrides && Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code] : undefined;
  if (typeof o === "string" && o !== "") return o;
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : fallback;
}

/** 예약 거절 코드의 한글 문구. 모르는 코드(UNKNOWN 포함)는 일반 안내. */
export function aiReserveLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  return pick(AI_RESERVE_CODE_LABELS, code, overrides, "AI 기능을 지금 사용할 수 없습니다.");
}

/** 오류 코드의 한글 문구. 모르는 코드는 일반 안내. */
export function aiErrorLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  return pick(AI_ERROR_CODE_LABELS, code, overrides, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
}
