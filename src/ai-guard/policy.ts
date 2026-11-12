import { compileMarkers, type Markers } from "./detectors";
import { normalizeText } from "./normalize";
import {
  GUARD_KINDS,
  HARD_KINDS,
  type ExtraDetector,
  type FieldSpec,
  type GuardKind,
  type GuardLevel,
  type GuardPolicy,
  type KindMode,
} from "./types";

/** 종류별 기본 처리. ORG·PERSON 의 «의심» 스팬은 level 에 따라 STRICT=BLOCK / STANDARD=MASK (guard.ts). */
export const DEFAULT_MODES: Readonly<Record<GuardKind, KindMode>> = {
  RESIDENT_ID: "MASK",
  BIZNO: "MASK",
  PHONE: "MASK",
  ACCOUNT: "MASK",
  EMAIL: "MASK",
  CARD: "MASK",
  ORG: "MASK",
  PERSON: "MASK",
  ADDRESS: "MASK",
  PLATE: "OFF",
  SECRET_LIKE: "BLOCK",
  KNOWN: "MASK",
};

/** 토큰 접두. 토큰 모양은 항상 `[PREFIX_n]` (PREFIX 는 [A-Z]+). */
export const TOKEN_PREFIX: Readonly<Record<GuardKind, string>> = {
  RESIDENT_ID: "RRN",
  BIZNO: "BIZ",
  PHONE: "PHONE",
  ACCOUNT: "ACCT",
  EMAIL: "EMAIL",
  CARD: "CARD",
  ORG: "ORG",
  PERSON: "PERSON",
  ADDRESS: "ADDR",
  PLATE: "PLATE",
  SECRET_LIKE: "SECRET",
  KNOWN: "KNOWN",
};
export const PREFIX_KIND: ReadonlyMap<string, GuardKind> = new Map(
  (Object.entries(TOKEN_PREFIX) as [GuardKind, string][]).map(([k, v]) => [v, k]),
);

export interface Term {
  norm: string;
  kind: GuardKind;
  key: string;
}

/** 컴파일 시점에 복사해 얼린 정책 값(보강 ⑤). 정책 객체를 나중에 바꿔도 이미 컴파일된 규칙은 달라지지 않는다. */
export interface PolicySnapshot {
  readonly policyId: string;
  readonly level: GuardLevel;
  readonly maxCharsPerField: number;
  readonly maxCharsTotal: number;
  readonly maxReplacements: number;
}

export interface Compiled {
  policy: PolicySnapshot;
  modes: Record<GuardKind, KindMode>;
  restorable: ReadonlySet<GuardKind>;
  fieldMap: ReadonlyMap<string, FieldSpec>;
  unknownKeys: "DROP" | "BLOCK";
  collision: "ESCAPE" | "BLOCK";
  markers: Markers;
  termIndex: ReadonlyMap<string, readonly Term[]>;
  extra: readonly ExtraDetector[];
}

export class PolicyError extends Error {}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
export const isForbiddenKey = (k: string): boolean => FORBIDDEN.has(k);

const KIND_SET: ReadonlySet<string> = new Set(GUARD_KINDS);
const MODE_SET: ReadonlySet<string> = new Set(["MASK", "BLOCK", "PASS", "OFF"]);
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,40}(\[\])?$/;
const POLICY_ID_RE = /^[a-z0-9_.:-]{1,48}$/;

export const LIMITS = {
  maxFields: 200,
  maxTerms: 20000,
  maxMarkers: 200,
  maxDetectors: 10,
  maxPerField: 20000,
  maxTotal: 100000,
  maxReplacements: 5000,
  maxDepth: 8,
  maxLeaves: 500,
  maxArray: 200,
  maxDetectorSpans: 500,
} as const;

function fail(msg: string): never {
  throw new PolicyError(msg);
}
function isPosInt(n: unknown, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max;
}
function strList(v: unknown, what: string): readonly string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > LIMITS.maxMarkers) fail(what);
  for (const s of v) if (typeof s !== "string" || s.length < 1 || s.length > 20 || /\s{2,}/.test(s)) fail(what);
  return v as string[];
}

const compiledCache = new WeakMap<object, Compiled>();

/** 정책 검증+컴파일. 검증 실패는 PolicyError(내용은 원문과 무관한 고정 문구). 같은 정책 객체는 한 번만 컴파일. */
export function compilePolicy(policy: unknown): Compiled {
  if (typeof policy !== "object" || policy === null) fail("policy");
  const hit = compiledCache.get(policy);
  if (hit) return hit;
  const p = policy as GuardPolicy;

  if (typeof p.policyId !== "string" || !POLICY_ID_RE.test(p.policyId)) fail("policyId");
  if (p.level !== "STRICT" && p.level !== "STANDARD") fail("level");
  if (!isPosInt(p.maxCharsPerField, LIMITS.maxPerField)) fail("maxCharsPerField");
  if (!isPosInt(p.maxCharsTotal, LIMITS.maxTotal)) fail("maxCharsTotal");
  if (!isPosInt(p.maxReplacements, LIMITS.maxReplacements)) fail("maxReplacements");
  if (p.unknownKeys !== undefined && p.unknownKeys !== "DROP" && p.unknownKeys !== "BLOCK") fail("unknownKeys");
  if (p.onCollision !== undefined && p.onCollision !== "ESCAPE" && p.onCollision !== "BLOCK") fail("onCollision");

  if (!Array.isArray(p.restoreKinds)) fail("restoreKinds");
  const restorable = new Set<GuardKind>();
  for (const k of p.restoreKinds) {
    if (!KIND_SET.has(k) || HARD_KINDS.includes(k)) fail("restoreKinds");
    restorable.add(k);
  }

  const modes: Record<GuardKind, KindMode> = { ...DEFAULT_MODES };
  if (p.kinds !== undefined) {
    if (typeof p.kinds !== "object" || p.kinds === null) fail("kinds");
    for (const [k, m] of Object.entries(p.kinds)) {
      if (!KIND_SET.has(k) || !MODE_SET.has(m as string)) fail("kinds");
      const kind = k as GuardKind;
      const mode = m as KindMode;
      if (HARD_KINDS.includes(kind) && (mode === "PASS" || mode === "OFF")) fail("kinds-hard");
      if (kind === "SECRET_LIKE" && mode !== "BLOCK") fail("kinds-secret");
      if (kind === "KNOWN" && (mode === "PASS" || mode === "OFF")) fail("kinds-known");
      modes[kind] = mode;
    }
  }

  const fieldMap = new Map<string, FieldSpec>();
  if (p.fields !== undefined) {
    if (typeof p.fields !== "object" || p.fields === null) fail("fields");
    const entries = Object.entries(p.fields);
    if (entries.length > LIMITS.maxFields) fail("fields");
    for (const [path, spec] of entries) {
      if (path.length > 100) fail("fields-path");
      for (const seg of path.split(".")) {
        const name = seg.endsWith("[]") ? seg.slice(0, -2) : seg;
        if (!SEGMENT_RE.test(seg) || FORBIDDEN.has(name)) fail("fields-path");
      }
      fieldMap.set(path, validateSpec(spec, p.maxCharsPerField));
    }
  }

  const terms: Term[] = [];
  if (p.knownTerms !== undefined) {
    if (!Array.isArray(p.knownTerms) || p.knownTerms.length > LIMITS.maxTerms) fail("knownTerms");
    for (const t of p.knownTerms) {
      if (typeof t !== "object" || t === null || !KIND_SET.has(t.kind) || typeof t.value !== "string") fail("knownTerms");
      const canonical = normalizeText(t.value).trim().toLowerCase();
      const key = `${t.kind}\u0000${canonical}`;
      const forms = [t.value, ...(t.alias ?? [])];
      for (const f of forms) {
        if (typeof f !== "string") fail("knownTerms");
        const norm = normalizeText(f).trim().toLowerCase();
        if (norm.length < 2 || norm.length > 64) fail("knownTerms-length");
        terms.push({ norm, kind: t.kind, key });
      }
    }
  }
  const termIndex = new Map<string, Term[]>();
  for (const t of terms) {
    const first = t.norm[0]!;
    const list = termIndex.get(first);
    if (list) list.push(t);
    else termIndex.set(first, [t]);
  }
  for (const list of termIndex.values()) list.sort((a, b) => b.norm.length - a.norm.length);

  const extraRaw = p.extraDetectors ?? [];
  if (!Array.isArray(extraRaw) || extraRaw.length > LIMITS.maxDetectors || extraRaw.some((d) => typeof d !== "function")) fail("extraDetectors");
  const extra: readonly ExtraDetector[] = Object.freeze([...extraRaw]); // 배열을 복사해 호출자가 나중에 push/교체해도 영향 없음

  const markers = compileMarkers(strList(p.extraOrgMarkers, "extraOrgMarkers"), strList(p.extraPersonCues, "extraPersonCues"));

  const c: Compiled = {
    policy: Object.freeze({
      policyId: p.policyId,
      level: p.level,
      maxCharsPerField: p.maxCharsPerField,
      maxCharsTotal: p.maxCharsTotal,
      maxReplacements: p.maxReplacements,
    }),
    modes: Object.freeze({ ...modes }) as Record<GuardKind, KindMode>,
    restorable,
    fieldMap,
    unknownKeys: p.unknownKeys ?? "BLOCK",
    collision: p.onCollision ?? "ESCAPE",
    markers,
    termIndex,
    extra,
  };
  compiledCache.set(policy, c);
  return c;
}

function validateSpec(spec: unknown, perField: number): FieldSpec {
  if (typeof spec !== "object" || spec === null) fail("spec");
  const s = spec as FieldSpec;
  switch (s.type) {
    // 모든 명세는 복사해 얼린다(보강 ⑤): 컴파일 뒤 원본 명세(enum 값 배열 등)를 바꿔도 허용 범위가 달라지지 않는다.
    case "text":
      if (s.maxChars !== undefined && !isPosInt(s.maxChars, perField)) fail("spec-text");
      return Object.freeze(s.maxChars !== undefined ? { type: "text" as const, maxChars: s.maxChars } : { type: "text" as const });
    case "enum":
      if (!Array.isArray(s.values) || s.values.length < 1 || s.values.length > 100) fail("spec-enum");
      for (const v of s.values) if (typeof v !== "string" || v.length > 64) fail("spec-enum");
      return Object.freeze({ type: "enum" as const, values: Object.freeze([...s.values]) });
    case "number":
      if (!Number.isFinite(s.min) || !Number.isFinite(s.max) || s.min > s.max) fail("spec-number");
      return Object.freeze({ type: "number" as const, min: s.min, max: s.max, ...(s.integer === true ? { integer: true } : {}) });
    case "boolean":
      return Object.freeze({ type: "boolean" as const });
    default:
      return fail("spec-type");
  }
}
