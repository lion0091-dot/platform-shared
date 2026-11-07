import { describe, expect, it } from "vitest";
import pii from "./__vectors__/pii.json";
import transitions from "./__vectors__/transitions.json";
import {
  BOARD_ACTION_RISK,
  BOARD_ANALYSIS_VIEW,
  BOARD_APP_KEYS,
  BOARD_ATTACH_ALLOWED,
  BOARD_ATTACH_MAX_BYTES,
  BOARD_ATTACH_MAX_COUNT,
  BOARD_ATTACH_MAX_TOTAL_BYTES,
  BOARD_AUDIT_ACTIONS,
  BOARD_CONTRACT_VERSION,
  BOARD_ERRORS,
  BOARD_NOTICES,
  BOARD_SETTINGS,
  BOARD_TIER1_CATEGORIES,
  BOARD_TIER2_CATEGORIES,
  BOARD_TIER2_STATUSES,
  allowedReplyVisibilities,
  approvalExpiresAt,
  canEscalate,
  canReply,
  canTransition,
  canView,
  canViewReply,
  clampSetting,
  detectPii,
  effectiveSetting,
  exceedsAttachLimit,
  exceedsDailyAttachBytes,
  canAttachToReply,
  BOARD_ATTACH_UPLOADER_KINDS,
  exceedsLimit,
  needsStaffReply,
  requiresReason,
  resolveNotice,
  sanitizeDisplayName,
  validateApprovalDecision,
  validateAttachmentMeta,
  validateEscalation,
  validateOverride,
  validateReason,
  validateSetting,
  writeLimits,
  type BoardActorSide,
  type BoardStatus,
  type BoardTier2Status,
  type BoardViewer,
} from "./index";

const bytes = (...b: number[]) => new Uint8Array(b);
const pad = (head: number[], len = 64) => new Uint8Array([...head, ...new Array(Math.max(0, len - head.length)).fill(0x41)]);

describe("계약 상수", () => {
  it("버전·앱 키·뷰 이름·분류·상태가 설계서 확정값과 같다", () => {
    expect(BOARD_CONTRACT_VERSION).toBe(1);
    expect([...BOARD_APP_KEYS]).toEqual(["shipping", "wholesale", "ledgercore"]);
    expect(BOARD_ANALYSIS_VIEW).toBe("board_escalations_v");
    expect([...BOARD_TIER1_CATEGORIES]).toEqual(["NOTICE", "QUESTION", "HANDOVER", "SUGGESTION"]);
    expect([...BOARD_TIER2_CATEGORIES]).toEqual(["BUG", "FEATURE", "ACCOUNT", "ETC"]);
    expect([...BOARD_TIER2_STATUSES]).toEqual(["RECEIVED", "IN_PROGRESS", "NEED_INFO", "DONE", "DECLINED"]);
  });
});

describe("detectPii", () => {
  it.each(pii.flagged as [string, string[]][])("걸림: %s", (text, kinds) => {
    expect(detectPii(text)).toEqual(kinds);
  });

  it.each(pii.clean)("통과: %s", (text) => {
    expect(detectPii(text)).toEqual([]);
  });

  it("null·undefined 는 통과, 같은 입력을 반복해도 결과가 같다(정규식 상태 없음)", () => {
    expect(detectPii(null)).toEqual([]);
    expect(detectPii(undefined)).toEqual([]);
    for (let i = 0; i < 3; i += 1) {
      expect(detectPii("010-1234-5678")).toEqual(["PHONE"]);
    }
  });

  it("값을 돌려주지 않고 종류만 돌려준다", () => {
    expect(JSON.stringify(detectPii("010-1234-5678"))).not.toContain("1234");
  });
});

describe("canView", () => {
  const staff = (sameTenant: boolean): BoardViewer => ({ viewerKind: "STAFF", sameTenant });

  it("일반 사용자: 자기 1층 글만, 2층은 안 보임", () => {
    expect(canView({ tier: 1 }, { viewerKind: "USER", isAuthor: true, sameTenant: true })).toBe(true);
    expect(canView({ tier: 1 }, { viewerKind: "USER", isAuthor: false, sameTenant: true })).toBe(false);
    expect(canView({ tier: 1 }, { viewerKind: "USER", isAuthor: true, sameTenant: false })).toBe(false);
    expect(canView({ tier: 2 }, { viewerKind: "USER", isAuthor: true, sameTenant: true })).toBe(false);
  });

  it("직원: 자기 테넌트 1층·2층 전부, 다른 테넌트는 안 보임", () => {
    expect(canView({ tier: 1 }, staff(true))).toBe(true);
    expect(canView({ tier: 2 }, staff(true))).toBe(true);
    expect(canView({ tier: 1 }, staff(false))).toBe(false);
    expect(canView({ tier: 2 }, { viewerKind: "STAFF" })).toBe(false);
  });

  it("플랫폼: 2층만, 1층은 안 보임", () => {
    expect(canView({ tier: 2 }, { viewerKind: "PLATFORM" })).toBe(true);
    expect(canView({ tier: 1 }, { viewerKind: "PLATFORM" })).toBe(false);
  });
});

describe("canViewReply", () => {
  const user = { viewerKind: "USER", isAuthor: true, sameTenant: true } as const;
  const staff = { viewerKind: "STAFF", sameTenant: true } as const;
  const platform = { viewerKind: "PLATFORM" } as const;

  it("TENANT_ONLY 는 직원만", () => {
    expect(canViewReply({ visibility: "TENANT_ONLY" }, { tier: 1 }, staff)).toBe(true);
    expect(canViewReply({ visibility: "TENANT_ONLY" }, { tier: 1 }, user)).toBe(false);
    expect(canViewReply({ visibility: "TENANT_ONLY" }, { tier: 2 }, platform)).toBe(false);
  });

  it("AUTHOR 는 직원과 그 글 작성자(1층)", () => {
    expect(canViewReply({ visibility: "AUTHOR" }, { tier: 1 }, user)).toBe(true);
    expect(canViewReply({ visibility: "AUTHOR" }, { tier: 1 }, staff)).toBe(true);
    expect(canViewReply({ visibility: "AUTHOR" }, { tier: 1 }, { viewerKind: "USER", isAuthor: false, sameTenant: true })).toBe(false);
  });

  it("PLATFORM 은 2층에서 직원과 플랫폼만, 일반 사용자는 못 봄", () => {
    expect(canViewReply({ visibility: "PLATFORM" }, { tier: 2 }, platform)).toBe(true);
    expect(canViewReply({ visibility: "PLATFORM" }, { tier: 2 }, staff)).toBe(true);
    expect(canViewReply({ visibility: "PLATFORM" }, { tier: 2 }, user)).toBe(false);
  });
});

describe("canReply / allowedReplyVisibilities", () => {
  const staff = { viewerKind: "STAFF", sameTenant: true } as const;
  const user = { viewerKind: "USER", isAuthor: true, sameTenant: true } as const;
  const platform = { viewerKind: "PLATFORM" } as const;

  it("1층: 직원과 작성자 본인, 플랫폼은 불가", () => {
    expect(canReply({ tier: 1 }, staff)).toBe(true);
    expect(canReply({ tier: 1 }, user)).toBe(true);
    expect(canReply({ tier: 1 }, platform)).toBe(false);
    expect(canReply({ tier: 1 }, { viewerKind: "USER", isAuthor: false, sameTenant: true })).toBe(false);
  });

  it("2층: 직원과 플랫폼, 일반 사용자는 불가, DECLINED 는 아무도 불가", () => {
    expect(canReply({ tier: 2, status: "RECEIVED" }, staff)).toBe(true);
    expect(canReply({ tier: 2, status: "RECEIVED" }, platform)).toBe(true);
    expect(canReply({ tier: 2, status: "RECEIVED" }, user)).toBe(false);
    expect(canReply({ tier: 2, status: "DECLINED" }, staff)).toBe(false);
    expect(canReply({ tier: 2, status: "DECLINED" }, platform)).toBe(false);
  });

  it("작성 가능한 가시성", () => {
    expect(allowedReplyVisibilities({ tier: 1 }, staff)).toEqual(["AUTHOR", "TENANT_ONLY"]);
    expect(allowedReplyVisibilities({ tier: 1 }, user)).toEqual(["AUTHOR"]);
    expect(allowedReplyVisibilities({ tier: 2, status: "IN_PROGRESS" }, platform)).toEqual(["PLATFORM"]);
    expect(allowedReplyVisibilities({ tier: 2, status: "IN_PROGRESS" }, staff)).toEqual(["PLATFORM"]);
    expect(allowedReplyVisibilities({ tier: 1 }, platform)).toEqual([]);
  });
});

describe("canEscalate", () => {
  const base = { viewerKind: "STAFF", sameTenant: true, hasEscalateRole: true } as const;

  it("직원 전원(역할 무관)이 자기 테넌트의 아직 승격 안 된 1층 글만", () => {
    expect(canEscalate({ tier: 1 }, base)).toBe(true);
    expect(canEscalate({ tier: 1 }, { ...base, hasEscalateRole: false })).toBe(true);
    expect(canEscalate({ tier: 1 }, { viewerKind: "STAFF", sameTenant: true })).toBe(true);
    expect(canEscalate({ tier: 1 }, { ...base, sameTenant: false })).toBe(false);
    expect(canEscalate({ tier: 1, escalated: true }, base)).toBe(false);
    expect(canEscalate({ tier: 2 }, base)).toBe(false);
    expect(canEscalate({ tier: 1 }, { viewerKind: "USER", sameTenant: true, hasEscalateRole: true })).toBe(false);
    expect(canEscalate({ tier: 1 }, { viewerKind: "PLATFORM", hasEscalateRole: true })).toBe(false);
  });
});

describe("전이표(벡터)", () => {
  type Row = [BoardStatus, BoardTier2Status, BoardActorSide, boolean];

  it.each(transitions.allowed as Row[])("허용 %s → %s (%s, 권한 %s)", (from, to, side, role) => {
    expect(canTransition(from, to, side, role)).toBe(true);
  });

  it.each(transitions.denied as Row[])("거부 %s → %s (%s, 권한 %s)", (from, to, side, role) => {
    expect(canTransition(from, to, side, role)).toBe(false);
  });

  it("전수 조합: 허용 목록 밖은 전부 거부(허용 벡터와 일치)", () => {
    const froms: BoardStatus[] = ["NONE", ...BOARD_TIER2_STATUSES];
    const allowedKeys = new Set((transitions.allowed as Row[]).map((r) => `${r[0]}>${r[1]}>${r[2]}`));
    for (const from of froms) {
      for (const to of BOARD_TIER2_STATUSES) {
        for (const side of ["TENANT", "PLATFORM"] as const) {
          const expected = allowedKeys.has(`${from}>${to}>${side}`);
          expect(canTransition(from, to, side, true), `${from}>${to}>${side}`).toBe(expected);
        }
      }
    }
  });

  it("사유 필수 전이", () => {
    expect(requiresReason("DECLINED")).toBe(true);
    expect(requiresReason("NEED_INFO")).toBe(true);
    expect(requiresReason("DONE")).toBe(false);
    expect(requiresReason("IN_PROGRESS")).toBe(false);
    expect(requiresReason("RECEIVED")).toBe(false);
  });
});

describe("validateEscalation", () => {
  const good = {
    hasEscalateRole: true,
    privacyConfirmed: true,
    category: "BUG",
    title: "배차 화면 오류",
    body: "배차 저장 시 오류가 납니다.",
    reason: "직원이 해결 못 함",
  };

  it("정상은 통과", () => {
    expect(validateEscalation(good)).toEqual({ ok: true });
  });

  it("분류·확인 체크·사유·내용 누락을 모두 알려 준다", () => {
    const r = validateEscalation({ ...good, category: "BILLING", privacyConfirmed: false, reason: "  ", title: "", body: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(
        expect.arrayContaining([
          BOARD_ERRORS.INVALID_CATEGORY,
          BOARD_ERRORS.PRIVACY_NOT_CONFIRMED,
          BOARD_ERRORS.EMPTY_CONTENT,
          BOARD_ERRORS.REASON_REQUIRED,
        ]),
      );
    }
  });

  it("본문·제목에 개인정보가 있으면 PII_DETECTED 와 종류만 돌려주고 값은 없다", () => {
    const r = validateEscalation({ ...good, body: "고객 연락처 010-1234-5678" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain(BOARD_ERRORS.PII_DETECTED);
      expect(r.pii).toEqual(["PHONE"]);
      expect(JSON.stringify(r)).not.toContain("1234");
    }
  });

  it("청구·계약 분류는 없다(결정 #8)", () => {
    expect(validateEscalation({ ...good, category: "BILLING" }).ok).toBe(false);
    expect(validateEscalation({ ...good, category: "CONTRACT" }).ok).toBe(false);
  });

  it("사유 501자는 거부", () => {
    expect(validateEscalation({ ...good, reason: "가".repeat(501) }).ok).toBe(false);
    expect(validateEscalation({ ...good, reason: "가".repeat(500) }).ok).toBe(true);
  });
});

describe("needsStaffReply", () => {
  it("1층: 답이 없거나 마지막 답이 직원이 아니면 참", () => {
    expect(needsStaffReply({ tier: 1, lastReplyAuthorKind: null })).toBe(true);
    expect(needsStaffReply({ tier: 1, lastReplyAuthorKind: "USER" })).toBe(true);
    expect(needsStaffReply({ tier: 1, lastReplyAuthorKind: "STAFF" })).toBe(false);
  });

  it("2층은 항상 거짓", () => {
    expect(needsStaffReply({ tier: 2, lastReplyAuthorKind: null })).toBe(false);
  });
});

describe("작성 제한·설정", () => {
  it("기본값은 확정값(일반 5/일·1/분, 직원 20/일·3/분, 첨부 일 50MB)", () => {
    expect(writeLimits("USER")).toEqual({ perDay: 5, perMinute: 1 });
    expect(writeLimits("STAFF")).toEqual({ perDay: 20, perMinute: 3 });
    expect(BOARD_SETTINGS["attach.daily_mb"].default).toBe(50);
  });

  it("범위 안 정수만 저장 허용, 범위 밖·소수·문자·알 수 없는 키는 거부", () => {
    expect(validateSetting("limit.user.per_day", 10)).toEqual({ ok: true, value: 10 });
    expect(validateSetting("limit.user.per_day", 30)).toEqual({ ok: true, value: 30 });
    expect(validateSetting("limit.user.per_day", 31)).toEqual({ ok: false, code: BOARD_ERRORS.SETTING_OUT_OF_RANGE });
    expect(validateSetting("limit.user.per_day", 0)).toEqual({ ok: false, code: BOARD_ERRORS.SETTING_OUT_OF_RANGE });
    expect(validateSetting("limit.user.per_day", 2.5)).toEqual({ ok: false, code: BOARD_ERRORS.SETTING_OUT_OF_RANGE });
    expect(validateSetting("limit.user.per_day", "5")).toEqual({ ok: false, code: BOARD_ERRORS.SETTING_OUT_OF_RANGE });
    expect(validateSetting("nope", 1)).toEqual({ ok: false, code: BOARD_ERRORS.SETTING_UNKNOWN });
    expect(validateSetting("toString", 1)).toEqual({ ok: false, code: BOARD_ERRORS.SETTING_UNKNOWN });
  });

  it("범위 경계: 직원 하루 5~100, 분당 1~10, 첨부 10~100MB", () => {
    expect(validateSetting("limit.staff.per_day", 4).ok).toBe(false);
    expect(validateSetting("limit.staff.per_day", 100).ok).toBe(true);
    expect(validateSetting("limit.staff.per_minute", 11).ok).toBe(false);
    expect(validateSetting("attach.daily_mb", 9).ok).toBe(false);
    expect(validateSetting("attach.daily_mb", 100).ok).toBe(true);
  });

  it("clampSetting·effectiveSetting: 읽을 때 범위 밖이면 보정·기본값", () => {
    expect(clampSetting("limit.user.per_day", 999)).toBe(30);
    expect(clampSetting("limit.user.per_day", -3)).toBe(1);
    expect(clampSetting("limit.user.per_day", Number.NaN)).toBe(5);
    expect(effectiveSetting("limit.user.per_day", null)).toBe(5);
    expect(effectiveSetting("limit.user.per_day", 12)).toBe(12);
    expect(effectiveSetting("limit.user.per_day", 999)).toBe(5);
    expect(writeLimits("USER", { "limit.user.per_day": 10 })).toEqual({ perDay: 10, perMinute: 1 });
  });

  it("exceedsLimit: 건수가 한도와 같거나 넘으면 RATE_LIMITED", () => {
    const user = writeLimits("USER");
    expect(exceedsLimit({ lastDay: 4, lastMinute: 0 }, user)).toBeNull();
    expect(exceedsLimit({ lastDay: 5, lastMinute: 0 }, user)).toBe(BOARD_ERRORS.RATE_LIMITED);
    expect(exceedsLimit({ lastDay: 1, lastMinute: 1 }, user)).toBe(BOARD_ERRORS.RATE_LIMITED);
    expect(exceedsLimit({ lastDay: 19, lastMinute: 2 }, writeLimits("STAFF"))).toBeNull();
    expect(exceedsLimit({ lastDay: 20, lastMinute: 0 }, writeLimits("STAFF"))).toBe(BOARD_ERRORS.RATE_LIMITED);
  });
});

describe("안내 문구", () => {
  it("locked 문구는 덮어쓸 수 없고 항상 기본 문구", () => {
    expect(validateOverride("WRITE_NOTICE_PII", "다르게")).toEqual({ ok: false, code: BOARD_ERRORS.NOTICE_LOCKED });
    expect(resolveNotice("WRITE_NOTICE_PII", { tenant: "다르게", app: "다르게" })).toBe(BOARD_NOTICES.WRITE_NOTICE_PII.text);
  });

  it("locked 가 아닌 문구는 테넌트 → 앱 → 기본 순으로 덮어쓴다", () => {
    expect(resolveNotice("WRITE_NOTICE_ORDER_GUIDE", { tenant: "테넌트 문구", app: "앱 문구" })).toBe("테넌트 문구");
    expect(resolveNotice("WRITE_NOTICE_ORDER_GUIDE", { tenant: null, app: "앱 문구" })).toBe("앱 문구");
    expect(resolveNotice("WRITE_NOTICE_ORDER_GUIDE", {})).toBe(BOARD_NOTICES.WRITE_NOTICE_ORDER_GUIDE.text);
    expect(resolveNotice("WRITE_NOTICE_ORDER_GUIDE", { tenant: "   ", app: "앱 문구" })).toBe("앱 문구");
  });

  it("빈 문구·500자 초과·모르는 id 는 거부", () => {
    expect(validateOverride("WRITE_NOTICE_ORDER_GUIDE", "  ")).toEqual({ ok: false, code: BOARD_ERRORS.NOTICE_INVALID });
    expect(validateOverride("WRITE_NOTICE_ORDER_GUIDE", "가".repeat(501)).ok).toBe(false);
    expect(validateOverride("WRITE_NOTICE_ORDER_GUIDE", "가".repeat(500)).ok).toBe(true);
    expect(validateOverride("nope", "x")).toEqual({ ok: false, code: BOARD_ERRORS.NOTICE_INVALID });
  });
});

describe("첨부", () => {
  it("확정 상수", () => {
    expect(BOARD_ATTACH_MAX_COUNT).toBe(5);
    expect(BOARD_ATTACH_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(BOARD_ATTACH_MAX_TOTAL_BYTES).toBe(15 * 1024 * 1024);
    expect(Object.keys(BOARD_ATTACH_ALLOWED)).toEqual(["jpg", "png", "webp", "pdf", "txt", "log"]);
  });

  const JPEG = [0xff, 0xd8, 0xff, 0xe0];
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
  const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31];

  it("허용: 확장자와 내용이 맞는 jpg·png·webp·pdf·txt·log", () => {
    expect(validateAttachmentMeta({ name: "a.JPG", size: 1000, head: pad(JPEG) })).toMatchObject({ ok: true, ext: "jpg", mime: "image/jpeg" });
    expect(validateAttachmentMeta({ name: "a.png", size: 1000, head: pad(PNG) })).toMatchObject({ ok: true, format: "png" });
    expect(validateAttachmentMeta({ name: "a.webp", size: 1000, head: pad(WEBP) })).toMatchObject({ ok: true, format: "webp" });
    expect(validateAttachmentMeta({ name: "a.pdf", size: 1000, head: pad(PDF) })).toMatchObject({ ok: true, mime: "application/pdf" });
    expect(validateAttachmentMeta({ name: "error.log", size: 10, head: new TextEncoder().encode("2026 ERROR 한글\n") })).toMatchObject({ ok: true, format: "text" });
    expect(validateAttachmentMeta({ name: "a.txt", size: 10, head: new TextEncoder().encode("hello\r\n\t") }).ok).toBe(true);
  });

  it("거부: 허용 밖 확장자·실행/스크립트/압축·svg·html", () => {
    for (const name of ["a.exe", "a.svg", "a.html", "a.zip", "a.docx", "a.gif", "a.heic", "a.mp4"]) {
      expect(validateAttachmentMeta({ name, size: 100, head: pad(JPEG) }), name).toEqual({ ok: false, code: BOARD_ERRORS.ATTACH_TYPE_NOT_ALLOWED });
    }
  });

  it("거부: 이중 확장자의 어느 구간이든 금지 확장자면 거부", () => {
    expect(validateAttachmentMeta({ name: "a.exe.pdf", size: 100, head: pad(PDF) })).toEqual({ ok: false, code: BOARD_ERRORS.ATTACH_TYPE_NOT_ALLOWED });
    expect(validateAttachmentMeta({ name: "a.pdf.exe", size: 100, head: pad(PDF) }).ok).toBe(false);
  });

  it("거부: 확장자와 내용 불일치(가짜 확장자)·텍스트로 위장한 실행 파일", () => {
    expect(validateAttachmentMeta({ name: "a.png", size: 100, head: pad(JPEG) })).toEqual({ ok: false, code: BOARD_ERRORS.ATTACH_CONTENT_MISMATCH });
    expect(validateAttachmentMeta({ name: "a.pdf", size: 100, head: pad(PNG) }).ok).toBe(false);
    expect(validateAttachmentMeta({ name: "a.txt", size: 100, head: pad([0x4d, 0x5a]) })).toEqual({ ok: false, code: BOARD_ERRORS.ATTACH_CONTENT_MISMATCH });
    expect(validateAttachmentMeta({ name: "a.log", size: 100, head: pad([0x50, 0x4b, 0x03, 0x04]) }).ok).toBe(false);
    expect(validateAttachmentMeta({ name: "a.txt", size: 100, head: bytes(0x41, 0x00, 0x42) }).ok).toBe(false);
    expect(validateAttachmentMeta({ name: "a.jpg", size: 100, head: new TextEncoder().encode("plain text") }).ok).toBe(false);
  });

  it("거부: 크기 초과·빈 파일·이름 문제", () => {
    expect(validateAttachmentMeta({ name: "a.jpg", size: BOARD_ATTACH_MAX_BYTES + 1, head: pad(JPEG) })).toEqual({ ok: false, code: BOARD_ERRORS.ATTACH_TOO_LARGE });
    expect(validateAttachmentMeta({ name: "a.jpg", size: BOARD_ATTACH_MAX_BYTES, head: pad(JPEG) }).ok).toBe(true);
    expect(validateAttachmentMeta({ name: "a.jpg", size: 0, head: pad(JPEG) }).ok).toBe(false);
    expect(validateAttachmentMeta({ name: "noext", size: 10, head: pad(JPEG) })).toEqual({ ok: false, code: BOARD_ERRORS.ATTACH_NAME_INVALID });
    expect(validateAttachmentMeta({ name: "", size: 10, head: pad(JPEG) }).ok).toBe(false);
  });

  it("sanitizeDisplayName: 경로·제어문자·방향 제어문자 제거, 100자 제한, 개인정보 이름은 대체", () => {
    expect(sanitizeDisplayName("C:\\fake\\dir\\사진.jpg")).toBe("사진.jpg");
    expect(sanitizeDisplayName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeDisplayName("a\u202Egpj.exe")).toBe("agpj.exe");
    expect(sanitizeDisplayName("a\u0000b.png")).toBe("ab.png");
    expect(sanitizeDisplayName("010-1234-5678.png", 2)).toBe("첨부2.png");
    expect(sanitizeDisplayName("   ", 1)).toBe("첨부1");
    const long = sanitizeDisplayName(`${"가".repeat(200)}.pdf`);
    expect(long.length).toBe(100);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("건당 개수·합계 한도와 일 총량", () => {
    expect(exceedsAttachLimit(5, 1)).toBeNull();
    expect(exceedsAttachLimit(6, 1)).toBe(BOARD_ERRORS.ATTACH_TOO_MANY);
    expect(exceedsAttachLimit(1, BOARD_ATTACH_MAX_TOTAL_BYTES)).toBeNull();
    expect(exceedsAttachLimit(1, BOARD_ATTACH_MAX_TOTAL_BYTES + 1)).toBe(BOARD_ERRORS.ATTACH_TOO_LARGE);
    expect(exceedsDailyAttachBytes(50 * 1024 * 1024, 50)).toBeNull();
    expect(exceedsDailyAttachBytes(50 * 1024 * 1024 + 1, 50)).toBe(BOARD_ERRORS.ATTACH_TOO_LARGE);
  });
});

describe("감사·사유·2인 승인", () => {
  it("action 은 `대상.동작`(소문자·점·밑줄) 형식이라 앱 감사 표의 형식 CHECK 를 통과한다", () => {
    for (const action of Object.values(BOARD_AUDIT_ACTIONS)) {
      expect(action).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
      expect(BOARD_ACTION_RISK[action]).toBeDefined();
    }
  });

  it("게시판 켜기는 1단계 L2, 2인 승인은 2단계 표시", () => {
    expect(BOARD_ACTION_RISK["board.switch_on"]).toEqual({ level: "L2", twoPersonStage: 2 });
    expect(BOARD_ACTION_RISK["board.switch_off"]).toEqual({ level: "L1" });
  });

  it("사유 1~500자(앞뒤 공백 제거)", () => {
    expect(validateReason("  이유  ")).toEqual({ ok: true, reason: "이유" });
    expect(validateReason("")).toEqual({ ok: false, code: BOARD_ERRORS.REASON_REQUIRED });
    expect(validateReason("   ").ok).toBe(false);
    expect(validateReason(null).ok).toBe(false);
    expect(validateReason("가".repeat(500)).ok).toBe(true);
    expect(validateReason("가".repeat(501)).ok).toBe(false);
  });

  it("승인 만료는 기본 24시간, 범위 1~72 밖이면 기본", () => {
    const t = new Date("2026-11-05T00:00:00Z");
    expect(approvalExpiresAt(t).toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(approvalExpiresAt(t, 72).toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(approvalExpiresAt(t, 73).toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(approvalExpiresAt(t, 0).toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });

  it("승인 판정: 요청자와 같은 사람 거부, 만료 거부, 거절은 사유 필수", () => {
    const now = new Date("2026-11-05T12:00:00Z");
    const expiresAt = new Date("2026-11-06T00:00:00Z");
    const base = { requestedBy: "u1", decidedBy: "u2", expiresAt, now, decision: "APPROVE" as const };
    expect(validateApprovalDecision(base)).toEqual({ ok: true });
    expect(validateApprovalDecision({ ...base, decidedBy: "u1" })).toEqual({ ok: false, code: BOARD_ERRORS.APPROVER_SAME_AS_REQUESTER });
    expect(validateApprovalDecision({ ...base, now: expiresAt })).toEqual({ ok: false, code: BOARD_ERRORS.APPROVAL_EXPIRED });
    expect(validateApprovalDecision({ ...base, decision: "REJECT" })).toEqual({ ok: false, code: BOARD_ERRORS.REASON_REQUIRED });
    expect(validateApprovalDecision({ ...base, decision: "REJECT", decisionReason: "내용이 이상함" })).toEqual({ ok: true });
  });
});

describe("첨부 업로더(canAttachToReply)", () => {
  it("업로더 유형은 STAFF·PLATFORM_ADMIN 둘뿐", () => {
    expect([...BOARD_ATTACH_UPLOADER_KINDS]).toEqual(["STAFF", "PLATFORM_ADMIN"]);
  });

  it("직원은 TENANT 답글에만, 플랫폼 운영자는 PLATFORM 답글에만", () => {
    expect(canAttachToReply("STAFF", "TENANT")).toBe(true);
    expect(canAttachToReply("STAFF", "PLATFORM")).toBe(false);
    expect(canAttachToReply("PLATFORM_ADMIN", "PLATFORM")).toBe(true);
    expect(canAttachToReply("PLATFORM_ADMIN", "TENANT")).toBe(false);
  });
});
