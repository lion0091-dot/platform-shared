import { describe, expect, it } from "vitest";
import {
  BOARD_AUTHOR_KINDS,
  BOARD_ERRORS,
  BOARD_ERROR_LABELS,
  BOARD_LABEL_FALLBACK,
  BOARD_PII_KIND_LABELS,
  BOARD_REPLY_VISIBILITIES,
  BOARD_REPLY_VISIBILITY_LABELS,
  BOARD_STATUS_LABELS,
  BOARD_TIER1_CATEGORIES,
  BOARD_TIER1_CATEGORY_LABELS,
  BOARD_TIER2_CATEGORIES,
  BOARD_TIER2_CATEGORY_LABELS,
  BOARD_TIER2_STATUSES,
  BOARD_VIEWER_KINDS,
  BOARD_AUTHOR_KIND_LABELS,
  BOARD_VIEWER_KIND_LABELS,
  boardCategoryLabel,
  boardErrorLabel,
  boardPiiKindLabel,
  boardStatusLabel,
  boardVisibilityLabel,
} from "./board";
import { GUARD_KINDS, GUARD_KIND_LABELS, GUARD_REASONS, GUARD_REASON_LABELS, GUARD_WARNING_LABELS, guardKindLabel, guardReasonLabel, guardWarningLabel } from "./ai-guard";
import { AI_ERROR_CODE_LABELS, AI_RESERVE_CODES, AI_RESERVE_CODE_LABELS, aiErrorLabel, aiReserveLabel } from "./ai-shared-key/types";
import { UNMASK_ERROR_LABELS, unmaskErrorLabel } from "./pii-display";
import { FREE_TEXT_FAILURE_LABELS, FREE_TEXT_MASKED_KIND_LABELS, FREE_TEXT_WARNING_LABELS, freeTextFailureLabel, freeTextMaskedKindLabel, freeTextWarningLabel } from "./free-text";

/** 널리 쓰는 고유명·형식 이름만 영어로 허용한다. */
const ALLOWED_ASCII = ["AI", "MB", "pdf", "txt", "log", "jpg", "png", "webp", "UUID", "RPC", "PG", "SSO", "QR", "GPS"];

function englishLeft(text: string): string[] {
  let t = text;
  for (const a of ALLOWED_ASCII) t = t.split(a).join(" ");
  return t.match(/[A-Za-z_]{2,}/g) ?? [];
}

const TABLES: Record<string, Readonly<Record<string, string>>> = {
  BOARD_ERROR_LABELS,
  BOARD_TIER1_CATEGORY_LABELS,
  BOARD_TIER2_CATEGORY_LABELS,
  BOARD_STATUS_LABELS,
  BOARD_AUTHOR_KIND_LABELS,
  BOARD_VIEWER_KIND_LABELS,
  BOARD_REPLY_VISIBILITY_LABELS,
  BOARD_PII_KIND_LABELS,
  GUARD_REASON_LABELS,
  GUARD_KIND_LABELS,
  GUARD_WARNING_LABELS,
  AI_RESERVE_CODE_LABELS,
  AI_ERROR_CODE_LABELS,
  UNMASK_ERROR_LABELS,
  FREE_TEXT_WARNING_LABELS,
  FREE_TEXT_FAILURE_LABELS,
  FREE_TEXT_MASKED_KIND_LABELS,
};

function keys(t: Readonly<Record<string, string>>): string[] {
  return Object.keys(t).sort();
}

describe("한글 라벨 표: 코드마다 라벨이 있다(누락 0)", () => {
  it("게시판", () => {
    expect(keys(BOARD_ERROR_LABELS)).toEqual(Object.values(BOARD_ERRORS).sort());
    expect(keys(BOARD_TIER1_CATEGORY_LABELS)).toEqual([...BOARD_TIER1_CATEGORIES].sort());
    expect(keys(BOARD_TIER2_CATEGORY_LABELS)).toEqual([...BOARD_TIER2_CATEGORIES].sort());
    expect(keys(BOARD_STATUS_LABELS)).toEqual(["NONE", ...BOARD_TIER2_STATUSES].sort());
    expect(keys(BOARD_AUTHOR_KIND_LABELS)).toEqual([...BOARD_AUTHOR_KINDS].sort());
    expect(keys(BOARD_VIEWER_KIND_LABELS)).toEqual([...BOARD_VIEWER_KINDS].sort());
    expect(keys(BOARD_REPLY_VISIBILITY_LABELS)).toEqual([...BOARD_REPLY_VISIBILITIES].sort());
    expect(keys(BOARD_PII_KIND_LABELS)).toEqual(["ACCOUNT", "EMAIL", "PHONE", "RESIDENT_ID"]);
  });

  it("ai-guard·ai-shared-key", () => {
    expect(keys(GUARD_REASON_LABELS)).toEqual([...GUARD_REASONS].sort());
    expect(keys(GUARD_KIND_LABELS)).toEqual([...GUARD_KINDS].sort());
    expect(keys(GUARD_WARNING_LABELS)).toEqual(["ADDRESS_CUE"]);
    expect(keys(AI_RESERVE_CODE_LABELS)).toEqual([...AI_RESERVE_CODES, "READ_FAILED"].sort());
    expect(keys(AI_ERROR_CODE_LABELS)).toEqual(["AI_CREDENTIAL_INVALID", "AI_LIMIT_INVALID", "FORBIDDEN_KEY", "NOT_FOUND", "PLATFORM_INVALID", "REASON_REQUIRED", "RPC_FAILED"]);
  });

  it("pii-display·free-text", () => {
    expect(keys(UNMASK_ERROR_LABELS)).toEqual(["BATCH_NOT_ALLOWED", "FAILED", "INVALID_REQUEST", "NOT_ALLOWED", "REASON_REQUIRED", "REASON_UNKNOWN", "RECENT_LOGIN_REQUIRED"]);
    expect(keys(FREE_TEXT_WARNING_LABELS)).toEqual(["ADDRESS_CUE", "LONG_DIGITS", "NAME_CUE", "SPELLED_DIGITS"]);
    expect(keys(FREE_TEXT_FAILURE_LABELS)).toEqual(["INTERNAL", "INVALID_POLICY", "NOT_TEXT", "TOO_LONG"]);
    expect(keys(FREE_TEXT_MASKED_KIND_LABELS)).toEqual(["ACCOUNT", "BIZNO", "CARD", "EMAIL", "PHONE", "RESIDENT_ID", "SECRET_LIKE"]);
  });
});

describe("한글 라벨 표: 영어 코드가 섞이지 않고 한글을 포함한다", () => {
  for (const [name, table] of Object.entries(TABLES)) {
    it(name, () => {
      for (const [code, text] of Object.entries(table)) {
        expect(text, `${name}.${code}`).toMatch(/[가-힣]/);
        expect(englishLeft(text), `${name}.${code}: ${text}`).toEqual([]);
        expect(text.includes(code) && /^[A-Z_]+$/.test(code), `${name}.${code} 라벨에 코드가 그대로 있음`).toBe(false);
      }
    });
  }

  it("모르는 코드용 일반 문구도 한글", () => {
    expect(BOARD_LABEL_FALLBACK).toMatch(/[가-힣]/);
    for (const text of [
      boardErrorLabel("???"), boardStatusLabel("???"), boardCategoryLabel("???"), boardPiiKindLabel("???"), boardVisibilityLabel("???"),
      guardReasonLabel("???"), guardKindLabel("???"), guardWarningLabel("???"),
      aiReserveLabel("???"), aiErrorLabel("???"), unmaskErrorLabel("???"),
      freeTextWarningLabel("???"), freeTextFailureLabel("???"), freeTextMaskedKindLabel("???"),
    ]) {
      expect(text).toMatch(/[가-힣]/);
      expect(englishLeft(text)).toEqual([]);
    }
  });
});

describe("getter: 덮어쓰기·안전한 폴백", () => {
  it("overrides 로 일부만 덮어쓰고 표 자체는 바뀌지 않는다", () => {
    const before = BOARD_ERROR_LABELS.NOT_AUTHORIZED;
    expect(boardErrorLabel("NOT_AUTHORIZED", { NOT_AUTHORIZED: "권한이 없어요." })).toBe("권한이 없어요.");
    expect(boardErrorLabel("NOT_AUTHORIZED")).toBe(before);
    expect(boardErrorLabel("NOT_AUTHORIZED", { NOT_AUTHORIZED: "" })).toBe(before);
    expect(boardStatusLabel("DONE", { DONE: "끝" })).toBe("끝");
    expect(unmaskErrorLabel("FAILED", { FAILED: "실패" })).toBe("실패");
  });

  it("객체 프로토타입 이름·비문자열 입력도 폴백(코드가 새지 않는다)", () => {
    for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", 1, null, undefined, {}]) {
      expect(boardErrorLabel(bad)).toBe(BOARD_LABEL_FALLBACK);
      expect(guardReasonLabel(bad)).toMatch(/[가-힣]/);
      expect(aiReserveLabel(bad)).toMatch(/[가-힣]/);
      expect(unmaskErrorLabel(bad)).toMatch(/[가-힣]/);
      expect(freeTextWarningLabel(bad)).toMatch(/[가-힣]/);
    }
    expect(boardErrorLabel("x", { constructor: "가짜" } as unknown as Record<string, string>)).toBe(BOARD_LABEL_FALLBACK);
  });

  it("UNKNOWN 예약 코드는 일반 안내", () => {
    expect(aiReserveLabel("UNKNOWN")).toBe("AI 기능을 지금 사용할 수 없습니다.");
    expect(aiReserveLabel("LIMIT_EXCEEDED")).toBe(AI_RESERVE_CODE_LABELS.LIMIT_EXCEEDED);
  });

  it("분류 getter 는 1층·2층 모두", () => {
    expect(boardCategoryLabel("QUESTION")).toBe("문의");
    expect(boardCategoryLabel("BUG")).toBe("오류");
  });
});
