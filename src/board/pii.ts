/**
 * 개인정보 형태 검사 — 저장 전에 걸리면 저장하지 않고 거부하는 「실수 방지 장치」(차단이 아니다).
 * 이름·주소·차량번호·자유 서술은 못 잡는다. 이미지·첨부 내용에는 작동하지 않는다. 값은 돌려주지 않고 종류만 돌려준다.
 */

export type PiiKind = "RESIDENT_ID" | "PHONE" | "ACCOUNT" | "EMAIL";

const RESIDENT_ID = /(?<!\d)\d{6}[- ]\d{7}(?!\d)/g;
const PHONE = /(?<!\d)(?:\+82[- .]?)?0?(?:1[016789][- .]?\d{3,4}[- .]?\d{4}|(?:2|[3-6][1-5])[- .]?\d{3,4}[- .]?\d{4})(?!\d)/g;
const ACCOUNT = /(?<!\d)\d{2,6}(?:-\d{2,8}){1,3}(?!\d)/g;
// 로컬 파트는 64자(RFC 상한)로 묶는다. 무제한 `+` 는 `@` 없는 긴 입력에서 시작점마다 끝까지 훑어 이차 시간이 된다(보안 점검 3-1).
// 「포함 여부」 판정은 같다: 긴 로컬 파트도 끝 64자만으로 같은 `@` 에서 걸린다.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function digitCount(s: string): number {
  return s.replace(/\D/g, "").length;
}

/** 걸린 종류 목록(중복 없음, 고정 순서). 비어 있으면 통과. */
export function detectPii(text: string | null | undefined): PiiKind[] {
  let rest = text ?? "";
  const found: PiiKind[] = [];

  if (RESIDENT_ID.test(rest)) {
    found.push("RESIDENT_ID");
  }
  rest = rest.replace(RESIDENT_ID, " ");
  RESIDENT_ID.lastIndex = 0;

  if (PHONE.test(rest)) {
    found.push("PHONE");
  }
  PHONE.lastIndex = 0;
  rest = rest.replace(PHONE, " ");

  // 계좌 형태: 하이픈으로 나뉜 숫자 덩어리, 숫자 합계 10~14자리
  const accounts = rest.match(ACCOUNT) ?? [];
  if (accounts.some((m) => digitCount(m) >= 10 && digitCount(m) <= 14)) {
    found.push("ACCOUNT");
  }
  ACCOUNT.lastIndex = 0;

  if (EMAIL.test(rest)) {
    found.push("EMAIL");
  }
  EMAIL.lastIndex = 0;

  return found;
}
