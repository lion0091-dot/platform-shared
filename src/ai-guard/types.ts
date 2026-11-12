/**
 * ai-guard 공개 타입·상수. 순수 함수 모듈 — 네트워크·DB·시계·난수 사용 없음, 의존성 0.
 * 설계: docs/design-ai-egress-guard-2026-11.md (로컬 초안). 실제 개인정보·키는 어디에도 없다.
 */

/** 규칙을 바꾸면 올린다. /2: 숫자 옆 유니코드 대시·비ASCII 숫자 정규화, 이름 단서어 추가, 겹친 스팬의 처리 방식 합치기(가장 엄격한 쪽), 주소 단서 경고. */
export const GUARD_RULES_VERSION = "ai-guard-rules/2";

/** 가리지는 않지만 알려 주는 신호(닫힌 집합). 값·위치는 담지 않는다. */
export type GuardWarning = "ADDRESS_CUE";

export const GUARD_KINDS = [
  "RESIDENT_ID",
  "BIZNO",
  "PHONE",
  "ACCOUNT",
  "EMAIL",
  "CARD",
  "ORG",
  "PERSON",
  "ADDRESS",
  "PLATE",
  "SECRET_LIKE",
  "KNOWN",
] as const;
export type GuardKind = (typeof GUARD_KINDS)[number];

/** 사유 코드는 닫힌 집합. 원문은 어디에도 실리지 않는다. */
export const GUARD_REASONS = [
  "OVER_LENGTH",
  "UNKNOWN_FIELD",
  "NON_TEXT",
  "SCHEMA_VIOLATION",
  "RESIDUAL_PII",
  "TOO_MANY_REPLACEMENTS",
  "SECRET_LIKE",
  "TOKEN_COLLISION",
  "DETECTOR_FAILED",
  "INVALID_POLICY",
  "CHECK_ERROR",
] as const;
export type GuardReason = (typeof GUARD_REASONS)[number];

/** MASK=토큰 치환 / BLOCK=호출 금지 / PASS=탐지·집계하되 그대로 전송 / OFF=탐지 안 함 */
export type KindMode = "MASK" | "BLOCK" | "PASS" | "OFF";
export type GuardLevel = "STRICT" | "STANDARD";

export type FieldSpec =
  | { readonly type: "text"; readonly maxChars?: number }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "number"; readonly min: number; readonly max: number; readonly integer?: boolean }
  | { readonly type: "boolean" };

export interface KnownTerm {
  readonly kind: GuardKind;
  readonly value: string;
  readonly alias?: readonly string[];
}

export interface DetectedSpan {
  readonly kind: GuardKind;
  readonly start: number;
  readonly end: number;
}
/** 앱 감지기: L1 정규화를 마친 텍스트를 받아 스팬만 돌려준다(합집합으로만 반영). 동기. */
export type ExtraDetector = (normalizedText: string) => readonly DetectedSpan[];

export interface GuardPolicy {
  /** 로그에 남는 식별자. 소문자·숫자·`_.:-` 만. */
  readonly policyId: string;
  readonly level: GuardLevel;
  /** 구조화 입력의 허용 경로. 문자열 단일 입력이면 쓰지 않는다. 경로: `a.b`, 배열 원소 `items[].name`. */
  readonly fields?: Readonly<Record<string, FieldSpec>>;
  /** 선언 밖 키: DROP(버림, 건수만 기록) / BLOCK(호출 금지, 기본). */
  readonly unknownKeys?: "DROP" | "BLOCK";
  readonly kinds?: Readonly<Partial<Record<GuardKind, KindMode>>>;
  readonly knownTerms?: readonly KnownTerm[];
  readonly extraOrgMarkers?: readonly string[];
  readonly extraPersonCues?: readonly string[];
  readonly extraDetectors?: readonly ExtraDetector[];
  /** 응답에서 원문으로 되돌릴 종류(필수, 기본값 없음). RESIDENT_ID·CARD·ACCOUNT·SECRET_LIKE 는 넣을 수 없다. */
  readonly restoreKinds: readonly GuardKind[];
  /** 입력에 토큰 모양(`[ORG_1]`)이 이미 있을 때. 기본 ESCAPE. */
  readonly onCollision?: "ESCAPE" | "BLOCK";
  readonly maxCharsPerField: number;
  readonly maxCharsTotal: number;
  readonly maxReplacements: number;
}

/** 로그에 남겨도 되는 것만: 종류별 건수·정책 ID·규칙 버전·길이. 원문·키 이름·맵·해시 없음. */
export interface GuardReport {
  readonly rulesVersion: string;
  readonly policyId: string;
  readonly counts: Readonly<Partial<Record<GuardKind, number>>>;
  readonly passed: Readonly<Partial<Record<GuardKind, number>>>;
  readonly fieldsSent: readonly string[];
  readonly droppedCount: number;
  readonly charsIn: number;
  readonly charsOut: number;
  /** 경고가 하나라도 있을 때만 존재(없으면 키 자체가 없다 — 기존 리포트 모양 유지). */
  readonly warnings?: Readonly<Partial<Record<GuardWarning, number>>>;
}

declare const SAFE: unique symbol;
/** guard() 가 만든 전송용 페이로드(문자열 또는 허용 필드만 담은 객체). 값은 L1 정규화를 거친 텍스트다. */
export interface SafePayload {
  readonly [SAFE]: true;
  readonly value: string | { readonly [key: string]: unknown };
}

export interface RestoreResult {
  readonly text: string;
  /** 이번 호출 맵에 없는 토큰(모델이 만들었거나 깨진 것). 복원하지 않았다. */
  readonly unknownTokens: readonly string[];
  /** 맵에는 있으나 restoreKinds 밖이라 복원하지 않은 토큰. */
  readonly unrestoredTokens: readonly string[];
}

export type GuardResult =
  | {
      readonly ok: true;
      readonly payload: SafePayload;
      readonly restore: (aiText: string) => RestoreResult;
      readonly report: GuardReport;
    }
  | {
      readonly ok: false;
      readonly reason: GuardReason;
      readonly kinds?: readonly GuardKind[];
      readonly report: GuardReport;
    };

/** 복원·치환 대상에서 영구히 제외되는(항상 가림/차단) 종류. */
export const HARD_KINDS: readonly GuardKind[] = ["RESIDENT_ID", "CARD", "ACCOUNT", "SECRET_LIKE"];
