/**
 * 첨부 규칙(2층만, 결정 #34~#49, 설계서 §11). 파일 전체가 아니라 이름·크기·앞부분 바이트만 받는다.
 * EXIF 제거·저장·서명 URL·정리는 공용에 없다(앱, 라이브러리 추가는 별도 승인 #37).
 * detectPii 는 첨부 내용에는 작동하지 않는다 — 「개인정보 가림 확인」 체크와 사후 삭제가 대책이다.
 */
import { BOARD_ERRORS } from "./codes";
import { detectPii } from "./pii";

const MB = 1024 * 1024;

export const BOARD_ATTACH_MAX_COUNT = 5;
/** 파일 1개 4MB(1MB = 1024*1024 바이트). 호스팅 요청 본문 한도(약 4.5MB 추정)보다 작게 둔다. */
export const BOARD_ATTACH_MAX_BYTES = 4 * MB;
/** 글(또는 답글) 1건당 합계 15MB */
export const BOARD_ATTACH_MAX_TOTAL_BYTES = 15 * MB;
export const BOARD_ATTACH_NAME_MAX = 100;
/** 앞부분 바이트 판정에 필요한 최소 길이(앱은 앞 1KB 정도를 읽어 넘긴다) */
export const BOARD_ATTACH_HEAD_BYTES = 1024;

export const BOARD_ATTACH_ALLOWED = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
} as const;
export type BoardAttachExt = keyof typeof BOARD_ATTACH_ALLOWED;

/** 허용 목록 밖은 어차피 거부이므로 이중 안전망. 이중 확장자의 어느 구간에 있어도 거부한다. */
export const BOARD_ATTACH_BLOCKED_EXT = [
  "exe", "bat", "cmd", "ps1", "sh", "js", "vbs", "msi", "dll", "jar", "apk", "scr", "com",
  "html", "htm", "svg", "zip", "7z", "rar",
] as const;

/** 첨부 업로더 유형(첨부 메타 uploaded_by_kind 값). 일반 사용자(USER)는 첨부할 수 없다. */
export const BOARD_ATTACH_UPLOADER_KINDS = ["STAFF", "PLATFORM_ADMIN"] as const;
export type BoardAttachUploaderKind = (typeof BOARD_ATTACH_UPLOADER_KINDS)[number];

/**
 * 어느 답글에 첨부할 수 있는가(2층 답글 단위). 직원(STAFF)은 TENANT 쪽 답글에만, 플랫폼 운영자(PLATFORM_ADMIN)는
 * 자기(PLATFORM) 답글에만. 플랫폼 운영자의 범위는 본인 답글 단위뿐이며 직원 글·답글에는 붙일 수 없다.
 * 운영사 상태(LIMITED 허용, CLOSED 거부)와 삭제·열람 권한은 앱이 판정한다.
 */
export function canAttachToReply(uploaderKind: BoardAttachUploaderKind, replySide: "TENANT" | "PLATFORM"): boolean {
  return (
    (uploaderKind === "STAFF" && replySide === "TENANT") ||
    (uploaderKind === "PLATFORM_ADMIN" && replySide === "PLATFORM")
  );
}

export type AttachFormat = "jpeg" | "png" | "webp" | "pdf" | "text";

export type AttachCheck =
  | { ok: true; ext: BoardAttachExt; mime: string; format: AttachFormat }
  | {
      ok: false;
      code:
        | typeof BOARD_ERRORS.ATTACH_TOO_LARGE
        | typeof BOARD_ERRORS.ATTACH_TYPE_NOT_ALLOWED
        | typeof BOARD_ERRORS.ATTACH_CONTENT_MISMATCH
        | typeof BOARD_ERRORS.ATTACH_NAME_INVALID;
    };

const RTL_AND_INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function fileNameOnly(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * 표시용 이름 정리: 경로 구분자·제어문자·방향 제어문자 제거, 100자 제한(확장자 보존).
 * 이름에 전화번호 등이 걸리면 `첨부N.확장자` 로 대체(index 는 1부터, 기본 1).
 */
export function sanitizeDisplayName(name: string, index = 1): string {
  const cleaned = fileNameOnly(name).replace(CONTROL_CHARS, "").replace(RTL_AND_INVISIBLE, "").trim();
  const ext = extensionOf(cleaned);
  const fallback = `첨부${index}${ext ? `.${ext}` : ""}`;

  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  if (detectPii(cleaned).length > 0) {
    return fallback;
  }
  if (cleaned.length <= BOARD_ATTACH_NAME_MAX) {
    return cleaned;
  }
  const keep = ext ? ext.length + 1 : 0;
  return cleaned.slice(0, BOARD_ATTACH_NAME_MAX - keep) + (ext ? `.${ext}` : "");
}

function startsWith(head: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, i) => head[offset + i] === byte);
}

function sniff(head: Uint8Array): AttachFormat | "unknown-binary" | "text" {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  // 알려진 다른 형식(실행·압축·GIF 등)이 텍스트로 위장하는 경우
  if (
    startsWith(head, [0x4d, 0x5a]) || // MZ (exe/dll)
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || // zip/jar/office
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(head, [0x47, 0x49, 0x46, 0x38]) || // GIF
    startsWith(head, [0x52, 0x61, 0x72, 0x21]) || // rar
    startsWith(head, [0x37, 0x7a, 0xbc, 0xaf])  // 7z
  ) {
    return "unknown-binary";
  }
  // 텍스트: NUL 과 탭·줄바꿈 외 제어 문자가 없어야 한다
  for (const byte of head) {
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)) {
      return "unknown-binary";
    }
  }
  return "text";
}

/**
 * 이름·크기·앞부분 바이트로 허용 여부와 형식을 판정한다. 브라우저가 보낸 Content-Type 은 믿지 않으므로 받지도 않는다.
 * 확장자와 내용(매직 바이트)이 맞아야 한다. txt·log 는 바이너리가 아니면 통과.
 */
export function validateAttachmentMeta(input: { name: string; size: number; head: Uint8Array }): AttachCheck {
  const fileName = fileNameOnly(input.name).replace(CONTROL_CHARS, "").replace(RTL_AND_INVISIBLE, "").trim();
  if (fileName.length === 0 || fileName.length > 255 || !fileName.includes(".")) {
    return { ok: false, code: BOARD_ERRORS.ATTACH_NAME_INVALID };
  }

  const segments = fileName.toLowerCase().split(".").slice(1);
  const ext = segments[segments.length - 1] ?? "";
  if (segments.some((s) => (BOARD_ATTACH_BLOCKED_EXT as readonly string[]).includes(s))) {
    return { ok: false, code: BOARD_ERRORS.ATTACH_TYPE_NOT_ALLOWED };
  }
  if (!Object.prototype.hasOwnProperty.call(BOARD_ATTACH_ALLOWED, ext)) {
    return { ok: false, code: BOARD_ERRORS.ATTACH_TYPE_NOT_ALLOWED };
  }
  const allowedExt = ext as BoardAttachExt;

  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, code: BOARD_ERRORS.ATTACH_CONTENT_MISMATCH };
  }
  if (input.size > BOARD_ATTACH_MAX_BYTES) {
    return { ok: false, code: BOARD_ERRORS.ATTACH_TOO_LARGE };
  }

  const found = sniff(input.head);
  const expected: AttachFormat =
    allowedExt === "jpg" ? "jpeg" : allowedExt === "txt" || allowedExt === "log" ? "text" : allowedExt;

  if (found !== expected) {
    return { ok: false, code: BOARD_ERRORS.ATTACH_CONTENT_MISMATCH };
  }

  return { ok: true, ext: allowedExt, mime: BOARD_ATTACH_ALLOWED[allowedExt], format: expected };
}

/** 건당 개수·합계 한도. count·totalBytes 는 이번 첨부를 「더한 뒤」 값. */
export function exceedsAttachLimit(
  count: number,
  totalBytes: number,
): typeof BOARD_ERRORS.ATTACH_TOO_MANY | typeof BOARD_ERRORS.ATTACH_TOO_LARGE | null {
  if (count > BOARD_ATTACH_MAX_COUNT) {
    return BOARD_ERRORS.ATTACH_TOO_MANY;
  }
  if (totalBytes > BOARD_ATTACH_MAX_TOTAL_BYTES) {
    return BOARD_ERRORS.ATTACH_TOO_LARGE;
  }
  return null;
}

/** 사용자별 하루 첨부 총량. todayBytes 는 이번 첨부를 더한 뒤 값, limitMb 는 설정값(기본 50MB). */
export function exceedsDailyAttachBytes(
  todayBytes: number,
  limitMb: number,
): typeof BOARD_ERRORS.ATTACH_TOO_LARGE | null {
  return todayBytes > limitMb * MB ? BOARD_ERRORS.ATTACH_TOO_LARGE : null;
}
