/**
 * 서울(KST, UTC+9, 서머타임 없음) 기준 날짜 도우미. 순수 함수, 의존성 0.
 *
 * 서버(Vercel)·DB·CI 는 UTC 라서 `new Date().toISOString().slice(0, 10)` 은 서울 00~09시에 «어제» 날짜가 된다.
 * 사람이 «오늘»로 읽는 날짜·하루/월 범위는 모두 이 파일을 거친다(업무 날짜 = 서울 하나).
 * 서머타임이 없는 현재 규칙(+09:00) 기준이다. 1961년 이전·1987~88년 같은 과거 날짜는 당시 오프셋이 달라 +9시간 보정이 맞지 않는다(업무 날짜는 현재 기준으로 쓴다).
 * 날짜 «논리»는 +9시간 보정으로 계산해 Intl(ICU) 에 의존하지 않고, 화면 «서식»(formatKstDate)만 Intl 에 timeZone 을 고정해 쓴다.
 * 시계는 항상 인자로 주입할 수 있다(기본값만 현재 시각).
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM_RE = /^(\d{4})-(\d{2})$/;

/** UTC 시각 구간. `to` 는 포함하지 않는다(`from <= t < to`). 둘 다 UTC ISO 문자열. */
export interface KstRange {
  readonly from: string;
  readonly to: string;
}

/**
 * `YYYY-MM-DD[T ]hh:mm[:ss[.ffffff]][Z|±hh[:mm]]` 꼴(DB timestamptz 문자열 포함).
 * 오프셋이 없으면 실행 환경 시간대에 따라 해석이 갈리므로 UTC 로 고정해 읽는다(날짜만 있는 문자열은 원래 UTC). `+09` 같은 짧은 오프셋도 받는다.
 */
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function parseInstant(value: string): number {
  const s = value.trim();
  const m = DATETIME_RE.exec(s);

  if (!m) {
    return Date.parse(s);
  }

  let tz = (m[3] ?? "Z").toUpperCase();

  if (tz !== "Z") {
    const digits = tz.slice(1).replace(":", "");

    tz = `${tz[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || "00"}`;
  }

  return Date.parse(`${m[1]}T${m[2]}${tz}`);
}

/** 서울 달력 기준 `YYYY-MM-DD`. 시각 문자열(ISO)·Date·밀리초를 받는다. 해석할 수 없으면 빈 문자열. */
export function kstDateOf(value: string | number | Date): string {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : parseInstant(value);

  if (!Number.isFinite(time)) {
    return "";
  }

  const shifted = new Date(time + KST_OFFSET_MS);

  if (Number.isNaN(shifted.getTime())) {
    return "";
  }

  const ymd = shifted.toISOString().slice(0, 10); // kst-ok: ts-iso-slice 위에서 +9시간 보정을 마친 값의 슬라이스(이 파일이 단일 출처)

  return YMD_RE.test(ymd) ? ymd : "";
}

/** 서울 기준 오늘 `YYYY-MM-DD`. */
export function kstToday(now: Date = new Date()): string {
  return kstDateOf(now);
}

/** 서울 기준 오늘에서 `days` 일 전(음수면 후) `YYYY-MM-DD`. */
export function kstDaysAgo(days: number, now: Date = new Date()): string {
  return kstDateOf(now.getTime() - days * DAY_MS);
}

/** 서울 기준 이번 달(1~12). */
export function kstMonth(now: Date = new Date()): number {
  return Number(kstToday(now).slice(5, 7));
}

/** `YYYY-MM-DD` 가 실제 달력에 있는 날짜면 그 날의 서울 00:00 에 해당하는 UTC 밀리초, 아니면 null. */
function ymdStartMs(ymd: string): number | null {
  const m = YMD_RE.exec(ymd);

  if (!m) {
    return null;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  if (year < 1000) {
    return null;
  }

  const utc = new Date(Date.UTC(year, month - 1, day));

  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }

  return utc.getTime() - KST_OFFSET_MS;
}

/**
 * 서울 `YYYY-MM-DD` 하루의 UTC 구간(`from` = 서울 00:00, `to` = 다음 날 서울 00:00, 미포함).
 * timestamptz 열 비교용: `col >= from AND col < to`. 없는 날짜·형식 오류는 null.
 */
export function kstDayRange(ymd: string): KstRange | null {
  const start = ymdStartMs(ymd);

  if (start === null) {
    return null;
  }

  return { from: new Date(start).toISOString(), to: new Date(start + DAY_MS).toISOString() };
}

/** 서울 `YYYY-MM` 한 달의 UTC 구간(`to` = 다음 달 1일 서울 00:00, 미포함). 형식 오류·없는 달은 null. */
export function kstMonthRange(ym: string): KstRange | null {
  const m = YM_RE.exec(ym);

  if (!m) {
    return null;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);

  if (month < 1 || month > 12) {
    return null;
  }

  const first = ymdStartMs(`${m[1]}-${m[2]}-01`);

  if (first === null) {
    return null;
  }

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const next = ymdStartMs(`${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`);

  if (next === null) {
    return null;
  }

  return { from: new Date(first).toISOString(), to: new Date(next).toISOString() };
}

/** 서울 `YYYY-MM-DD` 의 00:00 시각을 Date 로. 없는 날짜·형식 오류는 null. */
export function parseKstDate(ymd: string): Date | null {
  const start = ymdStartMs(ymd);

  return start === null ? null : new Date(start);
}

/** 서울 기준 날짜를 한국어 표기로(기본 `2026. 11. 11.`). options 를 주면 그대로 쓰되 시간대는 항상 서울. 서식 전용(날짜 계산에 쓰지 않는다). */
export function formatKstDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" },
): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString("ko-KR", { ...options, timeZone: "Asia/Seoul" });
}
