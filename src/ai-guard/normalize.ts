/**
 * L1 정규화: NFKC(전각→반각, ㈜→(주) 등) + 보이지 않는 문자·제어문자 제거
 *  + (보강) 숫자 사이 유니코드 대시/가운뎃점 → `-`, 비ASCII 십진 숫자 → ASCII 숫자.
 * 위치(오프셋)는 이 결과 기준. 위치 대응표가 필요한 호출(자유 문장 저장)은 `normalizeWithMap` 을 쓴다.
 */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 대시류(하이픈·en/em 대시·수학 빼기 등)와 가운뎃점류. NFKC 가 바꾸지 않는 것만 모은다. */
const SEP_CLASS = "\\u00B7\\u0387\\u058A\\u05BE\\u1806\\u2010-\\u2015\\u2027\\u2043\\u2212\\u2E3A\\u2E3B\\u30FB\\u318D\\uFE58\\uFE63\\uFF0D\\uFF65";
/** (lookbehind 를 쓰지 않는다 — 설계서 D19) 숫자 바로 옆(공백 최대 2칸 허용)에 있는 대시·가운뎃점만 `-` 로 통일한다. 문장 속 대시 문체는 건드리지 않는다. */
const DIGIT_SEP = new RegExp(`(\\d) {0,2}[${SEP_CLASS}] {0,2}(?=\\d)`, "g");

const ND = /\p{Nd}/u;

/** 비ASCII 십진 숫자의 값(0~9). 십진 숫자 블록은 0 으로 시작해 연속 10칸이므로 블록 시작을 찾아 나머지를 구한다. 숫자가 아니면 -1. */
export function decimalValue(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined || !ND.test(ch)) return -1;
  let start = cp;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

function asciiDigits(s: string): string {
  let out = "";
  for (const ch of s) out += ch >= "0" && ch <= "9" ? ch : ND.test(ch) ? String(decimalValue(ch)) : ch;
  return out;
}

/** 문자열 안의 모든 십진 숫자(전각·아랍-인도 등)를 ASCII 숫자로. 숫자가 아닌 글자는 그대로. */
export function toAsciiDigits(s: string): string {
  return /[^\x00-\x7F]/.test(s) ? asciiDigits(s) : s;
}

/** 정규화 결과와 «정규화 문자 → 원문 구간» 대응표. starts[i]..ends[i] 는 text[i] 를 만든 원문의 UTF-16 구간이다. */
export interface NormalizedMap {
  text: string;
  starts: number[];
  ends: number[];
}

/**
 * 위치 대응표가 있는 정규화. 코드포인트마다 NFKC·불가시 문자 제거·숫자 ASCII 화를 하고, 숫자 옆 대시류는 `-` 하나로 합친다.
 * 가림 결과를 «원문 위에» 얹을 때(자유 문장 저장) 쓴다. 한글 낱자 조합 같은 문맥 의존 정규화는 하지 않으므로
 * 숫자·구분자에 대해서는 `normalizeText` 와 같은 결과를 내고, 그 밖의 글자는 달라도 탐지에는 영향이 없다.
 */
export function normalizeWithMap(raw: string, opts: { collapseWhitespace?: boolean } = {}): NormalizedMap {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  const collapse = opts.collapseWhitespace === true;
  for (const ch of raw) {
    const s = i;
    const e = i + ch.length;
    i = e;
    const n = toAsciiDigits(ch.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROL, " "));
    for (let k = 0; k < n.length; k++) {
      // 탐지용 사본에서만: 줄바꿈·탭을 공백으로 보고 연속 공백을 하나로 합친다(번호 사이 줄바꿈 우회). 저장본은 원문 그대로다.
      if (collapse && /\s/.test(n[k]!)) {
        if (text.endsWith(" ")) continue;
        text += " ";
        starts.push(s);
        ends.push(e);
        continue;
      }
      text += n[k];
      starts.push(s);
      ends.push(e);
    }
  }

  // 숫자 옆 대시·가운뎃점 → `-` (구간 전체를 하나의 `-` 로 합치고, 대응표는 합친 구간 전체를 가리킨다)
  let out = "";
  const oStarts: number[] = [];
  const oEnds: number[] = [];
  let pos = 0;
  DIGIT_SEP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIGIT_SEP.exec(text)) !== null) {
    const a = m.index;
    const b = a + m[0].length;
    for (let k = pos; k <= a; k++) {
      out += text[k];
      oStarts.push(starts[k]!);
      oEnds.push(ends[k]!);
    }
    out += "-";
    oStarts.push(starts[a + 1]!);
    oEnds.push(ends[b - 1]!);
    pos = b;
  }
  for (let k = pos; k < text.length; k++) {
    out += text[k];
    oStarts.push(starts[k]!);
    oEnds.push(ends[k]!);
  }
  return { text: out, starts: oStarts, ends: oEnds };
}

export function normalizeText(raw: string): string {
  const stripped = raw.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROL, " ");
  return toAsciiDigits(stripped).replace(DIGIT_SEP, "$1-"); // 숫자를 먼저 ASCII 로 바꿔야 비ASCII 숫자 옆 대시도 잡힌다
}
