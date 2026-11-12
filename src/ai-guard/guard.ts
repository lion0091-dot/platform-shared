import {
  countAddressCues,
  detectAccountAndRuns,
  detectBizno,
  detectCard,
  detectEmail,
  detectOrgMarkers,
  detectPersonCues,
  detectPhone,
  detectPlate,
  detectResidentId,
  detectSecretLike,
  type Candidate,
} from "./detectors";
import { normalizeText } from "./normalize";
import { compilePolicy, isForbiddenKey, LIMITS, PolicyError, PREFIX_KIND, TOKEN_PREFIX, type Compiled } from "./policy";
import {
  GUARD_KINDS,
  GUARD_RULES_VERSION,
  type GuardKind,
  type GuardReason,
  type GuardReport,
  type GuardResult,
  type GuardWarning,
  type RestoreResult,
  type SafePayload,
} from "./types";

/**
 * guard(): 입력+정책 → 가린 결과. 동기·순수. **절대 throw 하지 않는다**(모든 오류는 ok:false).
 * 계약: ok:true 는 (1) 구조·길이·치환 수 상한 통과 (2) 치환 결과 재검사(post-check) 통과일 때만.
 * 결과·리포트·오류 어디에도 원문 조각·치환 맵·키 이름·해시를 넣지 않는다.
 */

class Block extends Error {
  constructor(
    readonly reason: GuardReason,
    readonly kinds?: readonly GuardKind[],
  ) {
    super(reason); // 메시지는 고정 코드뿐
  }
}

const TOKEN_RE = /\[([A-Z]+)_(\d+)\]/g;
const RANK: Readonly<Record<GuardKind, number>> = {
  SECRET_LIKE: 0,
  RESIDENT_ID: 1,
  CARD: 2,
  EMAIL: 3,
  PHONE: 4,
  BIZNO: 5,
  ACCOUNT: 6,
  ADDRESS: 7,
  ORG: 8,
  PERSON: 9,
  PLATE: 10,
  KNOWN: 11,
};
const KIND_SET: ReadonlySet<string> = new Set(GUARD_KINDS);
const SAFE_SET = new WeakSet<object>();

export function isSafePayload(x: unknown): x is SafePayload {
  return typeof x === "object" && x !== null && SAFE_SET.has(x);
}

export function reasonCodes(r: GuardResult): readonly string[] {
  if (r.ok) return [];
  return r.kinds && r.kinds.length > 0 ? r.kinds.map((k) => `${r.reason}:${k}`) : [r.reason];
}

// ── 호출 상태 ─────────────────────────────────────────────────
interface State {
  policyId: string;
  counts: Partial<Record<GuardKind, number>>;
  passed: Partial<Record<GuardKind, number>>;
  warnings: Partial<Record<GuardWarning, number>>;
  fields: Set<string>;
  dropped: number;
  charsIn: number;
  charsOut: number;
  replacements: number;
  tokenByValue: Map<string, string>;
  tokenMap: Map<string, { kind: GuardKind; original: string }>;
  counters: Map<string, number>;
}

function newState(): State {
  return {
    policyId: "invalid",
    counts: {},
    passed: {},
    warnings: {},
    fields: new Set(),
    dropped: 0,
    charsIn: 0,
    charsOut: 0,
    replacements: 0,
    tokenByValue: new Map(),
    tokenMap: new Map(),
    counters: new Map(),
  };
}

function report(st: State, ok: boolean): GuardReport {
  return {
    rulesVersion: GUARD_RULES_VERSION,
    policyId: st.policyId,
    counts: { ...st.counts },
    passed: { ...st.passed },
    fieldsSent: ok ? [...st.fields] : [],
    droppedCount: st.dropped,
    charsIn: st.charsIn,
    charsOut: ok ? st.charsOut : 0,
    ...(Object.keys(st.warnings).length > 0 ? { warnings: { ...st.warnings } } : {}),
  };
}

function bump(m: Partial<Record<GuardKind, number>>, k: GuardKind): void {
  m[k] = (m[k] ?? 0) + 1;
}

function sortKinds(kinds: Iterable<GuardKind>): GuardKind[] {
  const s = new Set(kinds);
  return GUARD_KINDS.filter((k) => s.has(k));
}

// ── 공개 함수 ─────────────────────────────────────────────────
export function guard(input: unknown, policy: unknown): GuardResult {
  const st = newState();
  try {
    const c = compilePolicy(policy);
    st.policyId = c.policy.policyId;
    return run(input, c, st);
  } catch (e) {
    if (e instanceof PolicyError) return { ok: false, reason: "INVALID_POLICY", report: report(st, false) };
    if (e instanceof Block) return { ok: false, reason: e.reason, ...(e.kinds ? { kinds: e.kinds } : {}), report: report(st, false) };
    return { ok: false, reason: "CHECK_ERROR", report: report(st, false) };
  }
}

// ── 입력 구조 ─────────────────────────────────────────────────
class TextSlot {
  out = "";
  constructor(readonly raw: string) {}
}
const DROP = Symbol("drop");

interface Walk {
  c: Compiled;
  st: State;
  slots: TextSlot[];
  leaves: number;
  total: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function unknownLeaf(w: Walk): typeof DROP {
  if (w.c.unknownKeys === "BLOCK") throw new Block("UNKNOWN_FIELD");
  w.st.dropped++;
  return DROP;
}

function visit(v: unknown, path: string, depth: number, w: Walk): unknown {
  if (depth > LIMITS.maxDepth) throw new Block("OVER_LENGTH");
  if (v === undefined) return DROP;
  if (Array.isArray(v)) {
    if (v.length > LIMITS.maxArray) throw new Block("OVER_LENGTH");
    const arr: unknown[] = [];
    for (const el of v) {
      const r = visit(el, path + "[]", depth + 1, w);
      if (r !== DROP) arr.push(r);
    }
    return arr.length > 0 ? arr : DROP;
  }
  if (isPlainObject(v)) {
    const obj: Record<string, unknown> = {};
    let kept = 0;
    for (const key of Object.keys(v)) {
      if (isForbiddenKey(key)) {
        unknownLeaf(w);
        continue;
      }
      const r = visit(v[key], path === "" ? key : `${path}.${key}`, depth + 1, w);
      if (r !== DROP) {
        obj[key] = r;
        kept++;
      }
    }
    return kept > 0 || depth === 0 ? obj : DROP;
  }
  // 잎
  if (++w.leaves > LIMITS.maxLeaves) throw new Block("OVER_LENGTH");
  const spec = w.c.fieldMap.get(path);
  if (!spec) return unknownLeaf(w);
  w.st.fields.add(path);
  switch (spec.type) {
    case "text": {
      if (typeof v !== "string") throw new Block("NON_TEXT");
      const limit = Math.min(spec.maxChars ?? Infinity, w.c.policy.maxCharsPerField);
      if (v.length > limit) throw new Block("OVER_LENGTH");
      w.total += v.length;
      w.st.charsIn += v.length;
      const slot = new TextSlot(v);
      w.slots.push(slot);
      return slot;
    }
    case "enum":
      if (typeof v !== "string" || !spec.values.includes(v)) throw new Block("SCHEMA_VIOLATION");
      return v;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v) || v < spec.min || v > spec.max || (spec.integer === true && !Number.isInteger(v))) {
        throw new Block("SCHEMA_VIOLATION");
      }
      return v;
    case "boolean":
      if (typeof v !== "boolean") throw new Block("SCHEMA_VIOLATION");
      return v;
  }
}

function materialize(node: unknown): unknown {
  if (node instanceof TextSlot) return node.out;
  if (Array.isArray(node)) return node.map(materialize);
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = materialize(v);
    return out;
  }
  return node;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

function run(input: unknown, c: Compiled, st: State): GuardResult {
  const w: Walk = { c, st, slots: [], leaves: 0, total: 0 };
  let tree: unknown;
  let root: "string" | "object";

  if (typeof input === "string") {
    root = "string";
    if (input.length > c.policy.maxCharsPerField) throw new Block("OVER_LENGTH");
    const slot = new TextSlot(input);
    w.slots.push(slot);
    w.total = input.length;
    st.charsIn = input.length;
    st.fields.add("$");
    tree = slot;
  } else if (isPlainObject(input)) {
    root = "object";
    tree = visit(input, "", 0, w);
  } else {
    throw new Block("NON_TEXT");
  }
  if (w.total > c.policy.maxCharsTotal) throw new Block("OVER_LENGTH");

  for (const slot of w.slots) slot.out = processText(slot.raw, c, st);

  const value = deepFreeze(materialize(tree === DROP ? {} : tree)) as SafePayload["value"];
  const payload = Object.freeze({ value }) as unknown as SafePayload;
  SAFE_SET.add(payload);
  void root;

  const map = st.tokenMap;
  const restorable = c.restorable;
  const restore = (aiText: string): RestoreResult => {
    if (typeof aiText !== "string") return { text: "", unknownTokens: [], unrestoredTokens: [] };
    const unknown: string[] = [];
    const unrestored: string[] = [];
    const text = aiText.replace(TOKEN_RE, (tok: string) => {
      const e = map.get(tok);
      if (!e) {
        if (!unknown.includes(tok)) unknown.push(tok);
        return tok;
      }
      if (!restorable.has(e.kind)) {
        if (!unrestored.includes(tok)) unrestored.push(tok);
        return tok;
      }
      return e.original;
    });
    return { text, unknownTokens: unknown, unrestoredTokens: unrestored };
  };

  return { ok: true, payload, restore, report: report(st, true) };
}

// ── 텍스트 처리 (L1~L6) ───────────────────────────────────────
interface Group {
  start: number;
  end: number;
  kind: GuardKind;
  suspect: boolean;
  members: number;
  /** 이 그룹에 합쳐진 모든 후보의 종류(처리 방식 합치기용). */
  kinds: Set<GuardKind>;
  key?: string;
}

function collect(text: string, c: Compiled): Candidate[] {
  const on = (k: GuardKind): boolean => c.modes[k] !== "OFF";
  const out: Candidate[] = [];

  detectSecretLike(text, out);
  detectResidentId(text, out);
  detectEmail(text, out); // OFF 여도 돌린다: 이메일 안의 숫자열이 계좌로 오인되지 않게 «흡수» 용도
  detectCard(text, out);
  detectPhone(text, out); // 같은 이유. OFF 면 classify 에서 마지막에 버린다
  if (on("BIZNO")) detectBizno(text, out);
  detectAccountAndRuns(text, out);
  if (on("PLATE")) detectPlate(text, out);
  if (on("ORG")) detectOrgMarkers(text, c.markers, out);
  if (on("PERSON")) detectPersonCues(text, c.markers, out);

  if (c.termIndex.size > 0) {
    const lower = text.toLowerCase();
    const hay = lower.length === text.length ? lower : text;
    for (let i = 0; i < hay.length; i++) {
      const list = c.termIndex.get(hay[i]!);
      if (!list) continue;
      for (const t of list) {
        if (hay.startsWith(t.norm, i)) {
          out.push({ kind: t.kind, start: i, end: i + t.norm.length, suspect: false, key: t.key });
          break;
        }
      }
    }
  }

  for (const d of c.extra) {
    let r: unknown;
    try {
      r = d(text);
    } catch {
      throw new Block("DETECTOR_FAILED");
    }
    if (!Array.isArray(r) || r.length > LIMITS.maxDetectorSpans) throw new Block("DETECTOR_FAILED");
    for (const s of r as unknown[]) {
      if (typeof s !== "object" || s === null) throw new Block("DETECTOR_FAILED");
      const { kind, start, end } = s as { kind: unknown; start: unknown; end: unknown };
      if (typeof kind !== "string" || !KIND_SET.has(kind)) throw new Block("DETECTOR_FAILED");
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Block("DETECTOR_FAILED");
      const a = start as number;
      const b = end as number;
      if (a < 0 || a >= b || b > text.length) throw new Block("DETECTOR_FAILED");
      out.push({ kind: kind as GuardKind, start: a, end: b, suspect: false });
    }
  }

  return out;
}

const STRENGTH: Readonly<Record<string, number>> = { OFF: -1, PASS: 0, MASK: 1, BLOCK: 2 };

function classify(cands: Candidate[], c: Compiled): Group[] {
  // 번호류 후보가 더 강한 번호(주민·카드·전화·이메일) 안에 완전히 들어 있으면 버린다(같은 번호의 이중 해석).
  const strong = cands.filter((x) => x.kind === "RESIDENT_ID" || x.kind === "CARD" || x.kind === "PHONE" || x.kind === "EMAIL");
  const biz = cands.filter((x) => x.kind === "BIZNO"); // 검증식을 통과한 사업자번호 모양은 계좌로 다시 해석하지 않는다
  const kept = cands.filter((x) => {
    if (x.kind === "ACCOUNT" || x.kind === "BIZNO") {
      if (strong.some((s) => s.start <= x.start && x.end <= s.end)) return false;
    }
    if (x.kind === "ACCOUNT" && biz.some((s) => s.start <= x.start && x.end <= s.end)) return false;
    return true;
  });
  kept.sort((a, b) => a.start - b.start || b.end - a.end);

  const groups: Group[] = [];
  for (const x of kept) {
    const g = groups[groups.length - 1];
    if (g && x.start < g.end) {
      g.end = Math.max(g.end, x.end);
      if (RANK[x.kind] < RANK[g.kind]) g.kind = x.kind;
      g.kinds.add(x.kind);
      g.suspect = g.suspect && x.suspect;
      g.members++;
      delete g.key;
    } else {
      groups.push({ start: x.start, end: x.end, kind: x.kind, suspect: x.suspect, members: 1, kinds: new Set([x.kind]), ...(x.key ? { key: x.key } : {}) });
    }
  }
  // 합친 그룹의 처리 방식은 «가장 엄격한 구성원» 을 따른다(BLOCK > MASK > PASS, OFF 는 무시).
  // 우선순위가 높은 종류가 PASS/OFF 여도 같은 구간에 있는 MASK·BLOCK 종류가 누락되지 않게 한다. 종류 이름은 가장 엄격한 쪽 중 우선순위가 가장 높은 것.
  const out: Group[] = [];
  for (const g of groups) {
    let best: GuardKind | null = null;
    let bestStrength = -1;
    for (const k of g.kinds) {
      const st = k === "SECRET_LIKE" ? STRENGTH.BLOCK! : STRENGTH[c.modes[k]]!;
      if (st > bestStrength || (st === bestStrength && best !== null && RANK[k] < RANK[best])) {
        best = k;
        bestStrength = st;
      }
    }
    if (best === null || bestStrength < 0) continue; // 구성원이 전부 OFF: 탐지 안 함(흡수 역할은 위에서 끝남)
    g.kind = best;
    out.push(g);
  }
  return out;
}

function effectiveMode(g: Group, c: Compiled): "MASK" | "BLOCK" | "PASS" {
  if (g.kind === "SECRET_LIKE") return "BLOCK";
  const m = c.modes[g.kind];
  if (m === "MASK" && g.suspect && c.policy.level === "STRICT") return "BLOCK";
  return m === "OFF" ? "PASS" : m;
}

function tokenRanges(text: string): Array<[number, number]> {
  const r: Array<[number, number]> = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) r.push([m.index, m.index + m[0].length]);
  return r;
}

function processText(raw: string, c: Compiled, st: State): string {
  let text = normalizeText(raw);
  if (text.length > c.policy.maxCharsPerField) throw new Block("OVER_LENGTH");

  // 토큰 모양 충돌: 위조 복원을 막는다.
  TOKEN_RE.lastIndex = 0;
  if (TOKEN_RE.test(text)) {
    if (c.collision === "BLOCK") throw new Block("TOKEN_COLLISION");
    text = text.replace(TOKEN_RE, (m) => "［" + m.slice(1));
  }

  const cues = countAddressCues(text); // 주소는 가리지 않고 단서어 경고만(보강 ①)
  if (cues > 0) st.warnings.ADDRESS_CUE = (st.warnings.ADDRESS_CUE ?? 0) + cues;

  const groups = classify(collect(text, c), c);
  const blocked = new Set<GuardKind>();
  const masks: Group[] = [];
  for (const g of groups) {
    const mode = effectiveMode(g, c);
    if (mode === "PASS") {
      bump(st.passed, g.kind);
    } else if (mode === "BLOCK") {
      bump(st.counts, g.kind);
      blocked.add(g.kind);
    } else {
      masks.push(g);
    }
  }
  if (blocked.size > 0) throw new Block(blocked.has("SECRET_LIKE") ? "SECRET_LIKE" : "RESIDUAL_PII", sortKinds(blocked));

  let out = "";
  let pos = 0;
  for (const g of masks) {
    if (++st.replacements > c.policy.maxReplacements) throw new Block("TOO_MANY_REPLACEMENTS");
    const original = text.slice(g.start, g.end);
    const valueKey = g.key ?? `${g.kind}\u0000${original}`;
    let tok = st.tokenByValue.get(valueKey);
    if (tok === undefined) {
      const prefix = TOKEN_PREFIX[g.kind];
      const n = (st.counters.get(prefix) ?? 0) + 1;
      st.counters.set(prefix, n);
      tok = `[${prefix}_${n}]`;
      st.tokenByValue.set(valueKey, tok);
      st.tokenMap.set(tok, { kind: g.kind, original });
    }
    bump(st.counts, g.kind);
    out += text.slice(pos, g.start) + tok;
    pos = g.end;
  }
  out += text.slice(pos);

  postCheck(out, c);
  st.charsOut += out.length;
  return out;
}

/** L6: 치환 결과에 모든 감지기를 다시 돌린다(앱 감지기 포함). 토큰 안쪽 스팬은 무시. */
function postCheck(masked: string, c: Compiled): void {
  const ranges = tokenRanges(masked);
  const residual = new Set<GuardKind>();
  for (const g of classify(collect(masked, c), c)) {
    if (ranges.some(([a, b]) => a <= g.start && g.end <= b)) continue;
    if (effectiveMode(g, c) !== "PASS") residual.add(g.kind);
  }
  if (residual.size > 0) throw new Block(residual.has("SECRET_LIKE") ? "SECRET_LIKE" : "RESIDUAL_PII", sortKinds(residual));
}

export { PREFIX_KIND };
