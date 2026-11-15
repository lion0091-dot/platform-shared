import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSignedCall, hmacHex } from "../account";
import {
  AI_USAGE_ACTION,
  AI_USAGE_EXT_TENANT,
  AI_USAGE_LINE_KEYS,
  AI_USAGE_MAX_BODY_BYTES,
  AI_USAGE_PATH,
  aiUsageMonthsToSend,
  buildAiUsageCall,
  buildAiUsageLine,
  classifyAiUsageResponse,
  estimateAiUsageUsd,
  type AiUsageLine,
} from "./index";

// 계약 §3 시험 벡터(가짜 비밀·고정 시각·고정 jti). 수신 시각 = 2026-11-14T12:00:30Z.
const SECRET = "test-secret-ai-usage-0123456789abcdef";
const NOW_MS = 1794657630000;
const JTI = "jti-1794657630-ai-usage";
const VECTOR_BODY =
  '{"system":"wholesale","action":"ai_usage","ext_tenant":"APP","contract":1,"month":"2026-11-01","calls":1250,"tokens":4800000,"est_usd":12.3456,"as_of":"2026-11-14T12:00:00.000Z","jti":"jti-1794657630-ai-usage","iat":1794657630,"exp":1794657690}';
const VECTOR_SIG = "b3973155feb339d33ab0b182700a9cc0e90b925dd64ac5a6c60a0292d200ef4e";
// 계약에 없는 값: 같은 입력에서 system 만 shipping 으로 바꾼 계산 결과를 고정한다(레저코어 담당과 교차 확인용).
const SHIPPING_SIG = "2b49491b9ba21be31130d5fe73f7e802ffb1cf393119dd9639c9ecc4f7435236";

const GOOD = { month: "2026-11-01", calls: 1250, tokens: 4_800_000, estUsd: 12.3456, asOf: "2026-11-14T12:00:00.000Z" };

function line(over: Record<string, unknown> = {}): AiUsageLine {
  const r = buildAiUsageLine({ ...GOOD, ...over }, NOW_MS);

  if (!r.ok) throw new Error(`line failed: ${r.code}`);

  return r.line;
}

describe("계약 §3 벡터 정합", () => {
  it("시각 상수 확인(iat 1794657630 = 수신 시각 12:00:30Z)", () => {
    expect(new Date(NOW_MS).toISOString()).toBe("2026-11-14T12:00:30.000Z");
  });

  it("계약 본문 원문을 계약 비밀로 서명하면 계약의 x-signature 와 같다", () => {
    expect(hmacHex(VECTOR_BODY, SECRET)).toBe(VECTOR_SIG);
  });

  it("buildAiUsageCall(wholesale) 은 계약 본문·서명과 바이트 단위로 같다", () => {
    const r = buildAiUsageCall(SECRET, "wholesale", line(), { now: NOW_MS, jti: JTI });

    expect(r).toEqual({ ok: true, body: VECTOR_BODY, signature: VECTOR_SIG });
  });

  it("같은 입력에서 system 만 shipping 이면 고정한 서명이 나온다", () => {
    const r = buildAiUsageCall(SECRET, "shipping", line(), { now: NOW_MS, jti: JTI });

    expect(r.ok && r.body).toBe(VECTOR_BODY.replace('"system":"wholesale"', '"system":"shipping"'));
    expect(r.ok && r.signature).toBe(SHIPPING_SIG);
  });

  it("buildSignedCall 을 직접 부른 결과와 래퍼 결과가 같다(fields 순서 = 줄 순서)", () => {
    const direct = buildSignedCall(
      SECRET,
      { system: "wholesale", action: AI_USAGE_ACTION, extTenant: AI_USAGE_EXT_TENANT, fields: { ...line() } },
      { now: NOW_MS, jti: JTI },
    );

    expect(direct.body).toBe(VECTOR_BODY);
    expect(direct.signature).toBe(VECTOR_SIG);
  });

  it("호출자가 키를 다른 순서로 넘겨도 본문 순서는 고정", () => {
    const l = line();
    const shuffled = { as_of: l.as_of, est_usd: l.est_usd, tokens: l.tokens, calls: l.calls, month: l.month, contract: l.contract } as AiUsageLine;
    const r = buildAiUsageCall(SECRET, "wholesale", shuffled, { now: NOW_MS, jti: JTI });

    expect(r.ok && r.body).toBe(VECTOR_BODY);
  });

  it("상수", () => {
    expect(AI_USAGE_PATH).toBe("/api/provision/ai-usage");
    expect(AI_USAGE_ACTION).toBe("ai_usage");
    expect(AI_USAGE_EXT_TENANT).toBe("APP");
    expect(AI_USAGE_MAX_BODY_BYTES).toBe(2048);
  });
});

describe("buildAiUsageLine — 보안: 허용 키만, 회사·사용자 필드 혼입 시 실패", () => {
  it("출력 키 집합은 계약 §1 필수 6개(app 없음), 순서 고정", () => {
    const l = line();

    expect(Object.keys(l)).toEqual(["contract", "month", "calls", "tokens", "est_usd", "as_of"]);
    expect(Object.keys(l)).toEqual([...AI_USAGE_LINE_KEYS]);
    expect("app" in l).toBe(false);
  });

  const FORBIDDEN = [
    "tenantId", "tenant_id", "wholesalerId", "wholesaler_id", "companyId", "company_id", "company", "userId", "user_id", "name", "email", "app", "ext_tenant", "extra",
  ];

  for (const key of FORBIDDEN) {
    it(`입력에 «${key}» 키가 섞이면 LINE_EXTRA_KEY`, () => {
      expect(buildAiUsageLine({ ...GOOD, [key]: "x" }, NOW_MS)).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    });
  }

  it("출력 이름 est_usd·as_of 를 입력으로 넘겨도 거부(입력 키는 estUsd·asOf)", () => {
    expect(buildAiUsageLine({ ...GOOD, est_usd: 1 }, NOW_MS)).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
  });

  it("심볼 키·비객체·배열·null", () => {
    expect(buildAiUsageLine({ ...GOOD, [Symbol("x")]: 1 }, NOW_MS)).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    expect(buildAiUsageLine(null, NOW_MS)).toEqual({ ok: false, code: "LINE_INPUT" });
    expect(buildAiUsageLine([], NOW_MS)).toEqual({ ok: false, code: "LINE_INPUT" });
    expect(buildAiUsageLine("x", NOW_MS)).toEqual({ ok: false, code: "LINE_INPUT" });
  });

  it("값을 읽다 던지는 입력도 던지지 않고 코드만", () => {
    const evil = {
      get month(): string {
        throw new Error("secret-value");
      },
    };
    const r = buildAiUsageLine(evil, NOW_MS);

    expect(r).toEqual({ ok: false, code: "LINE_INPUT" });
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  it("누락된 필수 값은 해당 코드", () => {
    const { month: _m, ...noMonth } = GOOD;
    const { calls: _c, ...noCalls } = GOOD;
    const { asOf: _a, ...noAsOf } = GOOD;

    expect(buildAiUsageLine(noMonth, NOW_MS)).toEqual({ ok: false, code: "LINE_MONTH" });
    expect(buildAiUsageLine(noCalls, NOW_MS)).toEqual({ ok: false, code: "LINE_NUMBER" });
    expect(buildAiUsageLine(noAsOf, NOW_MS)).toEqual({ ok: false, code: "LINE_AS_OF" });
  });
});

describe("buildAiUsageLine — 범위·형식", () => {
  const code = (over: Record<string, unknown>, now: number | Date = NOW_MS) => {
    const r = buildAiUsageLine({ ...GOOD, ...over }, now);

    return r.ok ? "OK" : r.code;
  };

  it("calls·tokens: 0·10¹⁴ 통과, 10¹⁴+1·소수·음수·NaN·문자열·BigInt 거부", () => {
    expect(code({ calls: 0, tokens: 0 })).toBe("OK");
    expect(code({ calls: 1e14, tokens: 1e14 })).toBe("OK");
    for (const bad of [1e14 + 2, 1.5, -1, Number.NaN, Infinity, "5", 10n, null, undefined]) {
      expect(code({ calls: bad }), String(bad)).toBe("LINE_NUMBER");
      expect(code({ tokens: bad }), String(bad)).toBe("LINE_NUMBER");
    }
  });

  it("estUsd: 0·10⁷ 통과, 10⁷ 초과·음수·NaN·문자열 거부, -0 은 0", () => {
    expect(code({ estUsd: 0 })).toBe("OK");
    expect(code({ estUsd: 1e7 })).toBe("OK");
    expect(code({ estUsd: -0 })).toBe("OK");
    for (const bad of [1e7 + 0.0001, -0.0001, Number.NaN, Infinity, "1", null]) expect(code({ estUsd: bad }), String(bad)).toBe("LINE_NUMBER");
  });

  it("est_usd 는 소수 4자리로 반올림(부동소수 포함)", () => {
    expect(line({ estUsd: 0.1 + 0.2 }).est_usd).toBe(0.3);
    expect(line({ estUsd: 12.34564 }).est_usd).toBe(12.3456);
    expect(line({ estUsd: 12.34566 }).est_usd).toBe(12.3457);
    expect(line({ estUsd: 12.3456 }).est_usd).toBe(12.3456);
    expect(line({ estUsd: 0 }).est_usd).toBe(0);
  });

  it("month: 형식·존재하지 않는 달·1일 아님·미래 달·24개월 초과", () => {
    expect(code({ month: "2026-11-01" })).toBe("OK");
    expect(code({ month: "2026-10-01" })).toBe("OK");
    expect(code({ month: "2024-12-01" })).toBe("OK"); // 23개월 전
    for (const bad of ["2026-13-01", "2026-00-01", "2026-11-02", "2026-11-1", "2026-11", "26-11-01", "2026-12-01", "2024-11-01", 20261101, null]) {
      expect(code({ month: bad }), String(bad)).toBe("LINE_MONTH");
    }
  });

  it("month 는 서울 기준 월로 비교(UTC 로는 아직 10월 말이어도 서울은 11월)", () => {
    const kstNov1 = Date.parse("2026-10-31T15:00:00Z"); // 서울 2026-11-01 00:00

    expect(code({ month: "2026-11-01", asOf: "2026-10-31T14:00:00.000Z" }, kstNov1)).toBe("OK");
    expect(code({ month: "2026-11-01", asOf: "2026-10-31T14:00:00.000Z" }, kstNov1 - 1)).toBe("LINE_MONTH");
  });

  it("as_of: 형식·미래 5분 경계·Date 입력·밀리초 정규화", () => {
    expect(code({ asOf: "2026-11-14T12:05:30.000Z" })).toBe("OK"); // now+5분 정각
    expect(code({ asOf: "2026-11-14T12:05:30.001Z" })).toBe("LINE_AS_OF");
    expect(code({ asOf: new Date(NOW_MS) })).toBe("OK");
    expect(line({ asOf: "2026-11-14T12:00:00Z" }).as_of).toBe("2026-11-14T12:00:00.000Z");
    expect(line({ asOf: new Date("2026-11-14T21:00:00+09:00") }).as_of).toBe("2026-11-14T12:00:00.000Z");
    for (const bad of ["2026-11-14", "2026-11-14T12:00:00", "2026-11-14T12:00:00+09:00", "x", new Date(Number.NaN), 1794657600000, null]) {
      expect(code({ asOf: bad }), String(bad)).toBe("LINE_AS_OF");
    }
  });

  it("now 가 잘못되면 LINE_AS_OF", () => {
    expect(buildAiUsageLine(GOOD, Number.NaN)).toEqual({ ok: false, code: "LINE_AS_OF" });
    expect(buildAiUsageLine(GOOD, new Date(Number.NaN))).toEqual({ ok: false, code: "LINE_AS_OF" });
  });

  it("사용 0 줄(하트비트)도 유효", () => {
    const l = line({ calls: 0, tokens: 0, estUsd: 0 });

    expect(l).toMatchObject({ calls: 0, tokens: 0, est_usd: 0 });
    const call = buildAiUsageCall(SECRET, "shipping", l, { now: NOW_MS, jti: JTI });

    expect(call.ok && call.body).toContain('"calls":0,"tokens":0,"est_usd":0,');
  });
});

describe("estimateAiUsageUsd — 합산한 뒤 한 번만 4자리 반올림", () => {
  const prices = { models: { a: { input: 3, output: 15 }, b: { input: 1, output: 5, cache: 0.1 } } };

  it("식: Σ(입력×입력단가+출력×출력단가+캐시×캐시단가)/10⁶, 캐시 단가 없으면 입력 단가", () => {
    // a: (1,000,000×3 + 100,000×15 + 200,000×3(입력 단가)) /1e6 = 3 + 1.5 + 0.6 = 5.1
    expect(estimateAiUsageUsd([{ model: "a", input: 1_000_000, output: 100_000, cache: 200_000 }], prices)).toEqual({ ok: true, usd: 5.1, estimated: true });
    // b: 캐시 단가 0.1 → (0 + 0 + 1,000,000×0.1)/1e6 = 0.1
    expect(estimateAiUsageUsd([{ model: "b", input: 0, output: 0, cache: 1_000_000 }], prices)).toEqual({ ok: true, usd: 0.1, estimated: true });
  });

  it("모델별 반올림 후 합과 합 후 반올림이 다른 입력에서 후자만 맞는다", () => {
    // 각 모델 raw = 0.00003 → 모델별로 먼저 4자리 반올림하면 0.0000 + 0.0000 = 0, 합 0.00006 을 반올림하면 0.0001
    const p = { models: { x: { input: 0.03, output: 0 }, y: { input: 0.03, output: 0 } } };
    const r = estimateAiUsageUsd(
      [
        { model: "x", input: 1000, output: 0 },
        { model: "y", input: 1000, output: 0 },
      ],
      p,
    );

    expect(r).toEqual({ ok: true, usd: 0.0001, estimated: true });
  });

  it("단가표에 없는 모델이 하나라도 있으면 전체 거부(MODEL_PRICE_MISSING)", () => {
    expect(estimateAiUsageUsd([{ model: "a", input: 1, output: 1 }, { model: "zzz", input: 1, output: 1 }], prices)).toEqual({ ok: false, code: "MODEL_PRICE_MISSING" });
    expect(estimateAiUsageUsd([{ model: "constructor", input: 1, output: 1 }], prices)).toEqual({ ok: false, code: "MODEL_PRICE_MISSING" });
    expect(estimateAiUsageUsd([{ model: "a", input: 1, output: 1 }], { models: { a: { input: 1 } } })).toEqual({ ok: false, code: "MODEL_PRICE_MISSING" });
  });

  it("빈 행은 0, 잘못된 입력은 ROWS_INVALID(던지지 않음)", () => {
    expect(estimateAiUsageUsd([], prices)).toEqual({ ok: true, usd: 0, estimated: true });
    for (const bad of [null, "x", [null], [{ model: 1, input: 1, output: 1 }], [{ model: "a", input: -1, output: 1 }], [{ model: "a", input: Number.NaN, output: 1 }], [{ model: "a", input: 1, output: 1, cache: -5 }]]) {
      expect(estimateAiUsageUsd(bad, prices), String(JSON.stringify(bad))).toEqual({ ok: false, code: "ROWS_INVALID" });
    }
    expect(estimateAiUsageUsd([], null)).toEqual({ ok: false, code: "ROWS_INVALID" });
    expect(estimateAiUsageUsd(new Array(201).fill({ model: "a", input: 1, output: 1 }), prices)).toEqual({ ok: false, code: "ROWS_INVALID" });
    expect(estimateAiUsageUsd(new Array(200).fill({ model: "a", input: 1, output: 1 }), prices).ok).toBe(true);
  });

  it("합산 결과를 buildAiUsageLine 에 넣어도 한 번 더 값이 바뀌지 않는다(반올림 멱등)", () => {
    const r = estimateAiUsageUsd([{ model: "a", input: 123_457, output: 98_765, cache: 4_321 }], prices);

    expect(r.ok).toBe(true);
    if (r.ok) expect(line({ estUsd: r.usd }).est_usd).toBe(r.usd);
  });
});

describe("classifyAiUsageResponse — 계약 §4 표", () => {
  const c = (status: number | "network", body: unknown) => classifyAiUsageResponse(status, body);

  it("성공 3종", () => {
    for (const s of ["OK", "UNCHANGED", "STALE"]) expect(c(200, { status: s })).toEqual({ action: "sent", code: s });
  });

  it("401: 수명 초과는 재서명 재시도, 서명 불일치는 멈춤", () => {
    expect(c(401, { error: "CALL_EXPIRED" })).toEqual({ action: "retry_resign", code: "CALL_EXPIRED" });
    expect(c(401, { error: "CALL_BAD_SIGNATURE" })).toEqual({ action: "stop", code: "CALL_BAD_SIGNATURE" });
    expect(c(401, {})).toEqual({ action: "stop", code: "HTTP_401" });
  });

  it("400·413 멈춤", () => {
    for (const e of ["CALL_MALFORMED", "CALL_INVALID", "LINE_EXTRA_KEY", "LINE_VERSION", "LINE_APP_MISMATCH", "LINE_MONTH", "LINE_NUMBER", "LINE_AS_OF"]) {
      expect(c(400, { error: e })).toEqual({ action: "stop", code: e });
    }
    expect(c(413, { error: "CALL_TOO_LARGE" })).toEqual({ action: "stop", code: "CALL_TOO_LARGE" });
  });

  it("503·500·네트워크는 다음 슬롯", () => {
    expect(c(503, { error: "AI_USAGE_NOT_CONFIGURED" })).toEqual({ action: "next_slot", code: "AI_USAGE_NOT_CONFIGURED" });
    expect(c(500, null)).toEqual({ action: "next_slot", code: "HTTP_500" });
    expect(c(502, "<html>")).toEqual({ action: "next_slot", code: "HTTP_502" });
    expect(c("network", undefined)).toEqual({ action: "next_slot", code: "NETWORK" });
  });

  it("알 수 없는 응답은 멈춤(계약 변경을 조용히 지나치지 않음)", () => {
    expect(c(200, { status: "SOMETHING" })).toEqual({ action: "stop", code: "UNKNOWN_STATUS" });
    expect(c(200, null)).toEqual({ action: "stop", code: "UNKNOWN_STATUS" });
    expect(c(404, null)).toEqual({ action: "stop", code: "HTTP_404" });
    expect(c(409, { error: "CALL_REPLAY" })).toEqual({ action: "stop", code: "CALL_REPLAY" });
    expect(c(Number.NaN, null)).toEqual({ action: "stop", code: "HTTP_UNKNOWN" });
  });

  it("본문의 임의 문자열을 코드로 되돌리지 않는다(형식 밖이면 HTTP 코드)", () => {
    expect(c(400, { error: "내부 오류 상세: secret" })).toEqual({ action: "stop", code: "HTTP_400" });
    expect(c(400, { error: "lower_case" })).toEqual({ action: "stop", code: "HTTP_400" });
  });
});

describe("aiUsageMonthsToSend — 서울 슬롯", () => {
  const kst = (s: string) => Date.parse(`${s}+09:00`);

  it("슬롯 15분 창 안/밖", () => {
    expect(aiUsageMonthsToSend(kst("2026-11-14T17:59:59"))).toEqual([]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T18:00:00"))).toEqual(["2026-11-01"]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T18:14:59"))).toEqual(["2026-11-01"]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T18:15:00"))).toEqual([]);
    for (const h of ["00", "06", "12"]) expect(aiUsageMonthsToSend(kst(`2026-11-14T${h}:00:00`))).toEqual(["2026-11-01"]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T13:00:00"))).toEqual([]);
  });

  it("월 1일에는 모든 슬롯에서 직전 달이 먼저, 2일 0시는 이번 달만", () => {
    for (const h of ["00", "06", "12", "18"]) expect(aiUsageMonthsToSend(kst(`2026-11-01T${h}:05:00`)), h).toEqual(["2026-10-01", "2026-11-01"]);
    expect(aiUsageMonthsToSend(kst("2026-11-01T01:00:00"))).toEqual([]);
    expect(aiUsageMonthsToSend(kst("2026-11-02T00:00:00"))).toEqual(["2026-11-01"]);
  });

  it("서울 기준 월 경계(UTC 로는 아직 전날)", () => {
    expect(aiUsageMonthsToSend(Date.parse("2026-10-31T15:00:00Z"))).toEqual(["2026-10-01", "2026-11-01"]); // 서울 11/1 00:00
    expect(aiUsageMonthsToSend(Date.parse("2026-10-31T14:59:59Z"))).toEqual([]); // 서울 10/31 23:59
  });

  it("연초·3월 1일(윤년 아님/윤년)", () => {
    expect(aiUsageMonthsToSend(kst("2027-01-01T00:00:00"))).toEqual(["2026-12-01", "2027-01-01"]);
    expect(aiUsageMonthsToSend(kst("2026-03-01T06:00:00"))).toEqual(["2026-02-01", "2026-03-01"]);
    expect(aiUsageMonthsToSend(kst("2028-03-01T06:00:00"))).toEqual(["2028-02-01", "2028-03-01"]);
    expect(aiUsageMonthsToSend(kst("2026-12-31T18:00:00"))).toEqual(["2026-12-01"]);
  });

  it("opts: 슬롯 시·창 변경(매 틱 등), 잘못된 opts 는 빈 목록", () => {
    const all = Array.from({ length: 24 }, (_, h) => h);

    expect(aiUsageMonthsToSend(kst("2026-11-14T13:07:00"), { slotHours: all })).toEqual(["2026-11-01"]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T13:20:00"), { slotHours: all, windowMinutes: 15 })).toEqual([]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T13:20:00"), { slotHours: [13], windowMinutes: 30 })).toEqual(["2026-11-01"]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T12:00:00"), { slotHours: [] })).toEqual([]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T12:00:00"), { slotHours: [24] })).toEqual([]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T12:00:00"), { windowMinutes: 0 })).toEqual([]);
    expect(aiUsageMonthsToSend(kst("2026-11-14T12:00:00"), { windowMinutes: 61 })).toEqual([]);
  });

  it("Date·ms 모두 받고, 잘못된 시각은 빈 목록", () => {
    expect(aiUsageMonthsToSend(new Date(kst("2026-11-14T06:00:00")))).toEqual(["2026-11-01"]);
    expect(aiUsageMonthsToSend(Number.NaN)).toEqual([]);
    expect(aiUsageMonthsToSend(new Date(Number.NaN))).toEqual([]);
    expect(aiUsageMonthsToSend("x" as unknown as number)).toEqual([]);
  });

  it("슬롯이 만든 월은 buildAiUsageLine 이 받는 형식", () => {
    const months = aiUsageMonthsToSend(kst("2026-11-01T06:00:00"));
    const now = kst("2026-11-01T06:00:00");

    for (const month of months) expect(buildAiUsageLine({ ...GOOD, month, asOf: new Date(now) }, now).ok, month).toBe(true);
  });
});

describe("buildAiUsageCall — 실패는 던지지 않고 코드만", () => {
  const l = line();

  it("비밀·ttl·now 오류", () => {
    expect(buildAiUsageCall("", "shipping", l, { now: NOW_MS })).toEqual({ ok: false, code: "SIGN_SECRET_INVALID" });
    expect(buildAiUsageCall(SECRET, "shipping", l, { now: NOW_MS, ttl: 0 })).toEqual({ ok: false, code: "SIGN_TTL_INVALID" });
    expect(buildAiUsageCall(SECRET, "shipping", l, { now: Number.NaN })).toEqual({ ok: false, code: "SIGN_NOW_INVALID" });
  });

  it("줄에 허용 밖 키가 섞였거나 키가 모자라면 LINE_EXTRA_KEY", () => {
    expect(buildAiUsageCall(SECRET, "shipping", { ...l, tenantId: "t" } as unknown as AiUsageLine, { now: NOW_MS })).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    expect(buildAiUsageCall(SECRET, "shipping", { ...l, app: "eumlogis" } as unknown as AiUsageLine, { now: NOW_MS })).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    const { calls: _c, ...less } = l;

    expect(buildAiUsageCall(SECRET, "shipping", less as unknown as AiUsageLine, { now: NOW_MS })).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
    expect(buildAiUsageCall(SECRET, "shipping", null as unknown as AiUsageLine, { now: NOW_MS })).toEqual({ ok: false, code: "LINE_EXTRA_KEY" });
  });

  it("본문은 2,048바이트 이하(정상 줄은 약 350바이트)", () => {
    const r = buildAiUsageCall(SECRET, "wholesale", l, { now: NOW_MS, jti: JTI });

    expect(r.ok && Buffer.byteLength(r.body, "utf8")).toBeLessThan(500);
  });

  it("오류 결과에 비밀·값이 없다", () => {
    const r = buildAiUsageCall("short", "shipping", l, { now: NOW_MS, ttl: -1 });

    expect(JSON.stringify(r)).not.toContain("short");
    expect(JSON.stringify(r)).not.toContain("1250");
  });

  it("jti 를 생략하면 호출마다 다른 본문(재시도마다 새 jti)", () => {
    const a = buildAiUsageCall(SECRET, "shipping", l, { now: NOW_MS });
    const b = buildAiUsageCall(SECRET, "shipping", l, { now: NOW_MS });

    expect(a.ok && b.ok && a.body !== b.body).toBe(true);
  });
});

describe("정적 점검 — 순수 함수 모듈", () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ f, text: readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1") }));

  it("소스 파일이 있다", () => {
    expect(sources.map((s) => s.f).sort()).toEqual(["call.ts", "constants.ts", "index.ts", "line.ts", "response.ts", "slots.ts"]);
  });

  const BANNED: [string, RegExp][] = [
    ["console 호출", /\bconsole\s*\./],
    ["환경변수 읽기", /process\s*\.\s*env/],
    ["네트워크 호출", /\bfetch\s*\(|XMLHttpRequest|node:https?|node:net/],
    ["현재 시각 읽기", /Date\s*\.\s*now|new\s+Date\s*\(\s*\)/],
    ["난수", /Math\s*\.\s*random/],
    ["DB 접근", /supabase|createClient|\bpg\b|node:fs/],
  ];

  for (const [label, re] of BANNED) {
    it(`${label} 없음`, () => {
      for (const s of sources) expect(re.test(s.text), `${s.f}: ${label}`).toBe(false);
    });
  }

  it("회사·사용자 필드 이름이 줄 만들기 코드에 없다", () => {
    const text = sources.filter((s) => s.f === "line.ts").map((s) => s.text).join("\n");

    expect(/tenant|wholesaler|company|user_?id|email/i.test(text)).toBe(false);
  });
});
