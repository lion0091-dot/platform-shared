/**
 * 안내 문구 상수(결정 #5, #52). 문구마다 id 가 있고 공용이 기본 문구와 locked 여부를 정한다.
 * locked 문구는 앱이 덮어쓸 수 없다(법무 필수 문구 — 잠정 목록, 오픈 전 재검토).
 * 우선순위: 테넌트 덮어쓰기 → 앱 전역 덮어쓰기 → 공용 기본. 화면 노출은 앱 몫.
 */
import { BOARD_ERRORS } from "./codes";

export interface NoticeSpec {
  text: string;
  /** true 면 덮어쓰기 불가 */
  locked: boolean;
}

export const BOARD_NOTICES = {
  WRITE_NOTICE_PII: {
    text: "전화번호·주소·계좌·주민번호·차량번호 등 개인정보는 쓰지 마세요.",
    locked: true,
  },
  WRITE_NOTICE_VISIBLE_TO_STAFF: {
    text: "쓰신 글은 운영사 직원이 봅니다. 필요하면 플랫폼 운영사에 전달될 수 있습니다.",
    locked: true,
  },
  WRITE_NOTICE_ORDER_GUIDE: {
    text: "주문과 관련된 문의는 주문 상세 또는 분쟁 화면에서 해 주세요.",
    locked: false,
  },
  ESCALATE_PRIVACY_CONFIRM: {
    text: "본문에 개인정보(이름·연락처·주소·계좌·차량번호·고객 정보)가 없음을 확인했습니다.",
    locked: true,
  },
  ATTACH_NOTICE_REDACT: {
    text: "화면 캡처에서 개인정보·거래처 정보는 가려서 올려 주세요. 이미지 속 글자는 자동으로 걸러지지 않습니다.",
    locked: true,
  },
  ATTACH_PRIVACY_CONFIRM: {
    text: "첨부에 이름·연락처·주소·계좌·차량번호·고객 정보가 보이지 않음을 확인했습니다.",
    locked: true,
  },
} as const satisfies Record<string, NoticeSpec>;

export type BoardNoticeId = keyof typeof BOARD_NOTICES;

export const BOARD_NOTICE_OVERRIDE_MAX = 500;

function noticeOf(id: string): NoticeSpec | undefined {
  return Object.prototype.hasOwnProperty.call(BOARD_NOTICES, id) ? BOARD_NOTICES[id as BoardNoticeId] : undefined;
}

export type NoticeOverrideResult =
  | { ok: true; text: string }
  | { ok: false; code: typeof BOARD_ERRORS.NOTICE_LOCKED | typeof BOARD_ERRORS.NOTICE_INVALID };

/** 덮어쓸 문구를 저장해도 되는가: 알려진 id, locked 아님, 1~500자(앞뒤 공백 제거). */
export function validateOverride(id: string, text: string): NoticeOverrideResult {
  const spec = noticeOf(id);
  if (!spec) {
    return { ok: false, code: BOARD_ERRORS.NOTICE_INVALID };
  }
  if (spec.locked) {
    return { ok: false, code: BOARD_ERRORS.NOTICE_LOCKED };
  }
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > BOARD_NOTICE_OVERRIDE_MAX) {
    return { ok: false, code: BOARD_ERRORS.NOTICE_INVALID };
  }
  return { ok: true, text: trimmed };
}

/** 화면에 보일 문구. locked 이거나 덮어쓰기가 유효하지 않으면 기본 문구. */
export function resolveNotice(
  id: BoardNoticeId,
  overrides: { tenant?: string | null; app?: string | null } = {},
): string {
  const spec = BOARD_NOTICES[id];
  if (spec.locked) {
    return spec.text;
  }
  for (const candidate of [overrides.tenant, overrides.app]) {
    if (candidate !== undefined && candidate !== null) {
      const checked = validateOverride(id, candidate);
      if (checked.ok) {
        return checked.text;
      }
    }
  }
  return spec.text;
}
