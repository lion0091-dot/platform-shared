import { afterEach, describe, expect, it, vi } from "vitest";
import { formatKstDate, kstDateOf, kstDaysAgo, kstDayRange, kstMonth, kstMonthRange, kstToday, parseKstDate } from "./index";

afterEach(() => {
  vi.useRealTimers();
});

// 아래 시각은 전부 고정값이다(실행 시각·시간대에 의존하지 않는다).
describe("kstToday / kstDateOf — 서울 날짜 경계", () => {
  it("서울 낮에는 UTC 날짜와 같다", () => {
    expect(kstToday(new Date("2026-11-11T06:00:00Z"))).toBe("2026-11-11"); // 서울 15:00
  });

  it("서울 00:00·00:30·08:59 는 UTC 로는 전날이지만 서울 날짜로 센다", () => {
    expect(kstToday(new Date("2026-11-10T15:00:00Z"))).toBe("2026-11-11"); // 서울 00:00
    expect(kstToday(new Date("2026-11-10T15:30:00Z"))).toBe("2026-11-11"); // 서울 00:30
    expect(kstToday(new Date("2026-11-10T23:59:59Z"))).toBe("2026-11-11"); // 서울 08:59:59
  });

  it("서울 09:00 부터는 UTC 날짜와 같고, 23:59 까지 같은 날이다", () => {
    expect(kstToday(new Date("2026-11-11T00:00:00Z"))).toBe("2026-11-11"); // 서울 09:00
    expect(kstToday(new Date("2026-11-11T14:59:59Z"))).toBe("2026-11-11"); // 서울 23:59:59
    expect(kstToday(new Date("2026-11-11T15:00:00Z"))).toBe("2026-11-12"); // 서울 다음 날 00:00
    expect(kstToday(new Date("2026-11-10T14:59:59Z"))).toBe("2026-11-10"); // 서울 23:59:59
  });

  it("월말 밤~월초 새벽, 연말·연초, 윤일 경계", () => {
    expect(kstToday(new Date("2026-11-30T14:59:59Z"))).toBe("2026-11-30");
    expect(kstToday(new Date("2026-11-30T16:30:00Z"))).toBe("2026-12-01");
    expect(kstToday(new Date("2026-12-31T14:59:59Z"))).toBe("2026-12-31");
    expect(kstToday(new Date("2026-12-31T15:30:00Z"))).toBe("2027-01-01");
    expect(kstToday(new Date("2028-02-28T14:59:59Z"))).toBe("2028-02-28");
    expect(kstToday(new Date("2028-02-28T15:00:00Z"))).toBe("2028-02-29"); // 윤일
    expect(kstToday(new Date("2028-02-29T15:00:00Z"))).toBe("2028-03-01");
    expect(kstToday(new Date("2027-02-28T15:00:00Z"))).toBe("2027-03-01"); // 평년
  });

  it("kstDateOf 는 ISO 문자열·밀리초·Date 를 같게 처리하고 잘못된 값은 빈 문자열", () => {
    const iso = "2026-11-30T16:30:00Z";

    expect(kstDateOf(iso)).toBe("2026-12-01");
    expect(kstDateOf(Date.parse(iso))).toBe("2026-12-01");
    expect(kstDateOf(new Date(iso))).toBe("2026-12-01");
    expect(kstDateOf("not-a-date")).toBe("");
    expect(kstDateOf(Number.NaN)).toBe("");
    expect(kstDateOf(new Date("invalid"))).toBe("");
  });

  it("Date 범위 끝에서 던지지 않고 빈 문자열을 돌려준다", () => {
    expect(kstDateOf(8.64e15)).toBe("");
    expect(kstDateOf(-8.64e15)).toBe("");
  });

  it("오프셋 없는 시각 문자열은 실행 환경 시간대와 무관하게 UTC 로 읽는다", () => {
    expect(kstDateOf("2026-11-11T23:30:00")).toBe("2026-11-12"); // UTC 23:30 = 서울 다음 날 08:30
    expect(kstDateOf("2026-11-11 23:30:00")).toBe("2026-11-12");
    expect(kstDateOf("2026-11-11T23:30")).toBe("2026-11-12");
    expect(kstDateOf("2026-11-11T14:59:59.999")).toBe("2026-11-11");
    expect(kstDateOf("2026-11-11")).toBe("2026-11-11"); // 날짜만 있는 문자열
  });

  it("오프셋이 있는 시각 문자열은 그 오프셋대로 읽는다", () => {
    expect(kstDateOf("2026-11-11T23:30:00+09:00")).toBe("2026-11-11");
    expect(kstDateOf("2026-11-11T23:30:00Z")).toBe("2026-11-12");
    expect(kstDateOf("2026-11-11T23:30:00.123456+00")).toBe("2026-11-12");
    expect(kstDateOf("2026-11-11T23:30:00-05:00")).toBe("2026-11-12");
  });

  it("시계를 주입하지 않으면 현재 시각(고정한 가짜 시계)을 쓴다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    expect(kstToday()).toBe("2026-11-11");
    expect(kstMonth()).toBe(11);
    expect(kstDaysAgo(1)).toBe("2026-11-10");
  });
});

describe("kstDaysAgo / kstMonth", () => {
  it("서울 오늘 기준으로 N일 전을 센다(월 경계 포함)", () => {
    const now = new Date("2026-11-30T16:30:00Z"); // 서울 12-01 01:30

    expect(kstDaysAgo(0, now)).toBe("2026-12-01");
    expect(kstDaysAgo(30, now)).toBe("2026-11-01");
    expect(kstDaysAgo(-1, now)).toBe("2026-12-02");
  });

  it("월은 서울 기준이다(UTC 로는 아직 11월)", () => {
    expect(kstMonth(new Date("2026-11-30T16:30:00Z"))).toBe(12);
    expect(kstMonth(new Date("2026-12-31T15:30:00Z"))).toBe(1);
    expect(kstMonth(new Date("2026-11-15T03:00:00Z"))).toBe(11);
  });
});

describe("kstDayRange", () => {
  it("서울 하루 = UTC 전날 15:00 ~ 당일 15:00(끝 미포함)", () => {
    expect(kstDayRange("2026-11-11")).toEqual({ from: "2026-11-10T15:00:00.000Z", to: "2026-11-11T15:00:00.000Z" });
  });

  it("범위 경계 시각이 같은 서울 날짜에 속한다", () => {
    const r = kstDayRange("2026-11-11")!;

    expect(kstDateOf(r.from)).toBe("2026-11-11"); // 서울 00:00
    expect(kstDateOf(Date.parse(r.to) - 1)).toBe("2026-11-11"); // 서울 23:59:59.999
    expect(kstDateOf(r.to)).toBe("2026-11-12"); // 미포함
  });

  it("월말·연말·윤일", () => {
    expect(kstDayRange("2026-12-31")).toEqual({ from: "2026-12-30T15:00:00.000Z", to: "2026-12-31T15:00:00.000Z" });
    expect(kstDayRange("2028-02-29")).toEqual({ from: "2028-02-28T15:00:00.000Z", to: "2028-02-29T15:00:00.000Z" });
    expect(kstDayRange("2026-01-01")).toEqual({ from: "2025-12-31T15:00:00.000Z", to: "2026-01-01T15:00:00.000Z" });
  });

  it("없는 날짜·형식 오류는 null", () => {
    expect(kstDayRange("2026-02-30")).toBeNull();
    expect(kstDayRange("2027-02-29")).toBeNull();
    expect(kstDayRange("2026-13-01")).toBeNull();
    expect(kstDayRange("2026-00-10")).toBeNull();
    expect(kstDayRange("2026-1-1")).toBeNull();
    expect(kstDayRange("20261111")).toBeNull();
    expect(kstDayRange("")).toBeNull();
    expect(kstDayRange("0099-01-01")).toBeNull();
  });
});

describe("kstMonthRange", () => {
  it("서울 한 달 = 전달 말 15:00 ~ 당월 말 15:00(끝 미포함)", () => {
    expect(kstMonthRange("2026-11")).toEqual({ from: "2026-10-31T15:00:00.000Z", to: "2026-11-30T15:00:00.000Z" });
  });

  it("12월은 다음 해 1월로 넘어간다", () => {
    expect(kstMonthRange("2026-12")).toEqual({ from: "2026-11-30T15:00:00.000Z", to: "2026-12-31T15:00:00.000Z" });
  });

  it("2월: 평년 28일·윤년 29일", () => {
    expect(kstMonthRange("2027-02")).toEqual({ from: "2027-01-31T15:00:00.000Z", to: "2027-02-28T15:00:00.000Z" });
    expect(kstMonthRange("2028-02")).toEqual({ from: "2028-01-31T15:00:00.000Z", to: "2028-02-29T15:00:00.000Z" });
  });

  it("월말 밤 시각이 다음 달 범위에 들어간다", () => {
    const nov = kstMonthRange("2026-11")!;
    const dec = kstMonthRange("2026-12")!;
    const t = Date.parse("2026-11-30T16:30:00Z"); // 서울 12-01 01:30

    expect(t >= Date.parse(nov.from) && t < Date.parse(nov.to)).toBe(false);
    expect(t >= Date.parse(dec.from) && t < Date.parse(dec.to)).toBe(true);
  });

  it("형식 오류는 null", () => {
    expect(kstMonthRange("2026-13")).toBeNull();
    expect(kstMonthRange("2026-00")).toBeNull();
    expect(kstMonthRange("2026-1")).toBeNull();
    expect(kstMonthRange("2026-11-01")).toBeNull();
    expect(kstMonthRange("")).toBeNull();
  });
});

describe("parseKstDate", () => {
  it("서울 00:00 시각의 Date 를 돌려준다", () => {
    expect(parseKstDate("2026-11-11")?.toISOString()).toBe("2026-11-10T15:00:00.000Z");
    expect(kstDateOf(parseKstDate("2028-02-29")!)).toBe("2028-02-29");
  });

  it("없는 날짜·형식 오류는 null", () => {
    expect(parseKstDate("2026-02-30")).toBeNull();
    expect(parseKstDate("x")).toBeNull();
    expect(parseKstDate("")).toBeNull();
  });
});

describe("formatKstDate (서식 전용)", () => {
  it("UTC 로는 전날인 시각도 서울 날짜로 표시한다", () => {
    expect(formatKstDate("2026-11-10T16:30:00Z")).toBe("2026. 11. 11.");
    expect(formatKstDate("2026-12-31T15:30:00Z")).toBe("2027. 01. 01.");
  });

  it("옵션을 주어도 시간대는 서울이다", () => {
    expect(formatKstDate("2026-11-10T16:30:00Z", {})).toBe("2026. 11. 11.");
    expect(formatKstDate("2026-01-04T16:30:00Z", {})).toBe("2026. 1. 5.");
  });

  it("해석할 수 없는 값은 빈 문자열", () => {
    expect(formatKstDate("x")).toBe("");
  });
});
