/**
 * 지금 보낼 월 목록 — 서울 시각 슬롯 판정. 순수 함수(시계는 인자), 던지지 않는다.
 * 슬롯(기본 서울 0·6·12·18시)의 첫 15분 창이 아니면 빈 목록. 슬롯이면 이번 달 1일.
 * 서울 매월 1일에는 그날의 **모든 슬롯**에서 직전 달을 앞에 붙인다(같은 값 재송은 수신이 행을 늘리지 않으므로 무해하고,
 * 슬롯 하나를 놓쳐도 직전 달 확정값이 남는다).
 */
import { AI_USAGE_SLOT_HOURS, AI_USAGE_WINDOW_MINUTES } from "./constants";

const KST_OFFSET_MS = 9 * 3600_000;

export interface AiUsageSlotOptions {
  /** 서울 기준 슬롯 시(0~23, 비어 있지 않음). 기본 0·6·12·18 */
  slotHours?: readonly number[];
  /** 슬롯 시각 뒤 몇 분 안(1~60)이면 보낼지. 기본 15 */
  windowMinutes?: number;
}

function ym(year: number, monthIndex: number): string {
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-01`;
}

export function aiUsageMonthsToSend(now: Date | number, opts: AiUsageSlotOptions = {}): string[] {
  const ms = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Number.NaN;

  if (!Number.isFinite(ms)) return [];

  const slotHours = opts.slotHours ?? AI_USAGE_SLOT_HOURS;
  const windowMinutes = opts.windowMinutes ?? AI_USAGE_WINDOW_MINUTES;

  if (
    !Array.isArray(slotHours) ||
    slotHours.length === 0 ||
    !slotHours.every((h) => Number.isInteger(h) && h >= 0 && h <= 23) ||
    !Number.isInteger(windowMinutes) ||
    windowMinutes < 1 ||
    windowMinutes > 60
  ) {
    return [];
  }

  const kst = new Date(ms + KST_OFFSET_MS);

  if (Number.isNaN(kst.getTime())) return [];

  if (!slotHours.includes(kst.getUTCHours()) || kst.getUTCMinutes() >= windowMinutes) return [];

  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth();
  const current = ym(year, month);

  if (kst.getUTCDate() !== 1) return [current];

  const prev = month === 0 ? ym(year - 1, 11) : ym(year, month - 1);

  return [prev, current];
}
