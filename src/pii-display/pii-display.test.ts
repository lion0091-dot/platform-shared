import { describe, expect, it } from "vitest";
import {
  buildExceptionPlainEntry,
  checkTokenUse,
  dayNumber,
  decideDisplay,
  displayAccount,
  displayAddress,
  displayName,
  displayPhone,
  issueTokenRecord,
  maskAccount,
  maskAddress,
  maskName,
  maskPhone,
  PLAIN_WINDOW_DAYS,
  runUnmask,
  UNMASK_TOKEN_TTL_MS,
  validateUnmaskRequest,
  type AccessLogEntry,
  type UnmaskConfig,
  type UnmaskHooks,
} from "./index";

// 합성 값만 사용한다(실제 개인정보 아님).
const CANARY = "CANARY-PLAIN-VALUE-0001";

/** 시험용: 순간(UTC ISO) → 서울 날짜. 운영에서는 앱이 공용 서울 날짜 헬퍼로 계산한다. */
function seoulDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

describe("maskName", () => {
  it.each([
    ["홍길동", "홍*동"],
    ["남궁민수", "남**수"],
    ["김수", "김*"],
    ["가", "*"],
    ["  홍길동  ", "홍*동"],
    ["홍​길동", "홍*동"], // 제로폭 문자 변형
    ["John Smith", "J*********"],
  ])("%s → %s", (input, out) => {
    expect(maskName(input)).toBe(out);
  });
  it("빈 값은 빈 문자열, 형식 불명은 원문을 돌려주지 않는다", () => {
    expect(maskName("")).toBe("");
    expect(maskName(null)).toBe("");
    expect(maskName(undefined)).toBe("");
    expect(maskName("   ")).toBe("");
    for (const bad of ["홍길동1", "홍길동@x.com", 42, {}, [], "홍".repeat(500)]) {
      const r = maskName(bad as unknown);
      expect(r).not.toContain("홍");
      expect(r).toMatch(/^\*+$/);
    }
  });
});

describe("maskPhone", () => {
  it.each([
    ["010-1234-5678", "010-****-5678"],
    ["01012345678", "010-****-5678"],
    ["010 1234 5678", "010-****-5678"],
    ["010.1234.5678", "010-****-5678"],
    ["０１０－１２３４－５６７８", "010-****-5678"], // 전각
    ["010‐1234–5678", "010-****-5678"], // 유니코드 대시
    ["٠١٠-١٢٣٤-٥٦٧٨", "010-****-5678"], // 아랍-인도 숫자
    ["+82 10-1234-5678", "010-****-5678"],
    ["82-10-1234-5678", "010-****-5678"],
    ["011-123-4567", "011-***-4567"],
    ["02-123-4567", "02-***-4567"],
    ["02-1234-5678", "02-****-5678"],
    ["031-123-4567", "031-***-4567"],
    ["1588-1234", "****-1234"],
  ])("%s → %s", (input, out) => {
    expect(maskPhone(input)).toBe(out);
  });
  it("형식 불명은 전부 *", () => {
    for (const bad of ["12345", "abc", "010-12", "123456789012345", "010-1234-5678-9", {}, 5]) {
      expect(maskPhone(bad as unknown)).toBe("****");
    }
    expect(maskPhone("")).toBe("");
  });
});

describe("maskAccount", () => {
  it("뒤 4자리만 남긴다", () => {
    expect(maskAccount("110-123-456789")).toBe("***-***-**6789");
    expect(maskAccount("1100123456789")).toBe("*********6789");
    expect(maskAccount("110 123 456789")).toBe("***-***-**6789");
  });
  it("짧거나 글자가 섞이면 전부 *", () => {
    expect(maskAccount("1234567")).toBe("****");
    expect(maskAccount("11a-123-456789")).toBe("****");
    expect(maskAccount("1".repeat(25))).toBe("****");
    expect(maskAccount("")).toBe("");
  });
});

describe("maskAddress", () => {
  it("구조화 주소는 region 만 남긴다", () => {
    const out = maskAddress({ region: "서울특별시 강남구", detail: "역삼동 123-4" });
    expect(out).toBe("서울특별시 강남구 ***");
    expect(out).not.toContain("역삼동");
  });
  it("한 줄 주소는 앞 두 어절만 남긴다", () => {
    expect(maskAddress("서울특별시 강남구 역삼동 123-4 5층")).toBe("서울특별시 강남구 ***");
    expect(maskAddress("서울")).toBe("***");
    expect(maskAddress("서울 강남구")).toBe("***");
    expect(maskAddress("")).toBe("");
  });
  it("잘못된 구조화 입력은 전부 *", () => {
    expect(maskAddress({ region: 5 })).toBe("****");
    expect(maskAddress({})).toBe("****");
    expect(maskAddress({ region: "<script>" })).toBe("****");
  });
});

describe("decideDisplay — 표면과 근거", () => {
  const active = { kind: "ACTIVE_ORDER", orderId: "o1", phase: "IN_PROGRESS", todayKst: "2026-11-12" } as const;
  const surfaces = ["LIST", "SEARCH", "EXPORT", "AUDIT_VIEW", "INCIDENT_VIEW"] as const;

  it("목록·검색·CSV·감사·사건 화면은 어떤 근거가 있어도 마스킹(하드)", () => {
    for (const surface of surfaces) {
      for (const basis of [active, { kind: "SELF" }, { kind: "DOCUMENT", docType: "tax-invoice" }]) {
        expect(decideDisplay({ surface, basis })).toEqual({ mode: "masked" });
      }
    }
  });
  it("DETAIL: 진행 중 주문·본인은 평문", () => {
    expect(decideDisplay({ surface: "DETAIL", basis: active })).toEqual({ mode: "plain", basisKind: "ACTIVE_ORDER" });
    expect(decideDisplay({ surface: "DETAIL", basis: { kind: "SELF" } })).toEqual({ mode: "plain", basisKind: "SELF" });
  });
  it("DOCUMENT: 문서 근거만 평문", () => {
    expect(decideDisplay({ surface: "DOCUMENT", basis: { kind: "DOCUMENT", docType: "tax-invoice" } })).toEqual({ mode: "plain", basisKind: "DOCUMENT" });
    expect(decideDisplay({ surface: "DOCUMENT", basis: active })).toEqual({ mode: "masked" });
    expect(decideDisplay({ surface: "DETAIL", basis: { kind: "DOCUMENT", docType: "tax-invoice" } })).toEqual({ mode: "masked" });
  });
  it("문서 종류 형식이 틀리면 마스킹", () => {
    for (const docType of ["", "Tax Invoice", "a/b", "x".repeat(41), 5]) {
      expect(decideDisplay({ surface: "DOCUMENT", basis: { kind: "DOCUMENT", docType } })).toEqual({ mode: "masked" });
    }
  });
  it("근거 없음·이상한 입력은 마스킹이고 throw 하지 않는다", () => {
    const getterThrows = {
      get surface(): string {
        throw new Error("boom");
      },
    };
    for (const bad of [undefined, null, 42, "DETAIL", [], {}, { surface: "DETAIL" }, { surface: "DETAIL", basis: null }, { surface: "DETAIL", basis: "SELF" }, { surface: "OTHER", basis: { kind: "SELF" } }, { surface: 5 }, getterThrows]) {
      expect(decideDisplay(bad)).toEqual({ mode: "masked" });
    }
  });
});

describe("decideDisplay — 종료 후 30일 (서버 계산, 경계)", () => {
  const ctx = (endedOn: unknown, todayKst: unknown, extra: Record<string, unknown> = {}) => ({
    surface: "DETAIL",
    basis: { kind: "ACTIVE_ORDER", orderId: "o1", phase: { endedOn }, todayKst, ...extra },
  });

  it("상수는 30", () => {
    expect(PLAIN_WINDOW_DAYS).toBe(30);
  });
  it("종료 당일(0일)·29일은 평문, 30일·31일은 마스킹", () => {
    expect(decideDisplay(ctx("2026-11-12", "2026-11-12")).mode).toBe("plain");
    expect(decideDisplay(ctx("2026-11-12", "2026-12-11")).mode).toBe("plain"); // 29일
    expect(decideDisplay(ctx("2026-11-12", "2026-12-12")).mode).toBe("masked"); // 30일
    expect(decideDisplay(ctx("2026-11-12", "2026-12-13")).mode).toBe("masked"); // 31일
  });
  it("서울 자정 직전/직후 (UTC 14:59:59 / 15:00:00)", () => {
    const endedBefore = seoulDate("2026-11-12T14:59:59Z");
    const endedAfter = seoulDate("2026-11-12T15:00:00Z");
    expect(endedBefore).toBe("2026-11-12");
    expect(endedAfter).toBe("2026-11-13");
    // 종료일 11-12 기준: 오늘이 서울 12-11(29일)이면 평문, 서울 12-12(30일)가 되는 순간부터 마스킹
    expect(decideDisplay(ctx(endedBefore, seoulDate("2026-12-11T14:59:59Z"))).mode).toBe("plain");
    expect(decideDisplay(ctx(endedBefore, seoulDate("2026-12-11T15:00:00Z"))).mode).toBe("masked");
    // 같은 UTC 날짜라도 서울 날짜로 하루 차이가 난다
    expect(decideDisplay(ctx(endedAfter, seoulDate("2026-12-11T14:59:59Z"))).mode).toBe("plain"); // 28일
    expect(decideDisplay(ctx(endedAfter, seoulDate("2026-12-12T14:59:59Z"))).mode).toBe("plain"); // 29일
    expect(decideDisplay(ctx(endedAfter, seoulDate("2026-12-12T15:00:00Z"))).mode).toBe("masked"); // 30일
  });
  it("월말·윤년 경계에서 달력 날짜 차이로 계산", () => {
    expect(dayNumber("2028-03-01")! - dayNumber("2028-02-28")!).toBe(2); // 2028 윤년
    expect(dayNumber("2027-03-01")! - dayNumber("2027-02-28")!).toBe(1);
    expect(decideDisplay(ctx("2028-02-01", "2028-03-01")).mode).toBe("plain"); // 29일
    expect(decideDisplay(ctx("2028-02-01", "2028-03-02")).mode).toBe("masked"); // 30일
  });
  it("종료일 없음·미래·형식 오류는 마스킹", () => {
    for (const bad of [undefined, null, "", "2026-13-40", "2026-02-30", "20261112", "2026-11-12T00:00:00Z", 20261112, {}]) {
      expect(decideDisplay(ctx(bad, "2026-11-12")).mode).toBe("masked");
    }
    expect(decideDisplay(ctx("2026-11-13", "2026-11-12")).mode).toBe("masked"); // 미래
    expect(decideDisplay(ctx("2026-11-12", "garbage")).mode).toBe("masked");
    expect(decideDisplay({ surface: "DETAIL", basis: { kind: "ACTIVE_ORDER", orderId: "o1", phase: "ENDED", todayKst: "2026-11-12" } }).mode).toBe("masked");
    expect(decideDisplay({ surface: "DETAIL", basis: { kind: "ACTIVE_ORDER", orderId: "", phase: "IN_PROGRESS", todayKst: "2026-11-12" } }).mode).toBe("masked");
  });
  it("진행 중은 날짜와 무관하게 평문(오늘 날짜 형식이 맞아야 함)", () => {
    expect(decideDisplay({ surface: "DETAIL", basis: { kind: "ACTIVE_ORDER", orderId: "o1", phase: "IN_PROGRESS", todayKst: "2030-01-01" } }).mode).toBe("plain");
    expect(decideDisplay({ surface: "DETAIL", basis: { kind: "ACTIVE_ORDER", orderId: "o1", phase: "IN_PROGRESS", todayKst: "bad" } }).mode).toBe("masked");
  });
  it("windowDays 는 줄일 수만 있다", () => {
    expect(decideDisplay(ctx("2026-11-12", "2026-11-18", { windowDays: 7 })).mode).toBe("plain"); // 6일
    expect(decideDisplay(ctx("2026-11-12", "2026-11-19", { windowDays: 7 })).mode).toBe("masked"); // 7일
    expect(decideDisplay(ctx("2026-11-12", "2026-12-12", { windowDays: 90 })).mode).toBe("masked"); // 30으로 제한
    for (const w of [0, -1, 1.5, Number.NaN, "7"]) {
      expect(decideDisplay(ctx("2026-11-12", "2026-11-12", { windowDays: w })).mode).toBe("masked");
    }
  });
});

describe("display* 래퍼", () => {
  const detail = { surface: "DETAIL", basis: { kind: "SELF" } };
  it("평문 근거 + 형식 맞는 값 → 원문 그대로", () => {
    expect(displayPhone("010-1234-5678", detail)).toEqual({ mode: "plain", basisKind: "SELF", text: "010-1234-5678" });
    expect(displayName("홍길동", detail).text).toBe("홍길동");
    expect(displayAccount("110-123-456789", detail).text).toBe("110-123-456789");
    expect(displayAddress("서울특별시 강남구 역삼동 1", detail).text).toBe("서울특별시 강남구 역삼동 1");
  });
  it("근거 없음·마스킹 표면 → 마스킹", () => {
    expect(displayPhone("010-1234-5678", { surface: "DETAIL" })).toEqual({ mode: "masked", text: "010-****-5678" });
    expect(displayPhone("010-1234-5678", { surface: "LIST", basis: { kind: "SELF" } }).text).toBe("010-****-5678");
    expect(displayName("홍길동", undefined).text).toBe("홍*동");
  });
  it("근거가 있어도 형식이 틀린 값은 원문을 돌려주지 않는다", () => {
    const r = displayPhone(`${CANARY}`, detail);
    expect(r).toEqual({ mode: "masked", text: "****" });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("결과에 주문 id 가 나오지 않는다", () => {
    const r = displayPhone("010-1234-5678", { surface: "DETAIL", basis: { kind: "ACTIVE_ORDER", orderId: "ORDER-SECRET-ID", phase: "IN_PROGRESS", todayKst: "2026-11-12" } });
    expect(r.mode).toBe("plain");
    expect(JSON.stringify(r)).not.toContain("ORDER-SECRET-ID");
  });
  it("빈 값은 빈 문자열(마스킹)", () => {
    expect(displayPhone("", detail)).toEqual({ mode: "masked", text: "" });
    expect(displayPhone(null, detail).text).toBe("");
  });
});

// ── 해제 계약 ────────────────────────────────────────────────
const cfg: UnmaskConfig = { reasonCodes: ["CS_CALLBACK", "DISPUTE"], fieldGroups: ["contact", "account"] };
const goodReq = () => ({
  company: "co-1",
  actor: { id: "u-1", role: "staff" },
  target: { table: "customers", recordId: "rec-1" },
  fieldGroup: "contact",
  reasonCode: "CS_CALLBACK",
  recentLoginAgeSec: 120,
});

describe("validateUnmaskRequest", () => {
  it("정상 요청 통과 + 복사본", () => {
    const req = goodReq();
    const v = validateUnmaskRequest(req, cfg);
    expect(v.ok).toBe(true);
    req.actor.id = "changed";
    if (v.ok) expect(v.value.actor.id).toBe("u-1");
  });
  it("사유 코드: 없음/빈 값 → REASON_REQUIRED, 목록 밖/형식 오류 → REASON_UNKNOWN", () => {
    const r = goodReq() as Record<string, unknown>;
    delete r.reasonCode;
    expect(validateUnmaskRequest(r, cfg)).toEqual({ ok: false, code: "REASON_REQUIRED" });
    expect(validateUnmaskRequest({ ...goodReq(), reasonCode: "" }, cfg)).toEqual({ ok: false, code: "REASON_REQUIRED" });
    expect(validateUnmaskRequest({ ...goodReq(), reasonCode: "OTHER" }, cfg)).toEqual({ ok: false, code: "REASON_UNKNOWN" });
    expect(validateUnmaskRequest({ ...goodReq(), reasonCode: "cs callback" }, cfg)).toEqual({ ok: false, code: "REASON_UNKNOWN" });
    expect(validateUnmaskRequest(goodReq(), { ...cfg, reasonCodes: [] })).toEqual({ ok: false, code: "REASON_UNKNOWN" });
  });
  it("최근 로그인: 300초까지 허용, 초과·음수·NaN·문자열은 RECENT_LOGIN_REQUIRED", () => {
    expect(validateUnmaskRequest({ ...goodReq(), recentLoginAgeSec: 300 }, cfg).ok).toBe(true);
    expect(validateUnmaskRequest({ ...goodReq(), recentLoginAgeSec: 0 }, cfg).ok).toBe(true);
    for (const bad of [301, -1, Number.NaN, Number.POSITIVE_INFINITY, "10", undefined]) {
      expect(validateUnmaskRequest({ ...goodReq(), recentLoginAgeSec: bad }, cfg)).toEqual({ ok: false, code: "RECENT_LOGIN_REQUIRED" });
    }
  });
  it("일괄 해제 금지: 배열·쉼표·와일드카드 id", () => {
    expect(validateUnmaskRequest({ ...goodReq(), target: [{ table: "customers", recordId: "a" }] }, cfg)).toEqual({ ok: false, code: "BATCH_NOT_ALLOWED" });
    expect(validateUnmaskRequest({ ...goodReq(), target: { table: "customers", recordId: ["a", "b"] } }, cfg)).toEqual({ ok: false, code: "BATCH_NOT_ALLOWED" });
    expect(validateUnmaskRequest({ ...goodReq(), fieldGroup: ["contact", "account"] }, cfg)).toEqual({ ok: false, code: "BATCH_NOT_ALLOWED" });
    for (const id of ["a,b", "a b", "a;b", "*", "%"]) {
      expect(validateUnmaskRequest({ ...goodReq(), target: { table: "customers", recordId: id } }, cfg)).toEqual({ ok: false, code: "BATCH_NOT_ALLOWED" });
    }
  });
  it("필드군·표·행위자 형식 검증", () => {
    expect(validateUnmaskRequest({ ...goodReq(), fieldGroup: "all" }, cfg)).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(validateUnmaskRequest({ ...goodReq(), target: { table: "Customers;drop", recordId: "a" } }, cfg)).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(validateUnmaskRequest({ ...goodReq(), actor: { id: "", role: "staff" } }, cfg)).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(validateUnmaskRequest({ ...goodReq(), reasonNote: "x".repeat(501) }, cfg)).toEqual({ ok: false, code: "INVALID_REQUEST" });
    for (const bad of [null, undefined, 1, "x", []]) {
      expect(validateUnmaskRequest(bad, cfg)).toMatchObject({ ok: false });
    }
  });
});

function makeHooks(over: Partial<UnmaskHooks> = {}) {
  const calls: string[] = [];
  const entries: AccessLogEntry[] = [];
  let n = 0;
  const hooks: UnmaskHooks = {
    authorize: () => {
      calls.push("authorize");
      return true;
    },
    record: (e) => {
      calls.push(`record:${e.outcome}`);
      entries.push(e);
    },
    load: () => {
      calls.push("load");
      return CANARY;
    },
    nowMs: () => Date.parse("2026-11-12T03:00:00Z"),
    newTokenId: () => `tok-${++n}`,
    ...over,
  };
  return { hooks, calls, entries };
}

describe("runUnmask — 순서와 fail-closed", () => {
  it("정상: 권한 → 시도 기록 → 읽기 → 결과 기록 → 반환(+토큰 5분)", async () => {
    const { hooks, calls, entries } = makeHooks();
    const r = await runUnmask(goodReq(), cfg, hooks);
    expect(calls).toEqual(["authorize", "record:attempt", "load", "record:ok"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(CANARY);
      expect(r.token.expiresAtMs - r.token.issuedAtMs).toBe(UNMASK_TOKEN_TTL_MS);
      expect(r.token).toMatchObject({ actorId: "u-1", company: "co-1", table: "customers", recordId: "rec-1", fieldGroup: "contact" });
    }
    expect(entries[0]).toMatchObject({ kind: "UNMASK", outcome: "attempt", reasonCode: "CS_CALLBACK", authBasis: "recent_login_5m" });
  });
  it("열람 기록에 원문(값)이 들어가지 않는다", async () => {
    const { hooks, entries } = makeHooks();
    await runUnmask(goodReq(), cfg, hooks);
    expect(JSON.stringify(entries)).not.toContain(CANARY);
  });
  it("검증 실패면 아무 훅도 부르지 않는다", async () => {
    const { hooks, calls } = makeHooks();
    expect(await runUnmask({ ...goodReq(), reasonCode: "" }, cfg, hooks)).toEqual({ ok: false, code: "REASON_REQUIRED" });
    expect(await runUnmask({ ...goodReq(), recentLoginAgeSec: 999 }, cfg, hooks)).toEqual({ ok: false, code: "RECENT_LOGIN_REQUIRED" });
    expect(calls).toEqual([]);
  });
  it("권한 없음(false/throw): 읽기 없음, denied 기록", async () => {
    for (const authorize of [() => false, () => Promise.reject(new Error("x")), () => undefined as unknown as boolean]) {
      const { hooks, calls, entries } = makeHooks({ authorize });
      expect(await runUnmask(goodReq(), cfg, hooks)).toEqual({ ok: false, code: "NOT_ALLOWED" });
      expect(calls).not.toContain("load");
      expect(entries.at(-1)?.outcome).toBe("denied");
    }
  });
  it("시도 기록이 실패하면 원문을 읽지도 반환하지도 않는다", async () => {
    const { hooks, calls } = makeHooks({
      record: () => {
        throw new Error("db down");
      },
    });
    expect(await runUnmask(goodReq(), cfg, hooks)).toEqual({ ok: false, code: "FAILED" });
    expect(calls).not.toContain("load");
  });
  it("결과 기록이 실패하면 읽은 원문을 버린다", async () => {
    let i = 0;
    const { hooks } = makeHooks({
      record: () => {
        if (++i === 2) throw new Error("db down");
      },
    });
    const r = await runUnmask(goodReq(), cfg, hooks);
    expect(r).toEqual({ ok: false, code: "FAILED" });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("읽기 실패는 failed 기록 + FAILED", async () => {
    const { hooks, entries } = makeHooks({
      load: () => {
        throw new Error("decrypt");
      },
    });
    expect(await runUnmask(goodReq(), cfg, hooks)).toEqual({ ok: false, code: "FAILED" });
    expect(entries.map((e) => e.outcome)).toEqual(["attempt", "failed"]);
  });
  it("load 가 문자열이 아니면 실패", async () => {
    const { hooks } = makeHooks({ load: () => 5 as unknown as string });
    expect(await runUnmask(goodReq(), cfg, hooks)).toEqual({ ok: false, code: "FAILED" });
  });
});

describe("해제 토큰", () => {
  const req = (() => {
    const v = validateUnmaskRequest(goodReq(), cfg);
    if (!v.ok) throw new Error("setup");
    return v.value;
  })();
  const use = { actorId: "u-1", company: "co-1", table: "customers", recordId: "rec-1", fieldGroup: "contact" };
  const t0 = Date.parse("2026-11-12T03:00:00Z");
  const tok = issueTokenRecord(req, "tok-1", t0)!;

  it("5분 이내 같은 대상 1건·필드군에서만 유효", () => {
    expect(checkTokenUse(tok, use, t0)).toEqual({ ok: true });
    expect(checkTokenUse(tok, use, t0 + UNMASK_TOKEN_TTL_MS - 1)).toEqual({ ok: true });
    expect(checkTokenUse(tok, use, t0 + UNMASK_TOKEN_TTL_MS)).toEqual({ ok: false, code: "TOKEN_EXPIRED" });
  });
  it("다른 대상·필드군·사용자·회사·표는 불일치", () => {
    for (const patch of [{ recordId: "rec-2" }, { fieldGroup: "account" }, { actorId: "u-2" }, { company: "co-2" }, { table: "orders" }]) {
      expect(checkTokenUse(tok, { ...use, ...patch }, t0 + 1)).toEqual({ ok: false, code: "TOKEN_MISMATCH" });
    }
  });
  it("조작된 토큰(유효기간 연장·역전·NaN·비객체)은 무효", () => {
    expect(checkTokenUse({ ...tok, expiresAtMs: t0 + 3_600_000 }, use, t0 + 1)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(checkTokenUse({ ...tok, expiresAtMs: t0 }, use, t0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(checkTokenUse({ ...tok, issuedAtMs: Number.NaN }, use, t0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(checkTokenUse(null, use, t0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(checkTokenUse(tok, use, t0 - 1)).toEqual({ ok: false, code: "TOKEN_INVALID" });
  });
  it("유효 시간은 줄일 수만 있다", () => {
    expect(issueTokenRecord(req, "tok-2", t0, 60_000)!.expiresAtMs).toBe(t0 + 60_000);
    expect(issueTokenRecord(req, "tok-3", t0, 3_600_000)!.expiresAtMs).toBe(t0 + UNMASK_TOKEN_TTL_MS);
    expect(issueTokenRecord(req, "tok-4", t0, -5)!.expiresAtMs).toBe(t0 + UNMASK_TOKEN_TTL_MS);
    expect(issueTokenRecord(req, "bad id", t0)).toBeNull();
  });
});

describe("예외 평문 최소 기록", () => {
  it("누가·언제·대상 id·surface·basis 만, 사유·값 없음", () => {
    const e = buildExceptionPlainEntry({
      nowMs: Date.parse("2026-11-12T03:00:00Z"),
      company: "co-1",
      actor: { id: "u-1", role: "dispatcher" },
      target: { table: "orders", recordId: "o-1" },
      surface: "DETAIL",
      basisKind: "ACTIVE_ORDER",
    });
    expect(e).toEqual({
      kind: "EXCEPTION_PLAIN",
      at: "2026-11-12T03:00:00.000Z",
      company: "co-1",
      actorId: "u-1",
      actorRole: "dispatcher",
      table: "orders",
      recordId: "o-1",
      surface: "DETAIL",
      basisKind: "ACTIVE_ORDER",
    });
    expect(Object.keys(e)).not.toContain("reasonCode");
  });
});
