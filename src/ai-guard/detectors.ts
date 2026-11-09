import type { GuardKind } from "./types";

/**
 * 패턴 감지기(L2·L3). 모두 정규화된 텍스트를 받아 «후보 스팬»만 돌려주는 순수 함수.
 * - 정규식은 수량자를 전부 상한으로 막았고 중첩 수량자가 없다(선형 시간). 입력 길이 상한이 전제 조건이다.
 * - lookbehind 를 쓰지 않는다(브라우저 번들 호환 여지, 설계서 D19). 앞 경계는 직접 문자를 보고 판정한다.
 * - 값은 돌려주지 않는다. 종류·위치·«의심(suspect)» 여부만.
 */
export interface Candidate {
  kind: GuardKind;
  start: number;
  end: number;
  /** 형식이 불분명한 «의심»(이름 단서, 상호 표지, 17자리 이상 숫자열). STRICT 에서는 차단 대상. */
  suspect: boolean;
  /** 같은 값이면 같은 토큰을 쓰게 하는 키(별칭 사전용). */
  key?: string;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    yield m;
  }
}

/** 거부된 후보 뒤에서 다시 탐색할 수 있게 한 칸만 전진(겹치는 시작점 놓침 방지). */
function scan(
  re: RegExp,
  text: string,
  accept: (m: RegExpExecArray, start: number, end: number) => boolean,
  out: Candidate[],
  make: (m: RegExpExecArray, start: number, end: number) => Candidate,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (accept(m, start, end)) out.push(make(m, start, end));
    else re.lastIndex = start + 1;
  }
}

function digitBoundary(text: string, start: number, end: number): boolean {
  return !isDigit(text[start - 1]) && !isDigit(text[end]);
}

/** 하이픈·점으로 이어진 숫자 덩어리 경계(날짜·소수 안의 일부를 건드리지 않는다). */
function chainBoundary(text: string, start: number, end: number): boolean {
  const b = text[start - 1];
  const a = text[end];
  if (isDigit(b)) return false;
  if ((b === "-" || b === ".") && isDigit(text[start - 2])) return false;
  if (isDigit(a)) return false;
  if ((a === "-" || a === ".") && isDigit(text[end + 1])) return false;
  return true;
}

// ── 체크섬·형식 ────────────────────────────────────────────────
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function biznoValid(digits: string): boolean {
  if (digits.length !== 10) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (digits.charCodeAt(i) - 48) * w[i]!;
  sum += Math.floor(((digits.charCodeAt(8) - 48) * 5) / 10);
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(9) - 48;
}

function rrnDateValid(d: string): boolean {
  const mm = Number(d.slice(2, 4));
  const dd = Number(d.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

const COMPACT_DATE = /^20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:\d{2}|\d{4}|\d{6})?$/;
const ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}$/;

/** 금액·소수·날짜로 읽히는 연속 숫자는 계좌/카드로 보지 않는다(오탐 제외). */
function plainNumberExcluded(text: string, start: number, end: number, run: string): boolean {
  const b = text[start - 1];
  if (b === "," || b === ".") return true;
  const a = text[end];
  if ((a === "," || a === ".") && isDigit(text[end + 1])) return true;
  if (COMPACT_DATE.test(run)) return true;
  let i = end;
  while (i < end + 3 && text[i] === " ") i++;
  const unit = text[i];
  return unit === "원" || unit === "만" || unit === "천" || unit === "억";
}

// ── 패턴 ───────────────────────────────────────────────────────
const RRN_RE = /\d{6} {0,2}[-~]? {0,2}[1-8]\d{6}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/g;
const CARD_GROUPED_RE = /\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{3,4}/g;
const CARD_AMEX_RE = /\d{4}[- ]\d{6}[- ]\d{5}/g;
const RUN_RE = /\d+/g;
const PHONE_INTL_RE = /\+82[-. ]?\(?0?\d{1,2}\)?[-. ]?\d{3,4}[-. ]?\d{4}/g;
const PHONE_82_RE = /82[-. ]?0?1\d[-. ]?\d{3,4}[-. ]?\d{4}/g;
const PHONE_DOMESTIC_RE = /\(?0(?:1[016789]|2|[3-6][1-5]|70|80|50\d?|60)\)?[-. ]?\d{3,4}[-. ]?\d{4}/g;
const PHONE_REP_RE = /1[5-9]\d{2}[-. ]?\d{4}/g;
const BIZNO_RE = /\d{3}[- ]?\d{2}[- ]?\d{5}/g;
const ACCOUNT_CHAIN_RE = /\d{2,6}(?:-\d{2,8}){1,3}/g;
const PLATE_RE = /\d{2,3} ?[가나다라마바사아자하허호거너더러머버서어저고노도로모보소오조구누두루무부수우주배] ?\d{4}/g;

const SECRET_RES: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /[A-Za-z0-9+/_-]{48,}/g,
];

export function detectSecretLike(text: string, out: Candidate[]): void {
  for (const re of SECRET_RES) {
    for (const m of matches(re, text)) out.push({ kind: "SECRET_LIKE", start: m.index, end: m.index + m[0].length, suspect: false });
  }
}

export function detectResidentId(text: string, out: Candidate[]): void {
  scan(
    RRN_RE,
    text,
    (m, s, e) => digitBoundary(text, s, e) && rrnDateValid(m[0]),
    out,
    (_m, s, e) => ({ kind: "RESIDENT_ID", start: s, end: e, suspect: false }),
  );
}

export function detectEmail(text: string, out: Candidate[]): void {
  for (const m of matches(EMAIL_RE, text)) out.push({ kind: "EMAIL", start: m.index, end: m.index + m[0].length, suspect: false });
}

export function detectCard(text: string, out: Candidate[]): void {
  const grouped = (m: RegExpExecArray, s: number, e: number): boolean => digitBoundary(text, s, e) && luhnValid(digitsOf(m[0]));
  const mk = (_m: RegExpExecArray, s: number, e: number): Candidate => ({ kind: "CARD", start: s, end: e, suspect: false });
  scan(CARD_GROUPED_RE, text, grouped, out, mk);
  scan(CARD_AMEX_RE, text, grouped, out, mk);
  // 구분자 없는 13~19자리는 연속 숫자 검사(runs)에서 Luhn 으로 판정한다.
}

export function detectPhone(text: string, out: Candidate[]): void {
  const mk = (_m: RegExpExecArray, s: number, e: number): Candidate => ({ kind: "PHONE", start: s, end: e, suspect: false });
  const ok = (_m: RegExpExecArray, s: number, e: number): boolean => digitBoundary(text, s, e);
  scan(PHONE_INTL_RE, text, ok, out, mk);
  scan(PHONE_82_RE, text, ok, out, mk);
  scan(PHONE_DOMESTIC_RE, text, ok, out, mk);
  scan(
    PHONE_REP_RE,
    text,
    (m, s, e) => {
      if (!digitBoundary(text, s, e)) return false;
      let i = e;
      while (i < e + 3 && text[i] === " ") i++;
      const unit = text[i];
      if (unit === "원" || unit === "만" || unit === "천" || unit === "억") return false;
      return !(m[0].length === 8 && (text[s - 1] === "," || text[s - 1] === "."));
    },
    out,
    mk,
  );
}

export function detectBizno(text: string, out: Candidate[]): void {
  scan(
    BIZNO_RE,
    text,
    (m, s, e) => chainBoundary(text, s, e) && biznoValid(digitsOf(m[0])),
    out,
    (_m, s, e) => ({ kind: "BIZNO", start: s, end: e, suspect: false }),
  );
}

/** 하이픈 덩어리 계좌 + 연속 숫자(10~16자리 확정, 17자리 이상은 «의심») + 구분자 없는 카드(Luhn). */
export function detectAccountAndRuns(text: string, out: Candidate[]): void {
  scan(
    ACCOUNT_CHAIN_RE,
    text,
    (m, s, e) => {
      if (!chainBoundary(text, s, e)) return false;
      const chunks = m[0].split("-").length;
      const n = digitsOf(m[0]).length;
      if (ISO_DATE.test(m[0])) return false;
      return (n >= 10 && n <= 16) || (n === 9 && chunks >= 3);
    },
    out,
    (_m, s, e) => ({ kind: "ACCOUNT", start: s, end: e, suspect: false }),
  );
  for (const m of matches(RUN_RE, text)) {
    const run = m[0];
    const s = m.index;
    const e = s + run.length;
    if (run.length < 10) continue;
    if (plainNumberExcluded(text, s, e, run)) continue;
    if (run.length >= 13 && run.length <= 19 && luhnValid(run)) {
      out.push({ kind: "CARD", start: s, end: e, suspect: false });
    } else if (run.length <= 16) {
      out.push({ kind: "ACCOUNT", start: s, end: e, suspect: false });
    } else {
      out.push({ kind: "ACCOUNT", start: s, end: e, suspect: true });
    }
  }
}

export function detectPlate(text: string, out: Candidate[]): void {
  scan(
    PLATE_RE,
    text,
    (_m, s, e) => digitBoundary(text, s, e),
    out,
    (_m, s, e) => ({ kind: "PLATE", start: s, end: e, suspect: false }),
  );
}

// ── L3: 상호 표지·이름 단서(보수적·과탐 허용, 전부 «의심») ──────────
const CORP_PREFIX = "(?:주식회사|\\( {0,2}주 {0,2}\\)|유한책임회사|유한회사|\\( {0,2}유 {0,2}\\)|합자회사|합명회사|사단법인|재단법인|농업회사법인|영농조합법인)";
const CORP_SUFFIX = "(?:주식회사|\\( {0,2}주 {0,2}\\)|\\( {0,2}유 {0,2}\\)|유한회사)";
const ORG_PREFIX_RE = new RegExp(`${CORP_PREFIX} {0,2}([가-힣A-Za-z0-9]{1,20})`, "g");
const ORG_SUFFIX_RE = new RegExp(`([가-힣A-Za-z0-9]{1,20}) {0,2}${CORP_SUFFIX}`, "g");

/** 기본 상호 접미어(일반 명사와 겹치는 식품·건설·물류 등은 넣지 않는다 — 앱이 extraOrgMarkers 로 더한다). */
export const DEFAULT_ORG_MARKERS: readonly string[] = ["상사", "상회", "물산", "실업", "무역", "산업"];
export const DEFAULT_PERSON_CUES: readonly string[] = ["받는분", "받는 분", "받는사람", "수취인", "인수자", "담당자", "담당", "보내는분", "보내는 분", "성함", "이름"];
const TITLES: readonly string[] = ["대표님", "사장님", "과장님", "부장님", "차장님", "팀장님", "실장님", "이사님", "선생님", "대표", "사장", "과장", "부장", "차장", "팀장", "실장", "이사", "님"];
const PARTICLES: readonly string[] = ["입니다", "이다", "이며", "이고", "께서", "에서", "으로", "에게", "한테", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만", "께"];
const NAME_STOP: ReadonlySet<string> = new Set([
  "업무", "부서", "직원", "기사", "차량", "배송", "운송", "확인", "문의", "연락", "요청", "사항", "관련", "배차", "업체", "거래처", "고객", "회원", "본인", "없음", "미정", "동일", "같음",
  "사장", "대표", "과장", "부장", "차장", "팀장", "실장", "이사", "선생", "담당", "담당자", "판매자", "구매자", "사용자", "관리자", "운전", "운전기사", "배송기사", "화주", "여러분", "손님", "상담", "접수", "주문", "발송",
]);

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function alt(list: readonly string[]): string {
  return [...list].sort((a, b) => b.length - a.length).map(esc).join("|");
}

export interface Markers {
  orgWord: RegExp;
  personBefore: RegExp;
  personAfter: RegExp;
}

export function compileMarkers(extraOrg: readonly string[], extraCues: readonly string[]): Markers {
  const words = alt([...DEFAULT_ORG_MARKERS, ...extraOrg]);
  const cues = alt([...DEFAULT_PERSON_CUES, ...extraCues]);
  const titles = alt([...TITLES, ...extraCues]);
  return {
    orgWord: new RegExp(`([가-힣A-Za-z0-9]{1,20}?)(${words})(?:${alt(PARTICLES)})?(?![가-힣A-Za-z0-9])`, "g"),
    personBefore: new RegExp(`(?:${cues}) {0,2}:? {0,2}([가-힣]{2,4})`, "g"),
    personAfter: new RegExp(`([가-힣]{2,4})(?: ?(?:${titles})| 씨)`, "g"),
  };
}

export function detectOrgMarkers(text: string, mk: Markers, out: Candidate[]): void {
  const push = (s: number, e: number): void => {
    out.push({ kind: "ORG", start: s, end: e, suspect: true });
  };
  for (const m of matches(ORG_PREFIX_RE, text)) push(m.index, m.index + m[0].length);
  for (const m of matches(ORG_SUFFIX_RE, text)) push(m.index, m.index + m[0].length);
  for (const m of matches(mk.orgWord, text)) push(m.index, m.index + m[1]!.length + m[2]!.length);
}

export function detectPersonCues(text: string, mk: Markers, out: Candidate[]): void {
  for (const m of matches(mk.personBefore, text)) {
    const name = m[1]!;
    if (NAME_STOP.has(name)) continue;
    const e = m.index + m[0].length;
    out.push({ kind: "PERSON", start: e - name.length, end: e, suspect: true });
  }
  for (const m of matches(mk.personAfter, text)) {
    const name = m[1]!;
    if (NAME_STOP.has(name)) continue;
    out.push({ kind: "PERSON", start: m.index, end: m.index + name.length, suspect: true });
  }
}
