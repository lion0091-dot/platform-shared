/**
 * 작성 제한·운영 설정의 기본값과 허용 범위(결정 #19, #51, 설계서 §12-4).
 * 공용은 기본값·범위만, 값의 저장(앱 설정 표)과 DB 재검사는 앱 몫. 범위 밖 값은 화면과 DB 모두 거부한다.
 */
import { BOARD_ERRORS, type BoardAuthorKind } from "./codes";

export interface SettingSpec {
  default: number;
  min: number;
  max: number;
}

export const BOARD_SETTINGS = {
  "limit.user.per_day": { default: 5, min: 1, max: 30 },
  "limit.user.per_minute": { default: 1, min: 1, max: 5 },
  "limit.staff.per_day": { default: 20, min: 5, max: 100 },
  "limit.staff.per_minute": { default: 3, min: 1, max: 10 },
  /** 사용자별 하루 첨부 총량(MB) */
  "attach.daily_mb": { default: 50, min: 10, max: 100 },
} as const satisfies Record<string, SettingSpec>;

export type BoardSettingKey = keyof typeof BOARD_SETTINGS;

export type SettingResult =
  | { ok: true; value: number }
  | { ok: false; code: typeof BOARD_ERRORS.SETTING_UNKNOWN | typeof BOARD_ERRORS.SETTING_OUT_OF_RANGE };

function specOf(key: string): SettingSpec | undefined {
  return Object.prototype.hasOwnProperty.call(BOARD_SETTINGS, key)
    ? BOARD_SETTINGS[key as BoardSettingKey]
    : undefined;
}

/** 저장해도 되는 값인가. 정수이고 [min, max] 안이어야 한다. */
export function validateSetting(key: string, value: unknown): SettingResult {
  const spec = specOf(key);
  if (!spec) {
    return { ok: false, code: BOARD_ERRORS.SETTING_UNKNOWN };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max) {
    return { ok: false, code: BOARD_ERRORS.SETTING_OUT_OF_RANGE };
  }
  return { ok: true, value };
}

/** 범위 안으로 맞춘 값(읽을 때 방어용). 정수가 아니거나 NaN 이면 기본값. 저장 검증에는 validateSetting 을 쓴다. */
export function clampSetting(key: BoardSettingKey, value: number): number {
  const spec = BOARD_SETTINGS[key];
  if (!Number.isFinite(value)) {
    return spec.default;
  }
  return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

/** 앱 설정 값이 없거나 범위 밖이면 공용 기본값. */
export function effectiveSetting(key: BoardSettingKey, stored?: number | null): number {
  if (stored === undefined || stored === null) {
    return BOARD_SETTINGS[key].default;
  }
  const checked = validateSetting(key, stored);
  return checked.ok ? checked.value : BOARD_SETTINGS[key].default;
}

export interface WriteLimits {
  perDay: number;
  perMinute: number;
}

/** 작성자 유형별 한도. stored 에 앱 설정 값을 넘기면 반영(범위 밖이면 기본값). */
export function writeLimits(
  kind: BoardAuthorKind,
  stored: Partial<Record<BoardSettingKey, number | null>> = {},
): WriteLimits {
  const prefix = kind === "USER" ? "limit.user" : "limit.staff";
  return {
    perDay: effectiveSetting(`${prefix}.per_day` as BoardSettingKey, stored[`${prefix}.per_day` as BoardSettingKey]),
    perMinute: effectiveSetting(
      `${prefix}.per_minute` as BoardSettingKey,
      stored[`${prefix}.per_minute` as BoardSettingKey],
    ),
  };
}

/**
 * 한도를 넘었는가. counts 는 이번 글 「이전」까지 그 사용자가 쓴 건수(지난 24시간·지난 1분).
 * 같거나 넘으면 거부(RATE_LIMITED). 카운트 조회와 시각 기준은 앱(DB) 몫.
 */
export function exceedsLimit(
  counts: { lastDay: number; lastMinute: number },
  limits: WriteLimits,
): typeof BOARD_ERRORS.RATE_LIMITED | null {
  if (counts.lastMinute >= limits.perMinute || counts.lastDay >= limits.perDay) {
    return BOARD_ERRORS.RATE_LIMITED;
  }
  return null;
}
