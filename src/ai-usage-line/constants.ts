/**
 * AI 사용량 «한 줄» 발신 — 상수. 계약: 레저코어 docs/contract/ai-usage-line-contract-v1.md (v1).
 * 순수 상수만 있다. 네트워크·DB·환경변수·시계를 쓰지 않는다.
 */

export const AI_USAGE_CONTRACT_VERSION = 1 as const;

/** 앱이 `ACCOUNT_APP_URL` 과 기본 경로(접두)를 앞에 붙여 쓴다. */
export const AI_USAGE_PATH = "/api/provision/ai-usage" as const;

/** 서명 본문의 action. 정지·접근 모드 요청과 서로 재사용할 수 없게 한다. */
export const AI_USAGE_ACTION = "ai_usage" as const;

/** 앱 전체 합계에는 업체가 없다. 서명 틀이 요구하는 자리에 넣는 고정 상수. */
export const AI_USAGE_EXT_TENANT = "APP" as const;

/** 본문 한도(바이트). 넘으면 수신이 413 으로 거부한다. */
export const AI_USAGE_MAX_BODY_BYTES = 2048;

/** 서울 기준 발신 슬롯(시). 일 4회. */
export const AI_USAGE_SLOT_HOURS: readonly number[] = Object.freeze([0, 6, 12, 18]);

/** 슬롯 시각 뒤 몇 분 안의 첫 틱만 보낸다(15분 크론 기준). */
export const AI_USAGE_WINDOW_MINUTES = 15;

/** 집계 기준 시각(as_of)이 발신 시각보다 이만큼 넘게 미래면 수신이 거부한다. */
export const AI_USAGE_FUTURE_SKEW_MS = 300_000;

/** calls·tokens 상한(계약 §1). */
export const AI_USAGE_MAX_COUNT = 1e14;

/** est_usd 상한(계약 §1). */
export const AI_USAGE_MAX_USD = 1e7;

/** estimateAiUsageUsd 가 받는 최대 행 수(모델 수 상한, 이상 입력 방어). */
export const AI_USAGE_MAX_ROWS = 200;

/** 줄에 들어가는 키(계약 §1 필수 6개, 이 순서로 직렬화). `app` 은 만들지 않는다. */
export const AI_USAGE_LINE_KEYS = Object.freeze(["contract", "month", "calls", "tokens", "est_usd", "as_of"] as const);
