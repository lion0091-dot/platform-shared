import type { TossKeyMode } from "./types";

/**
 * 시크릿키 접두사로 test/live 를 읽는다. **형식 가정**: 앞뒤 공백을 지운 뒤 `^(test|live)_g?sk_`(대소문자 구분) —
 * `test_sk_…`·`live_sk_…`, 결제위젯 시크릿 키 `test_gsk_…`·`live_gsk_…`. 토스가 접두사 규칙을 바꾸면 이 정규식을 고쳐야 한다(공식 키 형식 문서는 확인 못 함, 관례).
 * 모르는 형식이면 null. 키 값은 돌려주지 않는다.
 */
export function tossKeyMode(secretKey: string): TossKeyMode | null {
  const m = /^(test|live)_g?sk_/.exec(typeof secretKey === "string" ? secretKey.trim() : "");

  return m ? (m[1] as TossKeyMode) : null;
}

/** expected 와 키 종류가 다르거나 알 수 없으면 던진다. 메시지에 키를 넣지 않는다. */
export function assertKeyMode(secretKey: string, expected: TossKeyMode): void {
  const actual = tossKeyMode(secretKey);

  if (actual !== expected) throw new Error(`KEY_MODE_MISMATCH: 이 환경은 ${expected} 키만 쓸 수 있다(받은 키 종류: ${actual ?? "알 수 없음"}).`);
}
