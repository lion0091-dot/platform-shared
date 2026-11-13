import { normalizeText } from "../ai-guard/normalize";

/**
 * 규칙 A 표시용 순수 함수. 서버 데이터 반환 계층에서 쓴다(화면에서만 가리지 않는다).
 * 계약: 절대 throw 하지 않는다. 형식이 맞지 않는 입력은 **원문을 돌려주지 않고 전부 `*`**(실패 시 닫힘).
 * 빈 값(null/undefined/빈 문자열)은 빈 문자열. `*` 개수는 입력 길이를 따른다(고정 길이 여부는 미결, 설계서 A-D1).
 */

const STAR = "*";
const FALLBACK = "****";
const MAX_INPUT = 200;

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function clean(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_INPUT) return null;
  const s = normalizeText(v).trim();
  return s === "" ? null : s;
}

// ── 이름 ─────────────────────────────────────────────────────
const HANGUL_NAME = /^[가-힣]{1,10}$/;
const LATIN_NAME = /^[\p{L}][\p{L} .'-]{0,59}$/u;

/** 홍길동→홍*동, 남궁민수→남**수, 김수→김*, 가→*. 한글 외 이름(공백·영문)은 첫 글자만 남긴다. */
export function maskName(value: unknown): string {
  if (isBlank(value)) return "";
  const s = clean(value);
  if (s === null) return FALLBACK;
  const chars = Array.from(s);
  if (HANGUL_NAME.test(s)) {
    if (chars.length === 1) return STAR;
    if (chars.length === 2) return chars[0] + STAR;
    return chars[0] + STAR.repeat(chars.length - 2) + chars[chars.length - 1];
  }
  if (LATIN_NAME.test(s)) return chars[0] + STAR.repeat(chars.length - 1);
  return STAR.repeat(Math.min(chars.length, 8));
}

// ── 전화 ─────────────────────────────────────────────────────
interface PhoneParts {
  area: string;
  mid: string;
  last: string;
}

function parsePhone(raw: string): PhoneParts | null {
  if (!/^[+\d][\d\s().-]*$/.test(raw)) return null;
  let d = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) {
    if (!d.startsWith("82")) return null;
    d = "0" + d.slice(2);
  } else if (d.startsWith("82") && d.length >= 11 && d.length <= 12 && !d.startsWith("0")) {
    d = "0" + d.slice(2);
  }
  if (d.length === 8 && /^1[5-9]\d{2}/.test(d)) return { area: "", mid: d.slice(0, 4), last: d.slice(4) }; // 대표번호
  if (!d.startsWith("0") || d.length < 9 || d.length > 11) return null;
  const areaLen = d.startsWith("02") ? 2 : 3;
  const rest = d.slice(areaLen);
  if (rest.length < 7 || rest.length > 8) return null;
  return { area: d.slice(0, areaLen), mid: rest.slice(0, rest.length - 4), last: rest.slice(-4) };
}

/** 010-1234-5678→010-****-5678, 02-123-4567→02-***-4567. 형식 불명이면 전부 `*`. */
export function maskPhone(value: unknown): string {
  if (isBlank(value)) return "";
  const s = clean(value);
  if (s === null) return FALLBACK;
  const p = parsePhone(s);
  if (!p) return FALLBACK;
  if (p.area === "") return `${STAR.repeat(4)}-${p.last}`;
  return `${p.area}-${STAR.repeat(p.mid.length)}-${p.last}`;
}

// ── 주소 ─────────────────────────────────────────────────────
export interface StructuredAddress {
  /** 시·도 + 시·군·구까지(상세 제외). */
  region: string;
  detail?: string;
}

const REGION_OK = /^[가-힣A-Za-z0-9 .·()-]{1,60}$/;

/**
 * 구조화 주소: region 만 남기고 상세는 `***`. 한 줄 주소: 앞 두 어절만 남기고 이하 `***`(어절이 2개 이하이면 전부 `***`).
 * 주소 감지기가 아니다 — 입력이 «주소인가» 는 판단하지 않는다.
 */
export function maskAddress(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const r = clean((value as { region?: unknown }).region);
    if (r === null || !REGION_OK.test(r)) return FALLBACK;
    return `${r} ***`;
  }
  if (isBlank(value)) return "";
  const s = clean(value);
  if (s === null) return FALLBACK;
  const words = s.split(/\s+/);
  if (words.length <= 2) return "***";
  return `${words[0]} ${words[1]} ***`;
}

// ── 계좌 ─────────────────────────────────────────────────────
/** 뒤 4자리만 남긴다: 110-123-456789→***-***-**6789. 숫자 8자리 미만·글자 섞임은 전부 `*`. */
export function maskAccount(value: unknown): string {
  if (isBlank(value)) return "";
  const s = clean(value);
  if (s === null) return FALLBACK;
  if (!/^[\d -]+$/.test(s)) return FALLBACK;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 20) return FALLBACK;
  let seen = 0;
  const total = digits.length;
  let out = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") {
      seen++;
      out += total - seen < 4 ? ch : STAR;
    } else out += ch === " " ? "-" : ch;
  }
  return out;
}

// ── 평문 허용 컨텍스트 ────────────────────────────────────────
export type DisplaySurface = "LIST" | "SEARCH" | "EXPORT" | "AUDIT_VIEW" | "INCIDENT_VIEW" | "DETAIL" | "DOCUMENT";
export type BasisKind = "ACTIVE_ORDER" | "SELF" | "DOCUMENT";

export type PlainBasis =
  | {
      kind: "ACTIVE_ORDER";
      orderId: string;
      /** 앱 서버가 계산: 진행 중이면 "IN_PROGRESS", 종료면 완료·취소 확정 시각의 서울 날짜. */
      phase: "IN_PROGRESS" | { endedOn: string };
      /** 앱 서버 시계의 서울 날짜(YYYY-MM-DD). 모듈은 시계를 읽지 않는다. */
      todayKst: string;
      /** 종료 후 평문 허용 일수를 줄일 때만(1~30). 늘릴 수 없다. */
      windowDays?: number;
    }
  | { kind: "SELF" }
  | { kind: "DOCUMENT"; docType: string };

export interface DisplayContext {
  surface: DisplaySurface;
  basis?: PlainBasis;
}

export interface DisplayDecision {
  mode: "plain" | "masked";
  /** 평문일 때만: 어떤 근거였는지(값·주문 id 는 담지 않는다). */
  basisKind?: BasisKind;
}

/** 종료 후 평문 허용 일수(개발자 확정: 30일). 경과일 < 30 이면 평문, 30일째부터 마스킹. */
export const PLAIN_WINDOW_DAYS = 30;

const MASK_SURFACES: ReadonlySet<string> = new Set(["LIST", "SEARCH", "EXPORT", "AUDIT_VIEW", "INCIDENT_VIEW"]);
const DOC_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 달력 날짜 YYYY-MM-DD → 일 수(UTC 자정 기준). 형식·달력이 틀리면 null. */
export function dayNumber(date: unknown): number | null {
  if (typeof date !== "string") return null;
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86_400_000;
}

function activeOrderAllows(b: Extract<PlainBasis, { kind: "ACTIVE_ORDER" }>): boolean {
  if (typeof b.orderId !== "string" || b.orderId === "") return false;
  const today = dayNumber(b.todayKst);
  if (today === null) return false;
  const phase = b.phase;
  if (phase === "IN_PROGRESS") return true;
  if (typeof phase !== "object" || phase === null) return false;
  const ended = dayNumber((phase as { endedOn?: unknown }).endedOn);
  if (ended === null || ended > today) return false;
  let win = PLAIN_WINDOW_DAYS;
  if (b.windowDays !== undefined) {
    if (typeof b.windowDays !== "number" || !Number.isInteger(b.windowDays) || b.windowDays < 1) return false;
    win = Math.min(b.windowDays, PLAIN_WINDOW_DAYS);
  }
  return today - ended < win;
}

/** 평문을 보여도 되는지만 판정한다(근거의 사실 여부는 앱 서버가 검증한 결과를 받는다). 어떤 이상 입력도 `masked`. */
export function decideDisplay(ctx: unknown): DisplayDecision {
  try {
    if (typeof ctx !== "object" || ctx === null) return { mode: "masked" };
    const { surface, basis } = ctx as { surface?: unknown; basis?: unknown };
    if (typeof surface !== "string" || MASK_SURFACES.has(surface)) return { mode: "masked" };
    if (typeof basis !== "object" || basis === null) return { mode: "masked" };
    const b = basis as PlainBasis;
    if (surface === "DETAIL") {
      if (b.kind === "ACTIVE_ORDER" && activeOrderAllows(b)) return { mode: "plain", basisKind: "ACTIVE_ORDER" };
      if (b.kind === "SELF") return { mode: "plain", basisKind: "SELF" };
      return { mode: "masked" };
    }
    if (surface === "DOCUMENT") {
      if (b.kind === "DOCUMENT" && typeof b.docType === "string" && DOC_TYPE_RE.test(b.docType)) return { mode: "plain", basisKind: "DOCUMENT" };
      return { mode: "masked" };
    }
    return { mode: "masked" };
  } catch {
    return { mode: "masked" };
  }
}

export interface DisplayText extends DisplayDecision {
  text: string;
}

function show(value: unknown, ctx: unknown, mask: (v: unknown) => string, valid: (s: string) => boolean): DisplayText {
  const d = decideDisplay(ctx);
  if (d.mode === "plain" && typeof value === "string" && !isBlank(value)) {
    const s = clean(value);
    // 형식이 맞는 값만 평문. 맞지 않으면 근거가 있어도 원문을 돌려주지 않고 전부 `*`.
    if (s !== null && valid(s)) return { ...d, text: value };
    return { mode: "masked", text: FALLBACK };
  }
  return { mode: "masked", text: mask(value) };
}

const validName = (s: string): boolean => HANGUL_NAME.test(s) || LATIN_NAME.test(s);
const validPhone = (s: string): boolean => parsePhone(s) !== null;
const validAddress = (s: string): boolean => s.length <= 200 && !/[\u0000-\u001f]/.test(s);
const validAccount = (s: string): boolean => /^[\d -]+$/.test(s) && s.replace(/\D/g, "").length >= 8 && s.replace(/\D/g, "").length <= 20;

export function displayName(value: unknown, ctx: unknown): DisplayText {
  return show(value, ctx, maskName, validName);
}
export function displayPhone(value: unknown, ctx: unknown): DisplayText {
  return show(value, ctx, maskPhone, validPhone);
}
export function displayAddress(value: unknown, ctx: unknown): DisplayText {
  return show(value, ctx, (v) => maskAddress(v), (s) => validAddress(s));
}
export function displayAccount(value: unknown, ctx: unknown): DisplayText {
  return show(value, ctx, maskAccount, validAccount);
}
