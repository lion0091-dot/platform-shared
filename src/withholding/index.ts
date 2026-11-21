/**
 * 개인 차주(사업자 아닌 개인) 원천징수 계산. 순수 함수, 의존성 0.
 *
 * [세무사 확인 필요] 율·절사 규칙은 기준 구현의 현행 식을 그대로 옮긴 것이다.
 * 세무사 확인 전에는 «확정된 세무 규칙»이 아니라 «기준 구현의 현행 식과 같은 값»으로만 쓴다.
 *
 * 식(공급가 s, 원 단위 정수):
 *  - 총액     = floor(s × 33 / 1000)   (3.3%, 원 미만 버림)
 *  - 소득세   = floor(s × 30 / 1000)   (3%, 원 미만 버림)
 *  - 지방소득세 = 총액 − 소득세          (그래서 소득세 + 지방소득세 = 총액이 항상 성립, 지방소득세는 음수가 되지 않는다)
 *  예: 191,760 → 6,328 = 5,752 + 576 / 100,000 → 3,300 / 99,999 → 3,299.
 *
 * 이 함수는 «대상이면 계산»만 한다. 대상 판정(계산서 발행 여부·사업자번호 유무)은 앱 몫이다.
 * 음수는 받지 않는다: 기준 구현의 코드 식은 내림(Math.floor), DB 식은 0 방향 절사라 음수에서 서로 달라지므로 한쪽으로 고르지 않고 거부한다
 * (취소 반대 행은 호출 쪽이 절댓값으로 계산해 부호를 붙인다).
 */

/** 총률(1000분율): 3.3% */
export const WITHHOLDING_TOTAL_PER_1000 = 33;
/** 소득세율(1000분율): 3% */
export const WITHHOLDING_INCOME_PER_1000 = 30;
/** 허용 최대 공급가(DB integer 상한). 넘으면 거부. */
export const WITHHOLDING_MAX_SUPPLY = 2_147_483_647;

export interface PersonalWithholding {
  /** 원천징수 총액 = 소득세 + 지방소득세 */
  readonly total: number;
  readonly income: number;
  readonly local: number;
}

export type PersonalWithholdingResult =
  | { readonly ok: true; readonly value: PersonalWithholding }
  | { readonly ok: false; readonly code: "NOT_INTEGER" | "NEGATIVE" | "TOO_LARGE" };

/** 개인 차주 원천징수(총액·소득세·지방소득세). 던지지 않는다. */
export function computePersonalWithholding(supply: number): PersonalWithholdingResult {
  if (typeof supply !== "number" || !Number.isSafeInteger(supply)) return { ok: false, code: "NOT_INTEGER" };
  if (supply < 0) return { ok: false, code: "NEGATIVE" };
  if (supply > WITHHOLDING_MAX_SUPPLY) return { ok: false, code: "TOO_LARGE" };
  const total = Math.floor((supply * WITHHOLDING_TOTAL_PER_1000) / 1000);
  const income = Math.floor((supply * WITHHOLDING_INCOME_PER_1000) / 1000);
  return { ok: true, value: { total, income, local: total - income } };
}

/**
 * 개인 차주 대상 판정(순수 함수). [세무사 확인 필요] 판정 순서는 제품 결정이다.
 *  ① 사업자번호가 있으면 사업자(원천징수 없음)
 *  ② 없으면 세금계산서(계산서) 발행 여부를 본다. 있으면 사업자(원천징수 없음)
 *  ③ 둘 다 없으면 개인(3.3% 원천징수 대상)
 * 사업자번호는 «있는지 없는지»만 받는다(형식·유효성 검증은 앱 몫). 문자열은 앞뒤 공백을 뺀 뒤 비어 있지 않으면 «있음».
 * 입력 의미: `true`/값 있는 문자열 = 있음, `false`/빈 문자열/`null`(저장소에 값이 없음) = 없음, `undefined`(아직 모름) = 불명.
 * **주의: 아직 조회하지 않았거나 값을 모르는 항목은 반드시 `undefined` 로 넘길 것. `null` 은 «없음»으로 판정된다**(둘 다 `null` 이면 개인으로 판정됨).
 * 불명이면 임의로 단정하지 않고 NEEDS_CHECK 를 돌려준다(자동 단정 금지). 다른 쪽 근거만으로 결과가 정해지면 그대로 정한다
 * (예: 사업자번호 불명이어도 계산서가 있으면 어느 경우든 사업자).
 */
export interface WithholdingTargetInput {
  /** 사업자번호 유무 또는 값 */
  readonly businessNumber?: boolean | string | null;
  /** 세금계산서(계산서) 발행 여부 */
  readonly taxInvoice?: boolean | null;
}

export type WithholdingTargetReason =
  | "BUSINESS_NUMBER" // 사업자번호 있음 → 사업자
  | "TAX_INVOICE" // 사업자번호 없음 + 계산서 있음 → 사업자
  | "NO_BUSINESS_NO_INVOICE" // 둘 다 없음 → 개인
  | "BUSINESS_NUMBER_UNKNOWN" // 사업자번호 불명, 계산서로도 정해지지 않음
  | "TAX_INVOICE_UNKNOWN"; // 사업자번호 없음, 계산서 불명

export interface WithholdingTarget {
  /** PERSONAL = 개인(원천징수 대상), BUSINESS = 사업자(원천징수 없음), NEEDS_CHECK = 확인 필요(단정 금지) */
  readonly decision: "PERSONAL" | "BUSINESS" | "NEEDS_CHECK";
  /** 개인 대상이면 true, 사업자면 false, 확인 필요면 null */
  readonly personal: boolean | null;
  readonly reason: WithholdingTargetReason;
}

function presence(v: boolean | string | null | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().length > 0;
  return undefined; // 그 밖의 타입은 모르는 것으로 본다
}

export function judgeWithholdingTarget(input: WithholdingTargetInput): WithholdingTarget {
  const bn = presence(input?.businessNumber);
  const inv = presence(input?.taxInvoice);
  if (bn === true) return { decision: "BUSINESS", personal: false, reason: "BUSINESS_NUMBER" };
  if (inv === true) return { decision: "BUSINESS", personal: false, reason: "TAX_INVOICE" };
  if (bn === undefined) return { decision: "NEEDS_CHECK", personal: null, reason: "BUSINESS_NUMBER_UNKNOWN" };
  if (inv === undefined) return { decision: "NEEDS_CHECK", personal: null, reason: "TAX_INVOICE_UNKNOWN" };
  return { decision: "PERSONAL", personal: true, reason: "NO_BUSINESS_NO_INVOICE" };
}
