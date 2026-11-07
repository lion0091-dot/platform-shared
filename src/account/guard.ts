/**
 * 서명 입력 검증(패키지 내부용, index 에서 내보내지 않음). 보안 점검 2-3.
 * 잘못된 설정(빈 비밀·NaN 수명)이 약한 서명이나 만료 없는 토큰으로 조용히 이어지지 않게 던진다. 메시지에 값을 넣지 않는다.
 */
export const SIGN_MAX_TTL_SEC = 60;

export function assertSignSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.trim().length === 0) throw new Error("SIGN_SECRET_INVALID: 서명 비밀이 비어 있거나 문자열이 아니다.");

  return secret;
}

/** 수명(초): 생략하면 60, 주어졌으면 유한한 양수여야 하고 60 을 넘으면 60 으로 줄인다. */
export function signTtl(ttl: unknown): number {
  if (ttl === undefined) return SIGN_MAX_TTL_SEC;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) throw new Error("SIGN_TTL_INVALID: ttl 은 0 보다 큰 유한한 숫자(초)여야 한다.");

  return Math.min(ttl, SIGN_MAX_TTL_SEC);
}

/** 발행 시각(초): now(ms) 생략 시 현재, 주어졌으면 유한한 숫자여야 한다. */
export function signNowSec(now: unknown): number {
  if (now === undefined) return Math.floor(Date.now() / 1000);
  if (typeof now !== "number" || !Number.isFinite(now)) throw new Error("SIGN_NOW_INVALID: now 는 유한한 숫자(ms)여야 한다.");

  return Math.floor(now / 1000);
}
