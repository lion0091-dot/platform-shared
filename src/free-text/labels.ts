/**
 * free-text 한글 라벨 표 — 경고·실패 코드와 가려진 종류가 화면에 그대로 나오지 않게 하는 기본 문구.
 * 앱은 표를 그대로 쓰거나 getter 의 overrides 로 일부만 덮어쓴다. 순수 상수, 원문은 담지 않는다.
 */
import type { FreeTextFailure, MaskedKind, WarningCode } from "./mask";

/** 경고 코드 → 문구(건수는 앱이 붙인다). */
export const FREE_TEXT_WARNING_LABELS: Readonly<Record<WarningCode, string>> = {
  NAME_CUE: "사람 이름으로 보이는 표현이 있습니다. 이름은 자동으로 가려지지 않으니 지워 주세요.",
  ADDRESS_CUE: "주소로 보이는 표현이 있습니다. 주소는 자동으로 가려지지 않으니 지워 주세요.",
  SPELLED_DIGITS: "글자로 풀어 쓴 숫자가 있습니다. 개인정보라면 지워 주세요.",
  LONG_DIGITS: "긴 숫자가 있습니다. 개인정보라면 지워 주세요.",
};

/** 실패 코드 → 문구. 실패하면 원문을 돌려주지 않으므로 앱은 저장을 막고 이 문구를 보인다. */
export const FREE_TEXT_FAILURE_LABELS: Readonly<Record<FreeTextFailure, string>> = {
  TOO_LONG: "내용이 너무 길어 저장하지 않았습니다. 줄여서 다시 입력해 주세요.",
  NOT_TEXT: "글자가 아닌 값이라 저장하지 않았습니다.",
  INTERNAL: "내용을 검사하지 못해 저장하지 않았습니다. 잠시 후 다시 시도해 주세요.",
  INVALID_POLICY: "검사 설정이 올바르지 않아 저장하지 않았습니다. 관리자에게 알려 주세요.",
};

/** 가려진 종류 → 이름. */
export const FREE_TEXT_MASKED_KIND_LABELS: Readonly<Record<MaskedKind, string>> = {
  RESIDENT_ID: "주민등록번호",
  CARD: "카드번호",
  PHONE: "전화번호",
  ACCOUNT: "계좌번호",
  EMAIL: "이메일 주소",
  BIZNO: "사업자등록번호",
  SECRET_LIKE: "비밀번호·키 형태",
};

function pick(table: Readonly<Record<string, string>>, code: unknown, overrides: Readonly<Record<string, string>> | undefined, fallback: string): string {
  if (typeof code !== "string") return fallback;
  const o = overrides && Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code] : undefined;
  if (typeof o === "string" && o !== "") return o;
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : fallback;
}

export function freeTextWarningLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  return pick(FREE_TEXT_WARNING_LABELS, code, overrides, "확인이 필요한 내용이 있습니다.");
}

export function freeTextFailureLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  return pick(FREE_TEXT_FAILURE_LABELS, code, overrides, "내용을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
}

export function freeTextMaskedKindLabel(code: unknown, overrides?: Readonly<Record<string, string>>): string {
  return pick(FREE_TEXT_MASKED_KIND_LABELS, code, overrides, "개인정보 형태");
}
