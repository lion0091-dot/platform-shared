/** L1 정규화: NFKC(전각→반각, ㈜→(주) 등) + 보이지 않는 문자·제어문자 제거. 위치(오프셋)는 이 결과 기준. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeText(raw: string): string {
  return raw.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROL, " ");
}
