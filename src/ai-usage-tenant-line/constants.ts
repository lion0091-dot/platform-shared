/**
 * 테넌트별 AI 토큰 «한 줄» 발신 — 상수. 설계: 레저코어 docs/design-tenant-ai-usage-rollup-2026-11.md §3,
 * 계약: 레저코어 docs/contract/ai-usage-tenant-line-contract-v1.md (v1, 이 문서가 우선).
 * 순수 상수만 있다. 네트워크·DB·환경변수·시계를 쓰지 않는다.
 */
import { AI_USAGE_MAX_COUNT, AI_USAGE_PATH } from "../ai-usage-line/constants";

export const AI_USAGE_TENANT_CONTRACT_VERSION = 1 as const;

/** 앱 합계 한 줄(v1)과 같은 경로를 쓰고 action 으로 구분한다. */
export const AI_USAGE_TENANT_PATH = AI_USAGE_PATH;

/** 서명 본문의 action. 앱 합계(`ai_usage`)·정지·접근 요청과 서로 재사용할 수 없다. */
export const AI_USAGE_TENANT_ACTION = "ai_usage_tenant" as const;

/** 배치에는 업체가 하나가 아니다. 서명 틀이 요구하는 자리에 넣는 고정 상수(실제 외부 id 는 항목 안). */
export const AI_USAGE_TENANT_EXT_TENANT = "BATCH" as const;

/** 한 호출의 최대 항목 수. */
export const AI_USAGE_TENANT_MAX_ITEMS = 50;

/** 본문 한도(바이트, 16KB). 넘으면 수신이 413 으로 거부한다. */
export const AI_USAGE_TENANT_MAX_BODY_BYTES = 16384;

/** 토큰·호출 수 상한(앱 합계 한 줄과 같음). */
export const AI_USAGE_TENANT_MAX_COUNT = AI_USAGE_MAX_COUNT;

/** 외부 id(앱의 업체·운영사 id) 최대 길이(계약 §2: 영문·숫자·밑줄·하이픈 1~100자). */
export const AI_USAGE_TENANT_EXT_ID_MAX_LENGTH = 100;

/** as_of 가 발신 시각보다 이만큼(400일) 넘게 오래되면 수신이 거부한다. */
export const AI_USAGE_TENANT_MAX_AGE_MS = 400 * 24 * 3600_000;

/** 항목 키(이 순서로 직렬화). 회사 이름·금액·사용자·모델·기능은 없다. */
export const AI_USAGE_TENANT_ITEM_KEYS = Object.freeze([
  "ext_id",
  "contract",
  "month",
  "input_tokens",
  "output_tokens",
  "cache_tokens",
  "calls",
  "as_of",
] as const);

// ── 읽기 호출(레저코어 → 앱 방향 값 조회). 계약: 레저코어 docs/contract/ai-usage-read-contract-v1.md ──

/** 읽기 호출 경로. */
export const AI_USAGE_READ_PATH = "/api/provision/ai-usage-read";

/** 읽기 호출의 서명 본문 action. */
export const AI_USAGE_READ_ACTION = "ai_usage_read" as const;

/** 한 호출의 최대 외부 id 수. */
export const AI_USAGE_READ_MAX_IDS = 200;

/** 읽기 호출 본문 한도(바이트, 8KB). 넘으면 수신이 413 으로 거부한다. */
export const AI_USAGE_READ_MAX_BODY_BYTES = 8192;
