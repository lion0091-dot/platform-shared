import type { TossKeyMode } from "./types";

/** 시크릿키 접두사로 test/live 를 읽는다(`test_sk_…`·`live_sk_…`, 결제위젯 키는 `gsk`). 모르는 형식이면 null. 키 값은 돌려주지 않는다. */
export function tossKeyMode(secretKey: string): TossKeyMode | null {
  const m = /^(test|live)_g?sk_/.exec(typeof secretKey === "string" ? secretKey : "");

  return m ? (m[1] as TossKeyMode) : null;
}

/** expected 와 키 종류가 다르거나 알 수 없으면 던진다. 메시지에 키를 넣지 않는다. */
export function assertKeyMode(secretKey: string, expected: TossKeyMode): void {
  const actual = tossKeyMode(secretKey);

  if (actual !== expected) throw new Error(`KEY_MODE_MISMATCH: 이 환경은 ${expected} 키만 쓸 수 있다(받은 키 종류: ${actual ?? "알 수 없음"}).`);
}
