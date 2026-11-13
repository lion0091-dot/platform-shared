import {
  compileAddressCues,
  compileMarkers,
  countAddressCues,
  detectAccountAndRuns,
  detectBizno,
  detectCard,
  detectEmail,
  detectPersonCueBefore,
  detectPersonTitleAfter,
  detectPhone,
  detectResidentId,
  detectSecretLike,
  type Candidate,
  type Markers,
} from "../ai-guard/detectors";
import { normalizeWithMap } from "../ai-guard/normalize";

/**
 * 자유 문장 저장 시 자동 가림(규칙 B). 순수·동기·의존성 0. 절대 throw 하지 않는다.
 *
 * - 주민(외국인)등록번호·전화·카드·계좌 패턴을 «저장하기 전에» 가려서 돌려준다. 원문은 어디에도 남기지 않고, 복원 수단이 없다.
 * - 금액·날짜·소수·주문번호 같은 숫자 표기는 바꾸지 않는다(탐지 층은 ai-guard 와 공유).
 * - 이름·주소는 가리지 않고 «경고 코드(건수)» 만 준다. 한글로 풀어 쓴 숫자도 경고만.
 * - 문장의 나머지는 입력 그대로다(정규화 결과가 아니라 원문 위에 가린 구간만 치환, 대응표 사용).
 * - 실패(길이 초과 등)하면 원문을 돌려주지 않는다 — 앱은 저장을 거부해야 한다.
 */

export const FREE_TEXT_RULES_VERSION = "free-text-rules/1";
export const FREE_TEXT_MAX_CHARS = 20000;

export type MaskedKind = "RESIDENT_ID" | "CARD" | "PHONE" | "ACCOUNT" | "EMAIL" | "BIZNO" | "SECRET_LIKE";
export type ExtraKind = "EMAIL" | "BIZNO" | "SECRET_LIKE";
export type WarningCode = "NAME_CUE" | "ADDRESS_CUE" | "SPELLED_DIGITS" | "LONG_DIGITS";

export interface FreeTextWarning {
  readonly code: WarningCode;
  readonly count: number;
}

export type FreeTextFailure = "TOO_LONG" | "NOT_TEXT" | "INTERNAL" | "INVALID_POLICY";

export type FreeTextResult =
  | {
      readonly ok: true;
      /** 가린 문장(저장할 값). */
      readonly text: string;
      /** 가려진 종류(중복 없음, 고정 순서). 감사 메타. */
      readonly maskedKinds: readonly MaskedKind[];
      readonly counts: Readonly<Partial<Record<MaskedKind, number>>>;
      readonly warnings: readonly FreeTextWarning[];
      readonly rulesVersion: string;
    }
  | { readonly ok: false; readonly reason: FreeTextFailure; readonly rulesVersion: string };

export interface FreeTextPolicy {
  /** 감사용 이름(안전 문자만). */
  readonly policyId?: string;
  /** 기본 4종 밖에서 더 가릴 종류. 기본 4종은 끌 수 없다. */
  readonly extraKinds?: readonly ExtraKind[];
  readonly extraNameCues?: readonly string[];
  readonly extraAddressCues?: readonly string[];
  /** 이 단서 바로 뒤의 «구분 없는 긴 숫자»는 계좌로 보지 않는다(주문번호·운송장 등). 기본 목록에 더한다. */
  readonly numberCueExemptions?: readonly string[];
  /** 호칭(님·씨) 앞 이름 후보도 경고에 넣는다. 기본 꺼짐(오탐이 많음). */
  readonly nameTitleWarnings?: boolean;
  /** 입력 상한(줄이기만 가능). */
  readonly maxChars?: number;
}

/** 번호 뒤에 «구분 없는 10~16자리 숫자» 가 와도 계좌로 보지 않는 기본 단서어. */
export const DEFAULT_NUMBER_CUE_EXEMPTIONS: readonly string[] = ["주문번호", "운송장번호", "운송장", "송장번호", "송장", "접수번호", "배차번호", "관리번호", "문서번호", "추적번호"];

const PRIORITY: readonly MaskedKind[] = ["SECRET_LIKE", "RESIDENT_ID", "CARD", "EMAIL", "PHONE", "BIZNO", "ACCOUNT"];
const ORDER: readonly MaskedKind[] = ["RESIDENT_ID", "CARD", "PHONE", "ACCOUNT", "EMAIL", "BIZNO", "SECRET_LIKE"];
const LABEL: Readonly<Record<MaskedKind, string>> = {
  RESIDENT_ID: "[주민번호]",
  CARD: "[카드]",
  PHONE: "[전화]",
  ACCOUNT: "[계좌]",
  EMAIL: "[이메일]",
  BIZNO: "[사업자번호]",
  SECRET_LIKE: "[비밀값]",
};
const BASE_KINDS: readonly MaskedKind[] = ["RESIDENT_ID", "CARD", "PHONE", "ACCOUNT"];
const POLICY_ID_RE = /^[a-z0-9_.:-]{1,48}$/;
const SPELLED_RE = /(?:[공영일이삼사오육칠팔구] ?){9,}/g;
const MAX_PASSES = 3;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(reason: FreeTextFailure): FreeTextResult {
  return { ok: false, reason, rulesVersion: FREE_TEXT_RULES_VERSION };
}

function strList(v: unknown): readonly string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) return null;
  for (const s of v) if (typeof s !== "string" || s.length < 1 || s.length > 20 || /\s{2,}/.test(s)) return null;
  return [...(v as string[])];
}

interface Compiled {
  policyId: string;
  enabled: ReadonlySet<MaskedKind>;
  markers: Markers;
  addressRe: RegExp;
  exemptRe: RegExp;
  titleWarnings: boolean;
  maxChars: number;
}

function compile(policy: unknown): Compiled | null {
  if (policy !== undefined && (typeof policy !== "object" || policy === null || Array.isArray(policy))) return null;
  const p = (policy ?? {}) as FreeTextPolicy;
  const policyId = p.policyId ?? "default";
  if (typeof policyId !== "string" || !POLICY_ID_RE.test(policyId)) return null;

  const extra = p.extraKinds ?? [];
  if (!Array.isArray(extra) || extra.some((k) => k !== "EMAIL" && k !== "BIZNO" && k !== "SECRET_LIKE")) return null;

  const nameCues = strList(p.extraNameCues);
  const addrCues = strList(p.extraAddressCues);
  const exempt = strList(p.numberCueExemptions);
  if (!nameCues || !addrCues || !exempt) return null;
  if (p.nameTitleWarnings !== undefined && typeof p.nameTitleWarnings !== "boolean") return null;

  let maxChars = FREE_TEXT_MAX_CHARS;
  if (p.maxChars !== undefined) {
    if (typeof p.maxChars !== "number" || !Number.isInteger(p.maxChars) || p.maxChars < 1) return null;
    maxChars = Math.min(p.maxChars, FREE_TEXT_MAX_CHARS); // 줄이기만 가능
  }

  const cues = [...DEFAULT_NUMBER_CUE_EXEMPTIONS, ...exempt].sort((a, b) => b.length - a.length).map(esc);
  return {
    policyId,
    enabled: new Set<MaskedKind>([...BASE_KINDS, ...(extra as ExtraKind[])]),
    markers: compileMarkers([], nameCues),
    addressRe: compileAddressCues(addrCues),
    exemptRe: new RegExp(`(?:${cues.join("|")}) {0,2}[:#]? {0,2}$`),
    titleWarnings: p.nameTitleWarnings === true,
    maxChars,
  };
}

interface Group {
  start: number;
  end: number;
  kinds: Set<MaskedKind>;
  kind: MaskedKind;
}

const isPlainDigits = (s: string): boolean => /^\d+$/.test(s);

function collect(text: string, c: Compiled): { groups: Group[]; exempted: number } {
  const cands: Candidate[] = [];
  detectSecretLike(text, cands);
  detectResidentId(text, cands);
  detectEmail(text, cands); // 꺼져 있어도 «흡수» 용도로 돌린다(이메일 안의 숫자가 계좌로 오인되지 않게)
  detectCard(text, cands);
  detectPhone(text, cands);
  detectBizno(text, cands);
  detectAccountAndRuns(text, cands);

  const strong = cands.filter((x) => x.kind === "RESIDENT_ID" || x.kind === "CARD" || x.kind === "PHONE" || x.kind === "EMAIL");
  const biz = cands.filter((x) => x.kind === "BIZNO");
  let exempted = 0;
  const kept = cands.filter((x) => {
    if (x.kind === "ACCOUNT" || x.kind === "BIZNO") {
      if (strong.some((s) => s.start <= x.start && x.end <= s.end)) return false;
    }
    if (x.kind === "ACCOUNT") {
      if (biz.some((s) => s.start <= x.start && x.end <= s.end)) return false;
      // 구분 없는 긴 숫자가 주문번호·운송장 단서 바로 뒤에 있으면 계좌로 보지 않는다(주민·카드·전화·하이픈 계좌는 면제 불가).
      const raw = text.slice(x.start, x.end);
      // 영문·밑줄 바로 뒤의 숫자열(A1234567890 같은 코드)도 계좌로 보지 않는다.
      if (isPlainDigits(raw) && (/[A-Za-z_]/.test(text[x.start - 1] ?? "") || c.exemptRe.test(text.slice(Math.max(0, x.start - 14), x.start)))) {
        exempted++;
        return false;
      }
    }
    return true;
  });
  kept.sort((a, b) => a.start - b.start || b.end - a.end);

  const groups: Group[] = [];
  for (const x of kept) {
    const kind = x.kind as MaskedKind;
    const g = groups[groups.length - 1];
    if (g && x.start < g.end) {
      g.end = Math.max(g.end, x.end);
      g.kinds.add(kind);
    } else {
      groups.push({ start: x.start, end: x.end, kinds: new Set([kind]), kind });
    }
  }
  const out: Group[] = [];
  for (const g of groups) {
    const on = PRIORITY.filter((k) => g.kinds.has(k) && c.enabled.has(k));
    if (on.length === 0) continue; // 꺼진 종류(예: 사업자번호)만 있는 구간은 건드리지 않는다
    g.kind = on[0]!;
    out.push(g);
  }
  return { groups: out, exempted };
}

interface Pass {
  text: string;
  counts: Partial<Record<MaskedKind, number>>;
  warnings: Record<WarningCode, number>;
}

function onePass(raw: string, c: Compiled, first: boolean): Pass {
  const nm = normalizeWithMap(raw, { collapseWhitespace: true });
  const { groups, exempted } = collect(nm.text, c);

  const counts: Partial<Record<MaskedKind, number>> = {};
  const warnings: Record<WarningCode, number> = { NAME_CUE: 0, ADDRESS_CUE: 0, SPELLED_DIGITS: 0, LONG_DIGITS: 0 };

  if (first) {
    const names: Candidate[] = [];
    detectPersonCueBefore(nm.text, c.markers, names);
    if (c.titleWarnings) detectPersonTitleAfter(nm.text, c.markers, names);
    warnings.NAME_CUE = names.length;
    warnings.ADDRESS_CUE = countAddressCues(nm.text, c.addressRe);
    SPELLED_RE.lastIndex = 0;
    warnings.SPELLED_DIGITS = (nm.text.match(SPELLED_RE) ?? []).length;
    warnings.LONG_DIGITS = exempted;
  }

  // 정규화 구간 → 원문 구간. 같은 원문 글자(NFKC 확장)에 걸친 구간은 합친다.
  const ranges: Array<{ s: number; e: number; kind: MaskedKind }> = [];
  for (const g of groups) {
    const s = nm.starts[g.start]!;
    const e = nm.ends[g.end - 1]!;
    const last = ranges[ranges.length - 1];
    if (last && s < last.e) {
      last.e = Math.max(last.e, e);
      if (PRIORITY.indexOf(g.kind) < PRIORITY.indexOf(last.kind)) last.kind = g.kind;
    } else ranges.push({ s, e, kind: g.kind });
  }

  let out = "";
  let pos = 0;
  for (const r of ranges) {
    out += raw.slice(pos, r.s) + LABEL[r.kind];
    pos = r.e;
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  }
  out += raw.slice(pos);
  return { text: out, counts, warnings };
}

function run(input: unknown, c: Compiled): FreeTextResult {
  if (input === null || input === undefined) return okResult("", {}, {});
  if (typeof input !== "string") return fail("NOT_TEXT");
  if (input.length > c.maxChars) return fail("TOO_LONG");
  if (input === "") return okResult("", {}, {});

  const total: Partial<Record<MaskedKind, number>> = {};
  let warnings: Record<WarningCode, number> | null = null;
  let text = input;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const r = onePass(text, c, pass === 0);
    if (pass === 0) warnings = r.warnings;
    const changed = r.text !== text;
    for (const [k, n] of Object.entries(r.counts) as Array<[MaskedKind, number]>) total[k] = (total[k] ?? 0) + n;
    text = r.text;
    if (!changed) return okResult(text, total, warnings ?? {});
  }
  // 세 번을 돌려도 계속 바뀌면 안전하게 끝났다고 볼 수 없다 → 저장 거부(원문 미반환).
  return fail("INTERNAL");
}

function okResult(text: string, counts: Partial<Record<MaskedKind, number>>, w: Partial<Record<WarningCode, number>>): FreeTextResult {
  const maskedKinds = ORDER.filter((k) => (counts[k] ?? 0) > 0);
  const order: WarningCode[] = ["NAME_CUE", "ADDRESS_CUE", "SPELLED_DIGITS", "LONG_DIGITS"];
  const warnings: FreeTextWarning[] = order.filter((code) => (w[code] ?? 0) > 0).map((code) => ({ code, count: w[code]! }));
  return Object.freeze({
    ok: true as const,
    text,
    maskedKinds: Object.freeze(maskedKinds),
    counts: Object.freeze({ ...counts }),
    warnings: Object.freeze(warnings),
    rulesVersion: FREE_TEXT_RULES_VERSION,
  });
}

export type FreeTextMasker = (text: string | null | undefined) => FreeTextResult;

/**
 * 정책을 검증·복사·동결한 마스커를 만든다. 만든 뒤 정책 객체를 바꿔도 마스커는 달라지지 않는다.
 * 잘못된 정책이면 { ok:false }.
 */
export function createFreeTextMasker(policy?: FreeTextPolicy): { ok: true; mask: FreeTextMasker; policyId: string } | { ok: false; reason: "INVALID_POLICY" } {
  let c: Compiled | null = null;
  try {
    c = compile(policy);
  } catch {
    c = null;
  }
  if (!c) return { ok: false, reason: "INVALID_POLICY" };
  const frozen = c;
  const mask: FreeTextMasker = (text) => {
    try {
      return run(text, frozen);
    } catch {
      return fail("INTERNAL");
    }
  };
  return { ok: true, mask, policyId: frozen.policyId };
}

let defaultMasker: FreeTextMasker | null = null;

/** 편의 함수. 옵션 없이 부르면 기본 정책(4종, 상한 20,000자)을 쓴다. 잘못된 옵션이면 INVALID_POLICY. */
export function maskFreeText(text: string | null | undefined, options?: FreeTextPolicy): FreeTextResult {
  try {
    if (options === undefined) {
      if (!defaultMasker) {
        const m = createFreeTextMasker();
        if (!m.ok) return fail("INVALID_POLICY");
        defaultMasker = m.mask;
      }
      return defaultMasker(text);
    }
    const m = createFreeTextMasker(options);
    return m.ok ? m.mask(text) : fail("INVALID_POLICY");
  } catch {
    return fail("INTERNAL");
  }
}
