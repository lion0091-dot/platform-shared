import { SecretError, type SecretErrorCode } from "./errors";
import { openSecret, type SecretContext, type SecretFormat } from "./envelope";
import type { Keyring } from "./keyring";

/**
 * 비밀 읽기 결과의 3상태. 앱이 각자 구현하던 "행이 없음"과 "있는데 읽지 못함"의 구분을 한곳으로.
 *
 *  - ok          열었고 파싱도 통과. `needsRewrite` 가 true 면 다시 봉인해 저장할 것(레거시·이전 키).
 *  - absent      저장된 값이 없음(null·undefined·빈 문자열) → "설정 안 됨".
 *  - unavailable 값은 있는데 쓸 수 없음(DB 읽기 실패·키 없음·복호화 실패·형식 오류·내용 검증 실패).
 *                **설정 문제로 보고 소모하지 말 것**(예: 이미 승인된 결제가 있을 수 있어 "확인 못 함"으로 다룬다).
 *
 * `reason` 은 코드 문자열뿐이다(값·키 조각 없음).
 */
export type SecretState<T> =
  | { state: "ok"; value: T; needsRewrite: boolean; format: SecretFormat }
  | { state: "absent" }
  | { state: "unavailable"; reason: SecretErrorCode | "READ_FAILED" | "INVALID_PAYLOAD" };

export type SecretParser<T> = (plain: string) => T | null;

/**
 * 저장된 문자열(`stored`)을 3상태로 해석한다.
 *  - `stored === undefined` 가 아니라 DB 읽기 자체가 실패했다면 `readFailed()` 를 쓴다.
 *  - `keyring` 은 이미 만든 키링이거나, 키링을 만드는 함수(키 환경변수 누락·형식 오류가 `unavailable` 로 매핑된다).
 *  - `parse` 는 평문(보통 JSON)을 검증해 값으로 바꾼다. 형식이 틀리면 null 을 돌려주거나 던진다 → `INVALID_PAYLOAD`.
 */
export function resolveSecret<T>(
  stored: unknown,
  ctx: SecretContext,
  keyring: Keyring | (() => Keyring),
  parse: SecretParser<T>,
): SecretState<T> {
  if (stored === null || stored === undefined || stored === "") return { state: "absent" };

  if (typeof stored !== "string") return { state: "unavailable", reason: "SECRET_FORMAT" };

  let ring: Keyring;

  try {
    ring = typeof keyring === "function" ? keyring() : keyring;
  } catch (e) {
    return { state: "unavailable", reason: e instanceof SecretError ? e.code : "SECRET_KEY_INVALID" };
  }

  let opened;

  try {
    opened = openSecret(stored, ctx, ring);
  } catch (e) {
    return { state: "unavailable", reason: e instanceof SecretError ? e.code : "SECRET_DECRYPT_FAILED" };
  }

  let value: T | null;

  try {
    value = parse(opened.plain);
  } catch {
    return { state: "unavailable", reason: "INVALID_PAYLOAD" };
  }

  if (value === null) return { state: "unavailable", reason: "INVALID_PAYLOAD" };

  return { state: "ok", value, needsRewrite: opened.needsRewrite, format: opened.format };
}

/** DB·RPC 읽기 자체가 실패했을 때(값을 모름). 호출 쪽이 결과를 이 상태로 돌려주면 된다. */
export function readFailed(): { state: "unavailable"; reason: "READ_FAILED" } {
  return { state: "unavailable", reason: "READ_FAILED" };
}

/** JSON 평문용 파서 만들기: `validate` 가 unknown 을 받아 값 또는 null 을 돌려준다. */
export function jsonSecret<T>(validate: (value: unknown) => T | null): SecretParser<T> {
  return (plain) => validate(JSON.parse(plain) as unknown);
}
